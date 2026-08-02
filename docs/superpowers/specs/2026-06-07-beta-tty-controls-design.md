# 设计：Beta 聊天控制打通 TTY（闭环驱动 + 队列 + 停止）

- 日期：2026-06-07
- 状态：已与用户对齐（含 Codex review R1/R2 + 停止按钮 + (c)–(f) 决策）→ 待最终 spec 评审 → spike → writing-plans
- 触及敏感区：是（Claude TTY / hooks / `claude -p` 计费，见 `docs/runtime-modes/`）
- 关联：现状 bug「Beta 提交问题无法继续」「停止按钮不同步且无效」；现状缺失「Beta 无消息队列」

## 决策记录（本轮拍板）

| 编号 | 决策 |
|---|---|
| 架构 | 方案 A：闭环驱动层进 cc-proxy |
| model/effort/mode | **live 切**，不重开 PTY |
| slash | 核心闭环卡片 + 其余透传；`/login` 不在 scope |
| (c) setPermissionMode | **菜单式**（`/permission-mode` 选单，非 Shift+Tab 数步） |
| (d) send_now（TTY 忙时） | **立刻 paste 进 PTY**，由 Claude TUI 当"补充消息"处理（不等 Stop hook） |
| (e) A8/A9 工具权限弹窗 | **进本轮 scope**（闭环驱动） |
| (f) 多问 AskUserQuestion | **一问一卡**（沿用现状 QuestionCard 逐个出） |
| R1（Codex） | AskUserQuestion **待答发现钉 PreToolUse**；JSONL/PostToolUse 只做权威 resolve/reconcile |
| R2（Codex） | `session:remote-control` 收进 **owner/intent** 路径，去掉 host-trusted 旁路 |

---

## 0. 背景与硬约束

### 0.1 用户目标

- **Beta chat 框完整平替终端**：所有按钮/输入都能驱动底层 TTY，不必掉到裸终端。
- `model / effort / permission-mode` **live 切**；slash 核心闭环 + 其余透传；`/login` 出局。

### 0.2 硬约束（claude-code-guide 核实，2026-06-07）

交互式 `claude`（订阅进程，非 `-p`）**不对外暴露任何结构化控制通道**：

| 能力 | 交互式 claude | 备注 |
|---|---|---|
| Remote Control | 云端 ↔ claude.ai/手机 only | 无本地 API |
| stream-json / 控制请求 | ❌ 仅 `claude -p`（Agent SDK） | 计费分叉，排除 |
| hooks 改 model/mode/effort | ❌ | hooks 只观测 |
| hooks 答 AskUserQuestion / 权限弹窗 | ❌ | 只能 TTY 里真实选 |
| hooks 携带 permission_mode/effort | ✅ | model 需读 JSONL |

**结论：无协议可接，只能把 TTY 当受控对象闭环驱动**——这是设计高风险的根源（驱动对象=TUI 布局，随版本变）。

---

## 1. 架构（方案 A：闭环驱动层进 cc-proxy）

### 1.1 核心洞察（含 R1）

**稳态值与驱动过程分两条腿：**

- **稳态值**（当前 model/mode/effort）：`model ← JSONL`，`mode/effort ← hooks`。不靠刮屏。
- **驱动过程**（选择器开没开、高亮在哪、关没关）：靠服务端无头终端网格。

**R1 例外——待答交互不走 JSONL**：AskUserQuestion / 工具权限弹窗在被回答**之前不会 flush 进 JSONL**（`manager.ts:408` 已记此事实），所以：

- **待答发现 = `PreToolUse` hook**（唯一能在 pending 时看到的通道）。
- **JSONL / `PostToolUse` = 权威 resolve / reconcile**，**不**用于发现 pending。

### 1.2 数据流

