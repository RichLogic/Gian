# 设计：管家可建子任务 + 子任务完成态独立 + 任务列表/状态指示重做

- 日期：2026-06-28
- 状态：已与用户逐块对齐（含状态图标视觉定稿）→ Codex review R1（7 项）+ R2（6 项）已纳入，见各 `【review #N】` / `【R2 #N】`→ 待用户最终评审 → writing-plans
- 触及敏感区：是（管家 = codex-proxy 会话沙箱；见 `docs/runtime-modes/`、`packages/proxies/codex-proxy`）
- 关联：推翻 PRD-v3 §A1（管家只读 + 无结构化回传）；现状 bug「子任务跑完一个 turn 就被标记成完成」
- 视觉参照：`docs/superpowers/specs/assets/2026-06-28-status-icon-prototype.html`（最终 v8 原型，可直接 `open`）

## 决策记录（本轮拍板）

| 编号 | 决策 |
|---|---|
| A. 管家权限 | 从「硬锁只读」改为**可写**：`type==='manager'` → codex `sandbox:'workspace-write'` + `approvalPolicy:'never'`（cwd 仍是 root workspace `~/Coding`，跨全部项目） |
| A. 建子任务通道 | codex-proxy 给管家用 **app-server 结构化协议**；`StartTurnParams` 无 host 工具 schema 字段，codex 外部工具走 MCP（proxy 未配置）→ 本轮取低风险：管家产出 **ASCII sentinel 结构化块** → web 解析 → **内联确认卡**（可编辑）→ 确认后走 `POST /api/tasks/:id/subtasks`。管家不自建。 |
| A. 首条 prompt（review #1 / R2 #1·#2·#5） | prompt **留在 web 侧**，复用现有首消息路由 `planCreatedSessionFirstMessage` 投递（Claude→TTY `pty:input` **billing-safe**、Codex→结构化）；**不加后端/shared 字段**、不用 host `sendMessage`；等 `session:created` 到达再投递。见 §A3。 |
| B. 完成 guard（review #5 / R2 #3） | complete/reopen 与 turn 状态**正交**，任意时刻可点；不停 turn；summarizer best-effort，**写回前重校验 `completed_at` 仍非空**（防 complete→reopen 竞态覆盖）。 |
| B. 老数据迁移（review #6） | 现存 `status='done'` 子任务在旧模型下 turn-done 与用户完成**不可区分** → `completed_at` 一律 NULL（安全默认＝未完成），用户重标真正完成的。**显式接受**此「完成标记丢失」。 |
| G. Done 主任务 guard（review #4 / R2 #4） | **host 端**（task-manager / WS / REST `task:update status=done`）强制拦截：任一子任务 turn 正 running/pending 则拒置 done（非仅 UI toast）；未读-done 不拦；Done 组行仍显待处理汇总点。 |
| 提议块/路径（review #7） | sentinel 用 **ASCII**（`<<gian:create_subtask>>…<</gian:create_subtask>>`，对齐既有 `<<gian:manager-system>>`）；`workspace` 名/路径解析规则见 §A2。 |
| B. 完成态 | 子任务「完成」与 turn 状态**彻底分家**：新增 `sessions.completed_at`（migration 027）。`status` 只表 turn 生命周期。 |
| B. 完成动作位置 | 删除子任务行左侧方框 toggle；完成/重新打开搬进**面包屑 session 菜单**（`PathBreadcrumb`），仅 subtask 显示，可切换（可 reopen）。 |
| C. 列表展开 | **所有任务恒展开**子任务（不再「只展开选中任务」），支持多任务并发观察。 |
| D. 未读合并 | 「未读」并入 turn 终态指示器，统一成**一个「待处理」语义**（pending 或「完成且未读」）。弃用单独的 `.ri-unread-dot`。**Sessions 侧栏与 Tasks 子任务通用**。 |
| E. 主任务汇总 | 任一子任务待处理 → 主任务名后挂一颗**纯 accent 圆点**（无渐变，和子任务图标不同形）。 |
| F. 去 Open | 删除管家面板头部 `task.status`「Open」胶囊 + 列表顶部「Open」分组标题。 |
| G. Done 分组 | 完成的**主任务**收进**钉底可折叠「Done」组**；组内只能「完成↔未完成」，不能打开/发消息/其他操作；reopen 回正常区。 |
| H. 状态图标视觉 | 实心渐变盘 + 挖空字形（✅ emoji 式），渐变由 accent 派生、流动 + 呼吸 + glow。详见 §H。 |
| 错误色 | error 用 **accent 渐变**（非红），靠 ✕ 字形区分（用户选「全部走方案 A」）。可后续再议。 |

