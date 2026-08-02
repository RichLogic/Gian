# Gian 需求文档

> 版本 0.3 · 2026-04-23
> 前身项目：remote-vibe-coding

---

## 背景

remote-vibe-coding 是一个个人开发的工具，用 Web UI 代理本机的 Codex 和 Claude Code CLI，实现浏览器远程操控 AI 编程工具。核心链路已跑通：Session 管理、消息收发、IM 通知（Discord/Slack）。

该项目以原型速度开发，Session 内的交互体验定义模糊，跨通道存在竞态问题，代码结构不适合开源发布。现在要将其重构为 Gian — 一个 self-hosted、单用户的 AI 编程代理 Web 前端。

---

## 痛点问题

1. **Session 内事件展示不清晰**。AI 的回复、命令执行、文件编辑、审批请求混在一起，没有分类和差异化渲染。用户无法快速判断"AI 正在做什么"。

2. **命令执行过程不可见**。底层 Executor 支持命令输出的流式推送，但前端没有利用。用户只能等命令跑完才能看到输出。

3. **文件变更没有 diff 视图**。底层能提供文件变更的 diff 数据，但 UI 没有渲染。用户看不到 AI 改了文件的哪些行。

4. **Claude Code 中间过程缺失**。当前实现丢弃了 Claude Code 的思考过程、文字流式输出等中间事件。用户在 Claude Code Session 中感知不到 AI 正在做什么，只能等最终结果。

5. **Claude Code 审批不阻塞**。UI 上展示了审批卡片，但实际 Claude Code 并不会等待用户决策，审批形同虚设。

6. **审批跨通道竞态**。Web UI 和 IM 可以同时对同一个 Approval 做出响应，没有互斥机制，可能导致重复响应。（已简化：IM 不做审批，审批只在 Web 端处理）

7. **IM 信息过载**。IM 通道展示与 Web 完全一致的信息量。在手机上收到大量低价值事件通知（文件读取、搜索等），阅读体验差。

8. **缺少语音输入**。移动端或远程操作时打字不便，没有语音转文字能力。

---

## 目标

用户部署 Gian 后，通过浏览器访问 Web UI：

- 创建 Session，选择 Workspace 和 Executor（Codex / Claude Code），开始与 AI 对话
- 在 Transcript 中看到 AI 的每一步操作以结构化事件卡片呈现：文字回复、命令执行（含实时输出）、文件编辑（含 diff）、搜索、思考过程
- 敏感操作需要审批时，看到醒目的审批卡片，点击 Accept / Decline 即可继续
- 在 IM 上只收到精简的关键信息：AI 回复摘要、错误通知
- 可以用语音输入 prompt（转写 + 格式化后回显到输入框，确认后发送）

---

## 非目标

| 不做什么 | 原因 |
|---------|------|
| 多用户 | self-hosted 单用户场景，认证保持简单 |
| 代码编辑 | 不是 IDE，文件预览为只读，编辑通过 AI 完成 |
| 扩展 CLI 能力 | 只做 Web 层代理和可视化，不替代底层 CLI |
| 定义视觉规范 | UI 设计正在单独制作中，PRD 只定义信息架构和交互规则 |

---

## 需求范围

**本版本覆盖**：

- Session 内 12 种统一事件的定义、Web UI 渲染规则、IM 简化展示规则
- Workspace 管理（目录列表、默认 Executor、审批分类与风险等级）
- 文件浏览（独立 Files Tab，Changed / Tree 双视图，文件预览）
- 审批工作流（跨通道同步、消除竞态、风险等级、键盘快捷键）
- IM 集成（Discord / Slack，Bot 双模式、Native Slash Commands）
- 语音输入（语音转文字 + 排版优化）
- Job Mode — 多 Turn 自动执行（见§需求说明·八）
- 全局功能（Command Palette、Pending Approvals 聚合、Runner 状态）
- 隧道与远程访问配置（Cloudflare Tunnel / Tailscale / 反向代理）
- 认证与安全

**本版本不覆盖**：
- Skills — Role Preset 的升级版，可叠加指令片段 `[待定]`
- Chat Mode — 纯对话模式 `[延后]`

---

## 关键概念

| 概念 | 定义 |
|------|------|
| Executor | 底层 AI 编程工具实例（Codex 或 Claude Code） |
| Workspace | 一个本地目录（通常是 git repo），Executor 的执行上下文边界 |
| Session | 用户与 AI 的持续对话。绑定 Workspace + Executor（Chat Session 延后） |
| Turn | Session 内一次"用户提问 → AI 执行 → AI 回复"循环 |
| Event | Turn 内的原子操作记录，是 Transcript 的最小展示单元 |
| Approval | Executor 执行敏感操作时暂停并等待用户授权的阻塞机制 |
| Job | 多 Turn 自动执行模式。AI 完成一个 Turn 后自动发起下一个，持续执行直到任务完成或达到停止条件 |
| Transcript | Session 的时间线视图，按时间顺序展示所有 Event |
| Inspector | Transcript 右侧的文件预览面板，点击文件路径即可打开 |
| Command Palette | 全局快速跳转面板（⌘K），可搜索 Session、文件、命令 |
| Runner | Gian 后端服务进程，运行在用户本机，Web UI 通过 WebSocket 与之通信 |

层级关系：`Workspace → Session → Turn → Event`

---

## 需求说明

### 一、Session 内事件体系

> 这是整个产品交互的核心。

定义 12 种统一事件类型。不论底层使用哪个 Executor，事件模型统一。用户消息不在此列，它由 Composer 和 IM 入口直接处理，在 Transcript 中以消息气泡展示。

#### 1. assistant_text — AI 文字回复