```
按钮点击 → WS tty:*(set-model/answer-question/respond-permission/interrupt…)
        → host TtyManager(校验锁) → proxy ttyIntent → TuiDriver(读 ScreenModel/注键，闭环) → {ok|fail}
待答发现 → PreToolUse hook → 浮现卡片（不走 JSONL）
ScreenModel.change → tty.controlState → host 合成(+hooks +JSONL) → tty:control-state → 按钮状态
slash 透传 / 键盘 → pty:input(原样)
稳态 model/mode/effort → hooks + JSONL(权威 reconcile)
```

### 1.3 cc-proxy 新增（`packages/proxies/cc-proxy/src/runtime/`）

- **① `ScreenModel`** — 包 `@xterm/headless`，由 `TtyClaudeRuntime.onData` 同一份字节喂入（与 ring buffer 并联）。提供：`findSelector()`（开/选项/高亮/已标记项）、`remoteControlLine()`、`atInputPrompt()`（输入提示符 vs 模态，决定能否 paste）、`change` 事件（重绘 debounce）。
- **② `TuiDriver`** — intent 状态机，依赖 ScreenModel(读) + PTY write(注键)。**per-session 互斥锁**串行化所有 intent + 原始键盘（多问题/多操作不交错的根）。intents 见 §2.3。
- **③ `TtyClaudeService` 扩展** — 新增 `tty.intent` 路由 TuiDriver；新增 `tty.controlState` 通知。`tty.input` 原样保留（实时键盘 + slash 透传）。

### 1.4 host 改动

- **`CcProxyClient`**：加 `ttyIntent(...)`；透 `tty.controlState`。
- **`TtyManager`**（`tty/manager.ts`）：**唯一汇合点**。
  - 合成 `{model,mode,effort,remoteControl,pendingQuestion,running,selectorOpen}` → `tty:control-state` 广播。**删 `detectRemoteControl` 正则**（移进 ScreenModel）。
  - 新增 `setModel/setMode/setEffort/answerQuestion/respondPermission/toggleRemoteControl/interrupt`（**全部带 lock-owner 校验**）。
  - **R2**：删 `toggleRemoteControl` 的 host-trusted 旁路（`manager.ts:364` 现注"no web-owner check"），统一走 owner-checked intent。
- **`stopTurn`**（`manager.ts:433`）：加 `runtime_mode` 分支——结构化→现状 `interruptTurn`；**TTY→走 `interrupt` intent 注中断键**（见 §7.3）。
- **`ws-handler`**：新增 `tty:set-model`/`tty:set-mode`/`tty:set-effort`/`tty:answer-question`/`tty:respond-permission`/`tty:toggle-remote-control`/`tty:interrupt`。`pty:input` 仍管原始键盘 + slash 透传。

### 1.5 web 改动

- 新 `tty:control-state` store；按钮读它、派 intent 消息（非裸 paste）。
- `session-routing.ts` `planApprovalResponseDispatch`：question / 权限弹窗改派对应 intent。
- Stop 按钮可见性改读真实 running（§7.3）。composer slash 透传不变。

### 1.6 边界与可测性

ScreenModel 只读屏；TuiDriver 只经 ScreenModel 读 + write；host 唯一合成 control-state；proxy 不碰 DB/锁。单测：ScreenModel 喂字节断言网格；TuiDriver 喂假 ScreenModel 断言注键序列。

---

## 2. Intent 协议

### 2.1 形状

```
ttyIntent(sessionId, {kind, ...args}) → { ok:true, finalState } | { ok:false, reason, aborted }
```

### 2.2 通用闭环算法

```
acquire(per-session mutex)
前置检查（atInputPrompt / 无残留选择器）
发起命令（注 slash / 快捷键）
轮询 ScreenModel 直到预期 UI 出现     ── 超时 → Esc 中止 → {ok:false}
导航到目标（读高亮，方向键移动）       ── 越界/超时 → Esc → {ok:false}
确认高亮/勾选 → 提交（回车/空格）
确认选择器关闭 / 状态变更
release(mutex) → {ok:true, finalState}
```