---

## 0. 背景与硬约束

### 0.1 现状（已核实，文件行号）

- 管家是 `type='manager'` 的 Codex 会话，`SessionManager.sendMessage` 对其**硬锁** `sandbox:'read-only'` + `approvalPolicy:'never'`（`packages/host/src/session/manager.ts:947-958`），压过一切。
- 子任务 = `type='subtask'` 的 `Session`。`completeSubtask`/`abandonSubtask`（`manager.ts:1283/1302`）把 `status='done'` + 跑 summarizer。
- **完成态 bug 根因**：子任务行的方框 `done = subtask.status==='done'`（`packages/web/src/views/TasksView.tsx:399`）与右侧 turn 指示器 `StatusIcon status={subtask.status}`（`TasksView.tsx:427`）**共用同一个 `status` 字段**。`completeTurn` 在 turn 结束写 `status='done'`（`manager.ts:1887-1897`）→ 方框被自动勾上。
- 列表只展开选中任务：`expanded = task.id === activeTaskId`（`TasksView.tsx:247`）。
- 列表分 Open/Done 两组（`TasksList`，`TasksView.tsx:230-231/307-317`），组标题来自 `tasks.group.open` / `tasks.group.done`。
- 管家面板头部状态胶囊：`<span className="status-label">{task.status}</span>`（`TasksView.tsx:584-587`）。
- 建子任务链路已存在：`POST /api/tasks/:id/subtasks`（`packages/host/src/web/app.ts:612`）↔ `createSubtask(taskId, draft)`（`packages/web/src/api.ts:315`）↔ `onCreateSubtask`（`App.tsx:1479`）↔ `NewSubtaskForm`。
- 面包屑菜单：`SessionMenuActions`（`packages/web/src/components/PathBreadcrumb.tsx:13-24`）已是「可选回调按上下文增减」的模式 —— 加完成项天然契合。
- 状态图标：`StatusIcon`（`packages/web/src/views/CodingView.tsx:775`），现 4 态：`new`→空、`running`/`pending`→spinner、`error`→红 `!`、`done`→绿 ✓。Sessions 侧栏与 Tasks 子任务都复用它。
- 未读：`sessions.unread`（migration 024），`completeTurn` 自然完成/失败置 1、用户 Stop 不置；web 侧 `.ri-unread-dot`（侧栏行 + `TasksView.tsx:428-429`）。
- accent 设计系统：`packages/web/src/styles/tokens.css` 用 oklch + `--accent-h`/`--accent-c`，三主题（light/warm/dark）各定 accent L。最新 migration 是 026。

### 0.2 硬约束

- **codex-proxy 给管家用 app-server 结构化协议（不是纯 PTY）**【Codex review 修正】：管家走结构化路径，经 `CodexAppServerClient`（`turn/start` / `StartTurnParams`，`packages/proxies/codex-proxy/src/runtime/codex-app-server-client.ts`）。`StartTurnParams`（`core/types.ts:146`）**没有**注入 host 自定义工具 schema 的字段；codex 的外部工具走 **MCP**（codex 支持，见 `/mcp` slash + `generate-json-schema`），但 codex-proxy 当前**没配置任何 MCP server**。结论：给管家一个真正的 `create_subtask` schema 工具是**可行的**（给 codex-proxy 接 MCP），但是真工作量；本轮取**低风险路径**——管家输出结构化文本块 → web 解析 → 确认卡。（注：另有 `TtyCodexService` 走 PTY，是 codex CLI runtime 模式，与管家结构化路径无关。）
- 管家 cwd = 隐藏 root workspace（`getOrCreateRootWorkspace`，`packages/host/src/task/manager-session.ts`），指向 `workspace_root`（`~/Coding`），**跨所有项目**。「可写」即在整个 `~/Coding` 内可读写跑命令。
- 端口纪律：dev 用 8991/5191（`GIAN_DATA_DIR=$HOME/.config/gian-dev`），**不碰 8990/5190**。