AI 生成的自然语言回复，流式到达。一个 Turn 可能产生多段文字（穿插在工具调用之间）。

- **页面表现**：Markdown 渲染，逐块打字效果。代码块可复制，文件路径可跳转 Inspector
- **IM 展示**：Turn 完成后发送最终文本
- **Codex**：`agentMessage/delta` 逐句推送
- **Claude Code**：stream-json `assistant` 事件的 `text` block 逐块推送

#### 2. thinking — AI 思考过程

AI 内部推理链，帮助用户理解决策依据。

- **页面表现**：灰色折叠条 "Thinking..."，默认收起，展开显示推理文本
- **IM 展示**：不展示
- **Codex**：不支持
- **Claude Code**：stream-json `assistant` 事件的 `thinking` block

#### 3. command_execution — 命令执行

AI 执行 shell 命令。含命令文本、stdout/stderr、退出码。

- **页面表现**：Tool 卡片。等宽字体命令文本 + 状态徽标（running/success/error）。输出默认折叠，支持流式时实时追加
- **IM 展示**：命令文本 + 退出状态
- **Codex**：`commandExecution` item，输出通过 `outputDelta` 流式推送
- **Claude Code**：`Bash` tool_use，tool_result 含完整输出

#### 4. file_change — 文件编辑

AI 创建/修改/删除文件。含文件路径和 unified diff。

- **页面表现**：Tool 卡片。"Changed N files" + 文件路径。默认折叠，展开显示 diff（绿色增/红色删）。路径可跳转 Inspector
- **IM 展示**：变更文件路径列表
- **Codex**：`turn/diff/updated` 推送 diff，也可通过 `readThread()` 批量获取
- **Claude Code**：`Write`/`Edit`/`NotebookEdit` tool_use

#### 5. file_read — 文件读取

AI 读取文件内容。含路径和行范围。

- **页面表现**：紧凑 Tool 卡片，标题为文件路径 + 行范围。路径可跳转 Inspector
- **IM 展示**：不展示
- **Codex**：无独立事件（嵌在 Turn 历史中）
- **Claude Code**：`Read` tool_use

#### 6. file_search — 文件搜索

AI 按文件名或内容搜索代码库。

- **页面表现**：紧凑 Tool 卡片，标题为搜索 pattern + 匹配数。默认折叠，展开显示匹配列表
- **IM 展示**：不展示
- **Codex**：无独立事件
- **Claude Code**：`Glob`/`Grep` tool_use

#### 7. web_search — 网页搜索

AI 搜索网页获取外部信息。

- **页面表现**：紧凑状态行，显示搜索查询文本
- **IM 展示**：不展示
- **Codex**：`webSearch` item
- **Claude Code**：`WebSearch` tool_use

#### 8. agent_spawn — 子 Agent

AI 启动子 Agent 并行处理子任务。

- **页面表现**：状态行，显示任务描述 + 运行状态（running/done）
- **IM 展示**：不展示
- **Codex**：不支持
- **Claude Code**：`Agent` tool_use

#### 9. approval_requested — 审批请求

AI 执行敏感操作前暂停等待授权。**阻塞事件** — 响应前 Executor 不继续。类别：command / network / file_write_outside_ws / other。

- **页面表现**：审批卡片（高亮区分）。显示操作类别 + 风险等级徽标（low/medium/high） + 描述。三个按钮：Allow Once / Allow Session / Decline（快捷键 A / ⇧A / D）。自动滚动到可见区域。low risk 自动批准
- **IM 展示**：不展示（IM 通道强制 auto 模式，审批自动批准）
- **Codex**：JSON-RPC server request，proxy 持有 response 阻塞
- **Claude Code**：通过 `--permission-prompt-tool` 指定 MCP tool 拦截权限请求，阻塞等待返回

#### 10. approval_resolved — 审批结果

用户批准/拒绝，或系统按 Approval 模式自动决策。Executor 解除阻塞。

- **页面表现**：审批卡片就地更新。批准→绿色 Approved / 拒绝→红色 Declined，按钮消失
- **IM 展示**：确认消息
- **Codex**：proxy 回复 RPC response
- **Claude Code**：同上，MCP tool 返回 allow/deny 后 Executor 继续

#### 11. turn_completed — Turn 完成

Turn 执行结束。turns=1 时如有排队消息自动开始下一个；turns>1（Job Mode）时自动发起下一个 Turn。

- **页面表现**：活动指示器消失。无独立视觉元素。Job Mode 下更新全局进度条的 Turn 计数
- **IM 展示**：turns=1 时不展示。Job Mode（turns>1）下发送 Turn 摘要 + "⏳ 继续执行中"标记
- **Codex**：`turn/completed` 通知，附带汇总
- **Claude Code**：stream-json `result` 事件

#### 12. session_error — 错误

Executor 崩溃、API 报错、超时等异常。

- **页面表现**：红色错误横幅 + 错误摘要。可重试时附带"重试"按钮
- **IM 展示**：错误消息
- **Codex**：`error` 通知
- **Claude Code**：进程异常退出时 runtime 生成

---

> 部分 Executor 内部状态变化事件（如 Codex 的 `item/started`、`item/completed`、`thread/status/changed`）不单独展示，其信息已体现在 Tool 卡片的状态徽标变化中。

**Context Compact 指示器**：在 Composer 下方的 Context 栏展示 token 用量（当前 / 总量）和 compact 进度条。接近 compact 阈值时变色提醒，compact 发生时展示通知。

---

### 二、通道接管与审批工作流

#### 通道接管机制

同一时间只有一个通道（Web / IM）拥有 Session 的控制权。Web 始终为默认接管方。

**接管规则**：

