# Gian 需求文档 — Task 抽象层（v3 草案）

> 版本 0.2 · 2026-06-17 · 草案
> 与 `docs/PRD-v2.md` 并行。验收后再决定是否折回主 PRD。
>
> **修订 0.2（2026-06-17）**：管家（Manager）从 v0.1 的"直连 Anthropic Haiku、低成本"
> 改为**智能优先**——作为一个 **read-only sandbox 的 Codex 会话（`gpt-5.5` / thinking `xhigh`）**
> 运行，用 Codex **原生**文件工具**按需读** `.ai/` 与 Workspace 代码（不再固定注入一小块，
> 也**不**为读上下文另造工具——只把 cwd / sandbox / system prompt 配好，告诉它去哪读）。
> 写入与命令执行仍全程锁死。详见"关键概念 › Manager"与"需求说明 §6"。

---

## 背景

PRD-v2 已经把 Gian 的核心链路定义清楚：用户在 Web UI 里创建 **Session**（绑定一个 Workspace、一个 Executor），与 AI 协作完成单次编程任务。Session 是当前唯一的顶层工作单元。

实际使用中暴露了一类新的缺口：**用户的实际"任务"通常跨多个 Session**。例子：

- "把项目从 React 17 升到 19"——可能拆成 codemod、依赖升级、回归测试三轮 Session，跨好几天。
- "做一个 IM 通知子系统"——可能在 host 工作区里写 Discord adapter，又在 mobile 工作区里调推送，两个 workspace。
- 重启 Session 时，AI 完全不记得上一轮发生了什么。用户要么口头补，要么手动维护 `STATE.md` / `MEMORY.md` / `SESSION_LOG.md`（AGENTS.md 中已有这套约定，但没有工具支持，约束力极弱）。

Session 仍然是 runtime 单位（每个 Session 一个 cc-proxy / codex-proxy 子进程、一段 transcript、可选一棵 worktree）。我们需要在它**之上**加一层轻容器，把"一件事"的多轮 Session 串起来，并自动维护跨 Session 的上下文。

---

## 痛点问题

1. **跨 Session 没有归属**。同一件事的多个 Session 在 sidebar 里只是并列的条目，没有分组、没有顺序、没有进度感知。

2. **上下文需要用户人肉搬运**。Session 结束时，用户得自己总结、写进 `STATE.md`、在下一个 Session 开局复述。绝大多数用户不会真的去做，于是每个新 Session 都是"白板"。

3. **AGENTS.md 中的 `.ai/` 约定没有工具支撑**。`STATE.md` / `MEMORY.md` / `SESSION_LOG.md` / `HANDOFF.md` 这套机制是好的，但全靠 agent 自觉去读、去写，并且当前 gian 根本没在用户的 workspace 里搭这个脚手架。

4. **没有项目级"管家"**。一个跨多 Session 的任务里，用户希望有个常驻的助手——记得整件事的脉络、能提醒下一步、被询问时能给建议——而不是每个 Session 内的、上下文随 Session 死去的助手。

5. **新建 Session 时上下文注入手段单一**。当前只能靠 prompt 框输入。两种 runtime 模式（Structured / TTY）对系统提示的支持差异很大，缺乏一个统一可靠的注入通道。

---

## 目标

引入 **Task** 抽象作为新的顶层工作单元，Session 降为 **Subtask** 的 runtime 载体：

- 用户在 Web UI 中创建 Task（轻量，只需名字和可选描述），然后**边做边加 Subtask**。
- 每个 Subtask 包一个 Session，绑定到某个 Workspace（同一个 Task 下的多个 Subtask **可以分布在不同 Workspace**）。
- 每个 Task 自带一个 **管家（Manager）** 聊天面板，独立于任何 Subtask 的 transcript——用户可以随时和管家对话，让它帮规划、答疑、给路由建议。
- 每个 Workspace 自动获得一套 `.ai/` 上下文脚手架，由 gian 管理。新 Subtask 启动时，gian 自动把相关上下文注入；Subtask 完成时，gian 后台静默地刷新这套上下文。