---

## A. 管家：可写 + 可建子任务（确认门）

### A1. 放开 sandbox（host）

`manager.ts` 里 `type==='manager'` 的强制分支（现 `read-only`/`never`）改为：

```ts
sandbox: 'workspace-write',
approvalPolicy: 'never',
```

- 选 `never` 是因为管家面板目前**没有批准卡 UI**；`workspace-write` 上限即 `~/Coding`。
- 仍是 host 端**每轮强制**（压过 approval_mode / oneShotBypass），不在 UI 暴露切换。
- 风险提示写进代码注释 + MEMORY：管家可改写 `~/Coding` 下任意项目文件、跑命令。

**连带必改【Codex review #2】**——本仓库多处假设管家只读，放开时一并更新：
- 测试 `packages/host/test/p3-manager.test.ts:179`（断言 `sandbox==='read-only'` / `approvalPolicy==='never'`，及 system prompt 含「read-only project Manager」）。
- 管家 system prompt `buildManagerSystemPrompt`（`manager-session.ts:104`）现文「read-only project Manager… You cannot create… nor edit files or run commands」要改写成「可写 + 只提议建子任务」。
- 文档 `docs/PRD-v3-implementation-plan.md`、`docs/PRD-v3-task-abstraction.md`、`docs/protocol-proxy.md` 里「管家只读」表述（以新 ADR 为准；ADR 追加，不改既有 PRD 正文亦可，但需在新 ADR 标注被取代）。

### A2. create_subtask：结构化提议 → 内联确认卡

**Prompt**（`buildManagerSystemPrompt`，`manager-session.ts:104`）：把「写散文式建议」升级为「想拆活时输出带哨兵的结构化块」，沿用 `@gian/shared` 既有 sentinel 风格（参考 `MANAGER_SYS_*`）：

```
<<gian:create_subtask>>
{ "name": "...", "workspace": "<workspace 名或绝对路径>", "executor": "codex|claude", "prompt": "..." }
<</gian:create_subtask>>
```

sentinel 用 **ASCII**（`<<…>>`，对齐既有 `<<gian:manager-system>>`，避免 codex 复述/转义非 ASCII 出错）【review #7】。并明确告知：你只**提议**，由用户确认后创建；不要自己改文件/跑命令去建。

**Web**：管家 transcript 渲染层（复用 `stripManagerSystemPrefix` 那套 render-层剥离）：
- 扫描 assistant 文本里的 `create_subtask` 块，**解析成功**则原位渲染**可编辑确认卡**（name / workspace 下拉 / executor / 首条 prompt 预填），并把原始块从展示中隐藏。
- 点「创建」→ 走现有 `createSubtask(taskId, draft)`（无新后端字段）。点「取消」→ 丢弃。
- 解析失败 / JSON 坏 → 不渲染卡，原文按普通文本显示（稳）。
- **workspace 解析【review #7 / R2 #6】**：workspace **名字不唯一**，故按优先级解析：①绝对 `path` 精确匹配；②`name` 不区分大小写**且唯一**时匹配；③0 个命中 或 name 多个命中 → **不自动选**，确认卡下拉留空让用户挑。命中则预填下拉。最终只用解析出的 `workspace_id` 提交，**绝不**拿原始字符串直接建。
- 旧「照此建子任务」按钮被这张内联卡取代；手动新建仍保留 `NewSubtaskForm`。

> 软边界：管家可写 → 理论上能自己改文件/跑命令绕过确认。prompt 引导其「只提议」，与用户「需要我最后确认」意图一致；不做硬拦截。

### A3. 首条 prompt 投递（走现有 billing-safe 首消息路由）【review #1；R2 #1·#2·#5】

现状 `onCreateSubtask`（`App.tsx:1479`）**丢弃** `draft.prompt`（有 `TODO(P3-live)`）。本轮补上，但**必须复用 web 现有「新会话首消息」路由，绝不 host 端 `sendMessage`**——否则 Claude 子任务会走结构化 `claude -p`，**触发计费分叉**（敏感区，见 `docs/runtime-modes/`）。做法：