失败一律先 `Esc` 收掉半开模态再返回。**绝不留半开选择器。**

### 2.3 intent 清单与按键序列

| intent | 序列 | 确认锚点 |
|---|---|---|
| `setModel(target)` | `/model` 选单 → 读已标记 → ↑↓ 到 target → 回车 | 选单关闭；乐观设值 + JSONL reconcile |
| `setPermissionMode(target)` | **菜单式** `/permission-mode` 选单 → 到 target → 回车 | 下一拍 hook permission_mode 校正 |
| `setEffort(target)` | `/effort` 选单 → 到 target → 回车 | hook effort 校正 |
| `answerQuestion(answers)` | 见 §2.4 | 选择器关闭 + JSONL `toolUseResult.answers` |
| `respondPermission(decision)` | 见 §2.5（A8/A9） | 弹窗关闭 + 回合继续/拒绝 |
| `toggleRemoteControl()` | `/remote-control\r`（owner-checked，R2） | `remoteControlLine()` 状态翻转 |
| `interrupt()` | 注中断键（Esc，精确键 spike 验，见 §7.3） | `Stop` hook / status→done |

### 2.4 answerQuestion 子情形（spike 主靶，含 bug 修复）

- 单问单选：等选择器 → ↑↓ 到目标 → 回车。
- 单问多选：空格逐项 toggle → 提交。
- 一次多问：**实测是多页向导**（顶部 `← ☐Q1 ☐Q2 ✔Submit →` 步进条，一问一页，答完自动翻页，全答完进 `Review your answers → ❯ Submit answers / Cancel` 终页）。驱动＝逐页选 + **终页必须再选 `Submit answers`**（N 问 = N+1 次 commit）。这正是现状 paste 修不好多问题的根因。UI 仍一问一卡（f）。
- Other / 自由文本：选 Other → 进文本框 → 输入 → 提交。
- 取消：Esc → decline。

### 2.5 工具权限弹窗（A8/A9，本轮 scope，e）

Claude 在 Edit/Write/Bash/WebFetch/MCP 等工具前弹权限选择器（与 AskUserQuestion 同为模态选择器，但**布局/选项随工具变**）。intent `respondPermission(decision)`：

- **允许一次**：移到 "Yes" → 回车。
- **允许且不再问**：移到 "Yes, and don't ask again"（allowlist）→ 回车。
- **拒绝**：移到 "No" → 回车。
- **拒绝并写理由**：拒绝分支进文本框 → 输入 → 提交（同 Other 自由文本路径）。
- 现状 TTY 模式把这些"留在终端"；本轮改为 chat 原生闭环（与问题卡同一套机器）。
- **风险**：每种工具的弹窗文案/选项不同 → ScreenModel 识别要按工具归一；spike 至少冒烟一种权限弹窗确认机制可推广（§9）。

---

## 3. 屏幕模型与版本化

- `@xterm/headless` 维护网格 + 光标，与 ring buffer 同源。
- **识别（spike 实测，2026-06-07）**：高亮用 **`❯` 标记**（**非**反色 inverse）；输入框提示符也是 `❯`，故选项必须按 **`❯? N. label` 形状**解析、勿用"行首 ❯"；选择器"在场"判定用**"屏上存在激活 `❯ N.` 选项"**，**勿用 footer 文案**（问句页 footer="Enter to select·↑/↓"，Review 页 footer 不同，会漏判终页）。CJK/宽字符按显示列宽算（A7/D7）。
- **版本化**：固定"已验证 Claude 版本"并 gate（参考 `test/fixtures/claude-code/2.1.159/`）；**golden-capture**：用 live `~/.local/bin/claude` 录真实字节（memory `spike-vs-live-binary`：录制必须用 live 二进制），回放进 ScreenModel 断言注键。识别失败 → **响亮报错，绝不误驱动**（D8）。

---

## 4. 状态观测与合成