---

## 非目标

| 不做什么 | 原因 |
|---|---|
| 自动把 Task 拆解成 Subtask 计划 | 用户明确要求"可空开，边做边加"。管家**可以建议**，但不强制、不自动生成。|
| 强制 Subtask 顺序 / 依赖图 | 用户明确要求"任意顺序"。Subtask 之间无前后置。|
| 跨 Task 共享 / 引用 | 一个 Task 是一件事，不与其他 Task 联动。|
| 多人协作、分配、时间跟踪 | Gian 仍是单用户工具。|
| 替换 Session 概念 | Session 仍然是 runtime 单元，只是不再是顶层 nav 入口。|
| 依赖用户安装某个 Claude Code skill | gian 自己搭脚手架、自己注入上下文，不假设用户装了任何 skill。|

---

## 关键概念

### Task
轻容器。一个 Task 表示**用户视角的"一件事"**。字段：

- `id`、`name`、`description?`
- `status`: `open` / `done` / `archived`
- `created_at` / `updated_at`
- 不直接绑定 Workspace。Workspace 归属由其下的 Subtask 决定（一个 Task 下的 Subtask 可分散在多个 Workspace）。

### Subtask
1:1 包裹一个 Session。在现有 Session 字段之外增加：

- `task_id`（必填，指向所属 Task）
- `sort_order`（仅供 UI 展示用，**不** 蕴含执行顺序）
- `summary?`（完成时由 summarizer 自动写入，用户可改）

Session 现有字段保留：`workspace_id`、`executor`、`status`、`worktree_*`、`native_session_id` 等不动。

### Manager（管家）
每个 Task 内置一个管家。它**不是 Subtask**（不承载用户的编程工作），但实现上是一个
**受限只读的 Codex 会话**：

- **模型：Codex `gpt-5.5`，thinking `xhigh`。** 管家是**智能优先**的——它要替用户把整件事
  看明白、给高质量建议，所以宁可贵、慢，也尽量拉满智能（推翻 v0.1 的"Haiku 低成本"设定）。
- **运行**：host 起一个 Codex 会话，cwd 指向 `workspace_root`（这样够得到本 Task 涉及的所有
  Workspace），**sandbox 锁成只读**——可 read / grep 文件，**禁止任何写入和命令执行**。
- **约束靠 sandbox、不靠 prompt（关键，别搞反）**：上面的"只读"是 Codex sandbox 在**权限层硬性**
  保证的——写入 / 命令执行**根本不在可用工具里**，**不是**靠 system prompt 求模型自觉。原因：管家
  要读 `.ai/` 和仓库代码，里面**可能夹带注入指令**（prompt injection），prompt 级的"请只读"形同
  虚设，只有沙箱级硬约束挡得住。`create_subtask` 之外没有任何"动作"工具暴露给它。
- **system prompt 只承担软指引**：告诉它"你是谁、去哪读、用 `create_subtask` 提议而非直接动手"，
  以及内联 subtask 元信息。它塑造行为，但**不承担安全边界**——安全边界全在 sandbox + 工具白名单。
- **读上下文（关键）**：不再"固定注入一小块"，而是用 **Codex 原生文件工具按需翻**。system prompt
  只负责**告诉它去哪读**：本 Task 下各 Subtask 的元信息（name/status/summary/outcome）、涉及
  Workspace 的整套 `.ai/` 文件、以及那些 Workspace 的真实代码。它想看什么就自己 read/grep。
  **我们不为读上下文另造一套工具**。
- **不绑定单一 Workspace**、不开 worktree。有独立聊天面板，长生命周期（对话历史持久化，与 Task 同生死）。
- **能力边界**：可被询问、可主动建议；唯一的"动作"是发一个结构化的 **`create_subtask` 提议**
  （经用户批准后 gian 才真正建 Subtask）。因为是只读 sandbox，它**做不到**直接 创建/启动/完成
  Subtask、改 `.ai/`、跑命令、开 worktree。