- **不加任何后端/shared 字段**：`prompt` 全程留在 web 侧；`createSubtask` / `POST /subtasks` 不变（A2「无新后端字段」仍成立，消除 R2 #5 矛盾）。
- 确认卡点「创建」→ `onCreateSubtask` 调 `createSubtask` 建子任务（draft），把 `prompt` 暂存 `pendingFirstMessageRef`（keyed 子任务 id）。
- **等 host `session:created` 广播到达再投递**（保证 web state 已有该 session，顺序正确，R2 #2）：复用 `planCreatedSessionFirstMessage`（`session-routing.ts`；App.tsx:242-301 既有逻辑）——
  - **Claude** → `switchToTty` + stage ttyText → `session:switch-runtime(tty)` → `runtime_mode==='tty'` 时 `pty:input` 投递（**TTY billing-safe 路径**）。
  - **Codex** → 结构化 `message:send`（codex 无计费分叉问题）。
- 无 `prompt` → 仍建 draft（旧行为，手动新建不受影响）。
- 闭环：管家提议 prompt → 确认 → 子任务带 prompt 跑起来，且 Claude 子任务不掉计费分叉。

---

## B. 子任务完成态与 turn 分家

### B1. 数据模型

- migration `027_session_completed.sql`：`sessions.completed_at TEXT`（可空 ISO）。
- `@gian/shared` `Session.completed_at: string | null`（本轮唯一 shared 改动）。
- `status` 自此**只**表 turn 生命周期（new/running/pending/done/error），永不驱动完成显示。
- **现存行迁移决策（显式）【review #6】**：旧模型下 `status='done'` 同时来自 turn 完成与 `completeSubtask`，二者**不可区分** → migration 不回填，`completed_at` 一律 NULL（安全默认＝未完成）。等于「老的用户完成标记丢失」，用户重标真正完成的。**显式接受**——因为把所有旧 `done` 当成用户完成会把一堆只是「跑完一轮」的子任务误标完成（正是本次要修的 bug）。

### B2. host

- `completeSubtask` → 改写 `completed_at = now`（**不碰 status**）+ 后台跑 summarizer（写 `.ai/`）。
- 新增 `reopenSubtask` → 清 `completed_at`（不跑 summarizer）。
- `abandonSubtask` 同样改走 `completed_at`（不再污染 status）。
- REST：保留 `POST /api/sessions/:id/complete`（现在置 `completed_at`），新增 `POST /api/sessions/:id/reopen`。WS 广播 `session:updated{completed_at}`。
- **complete/reopen guard【review #5】**：完成态与 turn 状态**正交**——任意时刻可点（含 turn running/pending）；**不停 turn、不阻塞**。complete 触发的 summarizer 仍是 best-effort（fail-soft + detached，已具备），若在 turn 跑一半点完成，summarizer 读当前已落 transcript 即可（不等 turn）。
- **summarizer 写回竞态【R2 #3】**：detached 写回在真正写 `.ai/` 前**重新校验该 session `completed_at` 仍非空**，否则丢弃——防 complete→reopen 快速切换时，旧的写回落后于 reopen、覆盖已 reopen 状态或写脏 `.ai/`。

### B3. web

- `SubtaskRow`（`TasksView.tsx:385`）**删掉方框 `done-toggle`**；右侧状态图标保留（见 §H）。
- `completed_at != null` → 行加 class：**标题划线 + 整行变灰**。
- 完成/重新打开动作搬进**面包屑 session 菜单**：`SessionMenuActions` 加 `onToggleComplete?`（仅 subtask 给），文案在「标记完成 / 重新打开」间切换；走 complete/reopen REST。

---

## C. 所有任务默认展开

`renderGroup`（`TasksView.tsx:242`）里 `expanded = task.id === activeTaskId` → 改为**恒 `true`**（活跃区每个任务都展开子任务）。后续要折叠再加 caret（本轮不做）。

---

## D. 未读 ＝ 最后一轮 turn 未读，并入状态指示器（Sessions + Tasks 通用）

