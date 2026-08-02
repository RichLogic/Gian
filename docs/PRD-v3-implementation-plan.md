# PRD-v3 实施 plan — Task 抽象层

> 配套 [`PRD-v3-task-abstraction.md`](./PRD-v3-task-abstraction.md)（v0.2）。本文件是**实施 plan**：
> 锁定的决策 + 分阶段 + 关键代码事实。起于 2026-06-23。

---

## 锁定决策（2026-06-23）

去风险调研（读 `docs/runtime-modes/` + 实测 codex-proxy / cc-proxy / `session/manager.ts` /
`workspace/init.ts`）之后定下：

- **架构脊梁：Subtask 和 Manager 都是 `Session` 的变体**，复用现有 session 全套机制：
  - **Subtask** = `type='subtask'` + `task_id` 的普通 session。
  - **Manager** = `type='manager'` + `task_id`、绑在 `~/Coding`(workspace_root)、每轮
    `sandbox:'read-only'`、不开 worktree、一 Task 一个、常驻。
- **只读约束靠 sandbox，不靠 prompt**：codex-proxy 原生支持 per-turn `sandbox:'read-only'`
  （`StartTurnParams.sandbox` → Codex app-server `{type:'readOnly'}`）+ `approvalPolicy:'never'`。
  写 / 命令执行在权限层就拿掉，与 system prompt 无关。
- **A1 — `create_subtask` 用话术建议**：管家在回复里给出建议（workspace/executor/prompt），
  UI 给「照此建 Subtask」按钮 → 预填 NewSubtask 表单，用户确认。**不做结构化回传通道**
  （codex-proxy 不把模型 tool-call 透传给 host）。将来若要那张可编辑审批卡（A2），再上
  gian-side MCP server 或解析输出。
- **B1** 管家 cwd = `~/Coding`。 **B2** 复用 codex 登录，暂不做成本兜底。
  **B3** 管家绑 `~/Coding` —— 因 `sessions.workspace_id` 有 FK，需要一个指向 workspace_root 的
  特殊（hidden）workspace 行供它绑。
- **C 默认值**（到对应阶段再确认，无异议即采用）：
  - **C1** `.ai/` 写冲突：summarizer 重写前先备份旧版到 `.ai/.history/`，不静默丢用户编辑。
  - **C2** 散落 session 迁移：`task_id` 留空，UI 归入「散落 Session」分组（最不破坏）。
  - **C3** `read_subtask_transcript`：默认关（管家只看元信息）；要时再给「显式分享」按钮。

---

## 关键代码事实（调研所得，落代码时核对）

- `Session` 模型已有 `type`/`runtime_mode`/`approval_mode`/`native_session_id`/`unread` 等
  （`packages/shared/src/model.ts:89`）。加 nullable `task_id` 低风险（多文件读 Session 但 null-safe；
  host `SELECT *` 自动带出）。
- `SessionType` 现在只有 `'coding'`（`model.ts:3`）。
- `sessions` 表 `type TEXT NOT NULL DEFAULT 'coding'`，**无 CHECK 约束** → 加新 type 值不需要改约束。
  `workspace_id TEXT NOT NULL REFERENCES workspaces(id)` → Manager 必须有真实 workspace 行（B3）。
- migration：`packages/host/migrations/NNN_*.sql`，`storage/db.ts:runMigrations` 自动发现 + 排序运行；
  最新 `024`，下一个 **025**。
- codex-proxy 只发 turn/output/approval/diff 等 notification，**不透传模型 tool-call**；cc-proxy 有
  MCP approval bridge（`mcp/approval-server.ts` 的 `cc_approval/approval_prompt`）——是将来 A2 的
  参照，但 Claude=`claude -p`=烧 Agent SDK credit，不用于管家。
- `workspace/init.ts`：非 adopt 会写默认 `CLAUDE.md`；adopt 是只读不写。`.ai/` 脚手架插这里
  （adopt 也得写 —— 是行为变化，P2 处理）。

---

## 分阶段

### P0 地基（零行为变化）
- `packages/shared/src/model.ts`：`SessionType` 扩 `'coding'|'subtask'|'manager'`；`Session` 加
  `task_id: string | null`；新增 `Task` 接口 + `Subtask` 别名。
- migration `025_tasks.sql`：建 `tasks` 表；`sessions` 加 `task_id`。
- 验收：`tsc` 干净；migration 在临时 db 全链应用无误。

### P1 Task CRUD + Tasks UI
- host：tasks 增删查改 + complete/archive；REST + WS；Subtask = 带 `task_id` 调现有 `createSession`。
- web：Tasks 模式 + 任务列表 + 详情（照 `design/gian-design-v2` 原型接线）；subtask 列表 =
  按 `task_id` 过滤的 sessions。

### P2 `.ai/` 脚手架 + 上下文注入
- `workspace/init`：写 `.ai/`（HANDOFF/STATE/MEMORY/SESSION_LOG）+ `CLAUDE.local.md`，幂等，
  adopt 也写，不碰用户 `CLAUDE.md`。
- subtask 启动注入 HANDOFF+STATE：structured=system message；TTY=合成首条 user message
  （落代码前重读 `docs/runtime-modes/`）。

### P3 Manager（核心）
- root workspace 行（指向 `~/Coding`，hidden）供管家绑。
- 管家 session：`type='manager'`、codex、`gpt-5.5`/`xhigh`、每轮 `sandbox:'read-only'`+
  `approvalPolicy:'never'`、不开 worktree、一 Task 一个、常驻。
- system prompt：角色 + 内联 subtask 元信息 + 指向 `.ai/` / 相关 workspace 的路标。
- A1：话术建议 →「照此建 Subtask」预填表单。
- 管家面板：复用 transcript / composer（只读 sandbox）。

### P4 summarizer 回写（需 C1）
- subtask 完成 → 后台重写 `.ai/`（STATE/HANDOFF）+ 追加 SESSION_LOG；冲突按 C1。

### P5 老 session 迁移（需 C2）
- `task_id=null` + UI 散落分组。

**依赖**：P0 → P1/P2；P3 依赖 P0（+P2 提供 `.ai/` 给它读）；P4 需 C1；P5 需 C2。P0/P1 可立即起。