- **看不到** Subtask 的完整 transcript（默认；是否开放见待确认项 4）。

### `.ai/` 脚手架（每个 Workspace 一套）
由 gian 在 Workspace 初始化时创建并持续维护：

| 文件 | 用途 | 大小特征 | 加载策略 |
|---|---|---|---|
| `.ai/HANDOFF.md` | 上一个 Subtask 给下一个 Subtask 的交接简报 | 小（一两段） | 新 Subtask 启动时**注入** |
| `.ai/STATE.md` | 当前 Workspace 状态快照 | 小（保持精简） | 新 Subtask 启动时**注入**，有 token 上限，超限截断 |
| `.ai/MEMORY.md` | 长期项目事实 | 慢慢长 | **不**自动加载，agent 按需 Read |
| `.ai/SESSION_LOG.md` | 完成记录（append-only） | 持续膨胀 | **不**自动加载，按需 Read |
| `CLAUDE.local.md` | 极简指针文件（≤10 行），告诉模型 `.ai/` 里有什么 | 永远小 | 由 Claude Code / Codex 原生读取 |

`CLAUDE.local.md` 是 gitignore 的，不动用户已有的 `CLAUDE.md` / `AGENTS.md`。**绝不**通过 `@` import 把会膨胀的文件挂进 CLAUDE.md。

---

## 需求说明

### 1. Task 生命周期

- **创建**：用户在 Task 列表点"新建"，弹出极简表单（只要 name；description 可选）。提交后立即生成空 Task 并跳转到 Task 详情页。**不**强制先建 Subtask。
- **创建（可选高级路径）**：用户可以在新建表单里勾选"和管家聊一下再开始"，进入一段管家引导对话（多轮），结束时管家可建议第一个 Subtask（仍由用户点确认才创建）。
- **完成**：用户在 Task 详情页点"标记完成"。Task 转 `done`。下属未完成的 Subtask 一并标记为 abandoned（带原因）。
- **归档**：`done` 的 Task 可手动 archive；archive 的 Task 默认不显示在主列表，可在筛选里查看。

### 2. Subtask 生命周期

- **创建**：在 Task 详情页点"新建 Subtask"，选 Workspace（默认上一个 Subtask 的 Workspace）、Executor、Approval mode 等——和现有 NewSessionView 几乎一致。**不要求** Task 必须先有其他 Subtask。
- **启动**：Subtask 创建后默认 `draft` 状态，不会自动启动 runtime。用户点"开始"才 spawn proxy session，并触发上下文注入（见下）。
- **完成**：用户点"Mark Complete"。后台异步触发 summarizer（见 LLM 触点）。Subtask 转 `done`。**用户不需要等待**——summarizer 失败时降级到模板写入。
- **放弃**：用户点"Abandon"，给一段简短原因（可选）。Subtask 转 `abandoned`。仅追加一行 SESSION_LOG，**不**写 HANDOFF。

### 3. Workspace 初始化（gian 自动）

用户创建或 adopt 一个 Workspace 时，gian：

1. 检查 `.ai/` 目录，不存在则创建。
2. 写入 `HANDOFF.md` / `STATE.md` / `MEMORY.md` / `SESSION_LOG.md` 的空模板（带头部注释说明用途）。
3. 写入 `CLAUDE.local.md`（gitignore 增加一行）。
4. **不** 覆盖用户已有的 `CLAUDE.md` / `AGENTS.md`。

幂等：再次初始化已存在 `.ai/` 的 Workspace 时只补缺，不动已有内容。

### 4. 上下文注入（新 Subtask 开始时）

读取 `<workspace>/.ai/HANDOFF.md` 和 `<workspace>/.ai/STATE.md`（如有），拼成一段简短的上下文 blob：

- **Structured 模式**（cc-proxy `claude -p` / codex Agent SDK）：作为 system message 通过 proxy API 发出。
- **TTY 模式**（订阅版 claude / 订阅版 codex）：作为**合成的第一条 user message**发到 stdin。这条消息在 transcript 中**对用户可见**（透明，避免黑盒）。