### D1. 「待处理」语义（统一）

一行（session / subtask）为**待处理**当且仅当：`status==='pending'` **或**（`status` 为终态 `done`/`error` 且 `unread===1`）。语义只有一个：「这行有需要你处理的事」，不细分原因。

### D2. 指示器（弃用单独未读点）

`StatusIcon` 重写为接收 `{ status, unread }`，输出（详见 §H 视觉）：
- `new` → 空
- `running` → 渐变环（固定 16px，只转）
- `pending` → ❗（待处理，渐变盘）
- `done` → ✓ 盘；待处理(unread)=流动渐变 / 已读=纯 accent
- `error` → ✕ 盘；待处理(unread)=流动渐变 / 已读=纯 accent

读/未读由「渐变 vs 纯 accent」编码，**删除 `.ri-unread-dot`**（侧栏行 + `TasksView`）。打开/选中即标已读（沿用现有 `markSessionViewed`）。同一组件用在 Sessions 侧栏行与 Tasks 子任务行。

---

## E. 主任务「待处理」汇总

主任务名后挂一颗**纯 accent 圆点**（`.pdot`，无渐变、轻 pulse），当**任一子任务待处理**时显示。前端按子任务派生即可（不加 DB 字段）。形状与 §H 字形图标刻意不同。

---

## F. 去掉「Open」

- 删管家面板头部 `task.status`「Open」状态胶囊（`TasksView.tsx:584-587`）。
- 删列表顶部「Open」分组标题；活跃任务直接平铺在「正常区」（配合 §G）。

---

## G. Done 主任务钉底分组

- Done 变成**钉在列表最底部的可折叠分组**，点开 → 全是 `status==='done'` 的主任务。
- 组内任务**只有一个操作：完成↔未完成**（reopen，走 `task:update status open`）。**不能点开 / 不能发消息 / 无其他菜单**（行不可选、不展开子任务）。
- reopen → 任务回正常区。
- 子任务的「已完成」仍按 §B3 用划线+变灰留在父任务下；§G 只针对**主任务整体 done**。
- **标 done 前置 guard【review #4 / R2 #4】**：在 **host** 的 `task:update status=done` 路径（task-manager `updateTask` / WS / REST）**强制拦截**——若任一子任务 turn 正 running/pending，**拒绝置 done**（返回错误 / 不改 + 广播保持原状），**不只是 UI toast**（防多端或直连 API 绕过）。仅「未读-done」子任务不拦；UI 另给 toast 提示「先停/收尾子任务」。Done 组行仍显 §E 待处理汇总点，避免活跃子任务被藏进 Done 组失联。

---

## H. 状态图标视觉系统（定稿）

> 参照原型 `assets/2026-06-28-status-icon-prototype.html`。所有颜色从 `--accent-h`/`--accent-c` 派生，自动随 8 个 accent + 3 主题重新着色。

### H1. 渐变 token（加进 `tokens.css`）

每主题先定 `--gL1/2/3`（渐变三段亮度）：

| 主题 | gL1 | gL2 | gL3 |
|---|---|---|---|
| light | .66 | .74 | .58 |
| warm | .64 | .73 | .56 |
| dark | .70 | .80 | .62 |

再在 `body{}` 派生（同色系绕 accent 色相 ±）：

```css
--g1: oklch(var(--gL1) calc(var(--accent-c) + .04) calc(var(--accent-h) - 46));
--g2: oklch(var(--gL2) calc(var(--accent-c) + .06) calc(var(--accent-h) + 8));
--g3: oklch(var(--gL3) calc(var(--accent-c) + .04) calc(var(--accent-h) + 60));
--gGlow: oklch(var(--gL2) var(--accent-c) calc(var(--accent-h) + 8) / .6);
```

### H2. 图标构造