| 场景 | 行为 |
|------|------|
| 用户在 Web 发消息 | Web 接管 |
| 用户在 IM 发消息（Bot 为 Full control 模式） | IM 接管 |
| 新建 Session | 创建通道默认接管 |

**IM Bot 模式**（决定 IM 通道的能力范围，在 Bot 配置中设置）：

| 模式 | 事件推送 | 发送消息 | 接管能力 |
|------|---------|---------|---------|
| Read-only mirror | assistant_text + session_error | ✗ | ✗ |
| Full control (takeover) | 完整事件流 | ✓ | ✓ |

> IM 通道强制使用 auto 审批模式。IM 接管 Session 时，所有审批自动批准，不在 IM 展示审批卡片。

**非接管方的展示**：

| 通道身份 | 展示 |
|---------|------|
| Web（IM 接管中） | 顶部横幅："IM 正在控制此 Session" + [接管] 按钮。Transcript 只读可回看，每轮 assistant_text 实时追加 |
| IM（Web 接管中） | 按 Bot 模式推送对应子集的事件 |

**接管对事件推送的影响**：

| 事件 | 接管方 | 非接管方 |
|------|-------|---------|
| assistant_text | ✓ | ✓（仅 Turn 完成后） |
| command_execution | ✓ | ✗ |
| file_change | ✓ | ✗ |
| approval_requested | ✓（Web 可操作；IM 自动批准） | ✗ |
| approval_resolved | ✓ | ✗ |
| session_error | ✓ | ✓ |
| 其他过程事件 | ✓ | ✗ |

#### 审批工作流

审批请求只在 Web 端展示。IM 接管时强制 auto 模式，所有审批自动批准。

Approval 模式（用户可在 Session 中切换）：

| 模式 | 审批行为 | 适用场景 |
|------|---------|---------|
| default | 按风险等级决定是否需要手动审批 | 严格控制 |
| auto | 所有操作自动批准 | 日常编码、大型任务 |

**Turn 数量**：

auto 模式附带 `turns` 参数（默认 1）：

| turns | 行为 |
|-------|------|
| 1 | 单 Turn：用户发一条消息，AI 完成一个 Turn 后等待下一条 |
| N > 1 | 多 Turn（Job Mode）：AI 完成一个 Turn 后自动发起下一个，最多执行 N 个 Turn |

> default 模式固定为单 Turn（turns=1）。turns > 1 仅在 auto 模式下可用。

**审批分类与风险等级**：

每个 Workspace 为以下 4 个审批分类配置默认风险等级（low / medium / high）：

| 分类 | 说明 | 建议默认 |
|------|------|---------|
| command | Executor 要执行的 shell 命令 | medium |
| network | 出站 HTTP/DNS 请求 | medium |
| file_write_outside_ws | 写入 Workspace 目录之外的文件 | high |
| other | 未归类的插件 / MCP tool 请求 | medium |

> Workspace 内的文件编辑是 AI 编码的核心操作，不触发审批。仅写入 Workspace 外的文件时触发。

**风险等级在 default 模式下的行为**：

| 风险等级 | default 模式行为 |
|---------|----------------|
| low | 自动批准，审批卡片显示为 "Auto-approved (low risk)" |
| medium | 弹出审批卡片，需要用户手动决策 |
| high | 弹出高亮审批卡片，需要用户手动决策 |

> auto 模式下，所有风险等级均自动批准。

**审批响应选项**（仅在 default 模式下、medium/high 风险等级时触发）：

| 响应 | 含义 | 快捷键 |
|------|------|-------|
| Allow Once | 仅批准本次操作，后续同类操作仍需审批 | `A` |
| Allow Session | 本 Session 内同类操作（同 category）自动批准，不再弹审批 | `⇧A` |
| Decline | 拒绝本次操作 | `D` |

Allow Session 生效后，该 category 的后续审批请求自动 resolve，审批卡片直接显示为 "Auto-approved" 状态。

### 三、消息队列

用户可以在 AI 执行当前 Turn 时提前排队下一条消息：

- 排队消息在 Transcript 底部以编号列表展示，标题 "QUEUED N · sent serially after current turn"
- Turn 完成后自动启动下一个排队消息
- 用户可对排队消息执行：编辑、删除、上移、下移（调整执行顺序）
- "Send now" — 立即发送队列中所有消息（跳过当前 Turn 完成的等待）
- "Clear" — 清空所有排队消息
- Web UI 和 IM 都可以向队列添加消息

### 四、Workspace 管理

> Spaces 页的交互布局和操作流程待细化设计。以下定义功能范围和数据结构。

Workspace 在独立的 Spaces Tab 中管理。

| 操作 | 说明 |
|------|------|
| 列表 | 展示所有可用 Workspace（本地目录），显示根路径和关联 Session 数量 |
| 创建 | 关联已有目录，或创建新目录 |
| 删除 | 删除 Workspace 关联（不删除实际文件） |
| 排序 | 用户自定义排列顺序（上移/下移） |

**Workspace 属性**：

| 属性 | 说明 |
|------|------|
| Name | Workspace 名称 |
| Local path | 本地目录路径 |
| Default executor | 默认 Executor（Codex / Claude Code），创建 Session 时预选 |
| Git remote | Git 远程仓库地址（自动检测） |
| Default branch | 默认分支（自动检测） |
| Approval categories | 审批分类的默认风险等级（见§二） |

**Workspace 关联 Sessions 列表**：

Workspace 详情页底部展示所有关联 Session 的名称、Executor、状态和时间。

约束：
- Workspace 根目录可配置（默认 `~/Coding`）
- 不暴露根目录之外的文件系统

### 五、IM 集成

> Bots 页的交互布局和操作流程待细化设计。以下定义功能范围和数据结构。