注入内容有 token 上限（初步 ~2k tokens），超限截断 STATE.md。HANDOFF.md 若不存在则跳过。

### 5. 上下文回写（Subtask 完成 / 放弃时）

**完成**：后台异步调用 summarizer（Haiku 直连），输入：

- 当前 Subtask 的 session transcript
- 当前 `.ai/STATE.md`
- 当前 `.ai/HANDOFF.md`

输出：

- 覆盖 `.ai/STATE.md`（新的快照）
- 追加一段到 `.ai/SESSION_LOG.md`（带时间戳和 Subtask 引用）
- 覆盖 `.ai/HANDOFF.md`（给下一个同 workspace 的 Subtask 看）

**放弃**：仅追加一行 SESSION_LOG（`abandoned: <reason>`）。不写 HANDOFF。

失败时降级：summarizer 报错 → 用模板写一段含 Subtask 名/状态的占位记录；用户随时可手改 `.ai/` 文件，gian 写入用 diff 友好的方式（不粗暴覆盖用户编辑——具体策略在设计阶段定，候选方案：保留用户标记块 / 三方合并 / 重命名旧版本备份）。

### 6. 管家（Manager）

每个 Task 一个管家会话，长生命周期。

- 储存：管家的对话历史持久化在数据库里，与 Task 同生死。
- 触发：用户在 Task 详情页的管家面板里发消息，host 起（或复用）一个 **read-only sandbox 的
  Codex 会话**（`gpt-5.5` / `xhigh`，cwd = `workspace_root`），喂给它：
  - 管家 system prompt：描述角色（项目管家，只读、可建议不可执行）；**内联**本 Task 下各 Subtask
    的元信息摘要（name/status/summary/outcome——它存在 DB 里、不是文件，且量小每问都相关，所以
    直接写进 prompt，不为它造工具）；并**指明可深读的位置**——涉及哪些 Workspace、各自 `.ai/` 与
    代码在哪，让 Codex 按需自己 read/grep。
  - 用户当前消息 + 历史对话。
- 读上下文：管家用 **Codex 原生 read / grep 自己去翻** `.ai/` 文件和 Workspace 代码——多轮工具
  调用后再作答。**host 不另造只读工具**，只负责把 cwd / sandbox / system prompt 配好。
- 动作通道：管家若要建 Subtask，通过一个结构化 **`create_subtask` 提议**发出（host 暴露给该
  Codex 会话的唯一"动作"通道，例如一个 MCP 工具）；提议在 UI 上渲染成审批卡，用户可编辑后
  批准 / 拒绝，**批准后才真正创建**。
- 能力边界：sandbox 只读 → 管家**不能**直接创建 / 启动 / 完成 Subtask、不能动 `.ai/`、不能跑命令、
  不能开 worktree。除 `create_subtask` 提议外，所有产出都是文字建议。

### 7. UI 结构（简述）

- **顶层 nav 增加 "Tasks" 模式**，与现有 sessions / spaces / bots 并列。Tasks 视图默认替代 Session 列表成为主要入口（现有 Session 视图作为历史 / 散落 Session 的归档保留）。
- **Task 列表**：左侧栏，按 status / 最近活动排序。
- **Task 详情页**：双栏布局
  - 左：Subtask 列表（卡片视图，能看到 workspace / executor / status，可拖动改 sort_order）
  - 右：管家聊天面板（Composer + Transcript，但消息体走直连 API，不是 cc/codex-proxy）
- **Subtask 详情**：等同于现有的 SessionMain 视图，复用绝大部分组件。Topbar 面包屑显示 `Task > Subtask`。

具体布局、交互细节在后续设计阶段定（mockups 进 `docs/mockups/`）。

---

## Runtime 模式兼容

两种 runtime 模式都必须支持上下文注入和回写：

| 节点 | Structured | TTY |
|---|---|---|
| 注入（新 Subtask 启动） | system message（proxy API） | 合成第一条 user message（stdin） |
| 回写（Subtask 完成） | 后台 Haiku 直连（与 runtime 模式无关） | 同左 |
| 管家对话 | read-only Codex 会话（`gpt-5.5`/`xhigh`，与 Subtask 的 runtime 模式无关） | 同左 |