- **实心盘 + 挖空字形**（✅ emoji 式）：一个 `.gly` 层，`background` = 待处理时 `linear-gradient(115deg,var(--g1),var(--g2) 42%,var(--g3) 78%,var(--g1))`（`background-size:230% 230%`），已读时 `var(--accent)`；`mask-image: <disc>, <glyph>` + `mask-composite: subtract` → 字形从盘里挖空。
- 字形 SVG（16 viewBox，`fill='#fff'`）：
  - disc：`<circle cx=8 cy=8 r=7.4>`
  - done ✓：`<path d='M5 8l2 2 4-4' sw2.2 round>`
  - error ✕：`<path d='M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8' sw2.2 round>`
  - pending ❗：`<rect x=7.05 y=3.8 w=1.9 h=5.3 rx=.95>` + `<circle cx=8 cy=11.4 r=1.05>`
- **running 环**：`conic-gradient(from 0deg, g1,g2,g3,g2,g1)` + `radial-gradient` 挖中心（band），`mask-composite` 不需要。
- 用 DOM `.style.maskImage` 注入 data-URI（**不要**走内联 `style="..."` 字符串——双引号会截断属性，原型踩过坑）。

### H3. 动效与尺寸（锁定值）

| 项 | 值 |
|---|---|
| 字形盘（done/pending/error）尺寸 | 呼吸 **14px ↔ 18px**（base 18，`transform:scale`，`--minscale=.778`） |
| 变大变小周期（呼吸） | **4s** ease-in-out |
| 渐变滚动周期（flow，`background-position` 0→100→0） | **4s** ease-in-out |
| glow | `drop-shadow(0 0 4px var(--gGlow))`（模糊 4px，强度 alpha .6） |
| running 环 | **固定 16px，不呼吸**，只转圈（spin **4s** linear） |
| 已读态 | 纯 `var(--accent)`，**无动效** |

> 注：上述呼吸/流动只在「待处理(unread)」态跑；已读静止。glow 在真实 14–18px 上很微妙，用户已接受默认值。

---

## 数据 / 接口变更汇总

- migration `027_session_completed.sql`：`sessions.completed_at TEXT`。
- `@gian/shared`：`Session.completed_at: string|null`。
- host：`completeSubtask`/`reopenSubtask`/`abandonSubtask` 改写 `completed_at`（+ summarizer 写回前重校验 `completed_at`）；manager 沙箱放开；REST `/sessions/:id/reopen`；`updateTask`/WS `task:update` **host 端拦 done**（子任务 running/pending 时）；manager prompt 升级（去「read-only」措辞）。**无新 shared / REST 字段**（首条 prompt 走 web 侧）。
- 测试/文档（review #2）：`packages/host/test/p3-manager.test.ts`（read-only 断言改可写）；`docs/PRD-v3-*.md`、`docs/protocol-proxy.md` 只读表述以新 ADR 标注取代。
- web：`StatusIcon` 重写（含 `unread` 入参 + 渐变盘）；`tokens.css` 加渐变 token；`TasksView`（展开全部、删方框、划线灰、去 Open、Done 钉底+标 done guard toast、父任务 pdot、管家确认卡解析 + workspace 解析）；`onCreateSubtask` 暂存 prompt 并复用 `planCreatedSessionFirstMessage` 投递首条；`PathBreadcrumb` 加 `onToggleComplete`；`App.tsx` 接线；删 `.ri-unread-dot`；i18n。

## ADR

需新写 ADR：推翻 PRD-v3 §A1（管家从「只读 + 无结构化回传」→「可写 + create_subtask 确认通道」）。**准确记录**（按 Codex review 修正）：codex-proxy 给管家用的是 app-server 结构化协议，`StartTurnParams` 无 host 工具 schema 字段，codex 外部工具走 MCP（**可行**但 proxy 未配置）→ 本轮取「输出解析 + 确认卡」低风险路径而非接 MCP；沙箱 `workspace-write/never` 取舍（管家 cwd=`~/Coding` 跨全项目的安全面）；并标注其取代 PRD-v3-task-abstraction §230 / implementation-plan 的「只读」表述。ADR 追加制，不改既有。

## 仍待定 / 已知风险

- error 用 accent（非红）—— 用户本轮选「全部方案 A」，靠 ✕ 区分；若日后要红警示，单列 danger 渐变。
- 管家可写 + cwd=`~/Coding` 跨全项目，是本设计最大安全面；确认门只挡建子任务，挡不住管家自发改文件（用户已知并接受）。
- summarizer 真 LLM 仍是既有 TODO(P4-live)，本 spec 不涉及。
