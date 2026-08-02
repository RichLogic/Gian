# Task 管家（Manager）—— 设计文档

**日期：** 2026-05-26
**状态：** 草案 — 待用户评审
**范围：** PRD-v3 中的「管家（Manager）」子系统的完整设计。Task / Subtask 数据模型、`.ai/` 脚手架、上下文注入/回写等其他部分由 PRD-v3 独立覆盖，本稿只覆盖**管家**这一块。
**前置阅读：**
- `docs/PRD-v3-task-abstraction.md`（需求文档）
- `docs/runtime-modes/`（5 个文件）—— 落代码前**必读**
- `docs/adr/0001-codex-cli-runtime-mode.md`（Codex CLI runtime 决策，本稿复用其基础设施）

---

## 1. 背景与范围

PRD-v3 在 Session 之上引入 Task 抽象，每个 Task 配一个「管家」chat panel：用户可以和管家对话，请它规划下一步、推荐 workspace、产出新 Subtask 的初始 prompt。管家**没有执行权**——它本身不开 worktree、不改用户代码，只是个有约束的 advisor。

PRD-v3 把管家的能力表面写得比较抽象（"看 Subtask 元信息 + `.ai/`，可建议不可执行"），具体的工具集、运行时、记忆机制、approval 流均留为待定。本稿落地这些细节。

### 1.1 用户对话中已确定的决策（追溯到 2026-05-26 brainstorm）

汇总在这里，方便后面章节追溯。

| 编号 | 决定 |
|---|---|
| A1 | 管家主业是**前瞻型 PM**：建议下一步、推荐 workspace、不做"知识总管"类回溯检索 |
| A2 | 管家是 **tool-using agent**，不是纯 chat。Subtask 历史**按需 drill in**，且只暴露**最终结果**，不暴露中间过程 |
| A3 | 管家可见信息：`.ai/` 文件 + workspace 高层介绍。源代码**不主动拦着**爬，但默认期望它只在必要时碰 |
| Q5 | 触发方式：**完全 user-initiated**。不做"Subtask 完成后主动 ping 用户"这类 proactive 行为 |
| Q6 | 管家自己的工作记忆：**每 Task 一个 manager 目录**，管家在里面随便写（plan.md / notes.md 等都行） |
| Q7 | 管家运行时：**复用 codex-proxy + Codex CLI**（GPT-5.5 默认，effort=high，系统设置可改）—— 不直连 Anthropic API，避开 `claude -p` 单独计费的不确定性 |
| 工具表 | 仅 `create_subtask` + `read_subtask_outcome` 两个自定义工具；其他全用 Codex native 文件能力 |
| Approval | `create_subtask` 调用走**系统拦截审批卡**模式（不靠 system prompt 教育管家自己 ask first） |
| Sandbox | **读全开**（含源码），**写仅限 manager 目录** |
| Workspace 创建 | 管家**不能**创建新 workspace；只能文字建议用户去开 |

---

## 2. 架构

### 2.1 进程拓扑

```
┌──────────────────────────┐                 ┌──────────────────────────┐
│   web                    │  WS manager:*   │ host                     │
│   <ManagerPanel>         │ ──────────────→ │  TaskManagerService [新] │
│   (chat-like UI)         │                 │   ├─ 持久化 (DB)         │
└──────────────────────────┘                 │   ├─ MCP server (in-proc)│
                                             │   └─ codex-proxy client  │
                                             └──────────┬───────────────┘
                                                        │ JSON-RPC stdio
                                                        ▼
                                             ┌──────────────────────────┐
                                             │ codex-proxy (shared)     │
                                             │   StructuredService       │
                                             │   (现有；管家复用)        │
                                             └──────────┬───────────────┘
                                                        │
                                                        ▼
                                             ┌──────────────────────────┐
                                             │ codex CLI subprocess     │
                                             │   model: gpt-5.5-codex   │
                                             │   effort: high           │
                                             │   sandbox: read-all,     │
                                             │            write-mgr-dir │
                                             │   mcp_servers:           │
                                             │     gian-task-manager     │
                                             └──────────────────────────┘
```