IM 是 Web UI 的辅助通道。Bot 在独立的 Bots Tab 中管理。

**支持平台**：
- Discord — Bot 账号，DM 或 channel 交互
- Slack — Slack App，DM 或 channel mention

#### Bot 配置

每个 Bot 实例包含以下配置：

| 属性 | 说明 |
|------|------|
| Label | Bot 显示名称 |
| Platform | Discord / Slack |
| Bot token | 平台 token，加密存储 |
| Default workspace | 默认绑定的 Workspace |
| Mode | 工作模式（见§二 Bot 模式表） |
| Allowed user IDs | 允许使用该 Bot 的用户 ID 白名单（逗号分隔） |
| Channels | 允许 Bot 响应的频道列表（留空则全部） |

Bot 状态展示连接状态（connected / offline）和最后活跃时间。

支持配置多个 Bot 实例，每个 Bot 可绑定不同 Workspace。

#### Bot 管理页面

Bots Tab 包含以下子页面：

| 子页面 | 说明 |
|-------|------|
| Config | 连接信息、工作模式、权限配置 |
| Permissions | 细粒度权限管理 |
| IM preview | 实时预览 IM 消息样式，可切换 Discord / Slack 查看效果 |
| Logs | Bot 运行日志，附计数徽标 |

#### IM 事件展示规则

取决于 Bot 模式（见§需求说明·二）：

| Bot 模式 | 展示事件 |
|---------|---------|
| Read-only mirror | assistant_text（Turn 完成后）、session_error |
| Full control（接管方） | 完整事件流（审批自动批准，不展示审批卡片） |
| Full control（非接管方） | assistant_text（Turn 完成后）、session_error |

#### IM 通道约束

- **仅支持 DM 消息**。Bot 只响应私聊消息，不在频道/群组中响应
- Slack 命令带可配置前缀（如 `/gian-new`、`/gian-switch`），避免与其他 Bot 冲突

#### IM 命令

使用平台 Native Slash Commands（Discord Application Commands / Slack Slash Commands）。

| 命令 | 类型 | 功能 |
|------|------|------|
| `/new` | 引导式 | 创建 Session |
| `/switch` | 引导式 | 切换到已有 Session |
| `/alter` | 引导式 | 修改 Session 设置 |
| `/stop` | 即时 | 停止当前 Turn + 清空队列 |
| `/status` | 即时 | 查看当前 Session 状态 |
| 普通消息 | — | 作为 prompt 发送到当前 Session（仅 Full control 模式） |

#### 引导式命令流程

引导式命令采用多步交互：Bot 发送编号菜单，用户回复编号选择。每步超时 5 分钟未回复则自动取消。

**`/new` — 创建 Session**

```
1. Bot: "选择 Agent：\n0. 取消\n1. Codex\n2. Claude Code"
   用户回复编号
2. Bot: "选择 Workspace：\n0. 取消\n1. remote-vibe-coding\n2. codex-proxy\n..."
   用户回复编号
3. Bot: "输入 Session 名称：\n0. 取消\n1. 使用默认名称\n或直接输入自定义名称"
   用户回复编号或文本
→ Bot: "✅ 已创建 Session: [name]\nAgent: [executor] | Mode: [mode] | Model: [model]"
```

**`/switch` — 切换 Session**

```
1. Bot: "选择 Workspace：\n0. 取消\n1. remote-vibe-coding (3 sessions)\n2. codex-proxy (2 sessions)"
   用户回复编号
2. Bot: "选择 Session：\n0. 取消\n1. Implement OAuth flow ● Running — codex / gpt-5-codex\n2. Fix reconnect ● Done — claude / sonnet-4.6"
   用户回复编号
→ Bot: "✅ 已切换到 [name]（[workspace]）"
```

**`/alter` — 修改设置**

```
1. Bot: "修改什么？\n0. 取消\n1. Model\n2. Mode\n3. Thinking"
   用户回复编号
2. 根据选择进入子流程：
   - Model: 显示可用模型列表，标记当前选择 → 回复编号切换
   - Mode: 显示 Default / Auto → 回复编号切换
   - Thinking: 显示 effort 等级列表 → 回复编号切换
→ Bot: "✅ [设置项] 已切换为 [新值]"
```

无效回复不推进流程，Bot 回复 "无效选择，请重新输入。"，用户重新回复。

#### 即时命令

**`/stop`**：停止当前 Turn 并清空消息队列。无活动任务时回复 "当前没有正在执行的任务。"

**`/status`**：显示当前 Bot 状态：

```
Bot: connected
Workspace: remote-vibe-coding
Session: Implement OAuth flow ● Running
Agent: codex
Mode: default
Model: gpt-5-codex
Thinking: medium
Queue: 2
```

#### 普通消息处理

用户在 DM 中发送的非 Slash 消息作为 prompt 发送给当前 Session：

| 状态 | 行为 |
|------|------|
| Session 空闲 | 立即开始 Turn |
| Session 正在执行 | 消息排入队列，回复 "⏳ 已收到，当前正在执行任务，已帮你排队。" |
| 队列中已有消息 | 追加到队列，回复 "⏳ 已收到，前面还有 N 个待执行任务，已加入队列。" |
| 无选中 Session | 提示用户先 `/new` 或 `/switch` |

#### 消息回复与动态交互

**回复定位**：
- Discord：Bot 回复使用 quote reply（引用原消息），用户回复引导流程时也使用 quote reply
- Slack：Bot 回复使用 thread（线程），引导流程的多步交互在同一线程内完成

**Emoji 反应**（仅 Discord）：
- Bot 收到用户 prompt 后，对原消息添加 👀 反应，表示已接收