- host 汇合三源 → 一份 `tty:control-state`（含 `running`，供 Stop 按钮，§7.3），按钮只读它。
- **乐观 + 权威 reconcile**：intent 成功乐观设值；下一拍 hook（mode/effort）/ JSONL（model）校正。
- 用户在裸终端改的 mode/effort 经 hooks 回流到按钮（B6）。

---

## 5. 错误处理

- intent 超时（~3–5s，可调）→ Esc 中止 → `{ok:false,reason}` → host → toast；**裸 xterm（CLI tab）始终是逃生口**。
- 互斥防交错；版本漂移 fail-loud；PTY 退出 → 中止+清 pending；take over → 中止当前 intent。
- 前置判定"输入提示符 vs 模态"决定能否 paste（防 §6 bug）。

---

## 6. 现状 bug：「Beta 提交问题无法继续」诊断 + 修法

### 6.1 诊断（代码已定位）

根因：**AskUserQuestion 在 TTY 是等方向键选择的模态选择器，现状往它 paste 一段散文 + 回车**，选择器无法当"选第几项"。

链路：`CodingView.handleTranscriptApprove`（`CodingView.tsx:1481`）→ `planApprovalResponseDispatch` → `{channel:'tty', text: formatBetaQuestionAnswers}` → `onBetaSend` → `pty:input{text}` → `pasteMessage`。