**关键点：**

- 管家**不是** Subtask、**不是** Session、**没有** `workspace_id`、**没有** `worktree_*`。它是 Task 的附属物，1:1 绑定 Task。
- 复用 **codex-proxy**（既有「单进程共享所有 Codex sessions」的形态，由 `CLAUDE.md` / ADR-0001 锁定）。管家的 codex thread 在 codex-proxy 看来就是另一个 codex session，按既有 `proxySessionId` 路由。
- 复用 **structured runtime mode**（`runtime_mode='structured'`）。管家的 UI 是 chat panel，不是终端，不存在 TTY 模式。
- MCP server **在 host 进程内**起，通过 stdio 暴露给 codex CLI 子进程。每个 manager session spawn 一份独立 MCP server（携带 `task_id` 上下文），不需要全局共享 —— Subtask sessions 的 codex 实例不会看到这些工具，天然隔离。

### 2.2 三种 id 必须分清（沿用 ADR-0001 命名）

| id | 用途 | 落地 |
|---|---|---|
| `taskManagerId` | DB 主键，Gian 内部用 | `task_managers.id` |
| `proxySessionId` | codex-proxy 里 `SessionRecord.id`，host 路由 notifications 的 key | `task_managers.proxy_session_id` |
| `codexThreadId` | Codex 原生 thread UUID，`codex resume <id>` 用 | `task_managers.native_session_id` |

复用 ADR-0001 已经验证过的 `thread/start` 路径取 `codexThreadId`，不重复趟雷。

### 2.3 System prompt 结构

管家 codex session 启动时通过 codex-proxy 的 `structured` API 注入 system prompt。结构如下（伪文本，实际由 host 拼装）：

```
你是 Gian 任务管家（Manager），辅助用户规划当前 Task。

## 你的职责
- 建议下一步该做什么（哪个 workspace / 用什么 executor / 初始 prompt 怎么写）
- 回答用户关于本 Task 进展的问题
- **不**直接执行编程任务 —— 那是 Subtask 的事
- **不**修改 workspace 中的代码

## 当前 Task
{ name, description, status, created_at }

## 本 Task 下的 Subtasks
{ 依次列出 id / name / workspace_name / executor / status / summary (如果已完成) }

## 用户所有的 workspaces
{ 依次列出 id / name / abs_path / description }

## 本 Task 涉及到的 workspace 的当前状态
对每个涉及的 workspace 内嵌：
- `.ai/STATE.md` 全文（必带，小）
- `.ai/HANDOFF.md` 全文（必带，小）
不内嵌 `.ai/MEMORY.md` / `.ai/SESSION_LOG.md`（可能很大）—— 你需要时自己用文件工具读。

## 你的工具
1. `read_subtask_outcome(subtask_id)`
   返回某个 Subtask 的最终产出。**不**返回中间对话过程。
   用途：summary 不够时拿真实的最后结论。

2. `create_subtask(workspace_id, executor, runtime_mode, approval_mode, initial_prompt)`
   创建一个新 Subtask 并立即启动。系统会弹审批卡让用户确认入参，用户可改、可取消。
   建议你 call 之前先在 chat 里用人话把入参讲一遍——这样审批卡只是兜底，体验更好。

## 文件系统
- **读**：本 Task 涉及的 workspace 目录任意文件（含 `.ai/MEMORY.md`、`.ai/SESSION_LOG.md`、源代码）
- **写**：仅限你的私人 scratch 目录 `<task_manager_dir>`
- 你的 scratch 目录：`{abs_path_to_manager_dir}`
- 你可以在里面维护 `plan.md`、`notes.md` 之类，跨对话保留你的思考

## 行为约束
- 不假装能做编程之外的事（发邮件、调外部 API 等）
- 推荐下一步前，至少看一眼最近一个 Subtask 的 outcome / `.ai/STATE.md`
- 用户问"做过什么"时优先查 Subtask summaries 和 `.ai/SESSION_LOG.md`
```