**动态状态消息**（仅 Discord）：
- Turn 执行中，Bot 发送一条状态消息并每 4 秒编辑更新，循环展示不同阶段提示（"正在阅读代码..."、"正在修改..."、"正在跑检查..."等）
- 同时每 8 秒发送 typing indicator
- Turn 完成后，状态消息编辑为最终结果

**Turn 完成通知**：

根据完成状态选择标题：

| 状态 | 标题 |
|------|------|
| 正常完成 | ✅ 已完成 |
| 执行失败 | ❌ 执行失败 |
| 达到上限 | ⚠️ 已达到轮数上限 |
| 用户停止 | 🛑 已停止 |

通知包含标题 + 工作目录 + Turn 摘要内容。

#### IM 消息规则

- 长度限制：Discord 1900 字符、Slack 3900 字符
- 超长消息在换行符处切割，避免截断代码块
- 代码块保持 Markdown 格式

### 六、语音输入

**流程**：
1. 用户在 Composer 按住语音按钮录音
2. 前端录制音频发送到后端
3. 后端语音转文字（STT）
4. 后端 LLM 优化排版（修正口语、添加标点、格式化代码术语）
5. 返回前端，回显到 Composer 输入框（不直接发送）
6. 用户确认/编辑后手动发送

**延迟目标**：录音结束到文字回显 < 3 秒（短句场景）。

**STT 引擎**：可配置，支持云端 API 或本地模型。LLM 排版可复用 Executor 模型或独立配置轻量模型。

**语言选择**：STT 引擎支持语言选择（auto / 指定语言），在 Settings 中配置。

### 七、文件浏览（Files Tab）

独立的顶级 Tab，提供 Workspace 内文件的只读浏览和预览。**不提供任何写操作**，文件编辑只通过 AI 在 Session 中完成。

**双视图模式**：

| 视图 | 说明 |
|------|------|
| Changed | 当前 Session 修改过的文件列表，按变更类型标记（M=修改, A=新增, D=删除），徽标显示变更文件数 |
| Tree | 传统文件树，懒加载展开 |

顶部有 Workspace 选择器，可切换查看不同 Workspace 的文件。

**文件预览**：

- 语法高亮 + 行号
- 文件元信息：语言类型、行数、今日编辑次数、uncommitted 状态
- 支持 diff 视图
- "Open in new tab" 按钮：在新浏览器标签页中打开文件预览，方便全屏查看

约束：
- 完全只读，无任何写交互（无 accept、无编辑、无保存）
- 不暴露 Workspace 根目录之外的文件系统
- Changed 视图与当前活跃 Session 关联

> Spaces 页、Bots 页和 Settings 页的详细功能设计见各自章节，当前设计稿中的布局待细化。

---

### 八、Job Mode（多 Turn 自动执行）

用户在 auto 模式下将 turns 设为 N（N>1）后，Session 进入 Job Mode。AI 完成一个 Turn 后自动发起下一个 Turn，持续执行直到满足停止条件。

**停止条件**：

| 条件 | 行为 |
|------|------|
| AI 主动完成 | AI 判断任务已完成，正常结束 |
| 用户手动停止 | 用户点击 Stop 按钮或发送 `/stop` |
| 达到 Turn 上限 | 执行 Turn 数达到用户设定的 `turns` 值，自动停止 |
| 达到 Token 上限 | 累计 token 用量超限，自动停止 |
| 连续错误 | 遇到错误时尝试继续；连续错误超过 Turn 上限时停止 |

**Web UI 展示**：

- **全局进度条**：Transcript 顶部固定区域，显示：当前 Turn 序号 / Turn 上限、已执行操作数、已消耗 token
- **Turn 分隔**：每个 Turn 之间有明显分隔线 + Turn 编号标记
- **Stop 按钮**：Job 执行期间始终可见，固定在 Composer 位置
- **完成状态**：Job 结束后进度条显示终态（完成原因：AI 完成 / 用户停止 / 达到上限 / 错误）

**IM 展示**：

- 每个 Turn 完成后发送一条摘要消息，末尾标注 `⏳ 继续执行中 Turn N/M`
- Job 结束时发送最终汇总（完成原因 + Turn 数 + 总操作数）
- 遇到错误时发送错误信息（但不暂停，尝试继续）

### 九、Chat Mode（纯对话） `[延后]`

> 本版本不实现。后续版本再设计纯对话模式（不调用 Executor 工具，仅多轮对话）。

### 十、认证与安全

单用户 self-hosted，认证保持简单：

- 用户名 + 密码登录
- Token 认证（API 调用、IM Bot 关联）
- 密码加密存储
- Cookie 维持登录状态

安全约束：
- IM Bot token 加密存储
- Approval 机制防止 AI 无授权执行敏感操作
- Workspace 边界隔离，不暴露根目录外文件

**域名与远程访问**：
- 在 Settings 中配置 Public URL（远程访问地址）
- 支持四种隧道模式：None (LAN only) / Cloudflare Tunnel / Tailscale Funnel / Reverse proxy
- Force HTTPS 开关
- 认证在隧道之上仍然生效，无 session cookie 的请求返回 401

**部署方式**：
- 系统守护进程部署（Linux: systemd / macOS: launchd）
- 进程崩溃自动重启
- 提供安装脚本自动注册守护进程

---

## 界面与交互

### Top Bar

全局顶栏，始终可见：

| 元素 | 说明 |
|------|------|
| Logo | "Gian" 品牌标识，点击回到 Coding Tab |
| 连接状态 | 展示各组件连接状态（见下方"连接状态指示"） |
| 当前 Workspace | 显示 "Workspace: xxx" 前缀 + 名称 |
| Command Palette | ⌘K 打开。可搜索：Session（按名称）、文件（按路径）、命令（Gian + Executor 命令）。模糊匹配，键盘导航 |
| Pending Approvals | 徽标显示所有 Pending 状态 Session 的数量。点击展开审批列表，可快速跳转到对应 Session |
| Settings | 打开设置面板 |
| 用户头像 | 显示当前登录用户 |