证据：① `replay.ts:193-206` 注释已把 paste-back 当 selector-cancel → deny；② claude-code-guide 确认只能 TTY 真实选项回答；③ 前端 `onLocalApprovalResolve`（`CodingView.tsx:1488`）乐观翻牌 → UI 看着答了实则卡住。额外：bracketed paste 以 `\x1b[200~`(ESC[) 开头，喂模态选择器会被读成方向键/Esc。

### 6.2 修法

用 §2.4 `answerQuestion` intent **取代 paste**；`planApprovalResponseDispatch` 改派 intent。保留 PreToolUse 浮现（R1）、PostToolUse 清 pending、退出 synthetic decline。**前端不再盲乐观翻牌**——以 intent 返回 + JSONL `toolUseResult.answers` 为准。

---

## 7. 低风险线（不依赖 ScreenModel，可与 spike 并行先落）

### 7.1 队列补回 Beta（Q1）—— 现状为何没有

队列是 **Gian 自己的 host 侧结构化队列**（`packages/host/src/queue`），web 抽屉走 `queue:*`。**入队运行时无关，但排空只认结构化**：由 `turn.completed`/`turn.failed` → `maybeAutoSendNext` → `sendMessage`（`manager.ts:1265-1278,1343`），TTY 无此通知；且 `sendQueuedNow`（`:916`）/`maybeAutoSendNext`（`:1342`）显式 `tty → 不排空`；Beta composer 忙时禁止提交。

### 7.2 Q1 实现

- 队列数据结构 + web 抽屉 **全复用**。
- 排空运行时感知：结构化→现状；**TTY→收 `Stop` hook 时 `popNext` → `pasteMessage`**（一回合一条，与 `maybeAutoSendNext` 对称）。
- 放开 `:916`/`:1342` 两道挡，改"按 runtime 选通道"。
- Beta composer：忙时 Enter → 入队出 chips，空闲 → 直接发送。
- **(d) `send_now` 语义**：TTY 下 `popNext` 后**立刻 `pasteMessage`，不等 Stop hook**；跑动中由 Claude TUI 当"补充消息"处理（这是唯一刻意依赖 Claude 原生 mid-turn 收消息的地方）。

### 7.3 Stop / 中断（修「不同步 + 无效」）

**诊断**：① 通道错——`session:stop`→`stopTurn`→`interruptTurn`（`manager.ts:440`）打断的是**结构化运行时**，而 Beta 回合跑在 PTY；`stopTurn` 无 runtime 分支，唯一动 PTY 的是 forceRecover（`manager.ts:482-486`，那是"杀进程重置"重锤）。**优雅停止从未接**。② 状态错——Stop 按钮在 Composer `disabled`(=busy‖locked‖pending) 时显示（`Composer.tsx:990`），口径比"真有 turn 在跑"宽 → 该显示时不显示/不该点时可点。

**修法（低风险，注键档）**：
- `stopTurn` 加 TTY 分支 → `interrupt` intent **往 PTY 注中断键**（Claude TUI = Esc；单 Esc / 双 Esc / Ctrl-C 由 spike 顺手验）。确认靠下一拍 `Stop` hook / status→done。
- Stop 按钮可见性改读 `tty:control-state.running`（真实 hook 驱动运行态），只有真在跑才显示并可点。收编 B7。
- 不需要 ScreenModel 选择器闭环，与 Q1 同属低风险线。

---

## 8. 全测试场景目录（A–F）

> "测试场景 = Claude 可能触发的交互"。⚠️ = 现状已知坏/未处理。

### A. 阻塞回合、必须闭环驱动
- A1 单问单选 · A2 单问多选 ⚠️ · A3 一次多问（**一问一卡** f）⚠️ 现状合并
- A4 Other 自由文本 · A5 取消/Esc
- A6 选项超长滚动 · A7 选项含中文/宽字符/emoji
- A8 权限弹窗：允许一次 / 允许且不再问 / 拒绝 / 拒绝并写理由（**本轮 scope** e）
- A9 权限弹窗按工具差异：Edit/Write、Bash、WebFetch、MCP（文案/布局不同）
- A10 Plan 模式 ExitPlanMode：批准 / 继续规划
- A11 `/model` 选单 · A12 `/permission-mode`（菜单式 c）· A13 `/effort`
- A14 目录信任提示 · A15 `--dangerously-skip-permissions` 确认

### B. 非阻塞、观测并反映到按钮
- B1 Remote Control 状态行 ⚠️（现状刮屏易 desync；R2 收进 intent）
- B2 回合生命周期 started/streaming/done/failed
- B3 自动 compaction · B4 限流/用量上限 · B5 错误横幅/网络重试
- B6 用户在裸终端改 model/mode/effort → 按钮跟着变
- B7 "esc to interrupt" 运行态（Stop 按钮，§7.3）
- **B8 停止按钮状态同步**（只在真 running 时显示/可点）⚠️
- **B9 停止真的打断**（注中断键后回合收尾、status→done）⚠️

### C. 透传（不结构化镜像，输出在终端视图）
- C1 任意 `/foo` · C2 `/status` `/config` `/mcp` `/cost` `/help` `/context`
- C3 `/clear` `/compact`（若弹确认 → 落 A 档驱动）· C4 裸键盘 Ctrl-C/Esc/历史/Ctrl-R
- ~~login OAuth~~（出局）

### D. 驱动器时序/边界
- D1 重绘慢→轮询超时 · D2 已停目标值（空操作也干净退）· D3 目标不在列表→失败非误选
- D4 回合中/选择器开着时 intent 到达→互斥排队或拒绝 · D5 驱动中 PTY 退出→中止+清 pending
- D6 驱动中用户同时敲裸终端→串行化冲突 · D7 驱动中 resize 重排→重读网格
- D8 ⚠️ 版本漂移→识别器响亮失败 · D9 输入提示符 vs 模态判定（防 §6 bug）· D10 control-state 广播 debounce

### E. 恢复/一致性
- E1 恢复 host 重启前就挂 pending 问题的会话 · E2 刷新发生在问题进行中→replay 重建且 PTY 选择器仍开
- E3 驱动中被 take over · E4 PTY 退出 synthetic decline 与真实结果一致

### F. 队列 + 停止（低风险线）
- F1 Beta 忙时 Enter→入队出 chips · F2 `Stop` hook→自动 paste 队首
- F3 reorder/remove/clear 在 Beta 生效 · **F4 `send_now`：立刻 paste 进 PTY（补充消息），不等 Stop**（d）
- F5 Beta↔Chat 互切队列不丢 · F6 排空中途 PTY 退出/take over→不丢队列、不乱 paste
- F7 队列里 `/foo` slash→透传语义对

---

## 9. Spike（先行验证，一次性丢弃）

- **目标**：验"对真实 Claude 选择器闭环驱动，稳不稳到当主 UI"。
- **靶子**：A1→A3（AskUserQuestion，含 §6 bug 修法）+ **冒烟一种权限弹窗（A8）**确认机制可推广到 §2.5。
- **做法**：throwaway——`@xterm/headless` + `answerQuestion`(单问/多选/多问) + 一个 `respondPermission` 最小状态机，对 live `~/.local/bin/claude` 跑十几次测命中率，升一个 Claude 版本看识别碎不碎。**不进主代码。**
- **go/no-go**：稳 → 投全量 A；不稳 → 收缩（model/mode/effort 退 `--resume --flag`，闭环只留 AskUserQuestion + 权限弹窗）。

---

## 10. 工作流拆分与风险

- **线 A（高风险，spike 先行）**：闭环驱动层 + §6 问题 bug + §2.5 权限弹窗。过 spike 门槛再投全量。
- **线 B（低风险，可并行先上）**：队列 Q1 + Stop/中断（§7）。立刻补回体感，不依赖 ScreenModel。
- **风险**：版本耦合（D8，最大）；驱动抖动；中心进程负载（方案 A 按会话隔离已缓解）。`@xterm/headless` 进 cc-proxy 依赖（与其 `@modelcontextprotocol/sdk`/`zod` 一致）。

---

## 11. Open questions（剩余，多数交给 spike 验证）

- (a) 稳态值走 hooks/JSONL、屏幕只做驱动反馈 + R1 例外 —— 已采纳。
- (b) control-state 汇合点放 host —— 已采纳。
- (c)(d)(e)(f) —— 见决策记录，已定。
- **剩余待 spike 验证**：
  - 中断键到底单 Esc / 双 Esc / Ctrl-C（§7.3）。
  - 各工具权限弹窗布局差异的归一识别（A9 / §2.5）。
  - `send_now` 在跑动中 paste，Claude TUI 实际是排队还是即时插入（§7.2 d）。
  - Plan 模式 ExitPlanMode（A10）选项布局是否与权限弹窗同构、可复用 `respondPermission`。

---

## 12. Spike 结果（2026-06-07，已验证 → GO）

一次性 spike（`@xterm/headless` + node-pty 起 `~/.local/bin/claude --model haiku`，throwaway，未入库）：

| 场景 | 结果 |
|---|---|
| 单问单选 闭环驱动（读 ❯ → 收敛到目标 label → 回车 → 确认关闭） | **8/8**，0 失败 |
| 一次多问 全流程（逐页驱动 Q1/Q2 + 终页 Submit answers + 关闭，Review 校验所选正确） | **4/4**，0 失败 |
| 出选择器耗时（haiku） | 平均 ~4.8s（2.7–8.7s） |
| 信任提示（A14） | 首次未信任目录会弹，回车接受默认"Yes, I trust this folder" |

**结论：闭环驱动可靠到可当主 UI**，方案 A 与 §6 bug 修法（answerQuestion intent 取代 paste）成立。

**实现必须照搬的硬事实**（已写进 §2.4 / §3）：① 高亮＝`❯` 非反色；② 输入框也用 `❯`，选项按 `❯? N. label` 解析；③ 选择器在场＝有激活 `❯ N.` 选项，勿用 footer；④ 多问＝多页向导，N 问需 N+1 次 commit（含终页 `Submit answers`）；⑤ 导航＝↑/↓ 或 Tab/Arrow，Enter 选，Esc 取消。

**仍待真机/用户**：版本漂移——需切不同 Claude 版本验识别器是否仍命中（spike 在 2.1.168 上做）。权限弹窗（A8）未单独 smoke，但与问题选择器同构、置信度高，留实现期冒烟。