注入时机：管家会话首次 spawn 时（codex `thread/start`）作为 instructions 传入；每次 resume 时**不重传**（codex 自己持久化了）。当 Subtask 列表、workspace 列表等元信息变化时，**不**重启会话——通过下一条 user message 前缀的"上下文刷新块"补充（详见 §3.3）。

### 2.4 工具的 MCP 实现

每个 manager session 启动时，host 在内存里实例化一个 MCP server（用 `@modelcontextprotocol/sdk`，cc-proxy 已经在用了），把 `task_id` 闭包在工具实现里。codex CLI 通过子进程 spawn 时的 config 把这个 MCP server 加进来。

**为什么不用全局 MCP server？** 全局会让 Subtask 的 codex sessions 也看到 `create_subtask` —— Subtask 不该有这能力，会出现"Subtask 自己开 Subtask"的递归乱象。Per-instance MCP 干净隔离。

**实现细节：** codex CLI 的 MCP server 配置是否支持 per-instance（vs 仅 `~/.codex/config.toml` 全局）需要在 S0 阶段验证；如不支持，fallback 是全局注册但在工具实现里 reject "calling session is not a manager"（用 env var / 一个 special header 识别）。验证步骤见 §10。

---

## 3. 数据

### 3.1 DB schema 新增

```sql
-- 管家会话（1:1 跟 Task）
CREATE TABLE task_managers (
  id TEXT PRIMARY KEY,                          -- nanoid
  task_id TEXT NOT NULL UNIQUE,                 -- FK tasks.id
  proxy_session_id TEXT,                        -- codex-proxy SessionRecord.id (lazy: 首次启动时填)
  native_session_id TEXT,                       -- codex thread UUID (lazy)
  model TEXT NOT NULL DEFAULT 'gpt-5.5-codex',
  effort TEXT NOT NULL DEFAULT 'high',          -- low / medium / high
  status TEXT NOT NULL DEFAULT 'idle',          -- idle / active / error
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

-- 管家消息（chat history 镜像，用于 UI 重渲染）
CREATE TABLE task_manager_messages (
  id TEXT PRIMARY KEY,
  manager_id TEXT NOT NULL,
  seq INTEGER NOT NULL,                         -- 单调递增，UI 排序用
  role TEXT NOT NULL,                           -- user / assistant / tool_call / tool_result
  content TEXT NOT NULL,                        -- JSON-encoded payload
  created_at INTEGER NOT NULL,
  FOREIGN KEY (manager_id) REFERENCES task_managers(id) ON DELETE CASCADE,
  UNIQUE (manager_id, seq)
);
```

**为什么镜像消息到 DB**：codex CLI 自己有 rollout JSONL（用于 resume），但 web 端要做 chat UI 渲染、断线重连、多 tab 同步，host 这边必须有一份消息流。沿用现有 `sessions` + `session_messages` 的同款做法。

### 3.2 Manager 目录结构

每 Task 一个目录：

```
~/.config/gian/data/tasks/<task_id>/
  manager/                          ← 管家的私人 scratch
    plan.md                         ← 管家自己写（可选）
    notes.md                        ← 管家自己写（可选）
    ... 任意文件 ...
```

**约定：**

- 目录在创建 Task 时由 host **预先建好空的**（即使用户从没开管家面板）。这样管家首次启动时不用做"先 mkdir"。
- 用户**不**应该手动改这里的文件（不像 `.ai/` 是用户和 AI 共享的）。manager 目录是管家的私有空间。但也不强制锁权限——用户想 `cat plan.md` 看一眼是允许的。
- Task 被删除时，目录跟着被清掉（DB CASCADE 触发应用层做 rmtree）。归档（archive）时**不**清。

### 3.3 上下文刷新（不重启会话）

