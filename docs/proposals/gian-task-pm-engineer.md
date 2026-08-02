# 方案:Gian Task —— PM / Engineer / Individual 角色模型 + 横纵上下文 + LLM 自动 loop

> **状态**:**Accepted**（4 轮 Codex review 收敛 + 用户拍板，2026-06-30）。进入 implementation plan（见 `gian-task-implementation-plan.md`）。
> **日期**:2026-06-30　**作者**:Rich + Claude（头脑风暴定稿）
> **范围**:重设计 Task 模式的「角色层 + 上下文层 + 编排层 + skill 注入」。
> **关系**:在 PRD-v3（`docs/PRD-v3-implementation-plan.md`，确立「Subtask 和 Manager 都是 `Session` 变体」）之上，**重写其角色 / 上下文 / 写回 / loop 这几层**；底层 `tasks` 表 + `sessions.task_id` + session 机制基本保留。
> **依赖**:runtime-modes 的 **B 档（claude-TTY）**（见 `docs/runtime-modes/`）是本方案「便宜自动 loop」的前置。

---

## 0. 读这份文档的人

- **Codex reviewer**:重点看 §5（与现状的差异/改动点，已映射到真实文件）、§7（待评审问题）、§8（风险）。§4 是最终方案主体。
- **后续 agent**:§1 需求、§2 讨论轨迹解释「为什么是这样」，避免重新 re-litigate（很多结论是推翻了初版才得到的）。

---

## 1. 需求（要解决什么）

### 1.1 原始诉求（用户提出）