具体 TTY 注入的实现细节（输入通道、时机、与已规划的 TTY 子系统的衔接）在设计阶段验证，必须在落代码前读完 `docs/runtime-modes/`。

---

## 影响面

| 子系统 | 改动 |
|---|---|
| `packages/shared` | 新增 Task / Subtask 类型；Session 类型增加 `task_id` 字段（向后兼容：可空，旧 Session 视为"散落"） |
| `packages/host` | 新增 Task / Subtask 表（migration）；新增 `task/manager.ts`（起一个 read-only sandbox 的 Codex 会话，cwd=`workspace_root`，暴露 `create_subtask` 提议通道）；新增 `summarizer`（可用 `llm/direct-client.ts` 直连小模型，与管家无关）；扩展 `workspace/init.ts` 写 `.ai/` 脚手架；扩展 `session/manager.ts` 在 Subtask 启动时注入上下文；新增 REST + WS 端点 |
| `packages/web` | 新增 Task 模式与视图；改 NewSessionView 为 NewSubtaskView；新增管家面板组件；改 sidebar 默认显示 Task 列表 |
| `packages/proxies/*` | Subtask 注入走 host 侧（system message 通过现有 createSession 入参传入；TTY 注入走 host 直接控制 stdin）。**新增点**：管家需要 codex 侧支持以**只读 sandbox** 启动一个会话（禁写、禁命令执行）——codex-proxy 是否要新增这种受限会话模式，落代码前定。 |
| 数据迁移 | 旧 Session 在迁移时全部归到一个名为"散落 Session"的特殊 Task 下，或保持 task_id=null 由 UI 视为散落（设计阶段定） |

---

## 待确认项

1. ~~**管家用什么模型**~~（**已定，v0.2**）：默认 **Codex `gpt-5.5` / thinking `xhigh`**，智能优先。仍待定的是**成本控制**：是否给每个 Task 一个管家月度预算 / 让贵模型仅手动触发 / 允许用户降级到便宜模型？以及 Codex 凭据来源（复用现有 codex 登录 vs 新 config）——需要在 Settings UI 中体现。
2. **`.ai/` 写入冲突策略**：用户手改了 STATE.md，正好 summarizer 完成想覆盖——怎么办？候选：用户标记块 / 三方合并 / 备份旧版本到 `.ai/.history/`。设计阶段决定。
3. **散落 Session 迁移**：现有 Session 是直接挂到一个隐藏 Task 下，还是保持 `task_id=null`、由 UI 把它们渲染成一个特殊"散落"分组？
4. **管家与 Subtask 之间的可见性**：管家能不能在用户授权下查看某个 Subtask 的 transcript？默认否。要不要给一个"显式分享"按钮？
5. **Token 上限**：注入内容超 2k tokens 时怎么截断 STATE.md（按段落？按时间倒序？让 summarizer 先压缩？）。

---

## 待细化设计

- Task / Subtask 数据库 schema + migration 顺序
- direct-client（Anthropic 直连）的实现细节，含 streaming、重试、错误降级、prompt caching
- Summarizer 的 prompt 模板与输出 schema（结构化 vs 纯文本）
- `.ai/` 写入的 git-friendly 策略
- TTY 模式下注入第一条 user message 的具体通道
- 管家 UI 的细节：消息样式、是否支持 markdown、是否支持代码块复制
- 数据迁移脚本

---

## 链接

- 主 PRD：`docs/PRD-v2.md`
- Runtime 模式背景：`docs/runtime-modes/`
- 现有 Session 数据模型：`docs/data-model.md`、`packages/shared/src/model.ts:92-128`
- 现有 Workspace 初始化：`packages/host/src/workspace/init.ts`
- 现有 Session 生命周期：`packages/host/src/session/manager.ts`
- AGENTS.md 中 `.ai/` 约定（启发来源）：项目根 `AGENTS.md`