管家 codex session 长生命周期。Subtask 列表、状态、workspace 列表会一直变。

**做法：** 用户每次发消息时，host 在用户消息前**插入一个"上下文更新"前缀块**，附带最新元信息 diff（或全量重发，看 token 成本权衡）。codex 模型读到后自然带入推理。形如：

```
[Gian: 上下文更新 — 自上次对话以来]
- Subtask "fix-codemod" 状态变为 done（新 summary 已附）
- 新增 workspace "mobile-app"
（以下为用户消息：）
{ 用户实际输入 }
```

token 成本：每次刷新 < 500 tokens；如 Task 规模膨胀触发 token 上限，触发**会话重启**降级（旧消息丢入 manager 目录的 `archive/`，新会话用最新 system prompt 起）。**会话重启**作为 v1.1 优化，v1 不实现。

### 3.4 Manager session 生命周期

| 事件 | 行为 |
|---|---|
| Task 创建 | 创建 `task_managers` 行（仅 DB），**不** spawn codex —— 用户没打开面板时不烧 token |
| 用户首次打开 Manager panel | lazy spawn：codex-proxy `thread/start`，写入 `proxy_session_id` + `native_session_id`，注入 system prompt |
| 用户后续打开面板（app 重启后） | lazy resume：codex-proxy 对应 `codex resume <native_session_id>`（沿用 ADR-0001 路径） |
| Task `done` / `archived` | manager 标记 `status='idle'`，下次打开不再 spawn。DB 记录保留供回看 |
| Task 删除 | CASCADE 删 `task_managers` + 删 manager 目录 |

---

## 4. 工具契约

### 4.1 `read_subtask_outcome`

```
Input:
  subtask_id: string                    必填，本 Task 下的 Subtask id

Output (成功):
  {
    subtask_id: string,
    status: "done" | "abandoned" | "active" | "draft",
    outcome: string,                    // see below
    workspace_name: string,
    executor: string
  }

Output (失败):
  { error: "subtask not found in this task" }
  { error: "subtask not yet completed" }     // status === 'draft' / 'active'
```

**"outcome" 的定义：**

| Subtask 状态 | outcome 内容 |
|---|---|
| `done` | summarizer 完成时写入的 `subtasks.outcome` 字段（PRD-v3 的 summarizer 一并产出，需要 schema 扩展） |
| `abandoned` | 用户填的 abandon reason（可能为空字符串） |
| `active` / `draft` | 工具直接 reject，return error |

**为什么不返回最后一条 assistant 消息？** 最后一条消息可能是个未结束的工具调用、可能是个被 truncate 的中间步骤，并非"结论"。让 summarizer 写一个明确的 outcome 字段更靠谱。代价：PRD-v3 的 summarizer 需要多输出一字段——可接受。

### 4.2 `create_subtask`

```
Input:
  workspace_id: string                  必填
  executor: "claude" | "codex"          必填
  runtime_mode: "structured" | "tty"    必填
  approval_mode: "auto" | "manual"      必填
  initial_prompt: string                必填，管家组装好的首条用户消息

Output (成功):
  { subtask_id: string, status: "active" }

Output (失败):
  { error: "user rejected" }
  { error: "workspace not found" }
  { error: "approval timeout" }
  { error: "<runtime error message>" }
```

**Approval 流（B 模型）：**

```
管家 call create_subtask(...)
   │
   ▼
host 拦截 → 不立即执行
   │
   ▼
host 推 WS 消息: { type: 'manager:approval-request',
                   manager_id, request_id, proposed_args }
   │
   ▼
web 弹审批卡（参数全展示，每项可改）
   │
   ├── 用户点"批准" → ws.send({ type: 'manager:approval-decision',
   │                           request_id, decision: 'approve',
   │                           final_args: {...} })
   │      → host 执行 createSubtask(final_args)
   │      → tool return { subtask_id, status: 'active' }
   │
   ├── 用户点"拒绝" → ws.send(decision: 'reject')
   │      → tool return { error: 'user rejected' }
   │
   └── 60s 无响应 → host 自动 timeout
          → tool return { error: 'approval timeout' }
```