#### 连接状态指示

Top Bar 左侧区域展示各组件的连接状态。每个组件显示为图标 + 状态点：

| 组件 | 状态点 | 说明 |
|------|--------|------|
| Codex | 🟢 绿 / 🔴 红 | codex-proxy 进程是否存活 |
| Claude Code | 🟢 绿 / 🔴 红 | cc-proxy 进程是否存活 |
| Discord | 🟢 绿 / 🔴 红 / ⚫ 灰 | Bot 连接状态（灰色 = 未配置） |
| Slack | 🟢 绿 / 🔴 红 / ⚫ 灰 | Bot 连接状态（灰色 = 未配置） |

**交互**：

- 点击连接状态区域展开状态面板，显示各组件详情（版本号、延迟、最后活跃时间、错误信息）
- 断连的组件旁显示 **Reconnect** 按钮，点击触发重连
- Proxy 组件的 Reconnect 重新 spawn 子进程；IM 组件的 Reconnect 重新建立平台 API 连接

**WebSocket 断连**（浏览器与 Host 之间）：

- 断连时 Top Bar 变为警告样式，显示 "Disconnected · Reconnecting..."
- 自动重连（指数退避：1s → 2s → 4s → ... → 30s）
- 重连成功后全量状态同步，Transcript 补齐断连期间的事件
- 重连期间 Composer 禁用，Transcript 只读

### Navigation Tabs

左侧垂直导航栏，四个顶级 Tab：

| Tab | 说明 |
|-----|------|
| Coding | Session 列表 + Transcript + Inspector（核心工作区） |
| Files | 文件浏览与预览（见§七） |
| Spaces | Workspace 管理（见§四） |
| Bots | IM Bot 管理（见§五） |

### Coding Tab 面板布局

Coding Tab 由三个面板组成，从左到右：

| 面板 | 层级 | 内容 | 可隐藏 |
|------|------|------|-------|
| Session 列表 | 二级 | Session 筛选、分组、卡片列表 | ✓ |
| Transcript | 三级 | 事件时间线 + Composer | ✗（始终可见） |
| Inspector | 四级 | 文件预览 | ✓ |

- 相邻面板之间的分隔线可拖拽调整宽度
- 二级（Session 列表）可折叠隐藏，通过顶栏 Logo 旁的按钮或快捷键切换
- 四级（Inspector）可关闭，通过 Transcript 顶部的 Inspector 按钮或点击文件路径打开

### Session 列表

Coding Tab 左侧栏（二级面板）。

#### Session 状态

| 状态 | 含义 | 颜色 | 卡片展示 |
|------|------|------|---------|
| New | 新建 Session 或 Reset 后，等待用户首条消息 | — | 不显示状态标签 |
| Running | AI 正在执行 Turn | 蓝色 | 🔵 Running（Job Mode 时附加 "Turn 3/20"） |
| Pending | 等待用户审批 | 黄色 | 🟡 Pending |
| Error | 执行出错 | 红色 | 🔴 Error |
| Done | 单轮或多轮 Turn 全部完成 | 绿色 | 🟢 Done |

> `archived` 不是状态，而是可见性标记。归档的 Session 从默认列表隐藏。

#### 固定区域：Needs you

Pending 和 Error 状态的 Session 从分组中抽出，固定在列表最顶部的 "Needs you" 区域。无待处理 Session 时该区域隐藏。

#### 筛选

筛选缩小 Session 范围（多个条件 AND 组合）：

| 筛选维度 | 选项 | 默认 |
|---------|------|------|
| Workspace | All / 具体某个 Workspace | All |
| 活跃时间 | All / Today / 7 days / 30 days | All |

#### 分组

分组决定筛选结果的组织方式（Needs you 区域始终置顶，不受分组影响）：

| 分组方式 | 分组标签 | 说明 |
|---------|---------|------|
| Time（默认） | Today / Yesterday / This week / Earlier | 按最后活跃时间分段 |
| Workspace | 各 Workspace 名称 | 按所属 Workspace 聚类 |
| Status | Running → Done | 按状态排列（此时 Needs you 合并为 Pending → Error 组） |

组内排序：始终按最后活跃时间倒序。

#### Session 卡片

| 元素 | 说明 |
|------|------|
| 名称 | Session 名称 |
| 状态标签 | Running / Pending / Error / Done（New 不显示标签） |
| Executor | codex / claude |
| Workspace | 所属 Workspace 名称（按 Workspace 分组时隐藏） |
| 时间 | 相对时间（3m / 12m / 1d / 3d） |
| IM 标记 | IM 通道接管中时显示 "IM" 标签 |

#### 归档

- Session 可归档，归档后从默认列表隐藏
- 列表底部 "Archived (N)" 可展开查看
- 归档不改变 Session 状态，仅影响列表可见性

#### 操作入口

- "+ New" 按钮创建新 Session
- Session 卡片右键 / 长按弹出菜单：重命名、归档、Reset、删除

### Transcript Timeline

Transcript 是 Session 的核心视图，以时间线展示所有 Event。

- 最大宽度 720px 居中
- 事件按时间顺序从上到下排列
- 用户消息和 AI 回复均做 Markdown 渲染（标题、列表、代码块、链接等）
- 每个 Turn 内事件连续展示，Turn 之间有视觉分隔
- 初始加载最近 40-60 条 Event
- 向上滚动触发加载更早 Event（分页）
- 新 Event 实时追加到底部
- Session 顶部显示开始标记（如 "14:32 · Opened with Codex"）