1. **主任务的 LLM 应该是 PM（项目经理）**:不负责具体干活，但有权找人干活（建子任务）、盯流程（感知子任务进度）。正式流程里 PM 只决定「在哪个 workspace 开子任务、交代干什么」，剩下交给子任务发挥。此外用户能把**固化的工作流**委托给 PM，例如「开始开发」→ PM 自动 写码子任务 → review 子任务 → 按 review 返修 → 再 review → …… 直到没明显问题。
2. **子任务的 LLM 是 Engineer**:接任务、干活、写工作报告。
3. **用一个 Gian Task Skill 保证工作计划的交互**:给 Claude 和 Codex 都装；含角色 playbook；Engineer 每轮写工作报告（参考用户自己的 [session-context-skill](https://github.com/RichLogic/session-context-skill)）；skill 还能维护可固化、可自动 loop、需多 LLM 参与的工作流（写方案、开发流程）。

### 1.2 暴露出的真问题（现状痛点）

- **管家话太多、初始化消息又长又自以为是**:PM 上下文天生不全，却被现状逼着替子任务写实现级指令（`create_subtask` 的 `prompt` 字段），子任务一上来就跑偏。
- **新建子任务卡片过度设计**:`<<gian:create_subtask>>` 文本块 → web 解析 → 表单 → 用户点 Create，重且脆（从自由文本里 regex 结构化块）。适合「用户手动建」，不适合「LLM 与用户交互」。
- **没有 loop / workflow**:Task 下是 N 个扁平、无序、无依赖的子任务；没有「一个完成自动拉起下一个」。
- **PM 感知不到子任务**:子任务完成只 `broadcastSessionUpdated` 给 web，**不唤醒 PM**；PM 只在用户下次跟它说话时、靠重建 prompt 里内联的子任务状态才知情。
- **上下文平面混淆**:summarizer 把「子任务的 task 进度」整文件 overwrite 进「workspace 的 `.ai/STATE.md`」，既撞车又串味。

### 1.3 目标

- 角色清晰:PM 只编排、Engineer 只干活、普通会话有自己的默认角色。
- 子任务创建轻量、跨 claude/codex 一致。
- 支持「LLM 驱动的自动 loop」，Gian 在中间搭桥（不写重型状态机）。
- 上下文同时支持「同 workspace 内共享（横向）」和「同 task 内跨 workspace 共享（纵向）」，且**并发安全**。
- skill 合并成一个、双装、**自动隐形**（无需用户显式 slash 触发）。

---

## 2. 讨论轨迹（中间怎么聊的 / 为什么是这样）

按讨论顺序记录关键争点与落点。**标注「修正」的，是推翻了初版结论后才得到的**——别再回头提。

1. **PM 角色 ≈ 现状已有。** 当前 manager 的 system prompt（`task/manager-session.ts`）原文就是 "You are the project Manager … do NOT do the coding work yourself … PROPOSE a Subtask and the user confirms"。所以这不是「重新设计 PM」，是「给已存在的 PM 补缺口」。

2. **「固化 loop 交给 PM 负责」——初版我主张 host 写确定性状态机，被推翻。**
   - 用户反驳:编程形式太重，本质要的是「LLM 自动 loop 工程」。
   - **修正落点**:**LLM 当 loop controller，Gian 只提供三个薄原语**（完成信号唤醒 controller〔后细化:只有 `submit_step` 推进,见 §4A.A〕 / controller 拉起·喂消息子任务 / host 兜底护栏+loop 状态持久化）。流程逻辑活在 PM 脑子 + loop 合同 + skill playbook，**不固化进 host 代码**。

3. **「盯流程」不能轮询。** turn 对外是原子的，跑的时候问不到进度；只能 turn 之间读报告。所以「监盯」= 被动读报告，且需要新建「完成→唤醒 PM」的通道（现状明确没有）。

4. **新建子任务:卡片 → NL + action 信封。** PM 与用户用自然语言敲定参数，然后 PM 发一个 Gian 拦截的 JSON action 块。**手动建仍保留表单**。（**后续修正(讨论)**:这里**不走 MCP/真 tool-call**——改走 Gian 读输出流的 `<<gian:action>>` 信封，见 §4A.A;卡片去掉、文本块机制保留并规范化为统一 action 协议。）

5. **TTY 能不能自动驱动——初版我说不能，被推翻。**
   - 用户反驳:TTY 不阻碍自动化，本质就是「把消息 paste 进去 + 回车」；只有「回答问题时真阻塞」会让 loop 停，而那本来就该用户介入。
   - **修正落点（核对了 `docs/runtime-modes/`）**:**喂输入**=bracketed paste 写 PTY ✓；**观察完成**=Claude Stop hook / Codex JSONL tail ✓；**观察 verdict**=读 engineer 写出的报告文件（**不 scrape 终端**）✓；**真阻塞**=loop 暂停等用户 ✓。**结论:TTY 能扛自动 loop，且吃订阅 quota = 便宜。** 我原来立的「自动化 ⟺ metered」那道墙塌了。

6. **PM 必须是 codex——被推翻。** 现状 `MANAGER_EXECUTOR` 硬编码 codex；但 claude-TTY 也能当 controller（唤醒=paste 进空闲 PTY；动作=发 `<<gian:action>>` 块、Gian 读输出执行，见 §4A.A；便宜=订阅）。**修正落点:PM 可选 claude/codex。**（注:讨论时一度设想 controller 动作走 MCP，后定为不走 MCP 的 action 协议，见 §4A.A。）

7. **runtime 跑道简化。** 用户决定:**claude → TTY（订阅、有 hooks），codex → 正常 proxy**；codex-TTY 是设计遗漏，后续关掉。engineer 的 runtime 跟着 executor 走（沿用路由偏好:实现/修改→claude，review/审计→codex）。

8. **上下文平面冲突（用户发现）。** session-context-skill 是 **workspace 级、单 baton、串行**（STATE 只有一个 current status，且 skill 自己声明「不管 development workflow policy」）；PM/Engineer 是 **task 级、多 agent、并发**。两者天然不同。
   - **落点（横纵模型）**:源文件按 workspace 存（横向 = Plane A，≈ session-context）；task 层是**从 ws 分片聚合出来的视图**（纵向 = Plane B），加上 task-native 的真文件（目标/plan/loop）。
   - **并发**:`一个 session 只写自己的分片`，读时 merge；**MEMORY 例外**（canonical 真相需 curate，单一受控写者，不分片）。
   - 一句话规则:**Agent 只写自己的分片、只读视图;Gian 把分片生成视图。**

9. **角色:INDIVIDUAL 当默认基座。** 用户指出 engineer 当默认逻辑不顺（engineer 是预设了 PM/task 的特化）。**落点:三角色 = 一个基座 + 两个加层**——INDIVIDUAL（默认，≈ 经典 session-context）/ ENGINEER = INDIVIDUAL + 接 brief + 报告给 PM / PM = 编排。

10. **skill 合并 + 自动隐形。** 合并成一个 Gian-skill（session-context 被并入，成为 INDIVIDUAL 角色的行为）；**激活交给 Gian 确定性注入，不靠 model-auto-invoke**（后者概率性、且会漏进非 task 会话）；读上下文靠 agent 原生读文件（省注入、TTY 友好）。

11. **注入清单（用户喊乱）。** 真正注入的只有「一个稳定小角色头 + 几段小数据」；大块 playbook 和 ws 上下文都走「读文件」不走注入 → 注入面有界且小。详见 §4.8。

---

## 2.5 Codex review（2026-06-30）与回应

Codex 评审本提案，7 条 finding **全部接受**（已逐一对照代码核实锚点）。核心结论:**§6 的落地顺序之前，必须先闭一版「Controller & Wake mini-spec」**（见 §4A）——loop 的核心动作（PM 调工具建子任务、host 喂消息给 TTY、感知子任务完成）目前在 host 管道上**全部不可达**。

| # | Finding | 核实 | 落点 |
|---|---|---|---|
| H1 | create_subtask/message_subtask「真工具+auto-approve」不可达:codex `StartTurnParams` 无 host tool 字段（`codex-proxy/core/types.ts:146`）；Claude TTY 只注册 AskUserQuestion 的 PreToolUse（`host/tty/manager.ts:761`）；host **零** MCP/tool 通道（grep `McpServer`/`registerTool` 无命中） | ✅ 属实 | §4A.A（**改走 action 协议,不用 MCP/auto-approve**） |
| H2 | TTY 自动喂消息与现状冲突:`sendMessage` 对 `runtime_mode='tty'` 直接拒绝（`host/session/manager.ts:878`）；无 host-owned automation channel / lock / turn 记录 / 重试 | ✅ 属实 | §4A.B |
| H3 | 「完成 hook 唤醒」语义不清:`completeSubtask` 是用户 `completed_at` 标记（`manager.ts:1302`，migration 027），≠ turn lifecycle（Stop 每轮都触发） | ✅ 属实 | §4A.A（`submit_step` 收口） |
| M4 | 「只写自己分片」是 prompt 约定，非并发安全保证 | ✅ 属实 | §4A.D（降级为 soft convention + host 持有硬保证） |
| M5 | 废 summarizer 后 `sessions.summary`/verdict 来源没补（现由 summarizer 写） | ✅ 属实 | §4A.A（`submit_step` params 写 summary,无需 parser） |
| M6 | RoleInjector 落点缺:TTY hook handler 不返回 `additionalContext`（`host/tty/manager.ts:274`，只更状态/广播）；Codex「首条 wrap」仅对 manager system prompt 生效 | ✅ 属实 | §4A.C |
| M7 | baseline 旧:TTY 其实已部分落地（claude+codex tty manager、`runtime_mode`、`switchRuntime`、migration 027） | ✅ 属实 | §5 / §6 已订正 |

---

## 2.6 Codex review 二轮（2026-06-30）与回应

二轮评审 6 条,**全部接受**(已核实:`--append-system-prompt` 现状 spawn args 确实没用;而 `SessionStart`→`additionalContext` 在 `findings.md:92` 有据)。核心:`<<gian:action>>` 有副作用,动工前必须补一个**小的 action 执行契约**(final-only 解析 / 幂等 / 授权状态 / 错误重试),否则比卡片更容易重复/误执行。

| # | Finding | 落点 |
|---|---|---|
| H1 | 缺幂等:JSONL replay / restart / stream-final 双路 / 重试都可能重复执行 → 重复建子任务 | §4A.A 执行契约 ②(`action_id` + `task_actions` 表 + 状态机) |
| H2 | 授权边界不硬:「PM 输出块」≠「用户授权」,没定义 task 授权了哪些 method/step/ws/round | §4A.A 执行契约 ③(`task_loops` 作授权源;无 active loop 只能 `staged`) |
| H3 | parser 事件源没落准:TTY 不持久化 final text、Codex 是 delta+summary 两路 | §4A.A 执行契约 ①(final-only + 逐 runtime 固定事件源,禁 delta) |
| M4 | §4.5/§4.6 残留旧语义「完成 hook 唤醒」 | 已改:只有 `submit_step` 推进 loop;裸 Stop = idle/needs-submit |
| M5 | RoleInjector 的 `--append-system-prompt` 未验证(现状没用) | §4A.C 改为 **`SessionStart` hook `additionalContext`**(findings.md 有据)+ structured fallback |
| L6 | §5/§8 旧措辞(「NL+工具」「TTY B 档未落地」) | 已清理 |

---

## 2.7 Codex review 三轮（2026-06-30）与回应

三轮评审 6 条,**全部接受**。核实:Codex final text = `assistantText`(所有 `agentMessage.text` 逐字 `join('')`,`service.ts:1188`)——**逐字非改写**,故二轮遗留的"幂等键在 summary 改写下不稳"问题**解除**(§7.1)。本轮把执行契约从 4 条扩到 **8 条**:

| # | Finding | 落点 |
|---|---|---|
| H1 | `staged`(parsed but not executable)缺 UI/API,且与 §4.4 去卡片冲突 | §4A.A 执行契约 ④:confirm/reject 端点 + 轻量确认 chip + 二次校验;§4.4 已对齐 |
| H2 | parser 不能只"找块":Codex final text 是多条 agentMessage 拼接,示例块会误执行 | §4A.A 执行契约 ②:尾部规则(块须为 final text 去尾空白后的结尾) |
| M3 | submit_step 后没保证 report 写完,digest 却带 report 路径 | §4A.A 执行契约 ⑥:report 可选,digest 用 submit_step params;路径仅当存在且 mtime≥turn 起始才进 digest |
| M4 | message_subtask 对 busy/terminal 目标无状态机 | §4A.A 执行契约 ⑤:idle→投递 / active·approval→排队 / blocked→暂停 loop / 终态→failed |
| M5 | `sessions.summary` 写者切换与旧 summarizer 竞争 | §5/§6:落地先停旧 summarizer 的 summary 写,action handler 接管 |
| L6 | workspace 授权缺 canonical 规则 | §4A.A 执行契约 ⑧:解析成 `workspace_id`,allowed_workspaces 存 id |

Codex 结论:把 task_actions schema/API、parser 尾部规则、actor/current-step 校验、message_subtask 状态机写进 §4A 后,**即可进入 implementation plan**。本轮已补齐。

---

## 2.8 Codex review 四轮（2026-06-30）与回应

四轮评审 5 条,**全部接受**(字段级收紧)。Codex 评语:v4 可作 implementation plan 骨架,但开工前把 source_turn_key / queued action / actor-step 授权补成**字段级**契约会更稳——本轮已补。

| # | Finding | 落点 |
|---|---|---|
| H1 | `action_id` 的 turn id 不可直接实现:host DB turn UUID ≠ proxy 原生 turnId,TTY Stop 不持久化 final text/turn key | §4A.A 执行契约 ③:`task_actions` 存 `host_turn_id` + `source_turn_key`,逐 runtime 定义 source(TTY 三选一待定) |
| H2 | 「排队」没落到 status 枚举 | §4A.A 执行契约 ⑤+③:加 `queued` 状态 + drain 规则(目标 turn.completed 由 loop 引擎 drain)+ 复用 `QueueList` |
| M3 | 授权缺 actor/current-step 精确字段(engineer 可能冒发 PM method) | §4A.A 执行契约 ④:加 `current_step_session_id`/`expected_role` + method↔role 硬门 |
| M4 | RoleInjector 把未验证的 structured `--settings` 当首选 | §4A.C:structured 默认改 **prepend 首条消息**;`-p` 现无 `--settings`,SessionStart 仅 TTY 可用 |
| L5 | stale:§7 还问 loop 表 vs JSON、风险还提"Codex summary 改写" | 已清理(§7.5 标已定、风险句改) |

至此设计层 4 轮 review 收敛,findings 已降到字段级实现细节。**结论:进 implementation plan。**

---

## 2.9 设计简化（用户拍板，2026-06-30）

四轮 review 后用户又砍掉三处过度设计 + 定角色名:

1. **合并视图懒生成**:`STATE.view.md` 是**派生缓存**,不在每次分片写时生成。默认**读时按需 + dirty 标记**(有分片变过才在真有人读时重生成);或退化为 turn 边界/每 N 轮/定时。是调参旋钮,不影响正确性。
2. **MEMORY「谁写谁写 + 谨慎 + 防并发」**(取代原"单写者 wrap-up 子任务"——过度设计)。MEMORY 并发本就低(大部分事不值得记)。任何角色判断到长期事实即可写,playbook 管纪律(只记长期真相、不扔破烂);防偶发碰撞用 **atomic write(temp+rename) + `.ai/.history` 备份**,真撞了再上 host-mediated `update_memory` 串行化。⚠️ 注意:agent 用原生 file 工具直接写、不经 host,故纯 host 锁拦不住——atomic+备份是现实底线。
3. **砍掉 `report.md` 必需产物**:loop 只需要 `submit_step` 的 verdict(结构化、在 action 里);要**细节**就让 **PM 按需读 engineer 的 session transcript**(= `read_subtask_transcript` 能力)。`report.md` 变纯可选(engineer 想写人类交接 note 也行,但无依赖)。→ "report 落点"问题消失。
4. **默认角色名 = `INDIVIDUAL`**(超级个体;PM/ENGINEER 不变)。

---

## 3. 概念模型（一图流）

```
平面 A（横向 / workspace）          平面 B（纵向 / task）
repo 的真相，永生，可移植           目标的工作集，随 task 生灭，Gian 原生
─────────────────────────          ─────────────────────────
~/Coding/repoA/.ai/                ~/.config/gian/tasks/<taskId>/
  MEMORY.md      ← canonical          PLAN.md     ← 目标/计划/loop合同+轮次(PM)
  sessions/<id>.state.md  ← 分片      roster.md   ← 子任务花名册(Gian 生成)
  sessions/<id>.report.md ← 分片      views/      ← Gian 生成:卷上各 ws 的 report/state
  log/<id>.log.md         ← 分片
  STATE.view.md  ← Gian 懒生成的 merge 视图(只读;读时按需/turn 边界,非每次写)

角色（三个，一个基座 + 两个加层）
  INDIVIDUAL      coding   只横向            orient ws → 干 → 更新 ws 上下文（≈ session-context）
  ENGINEER  subtask  横向 + 贡献纵向    = INDIVIDUAL + 接 brief + 写 report 分片喂 PM
  PM        manager  纵向 + 读横向      不干活，编排，管 task-native（目标/plan/loop）
```

---

## 4. 最终方案

### 4.1 角色模型

| 角色 | session type | 平面 | 职责 | 不做 |
|---|---|---|---|---|
| **INDIVIDUAL**（默认） | `coding` | 横向 | orient 本 ws → 直接与用户干活 → 收尾写自己的 state 分片、（单写者）curate MEMORY | 无 task/PM/纵向 |
| **ENGINEER** | `subtask` | 横向 + 贡献纵向 | orient（brief 当意图非圣旨）→ 干活 → 写 `report` 分片（含 `结论`）；撞真阻塞就停下问 | 不建子任务（叶子）；不覆盖 canonical MEMORY/STATE |
| **PM** | `manager` | 纵向 + 读横向 | 与用户 NL 对齐 → `create_subtask`/`message_subtask` 编排 → 被唤醒时推进 loop | 不写代码/不写长 brief/不无界跑 loop |

- 角色由 **session type 决定**，Gian 在 spawn 时注入（§4.7）。拿不准默认 INDIVIDUAL（安全:干眼前的活、不乱建子任务）。
- **可移植性不对称**:平面 A 用文件（repo 可能被 Gian 外的裸 agent 打开，文件最通用）；平面 B 用 Gian 原生存储（task 只在 Gian 里才有意义，无需可移植）。

### 4.2 运行时映射

- **claude → TTY**（interactive `claude` in PTY，订阅 quota，有 hooks）。
- **codex → 正常 proxy**（codex-proxy，原生工具通道）。codex-TTY 后续移除。
- **PM 可选 claude / codex**:claude-TTY PM 便宜（订阅）；codex PM 走正常 proxy。两者的 controller 动作都走 §4A.A 的 action 协议（发 `<<gian:action>>` 块，Gian 读输出执行），给个默认即可。
- **engineer runtime 跟 executor 走**:claude engineer = TTY；codex engineer/reviewer = proxy。
- **controller（PM）行动通道**:走 **Gian action 协议**（§4A.A 的 `<<gian:action>>` JSON 信封，**非 MCP**）——claude/codex 一视同仁（都只是"写文本"，Gian 读输出流执行）。不是 tool call，故**无权限弹窗、无 auto-approve 问题**。

### 4.3 上下文模型（横纵 + 分片 + 生成视图）

**核心铁律**:

> **Agent 只写自己的分片（`sessions/<id>.*`），只读视图（`STATE.view.md` / task `views/`）；所有 merge/聚合视图由 Gian 生成；MEMORY 例外——单文件、单受控写者、deliberate merge。**

（⚠️ 评审修正:上面这条是 **soft convention**，sandbox 拦不住 agent 写别处。并发安全的**硬保证**在 host——视图只由 host 生成、MEMORY 单写者、分片 atomic write。详见 §4A.D。）

- **分片化**（并发安全，一文件一写者）:`sessions/<id>.state.md`（我的当前状态）、`sessions/<id>.report.md`（我这轮干了啥 + `结论`）、`log/<id>.log.md`（append-only）。
- **生成视图**（Gian 在每次完成后重生成）:`STATE.view.md`（横向 merge）、task `views/`（纵向 rollup，软链或合并文件，二选一—— 软链保留 per-ws 结构、合并文件更简单；**当成 Gian 维护的缓存，不让 agent 手维护**）。
- **MEMORY（canonical）**:repo 长期真相，单文件。**并发本就低**(大部分事不值得记)——**谁判断到长期事实谁写**,playbook 管纪律(只记长期真相、不扔破烂);防偶发碰撞用 **atomic write + 备份**(见 §2.9 第 2 条、§4A.D)。loop 中途多数 engineer 不会碰。
- **task-native**:`PLAN.md`（目标/计划/loop 合同+轮次，PM 维护）、`roster.md`（Gian 生成）。这些**不是 ws 文件的聚合**，软链覆盖不到，必须有 task 自己的家。
- **跨 ws/task 的料一律由 Gian 注入精简 digest**，不让 agent 去 browse task 目录（cwd/`--add-dir` 权限 + token 成本）。agent 原生只读自己 ws 的视图。
- **残留边界**:两个不同 task 同改一个 repo → 平面 A 单 baton 争用 → 走 **worktree 隔离**（host 已有 worktree 概念）。单 task 内 dev-loop 本来串行，不受影响。

### 4.4 子任务创建

- **PM 路径（NL 对齐 + action 信封）**:PM 与用户自然语言对齐（哪个 ws / 谁 / 目标）→ 发一个 **`<<gian:action>>` 块**（见 §4A.A），Gian 读到即建:

  ```
  <<gian:action>>
  {"method":"create_subtask","params":{"workspace":"<名或绝对路径>","executor":"claude|codex","brief":"<意图,非实现:目标/为什么/边界/去哪看>","name":"<短标题>"}}
  <</gian:action>>
  ```

  - `brief` = 意图，不是长实现指令（信号:对应原 `prompt` 字段，刻意改名）。
  - **不走 MCP/真 tool call**，就是 Gian 拦截输出的 JSON 信封（详见 §4A.A）。旧的 `<<gian:create_subtask>>` 提议块（喂卡片）由统一的 `<<gian:action>>` 执行信封取代。
- **路由默认**:实现/修改 → `claude`；review/审计 → `codex`（沿用 MEMORY 偏好）。
- **无 active loop 的 LLM 路径**:action 落 `staged` → **轻量确认 chip**（[确认][拒绝]，非旧多字段表单；端点 + 二次校验见 §4A.A 执行契约 ④）。这是日常无-loop 模式的默认交互,取代旧卡片。
- **手动路径**:用户自己建子任务的**表单保留**（只去掉"LLM 提议 → 卡片"那条重链路）。

### 4.5 Loop / Workflow

- **loop 合同（开 loop 前一次性确认）**:几步 / 每步 ws+executor / 退出条件 / 最多几轮。写进 `PLAN.md`。
- **执行**:PM 当 controller，被子任务的 **`submit_step`** 唤醒（**只有 `submit_step` 推进 loop;裸 Stop = idle/needs-submit,不推进;`completed_at` 是用户正交标记,也不推进**），每次决定下一步（`message_subtask` 返修 或 `create_subtask` 下一步）。**轮数/预算上限由 host 兜底**，PM 尊重「已到上限」信号。
- **三个出口**:① reviewer `结论=通过` → 停 + 回报用户；② 到上限未过 → **问用户「再来一轮?」**（不自动放弃）；③ engineer 撞真阻塞 → 暂停 loop，交还用户。
- **verdict 锚点**:reviewer 的报告结尾必须明确 `结论: 通过 / 需修改 + 要点`（轻量约定，非重型结构化块），PM 据此决定是否继续。
- **loop 永远可见可杀**:host 落库 loop 状态（轮次/当前步/状态），UI 可见、用户可停。

### 4.6 Hook / 唤醒机制

- **新增**:子任务的 **`submit_step` action** → 唤醒 controller（PM）。**不是裸 Stop（每轮触发,太频）、不是 `completed_at`（用户标记）**——只有 `submit_step` 推进 loop;Stop without submit_step = idle/needs-submit。基底是现成的 `manager.ts` `onEvent` 订阅机制（现 IM router 在用），挂一个新订阅者即可。
- **唤醒载荷 = 精简 digest**（子任务 + `submit_step` 的 verdict/headline/points + loop 轮次），**不是全 transcript**（PM 上下文保持精简）。要细节 → PM 按需读该 subtask 的 session transcript（见 §2.9 第 3 条）。
- **只唤醒「由 PM/loop 创建并标记 notify」的子任务**；手动建的默认不唤醒（避免噪音/费用）。
- **唤醒实现**:对 codex/structured PM = `sendMessage` 合成一轮；对 claude-TTY PM = 在其空闲（Stop hook 确认）时 paste digest + 回车，**串行化**避免与用户输入抢 PTY。
- 这一个 hook 是后续功能的拱心石:全部子任务完成→PM 自动汇总回报、某子任务 error/卡住→PM 重 brief 或升级、子任务间依赖等，都骑在它上面。

### 4.7 Skill 打包与激活

- **一个 Gian-skill**，三个角色文件:`individual.md` / `engineer.md` / `pm.md` + `SKILL.md`（总则路由）。这是**重造的 context 引擎**（分片+横纵+生成视图），session-context 是其祖先，INDIVIDUAL 角色复现其经典行为。
- **双装**（有先例:用户的 session-context-skill 仓库本就 `.claude/skills/` + `.agents/skills/` + plugin marketplace 双份）。
- **激活 = Gian 确定性注入，不靠 model-auto-invoke**:
  - 原因:engineer「每轮 orient + 收尾写报告」是必须发生，不能靠模型心情；去掉 `disable-model-invocation` 还会漏进非 task 会话。
  - host 知道 session type → **只给对应会话**注入角色头（§4.8）；agent 自己用原生 file 工具读 playbook 文件（一次）+ 读本 ws 视图（每轮）。
  - **读不靠注入**:省 token，TTY 也原生可读。

### 4.8 注入逐字清单（这是 Codex 要逐条看的）

**注入面有界且小**:每会话仅 ① 一个稳定角色头；②④ 是按需小数据；③⑤ 是 PM 自己写的话。playbook 与 ws 上下文走「读文件」不走注入。

| # | 时机 | 给谁 | 内容 | 大小 | 通道 |
|---|---|---|---|---|---|
| ① | session spawn | 所有会话 | ROLE 头 | 极小 | Claude:system(structured)/SessionStart hook(TTY)；Codex:首条 wrap |
| — | agent 自读 | — | skill 的 `<role>.md` 全文 | 中 | **文件，非注入** |
| — | agent 自读 | — | 本 ws `MEMORY.md`/`STATE.view.md` | 中 | **原生 file 读，非注入** |
| ② | PM 首轮/刷新 | PM | task digest | 小 | 同① |
| ③ | engineer spawn | engineer | brief（PM 写的意图） | 小 | 首条消息 |
| ④ | 完成唤醒 | PM | 完成 digest | 小 | 合成一轮 / paste |
| ⑤ | loop 返修 | engineer | `message_subtask` 文本 | 小 | paste(TTY)/sendMessage(proxy) |

**逐字内容**（`<<gian:...>>` sentinel 仅在 Codex「预置首条消息」路上用于从显示里剥除；Claude 走 system/hook 通道不进可见对话，无需剥）:

**① ROLE 头**（三变体，唯一每会话必注入）:
```
<<gian:role>>
ROLE: ENGINEER                 # 或 PM / INDIVIDUAL
TASK: 给 repoA 加 X 功能         # PM/ENGINEER 有；INDIVIDUAL 无
WORKSPACE: ~/Coding/repoA
REPORT_PATH: ~/Coding/repoA/.ai/sessions/<id>.report.md   # ENGINEER/INDIVIDUAL 写自己分片
→ 按 gian-task skill 的 <role>.md 行事：开场 orient（读本 ws 的 .ai/ 视图），收尾只写自己的分片。
<</gian:role>>
```

**② PM task digest**:
```
<<gian:task-digest>>
目标: ...
PLAN: <loop 合同 + 当前第 N/M 轮>
ROSTER:
  - engId [claude/repoA] 进行中 · 上次结论 ...
  - revId [codex/repoA] 完成   · 结论 需修改(要点 ...)
<</gian:task-digest>>
```

**③ engineer brief**（PM 写的数据本体，作首条消息；模板见 pm.md）:
```
目标:   <一句话，完成长什么样>
为什么: <一句话，意图——让 engineer 能自己权衡>
边界:   <别碰什么 / 硬约束>
去哪看: <.ai/、具体文件或目录、相关子任务报告>
```

**④ 完成唤醒 digest**:
```
<<gian:subtask-done>>
revId [codex/repoA] 完成。结论: 需修改。要点: ...
报告: ~/Coding/repoA/.ai/sessions/<revId>.report.md（要细节自己读）
loop: 2/3。请决定下一步。
<</gian:subtask-done>>
```

**⑤ loop 返修**:PM 写的修改要点文本（数据，无模板）。

### 4.9 工作流走查（拿目录跑一遍）

**INDIVIDUAL**（默认）:repoB 开会话 → 注入 ROLE: INDIVIDUAL → orient 读 `repoB/.ai/{MEMORY,STATE.view}.md` → 与用户干活 → 写 `repoB/.ai/sessions/<sid>.state.md`，单写者直接 curate MEMORY → Gian 重生成 `STATE.view.md`。无 task/PM/纵向。

**Task + dev-loop**:
0. 建 Task → PM spawn（注入 ROLE: PM + task digest）→ NL 敲定 loop 合同 → 写 `tasks/<id>/PLAN.md`。
1. PM `create_subtask(repoA, claude, brief)` → Gian 建 engId、起 claude-TTY、注入 ROLE: ENGINEER（带 REPORT_PATH）、paste brief。
2. engineer:orient（读 ws 视图，brief 当意图）→ 写码 → 写 `sessions/<engId>.{state,report}.md`（不碰 MEMORY）→ Stop hook → Gian。
3. Gian:重生成 `STATE.view.md` + task `views/` → 唤醒 PM（注入完成 digest）。
4. PM:码写完 → `create_subtask(repoA, codex, "review engId 改动")` → Gian 起 revId（codex proxy）。
5. reviewer:orient（+ engId report）→ 评 → 写 report 分片 `结论: 需修改 + 要点` → Gian 善后 + 唤醒 PM。
6. PM:未到上限 → `message_subtask(engId, "修: 要点")` → Gian resume engId TTY、paste；host 轮次++。
7. 循环直到 ① 通过（PM 停 + 回报 + 触发收尾:单写者 curate repoA `MEMORY.md`、`PLAN.md` 标 done）/ ② 到上限问「再来一轮?」/ ③ 真阻塞暂停交还用户。

---

## 4A. Controller & Wake mini-spec（前置闭环，必须先定）

> Codex review 后新增的**前置工作项**:loop 的核心动作目前在 host 管道上**全部不可达**。A–D 不闭，§6 不能开工。
> **设计修正(讨论后)**:agent→Gian 的动作**不走 MCP**,走「Gian 拦截 agent 输出的 JSON action 信封」(function-calling 思路,传输层是 Gian 读输出流)。这把原 H1(工具可达)/H3(完成契约)/M5(report 来源)**塌成同一个 action 协议**(下面 A),auto-approve、Codex-MCP 分叉、独立 report parser 全部消失。

### A. Gian action 协议（闭 H1 + H3 + M5）

agent 在输出里发一个 JSON 信封,Gian 的输出 watcher 解析并执行。**不是 MCP、不是真 tool call**——所以无权限弹窗、无 auto-approve、Claude/Codex 一视同仁(都只是"写文本",现状管家本就这么发块)。

**信封**(JSON-RPC 式 `method`+`params`,一种动作一个 method):
```
<<gian:action>>
{"method":"create_subtask","params":{"workspace":"repoA","executor":"claude","brief":"...","name":"加X功能"}}
<</gian:action>>
```

**三个 method = controller 的全部动作面**:

| method | 谁用 | params | 语义 |
|---|---|---|---|
| `create_subtask` | PM | `workspace`*, `executor`("claude"\|"codex")*, `brief`*, `name`? | 建子任务(NL 已对齐 / loop 合同已授权后 Gian 直接执行,**不再弹卡片**) |
| `message_subtask` | PM/loop | `subtask_id`*, `text`* | 给已有子任务喂消息(返修复用其上下文) |
| `submit_step` | engineer | `status`("done"\|"blocked")*, `verdict`("pass"\|"changes"\|null), `points`?, `headline`* | 显式声明"这步做完",**自带 verdict** → 既是完成信号(H3),又是 loop 决策数据(M5) |

**让文本解析变稳的约定**:
1. **一轮一个 action,放该轮最后一条消息里**。TTY 下 Gian 只能从 Stop hook 的 `last_assistant_message` 抓到,不放最后就丢。structured 模式无所谓,统一按此。
2. **无同步返回值**(不是真 tool call)。Gian 执行后,需回传的东西(新 `subtask_id`、错误)走**下一次注入**(task-digest / 错误提示),不在本轮返回。契合 fire-and-wake 异步模型。
3. **Gian 校验 params**,缺字段/格式错 → 注入"字段缺失,请重发",让 agent 重试(补文本解析的脆弱)。
4. **只认裸 `<<gian:action>>` 块**;包在 ``` 代码围栏里的当示例忽略(防模型举例误触发)。
5. **块从用户显示里 strip**(复用现成 sentinel strip / `showManagerRaw`)。

**完成语义(H3,由 `submit_step` 收口)**:loop 引擎按 `submit_step` 推进,**不按裸 Stop**(Stop 每轮都触发,太频)。Stop 但没 `submit_step` = engineer 中途让出 → host nudge「继续还是提交?」或等待。与用户的 `completed_at`(migration 027,UI 手动标完成)**解耦**——那是正交动作,不驱动 loop。

**verdict/report 来源(M5,由 `submit_step` params 收口)**:Gian 从 action 本身就拿到 `verdict`/`points`/`headline` → 写 `sessions.summary`(复用该列,**写者从 summarizer 改为 action handler**)→ 喂 roster/task digest + loop 决策。**不再需要独立的 report 文件解析器。** `report.md` **砍成纯可选**(见 §2.9 第 3 条):loop 跑在 `submit_step` verdict 上;要细节 → PM **按需读 engineer 的 session transcript**(`read_subtask_transcript`)。engineer 想写人类交接 note 也行,但**无任何依赖**。

> **per-task 隔离**:Gian 执行 action 时按发起 session 的 `task_id` 鉴权(`create_subtask` 只建在本 task 下、`message_subtask` 只发给本 task 的子任务),manager A 碰不到 task B。
> **授权闸**:`create_subtask` 不逐次确认——真正的闸是 **loop 合同(PM 与用户预先 NL 确认)+ host 预算/轮数兜底**(具体校验见下「执行契约 ③」)。

**执行契约（二/三轮 review 后定稿，8 条）** —— action 有副作用,以下不补,`<<gian:action>>` 会比卡片更容易重复/误执行:

1. **只在 turn 终态边界解析,禁 streaming delta。** 事件源逐 runtime 固定:**Claude structured** = turn 终态的完整 assistant text;**Codex** = `turn_completed` 的 `assistantText`(= 所有 `agentMessage.text` 逐字 `join('')`,`codex-proxy/core/service.ts:1188`，**逐字、非改写摘要**);**Claude TTY** = `Stop` hook 的 `last_assistant_message`。delta/中间消息不解析。⚠️ 现 TTY hook handler 不持久化 final text(`tty/manager.ts`),要扩成 Stop 时取 `last_assistant_message` 交 parser。
2. **尾部规则(防把"示例块"当真执行)。** Codex final text 是多条 agentMessage **无分隔拼接**——模型可能先举一个 action 示例、后接正文,即使不在代码围栏也会被"找块"式 parser 命中。**规则:只接受「final text 去尾空白后,正好以一个完整 `<<gian:action>>…<</gian:action>>` 结尾」**;块后还有非空白正文 → 视为示例,不执行(可注入"要执行请把 action 放回复末尾")。配合"一轮一个 action"。
3. **幂等（含 turn key 落地）。** `action_id = hash(session_id + source_turn_key + payload_hash)`。⚠️ **turn id 有两个、别混**:host 自己的 DB turn UUID(`host_turn_id`)+ runtime 原生的 **`source_turn_key`**(parser 真正解析自哪条 assistant 输出)。`task_actions` 两个都存:`{action_id PK, task_id, session_id, host_turn_id, source_turn_key, method, payload_hash, status(parsed|validated|staged|queued|authorized|executing|done|failed|rejected), result(如 new subtask_id), created_at}`。**`source_turn_key` 逐 runtime 定义**:Codex = `turn_completed.turnId`(`service.ts:1221`);Claude structured = stream-json 的 assistant message/turn id;Claude TTY = JSONL message id / transcript offset / hook sequence **三选一(待定,§7)**,且 Stop handler 要把它连同 final text 一起持久化(现在两者都不持久化)。执行前查表,已终态 → 跳过(no-op)。挡 JSONL replay、restart 重解析、stream/final 双读、重试注入导致的**重复建子任务**。
4. **授权 + `staged` 生命周期(`task_loops` 作授权源)。**「PM 输出块」≠「用户授权」。新增 **`task_loops`** = 授权上下文:`{task_id, status(active|paused|done), allowed_methods, allowed_workspaces(workspace_id), allowed_executors, round, max_rounds, current_step, current_step_session_id, expected_role}`(由 §4.5 loop 合同填充)。**method↔role 硬门**(防越权):`create_subtask`/`message_subtask` 仅 **PM(manager session)** 可发;`submit_step` 仅 **engineer(subtask session)** 可发,且发起 session_id 必须 = 当前 step 的 `current_step_session_id`(挡 engineer 冒发 PM method、PM 伪造 submit_step)。三条创建路径:
   - **active loop 内 + 过校验**(allowed_methods/workspaces/executors + round budget + current_step) → 直接执行(无 UI 闸)。
   - **无 active loop / 越界** → 落 `staged`,**不是死路**:host 暴露 **`POST /api/tasks/:id/actions/:action_id/{confirm,reject}`** + UI 一张**轻量确认 chip**(「PM 想 create_subtask X @repoA 用 claude」[确认][拒绝]，**非旧多字段表单**)。confirm → **二次校验**(workspace 存在等)后执行;reject → `rejected`。**这就是日常无-loop 模式的默认交互**(PM 发块 → 用户一键确认),取代旧卡片。
   - **手动** → 用户自己填表单(§4.4 保留)。
5. **`message_subtask` 目标状态机。** 现 `sendMessage` 对 active turn 直接拒;loop 不能拒,要统一转移。按目标 session 状态:**idle** → 投递(TTY paste / structured sendMessage),action `executing`→`done`;**active turn / pending approval** → action 落 **`queued`**(不打断),目标 `turn.completed` 回 idle 时由 loop 引擎(订阅目标完成事件)**drain** 投递;**真阻塞(blocked)** → **暂停 loop 交还用户**(= loop 出口③);**completed_at / worktree finalized(终态)** → action `failed` + 注入"目标已关闭",controller 决定(如另建子任务)。queued action 仍按 `action_id` dedup(重解析不重复入队);可复用现有 queue manager(`QueueList` / send-now 那套)。
6. **`submit_step` 与 report 解耦。** `report.md` 是**可选**人类详情,host **不依赖**它驱动 loop——digest 用 `submit_step` 的 `headline/verdict/points`。`report_path` 仅当**存在且 mtime ≥ turn 起始**才校验通过并放进 digest;缺失/陈旧 → 不进 digest,不报错。
7. **错误/重试。** 校验失败 → `failed` + 注入"字段缺失,请重发",下轮重发(新 turn = 新 action_id);授权拒 → `rejected`,不自动重试;执行失败 → `failed` + 注入错误,可重试。dedup 认确定性 id,故同一 turn replay 不重跑。
8. **workspace 规范化。** action 的 `workspace`(名或绝对路径)在校验时解析成 canonical **`workspace_id`**;`task_loops.allowed_workspaces` 存 `workspace_id`;保留"workspace 名唯一"。

### B. Host-owned TTY automation channel（闭 H2）

现状:`sendMessage` 拒绝 tty；`ttyMgr.input` 能写 PTY 但无托管。决策:新增**独立于用户输入的 host 自动化通道**（如 `automatedInput(sessionId, text, {reason})`）:

- 前置:取 TTY lock + 确认 idle（见过 Stop、无 pending question）才写；否则**排队或暂停 loop**，绝不与用户抢 PTY。
- 写:bracketed-paste + CR，经 `ttyMgr.input`。
- 记:落一条 synthetic turn（审计可见「Gian 喂了:…」）。
- 错:busy/locked/dead PTY → 返回错误，loop 引擎处理（退避重试 / 升级给用户）。
- **不改 `runtime_mode`**:结构化路径的 `sendMessage` tty-reject 保持不变，automation 是 host 内部独立通道。

### C. RoleInjector（闭 M6）

一个 runtime-aware 注入器，覆盖 structured/TTY × Claude/Codex × spawn/resume:

- **Claude TTY**:**`SessionStart` hook 返回 `additionalContext`**（`findings.md:92` 有据;TTY **确实**加载 `--settings`,`tty-claude-runtime.ts:319`）。在 settings 注册 `SessionStart` → handler 返回 ROLE 头(`source`=startup/resume 都触发,覆盖 resume)。⚠️ 现 handler 只改状态/广播、不返回 `additionalContext`(`tty/manager.ts`),需扩。
- **Claude structured（`-p`）**:**默认 = prepend 到首条消息**（管家今天就这么注 system prompt）。⚠️ 现 `claude -p` args **没有 `--settings`**(`claude-mcp-runtime.ts`),所以 SessionStart 注入在 structured **不可用**;若要统一走 SessionStart,需另立"给 `-p` 加 `--settings`"工作项(待验)。
- **（修正:原写的 `--append-system-prompt`、以及"structured 也走 --settings"经核实现状均未用,弃。）**
- **Codex**:把现有「首条 wrap」从 manager-only 扩到所有 task 会话，注 sentinel 包裹的 ROLE 头。
- **resume / 已有 session**:每次 spawn/resume 重注那一小段 ROLE 头（极小、幂等）。

### D. 分片安全性:soft convention + host 持有硬保证（闭 M4）

「agent 只写自己分片」是 **soft convention**（prompt 级，sandbox 拦不住）。**硬保证在 host**:① 视图文件**只由 host 生成**（agent 从不写视图）；② MEMORY 并发低 → **谁判断到长期事实谁写**(playbook 管纪律) + atomic write + `.ai/.history` 备份防偶发碰撞,真撞了再上 host-mediated `update_memory` 串行化(见 §2.9 第 2 条)；③ 分片写用 atomic write（temp+rename），host 可检测/忽略越界编辑。安全来自「host 持有 merge + canonical」，不是「sandbox 把 agent 关进分片」。

---

## 5. 与现状的差异 / 改动点（映射到真实文件，供 Codex 对照）

| 模块 | 现状 | 改动 |
|---|---|---|
| `host/src/task/manager-session.ts` | `MANAGER_EXECUTOR='codex'` 硬编码；`buildManagerSystemPrompt` 内联 PM prompt | PM 可选 executor；PM prompt 改为 §4.8 的 ROLE 头 + 引 `pm.md`；逐轮重建的内联子任务元信息 → 改为 §4.8② task-digest（精简） |
| `host/src/session/manager.ts` | `ensureManagerSession` 强制 codex/plan；`completeSubtask`→`runSummarizerInBackground`；`onEvent` 仅 IM router 用；子任务完成不唤醒 PM | 子任务完成 → 经 `onEvent` 唤醒 PM（§4.6）；新增 loop 状态机的薄编排（拉起/喂消息/护栏，**非业务逻辑状态机**）；新增 `message_subtask` |
| `host/src/task/summarizer.ts` | 读 `.ai/STATE+HANDOFF`，LLM hook **或** template（template 是 active，真 LLM 是 P4-live TODO「小模型+凭据」未决），**overwrite** STATE/HANDOFF | **大改**:不再 host 端 LLM 总结、不再 overwrite ws STATE；改为「engineer 自写 report 分片 + Gian 从分片**生成视图** + 收尾单写者 curate MEMORY」。**P4-live「小模型+凭据」TODO 直接作废**（engineer 自报告）。⚠️ **写者竞争**:旧 summarizer 也写 `sessions.summary` → 落地时先停其 summary 写,由 action handler(`submit_step`)接管,避免异步覆盖 |
| `shared/src/manager.ts` | `parseCreateSubtaskProposal` + `<<gian:create_subtask>>` 文本块 | `<<gian:create_subtask>>` 提议块（喂卡片）→ 统一 `<<gian:action>>` 执行信封（§4A.A）；加 `message_subtask`/`submit_step` method；strip 逻辑保留 |
| `web/src/views/TasksView.tsx` | 文本块 → `NewSubtaskForm` 卡片（LLM 提议路径） | LLM 路径改 **NL 对齐 + `<<gian:action>>` 信封**（卡片只留**手动建**路径；无 active loop 时 `staged` action 仍可弹一键确认） |
| `host/src/web/app.ts` | `POST /api/tasks/:id/subtasks` | action handler（解析 `<<gian:action>>`）落到同一创建链路；增 loop 控制端点（start/stop/status） |
| `host/src/workspace/ai-scaffold.ts` | `.ai/` 脚手架（STATE/HANDOFF/MEMORY/SESSION_LOG 单文件） | 重设计为 §4.3 布局（`sessions/` 分片 + `STATE.view.md` 生成视图）；新增 task 目录脚手架 |
| `shared/src/events.ts` | 有 `turn_completed` 等 | 唤醒复用现有事件，无需新事件类型（host 内部订阅） |
| DB | `tasks` 表、`sessions.task_id`、`sessions.summary`（025/026） | 复用 `sessions.summary` 作 digest headline；新增 `tasks.plan TEXT`；新增 **`task_loops` 表**（授权源:status/allowed_methods/workspaces/executors/round/max_rounds/current_step）；新增 **`task_actions` 执行表**（action_id PK/method/payload_hash/status，幂等，见 §4A.A 执行契约） |
| skill | 无 spawn 注入；`SkillInputItem`（codex）存在 | 新增 `gian-task` skill（3 角色文件）；Gian spawn 时确定性注入 ROLE 头（§4.7） |
| runtime | **TTY 已部分落地**:claude+codex `tty/manager.ts`、`runtime_mode`、`switchRuntime`、PreToolUse(仅 AskUserQuestion)、migration 027 | 自动 loop 仍缺:host action 协议（解析+执行 `<<gian:action>>`）+ host-owned TTY automation channel + RoleInjector（见 §4A）；codex-TTY 后续移除 |

---

## 6. 依赖与排期

> **评审修正**:TTY 已部分落地（见 §5）；缺的是自动 loop 所需的 host action 协议 / host-owned input。**先闭 §4A mini-spec，再按下面开工。**

0. **【前置】闭 §4A**:Gian action 协议（解析 + 执行 + 校验 `<<gian:action>>`）、TTY automation channel、RoleInjector、分片安全。**这一步不闭，下面全部不可达。**
1. 上下文模型（分片 + host 生成视图，先在 INDIVIDUAL 上验，最小风险）。
2. RoleInjector（§4A.C）+ action 协议落地（`create_subtask`/`message_subtask`/`submit_step`，§4A.A）。
3. `submit_step` 收口完成语义 + 写 `sessions.summary`（§4A.A）→ host 感知步骤完成（**同时停掉旧 summarizer 的 summary 写,避免竞争**）。
4. 完成 → 唤醒 PM（§4.6，复用 `onEvent`）。
5. loop 编排 + 护栏 + host-owned TTY automation（§4A.B）。
6. 切 TTY 省钱（移除 codex-TTY）。

---

## 7. 待评审问题

> 三轮 review（§2.7）后,execution 契约扩到 **8 条**（含尾部规则 / staged 生命周期 / message_subtask 状态机 / workspace 规范化）。**Codex 评语:这四项写进 §4A 后即可进 implementation plan——已补齐。** 以下为仍需用户拍板:

1. ~~幂等键稳定性~~ **已解**:核实 Codex final text = `assistantText` 逐字拼接(`service.ts:1188`,非摘要改写),`hash(session+turn_id+块文本)` 稳。
2. **TTY automation 抢占**（§4A.B）:idle 判定 + 排队/暂停的具体规则。
3. ~~视图物化~~ **已定**:host **生成合并文件**(懒生成),不用软链(§2.9 第 1 条)。
4. ~~MEMORY 写者~~ **已定**:谁判断到长期事实谁写 + atomic/备份(§2.9 第 2 条)。
5. ~~loop 状态落点~~ **已定**:`task_loops` 表（见 §4A.A 执行契约 ④）。
6. ~~report 落点~~ **已定**:`report.md` 砍成可选（loop 跑 `submit_step` verdict，细节 PM 按需读 transcript，§2.9 第 3 条）;若 engineer 选择写,落 ws。
7. ~~角色名~~ **已定**:默认角色 = `INDIVIDUAL`（超级个体;PM/ENGINEER 不变）。

---

## 8. 风险

- **成本/失控 loop**:claude engineer 在 `-p`（TTY 落地前）= metered；自动 loop 一句话触发一串花费。缓解:loop 合同上限 + host 预算兜底 + 预检确认。
- **PM 上下文膨胀**:多轮唤醒累积。缓解:唤醒载荷只放精简 digest，工作记忆在文件。
- **action 重复 / 误执行**:幂等表(`task_actions`,确定性 `action_id` = session+source_turn_key+payload_hash)+ `task_loops` 授权(method↔role 硬门)+ final-only+尾部规则解析,三者兜底（§4A.A 执行契约）。幂等键稳定性已验(Codex final text 逐字拼接,§2.7)。
- **软链脆弱**（若选软链物化）:见 §7.3。
- **TTY 输入交错**:见 §7.2。
- **并发同 repo**:两 task 同改一 repo 的 baton 争用 → worktree 隔离。
- **TTY 部分落地,但 action 执行契约 / automation channel / RoleInjector 未落地**:排期风险，见 §6。

---

## 9. 落地后要回写的 Gian 文档（按 AGENTS.md 协议）

- 锁定的决策 → 抽成 ADR（`docs/adr/`）:角色模型、横纵上下文、claude→TTY/codex→proxy、LLM-loop-controller。
- `docs/ai/MEMORY.md`:新增不变量（三角色、横纵分片规则、runtime 跑道）。
- `docs/quality/traceability.md`:需求↔代码↔测试映射。
- 本 proposal accept 后标 `状态: Accepted` 并链接对应 ADR。