审批卡 UI：见 §6。

**为什么不把审批做成"管家在 chat 里 ask first"？** 见 brainstorm 决策 — 靠 system prompt 教育模型有概率忘掉；系统拦截是硬保证。

### 4.3 工具调用频率

无硬性 rate limit。但 codex 自身有 max iterations / max tool calls per turn 的护栏，沿用其默认。若发现管家"无限 drill in 各种 Subtask transcript"行为，再加 host 侧 rate limit。

---

## 5. Sandbox / 权限

### 5.1 codex CLI 启动参数（管家专用）

```
codex resume <native_session_id> \
  --sandbox workspace-write \                # 基础模式
  --add-dir <workspace_a_path> \             # 读：本 Task 涉及的所有 workspace
  --add-dir <workspace_b_path> \
  ... \
  --workdir <task_manager_dir> \             # 写：仅 manager 目录
  --model gpt-5.5-codex \
  --effort high \
  --config mcp_servers.gian-task-manager.command=<host-helper-path> \
  --config mcp_servers.gian-task-manager.args=["--manager-id=<task_manager_id>"]
```

**关键：**
- `--workdir` 设为 manager 目录 → codex 的 write 默认落在这里
- `--add-dir` 给读权限到 workspace 们 → codex 能 `read_file` / `grep`，但**写**不被允许（workspace-write 模式只允许写 workdir，读 `--add-dir` 列表）
- 管家**不能改** workspace 的源代码（含 `.ai/`）—— 这是物理隔离，不靠模型自律

**待 S0 验证（§10）：** codex CLI 的 sandbox 模式是否真的能做到「读 add-dir、写 workdir-only」。如不行，fallback 是更严格的 sandbox + 我们自己包一层。

### 5.2 .ai/ 写入权限的"反直觉"决定

直觉上，summarizer 写 `.ai/STATE.md` / `.ai/HANDOFF.md` 是「AI 在写」，所以管家也该能写。但**summarizer 和管家是两回事**：

- **Summarizer** 由 PRD-v3 定义，是 Subtask 完成后 host 直接调用的一次性 LLM 请求，host 拿到结果由 host 写盘 —— 完全在 host 控制下。
- **管家** 是个长生命周期 agent，给它写 `.ai/` 权限会导致它"我觉得 STATE.md 该这么改"自作主张去改，跟 summarizer 撞车（PRD-v3 的待确认项 2 已经在头疼一个写手的冲突）。

所以**管家只读 `.ai/`，不写 `.ai/`**。如果管家觉得 STATE 该改，让它建议用户/Subtask 去改即可。

---

## 6. UI surfaces（仅列不画）

mockup 留给 claude design 单独一轮（用户明确要求）。本节只声明**需要哪些 surface**，layout / 样式 / 配色都不涉及。

| Surface | 大致内容 | 落地组件名（建议） |
|---|---|---|
| Task 详情页的管家面板 | chat 输入框 + 消息列表，类似 Subtask transcript 的样式但更轻 | `<ManagerPanel>` |
| `create_subtask` 审批卡 | inline 在管家消息流中（不是 modal），展示 5 个入参（workspace_id 下拉、executor 下拉、runtime_mode 下拉、approval_mode 下拉、initial_prompt 多行可编辑）+ 批准/拒绝按钮 | `<CreateSubtaskApprovalCard>` |
| 系统设置 → 管家 | 模型下拉（默认 gpt-5.5-codex、可切其他 codex 模型）+ effort 下拉 + (可选) API key/account 选择 | `<SettingsManagerSection>` |
| Task 详情页 sidebar | 一个 toggle 切换"看 Subtask 列表" / "和管家说话"（如果 layout 不放双栏） | （见 PRD-v3 §7） |

**不在本稿范围：** 任何 layout decisions, color, typography, mockup. 拍板交给 claude design。