### Tool 卡片

工具调用类事件（command_execution、file_change、file_read、file_search）使用统一的 Tool 卡片容器：

```
┌─ [icon] 标题文本 ────────────── [status badge] ─┐
│  (折叠的内容区)                                   │
│  > Click to expand                               │
└──────────────────────────────────────────────────┘
```

- 标题行：图标 + 工具描述 + 状态徽标（running / success / error）
- 内容区：默认折叠，展开显示完整输出
- file_change 特殊处理：展开显示 unified diff，行级着色

### 流式更新

- assistant_text 实时流式渲染（逐块出现）
- Turn 执行中显示活动指示器（脉冲动画点）
- Scroll 策略：用户在底部时自动跟随；用户手动上滚时固定位置

### Session Composer

Session 底部的输入区域：

- 多行文本输入，Enter 发送，Shift + Enter 换行
- 文件附件上传按钮
- 语音输入按钮（见§需求说明·六）
- Slash 命令按钮（`/`）：点击 `/` 弹出 Executor 原生命令列表
- 发送按钮（↵）

**Composer 工具栏**：

| 元素               | 说明                                                   |
| ---------------- | ---------------------------------------------------- |
| Model 选择器        | 当前模型名 + thinking effort 指示器，点击切换                     |
| Approval mode 切换 | DEFAULT / AUTO 二态切换。AUTO 时显示 turns 数值（默认 1），可调整      |
| Slash 命令         | `/` 按钮，弹出当前 Executor 原生命令列表（如 `/clear`、`/compact` 等） |
| 文件附件             | 📎 按钮，上传文件                                           |
| 语音输入             | 🎙 按钮，按住录音                                           |
| 发送               | ↵ 按钮                                                 |

**Context 栏**（Composer 下方）：

| 元素 | 说明 |
|------|------|
| Token 用量 | 显示当前 / 总量（如 "28.4k / 200k"） |
| Compact 进度条 | 可视化 token 使用比例，接近阈值时变色 |
| Auto-compact 阈值 | 显示 compact 百分比（如 "compact 90%"）和剩余 token |
| Session 菜单 | `...` 按钮，包含重命名、归档、Reset、删除等操作 |

**语音交互**：
- 录音中：按钮变为红色脉冲 + 时长计数
- 处理中：按钮变为 loading 状态
- 完成后：文字填入输入框，光标定位到末尾

### Inspector

Transcript 右侧可调整宽度的面板：

- 点击 Transcript 中的文件路径 → Inspector 打开该文件
- 语法高亮
- 支持 diff 视图
- 可手动浏览 Workspace 文件树

### Session 生命周期

```
创建 → 选择 Workspace → 选择 Executor → (可选)命名、选 model
  ↓
活跃使用 → 发送消息 → Turn 执行 → 查看 Transcript → 处理 Approval
  ↓
管理 → 重命名 / 归档 / Reset / 删除
```

Session 状态机：

| 当前状态 | 触发 | 目标状态 |
|---------|------|---------|
| New / Done / Error | 用户发送消息 | Running |
| Running | Turn 正常完成（turns=1 或已达 turns 上限） | Done |
| Running | Turn 正常完成（turns>1，未达上限，继续下一 Turn） | Running |
| Running | Job 结束（AI 完成 / 用户停止 / Token 超限 / 连续错误） | Done |
| Running | 需要审批（default 模式） | Pending |
| Running | 执行出错 | Error |
| Pending | 用户 Accept / Decline | Running |
| Error | 用户重试或发新消息 | Running |
| 任意状态 | 用户 Reset | New（强制终止 Executor） |

> 归档不改变状态。归档是独立的可见性标记，任何状态的 Session 都可以归档/取消归档。

### Slash 命令透传

Composer 中输入 `/` 时弹出当前 Executor 的原生命令列表（如 `/clear`、`/compact` 等 CLI 原生命令）。用户选择后直接透传给 Executor 执行。

> Web UI 不提供 Gian 自身的 Slash 命令。Session 管理操作（重命名、归档、Reset 等）通过 Session 菜单和 Command Palette 完成。

Executor 原生命令的响应在 Transcript 中展示为系统消息（非 Turn 事件）。

### Session Reset

Session 卡死或异常时的恢复手段：

- 强制终止当前 Executor 进程
- 丢弃当前未完成的 Turn
- 重置 Session 状态为 New
- 保留历史 Transcript

入口：Session 菜单中的 Reset 按钮，或 IM `/reset` 命令。

### 文件附件

Composer 支持文件附件上传，附件随消息发送给 Executor。

| 属性 | 规则 |
|------|------|
| 支持类型 | 任意文件类型，分三类处理：image / pdf / 其他 |
| 大小限制 | 单文件 20MB |
| 存储位置 | Workspace 下 `.gian-attachments/` 目录 |
| 上传方式 | 文件选择器 + 剪贴板粘贴 |

**发送给 Executor 的方式**：
- 图片：发送文件路径，Executor 直接读取
- PDF：提取文字内容，作为上下文发送
- 文本类文件（代码、markdown、json 等）：提取文字内容，作为上下文发送
- 二进制文件：发送文件路径 + 文件元信息

附件在发送前可移除，发送后不可删除。

---

## 字段与规则