---

## 7. WS 协议

新增三条 WS 消息（沿用 `packages/shared/src/web.ts` 现有 message 类型 + Zod schema 模式）：

| 方向 | type | payload |
|---|---|---|
| client → server | `manager:send-message` | `{ manager_id, text }` |
| server → client | `manager:message` | `{ manager_id, seq, role, content }` —— 增量推 |
| server → client | `manager:approval-request` | `{ manager_id, request_id, proposed_args }` |
| client → server | `manager:approval-decision` | `{ request_id, decision, final_args? }` —— `decision='approve'` 时 `final_args` 必填（可能与 `proposed_args` 一致，也可能用户改过）；`decision='reject'` 时 `final_args` 缺省 |
| server → client | `manager:status` | `{ manager_id, status }` —— idle / active / error |

**replay：** 客户端打开面板时一次性 fetch `task_manager_messages` 全量（小，几十 KB 级），不走 WS replay。后续增量走 `manager:message`。

---

## 8. 错误处理 / 降级

| 失败场景 | 行为 |
|---|---|
| codex CLI 不可用（ENOENT / 启动失败） | manager status 设 `error`，UI 显示"管家暂不可用 — 检查 codex 安装"，**不**降级到 Anthropic 直连（避开 `claude -p` 计费坑是核心 motivation） |
| codex thread resume 失败（rollout 文件丢了） | manager status 设 `error`，UI 提供"重置管家会话"按钮 → 删 `native_session_id`，下次打开重新 spawn（历史消息保留 in DB 但脱节，提示用户） |
| `create_subtask` 工具失败（workspace 不存在 / 启动 runtime 报错） | tool return error，管家自己读到 error 后用人话告诉用户 |
| approval 60s 无响应 | tool timeout，管家收到 `error: approval timeout` 后建议用户重试 |
| Manager 目录损坏 / 不可写 | 启动时 host 检测并 recreate（空目录）。如果 recreate 也失败（磁盘满 / 权限）→ manager status `error` |
| MCP server 启动失败 | 不 spawn codex，manager status `error`，UI 显示"管家配置异常" |
| codex 进入死循环 / 长时间不响应 | codex CLI 自身有 max iterations 护栏；超出后 codex 返回 error，host 转成 `manager:message` 推给 web |

---

## 9. 影响面

### 9.1 新增

| 文件 | 行数估计 | 内容 |
|---|---|---|
| `packages/shared/src/model.ts` | +50 | `TaskManager` / `TaskManagerMessage` / `ManagerStatus` 类型 |
| `packages/shared/src/web.ts` | +60 | `manager:*` 5 条 WS message 的 Zod schema + 类型 |
| `packages/host/src/db/migrations/NNN_task_managers.ts` | ~80 | `task_managers` + `task_manager_messages` 两表 |
| `packages/host/src/task/manager-service.ts` | ~400 | `TaskManagerService` — lazy spawn / resume / sendMessage / approval 流 / 持久化 / WS broadcast |
| `packages/host/src/task/manager-mcp-server.ts` | ~200 | per-manager-instance MCP server，暴露 `create_subtask` + `read_subtask_outcome` |
| `packages/host/src/task/manager-codex-launch.ts` | ~150 | 组装 codex CLI 启动参数（sandbox / add-dir / mcp config / model / effort） |
| `packages/host/test/manager-service.test.ts` | ~250 | spawn / resume / approval approve+reject+timeout / sendMessage / status transitions |
| `packages/host/test/manager-mcp-tools.test.ts` | ~150 | `create_subtask` / `read_subtask_outcome` 工具正反例 |
| `packages/web/src/views/ManagerPanel.tsx` | ~250 | chat UI |
| `packages/web/src/components/CreateSubtaskApprovalCard.tsx` | ~180 | inline approval 卡 |
| `packages/web/src/wire/managerWire.ts` | ~120 | WS adapter |
| `packages/web/test/ManagerPanel.test.tsx` | ~120 | render / send / replay |

### 9.2 修改

| 文件 | 改动 |
|---|---|
| `packages/host/src/proxy/codex-proxy-client.ts` | 新增 `createManagerSession({ instructions, mcpConfig, sandbox, addDirs, workdir, model, effort })` —— 包一层 thread/start，把管家专用参数透传 |
| `packages/host/src/index.ts` | wire `TaskManagerService`，传 `CodexProxyClient` / DB / WS broadcaster |
| `packages/host/src/web/ws-handler.ts` | 路由 `manager:send-message` / `manager:approval-decision` 到 `TaskManagerService` |
| `packages/host/src/task/subtask-service.ts` | （PRD-v3 主线已规划）summarizer 输出 schema 增加 `outcome` 字段 |
| `packages/host/src/db/migrations/NNN_subtask_outcome.ts` | `ALTER TABLE subtasks ADD COLUMN outcome TEXT`（若 PRD-v3 主线没加） |
| `packages/web/src/views/TaskDetailView.tsx` | 嵌入 `<ManagerPanel>` |
| `packages/web/src/views/SettingsView.tsx` | 嵌入 `<SettingsManagerSection>` |

### 9.3 零改动 / 复用

- `codex-proxy` 本体（structured service / thread/start / message 路径全部复用）
- cc-proxy（管家不走 Claude）
- 现有 Session / Subtask runtime（管家不是 Session）
- `.ai/` 脚手架（管家只读，不需要 PRD-v3 之外的额外脚手架机制）

---

## 10. 待 S0 验证 / 待定项

落代码前必须确认的硬技术问题：

1. **codex CLI 的 per-instance MCP server 配置**：能否通过 CLI flag 或 per-call config 注入，而不污染 `~/.codex/config.toml` 全局？如果只能全局，需要在 MCP 工具实现里靠 `task_manager_id` env var + 调用方 session 识别做软隔离。
2. **codex CLI 的 sandbox + add-dir 组合**：`--sandbox workspace-write` + `--workdir manager_dir` + `--add-dir workspace_dirs` 能否真的实现"读全开、写仅 workdir"？模式名以 codex 实际支持的为准；S0 跑一个 toy session 验证（写 add-dir 应该 403、读 add-dir 应该成功、写 workdir 成功）。
3. **codex CLI 的 model 切换**：`gpt-5.5-codex` 这个模型 id 在 codex CLI 里的准确名称、effort 参数的实际形态（flag / config / env）需要在 S0 写代码前查文档对齐。
4. **codex thread resume 在长时间停用后的行为**：rollout JSONL 是否会被 codex 自身清理？如果会，需要在 host 侧定期 touch 或备份。
5. **codex 的 instructions 注入通道**：`thread/start` 的入参是否支持自定义 instructions（system prompt）？如不支持，fallback 是把它作为合成的第一条 user message（沿用 PRD-v3 TTY 注入同款做法）。

**留给设计阶段后期 / 实现阶段决：**

- `task_manager_messages` 在长 Task 下会膨胀（管家可能对话上千轮）。是否需要分页 / 截断？v1 先不管，加监控指标看 p95 大小。
- 管家会话的 token cost 监控（每次 turn 用了多少 token、累计多少）。
- 多 manager 并发数限制（一个 host 上同时活跃 N 个 Task 都开着面板时，N 个 codex 子进程的资源消耗）。

---

## 11. 链接

- 需求文档：`docs/PRD-v3-task-abstraction.md`
- Runtime 模式背景（必读）：`docs/runtime-modes/`
- 既有 Codex CLI 路径决策：`docs/adr/0001-codex-cli-runtime-mode.md`
- codex-proxy 实现：`packages/proxies/codex-proxy/`
- 现有 Session 数据模型：`docs/data-model.md`、`packages/shared/src/model.ts`
- PRD-v3 中的 `.ai/` 脚手架（管家只读）：PRD-v3 §「关键概念」「Workspace 初始化」