### Session 字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| id | UUID | 是 | 自动生成 |
| name | string | 否 | 用户自定义名称，缺省时自动生成 |
| type | enum | 是 | `coding`（`chat` 延后） |
| workspace | string | 是 | 用户选择的项目目录 |
| executor | enum | 是 | `codex` / `claude-code` |
| model | string | 否 | 当前使用的模型，null 时使用 Executor 默认模型 |
| approval_mode | enum | 是 | `default` / `auto`，默认 `default` |
| turns | integer | 是 | auto 模式下的最大 Turn 数，默认 1。大于 1 时进入 Job Mode |
| active_channel | enum | 否 | `web` / `im`，当前接管通道。用户在某通道发消息时自动更新 |
| status | enum | 是 | `new` / `running` / `pending` / `error` / `done`，默认 `new` |
| archived | boolean | 是 | 是否归档，默认 false。归档仅影响列表可见性，不改变状态 |
| created_at | datetime | 是 | 自动生成 |
| updated_at | datetime | 是 | 每次状态变更时更新 |

### Event 字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| id | UUID | 是 | 自动生成 |
| session_id | UUID | 是 | 所属 Session |
| turn_id | UUID | 是 | 所属 Turn |
| type | enum | 是 | 12 种事件类型之一 |
| data | JSON | 是 | 事件数据，结构取决于 type |
| created_at | datetime | 是 | 自动生成 |

### Approval 字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| id | UUID | 是 | 自动生成 |
| session_id | UUID | 是 | 所属 Session |
| turn_id | UUID | 是 | 所属 Turn |
| category | enum | 是 | `command` / `network` / `file_write_outside_ws` / `other` |
| risk_level | enum | 是 | `low` / `medium` / `high`（取自 Workspace 配置） |
| description | string | 是 | 操作描述 |
| status | enum | 是 | `pending` / `approved` / `approved-session` / `auto-approved` / `declined` |
| resolved_by | enum | 否 | `web` / `im` / `auto`（由哪个通道处理） |
| resolved_at | datetime | 否 | 处理时间 |

### 配置项

> Settings 页的交互布局待细化设计。以下定义配置项范围和默认值。

**系统与网络**（环境变量 + Settings UI）：

| 配置项 | 环境变量 | 默认值 | Settings UI |
|--------|---------|--------|------------|
| 监听地址 | `GIAN_HOST` | `127.0.0.1` | ✓ |
| 监听端口 | `GIAN_PORT` | `8990` | ✓ |
| 数据目录 | `GIAN_DATA_DIR` | `~/.config/gian/` | ✓ |
| Workspace 根 | `GIAN_WORKSPACE_ROOT` | `~/Coding` | ✓ |
| 认证用户名 | `GIAN_AUTH_USERNAME` | — | ✓ |
| 认证密码 | `GIAN_AUTH_PASSWORD` | 首次启动随机生成 | ✓ |
| Public URL | `GIAN_PUBLIC_URL` | —（留空使用 LAN 地址） | ✓ |

**Executor**（环境变量 + Settings UI）：

| 配置项 | 环境变量 | 默认值 | Settings UI |
|--------|---------|--------|------------|
| Codex 路径 | `GIAN_CODEX_BIN` | 系统 PATH | ✓（含版本显示） |
| Claude Code 路径 | `GIAN_CC_BIN` | 系统 PATH | ✓（含版本显示） |

**语音（STT）**（Settings UI）：

| 配置项 | 说明 |
|--------|------|
| STT 引擎 | 下拉选择（OpenAI Whisper API / 其他） |
| STT 语言 | 下拉选择（auto / 具体语言） |
| STT API Key | 加密存储 |

**远程访问**（Settings UI）：

| 配置项 | 说明 |
|--------|------|
| Tunnel mode | None (LAN only) / Cloudflare Tunnel / Tailscale Funnel / Reverse proxy |
| Tunnel ID | Cloudflare Tunnel / Tailscale 的 tunnel 标识 |
| Force HTTPS | 开关，强制 HTTPS 访问 |

**外观**（Settings UI）：

| 配置项 | 选项 |
|--------|------|
| Theme | Light / Warm / Dark |
| Accent | 4 种强调色 |
| Density | Compact / Cozy / Roomy |
| Language | 中文 (zh-CN) / English（仅 UI 字符串，Transcript 内容不变） |

---

## 影响面

### 从 remote-vibe-coding 迁移

| 方面 | 现状 | 改动 |
|------|------|------|
| 命名空间 | `rvc_` / `RVC_` | `gian_` / `GIAN_` |
| 配置目录 | `~/.config/remote-vibe-coding/` | `~/.config/gian/` |
| 事件模型 | 模糊的 transcript entry | 12 种统一 Event |
| IM 展示 | 与 Web 同质 | 明确的简化规则 |
| Approval | 跨通道竞态 | 单一队列，跨通道同步 |
| 语音输入 | 无 | 语音转文字 + 排版优化 |
| 国际化 | 硬编码中文 | i18n 支持（中/英） |

---

## 待确认项

1. **Skills**：Role Preset 升级为 Skills 体系（可叠加的指令片段 vs 带工具的触发式 Skill）`[待定]`
2. **Slash 命令透传**：Executor 原生命令列表需要整理，部分命令（如 `/compact`）可能需要特殊处理（展示 compact 通知）
3. **Files Tab - Changed 视图范围**：Changed 视图显示的变更范围是当前 Session 的修改、还是 git uncommitted changes？需要确认 scope
4. ~~**Bot Queue approvals 完整流程**~~：已简化，IM 不做审批，强制 auto 模式

## 待细化设计

以下页面功能定义已完成，但交互布局和操作流程需要在设计稿中细化：

1. **Spaces 页**：Workspace 列表与详情的交互、审批分类风险等级的配置方式、Git 信息展示
2. **Bots 页**：Bot 配置的表单布局、Mode 切换交互、IM preview 的实现方式、Logs 查看器
3. **Settings 页**：内容分组与导航（内容量较大，当前侧滑面板可能不够）、Tunnel 配置的引导流程
