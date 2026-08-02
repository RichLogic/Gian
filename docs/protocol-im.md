# Host ↔ IM 边界

> 版本 0.3 · 2026-07-31

Discord 和 Slack manager 是 Host 内部的 transport adapter。它们不通过
独立网络协议连接 Host，也不拥有 session、turn、queue、approval 或 model
状态。ADR-0009 是此边界的决策来源。

## 架构

```text
Discord API ─▷ DiscordCodingManager ─┐
                                     ├─▷ MessagingPlatformOptions
Slack API   ─▷ SlackCodingManager ───┘          │
                                                v
                              SessionManager / QueueManager
                              ApprovalManager / Proxy capabilities
```

Host 在 `web/app.ts` 创建两个 manager，并通过 `buildIMOptions` 注入 canonical
domain services。manager 不直接读写 Gian 的 session/turn/queue 表。

## Platform 生命周期

两个 manager 实现同一 `MessagingPlatform`：

```typescript
interface MessagingPlatform {
  readonly platformId: 'discord' | 'slack';
  startAll(): Promise<void>;
  syncBot(botId: string): Promise<void>;
  stopBot(botId: string): Promise<void>;
  shutdown(): Promise<void>;
  sendTurnCompletion(session, thread, turnId): Promise<void>;
  sendApprovalRequested(session, approval): Promise<void>;
  sendSessionError(session, message): Promise<void>;
}
```

- `startAll` 只启动 platform table 中 enabled 的 bot；
- `syncBot` 在 CRUD 后按当前配置 start/stop；
- `shutdown` 由 Host graceful shutdown 调用；
- 通知方法接收 canonical Gian session 的 projection，不查询平台 session。

## 注入的 Domain API

`MessagingPlatformOptions` 是 IM 到 Host 的唯一业务入口：

| 能力 | Canonical 来源 |
|---|---|
| workspace list/get | `workspaces` |
| session list/get/create/update | `SessionManager` |
| start turn | `SessionManager.sendMessage` |
| queue/length/clear | `QueueManager` |
| approval list/resolve | `ApprovalManager` + session response |
| model/effort options | live proxy capabilities |
| interrupt | executor proxy through `SessionManager` |

Kimi 不进入 IM；projection 只接受 Claude/Codex session。

## Bot 选中状态

每个 platform bot 保存：

- owner identity（当前为 single-user local identity）；
- `selected_workspace_id`；
- `selected_session_id`；
- connection status 和 secrets。

`selected_session_id` 直接指向 Gian `sessions.id`。如果选中的 session 已
不存在，shared `session-context.ts` 会清除选择；如果 workspace 只有一个
可用 session，可自动选择并回写 bot。

## 入站消息

平台 manager 把原生事件归一为 `InboundPromptInput`，包含：

- bot/message/channel/author identity；
- text 和 attachment count；
- platform-native reply callback。

处理顺序：

1. 验证 direct-message/channel 与允许用户；
2. 用 platform inbound table 去重；
3. 解析审批回复或 `/new /switch /alter /stop /status` flow；
4. 解析当前 canonical context；
5. idle 时 start turn，busy 时进入 canonical `queue_entries`；
6. transport reply/outbox 只负责平台送达。

附件当前被明确拒绝，不会下载到 Host 或转发 executor。

## 命令流

共享 `command-flows.ts` 和 `interactive-flow.ts` 承载跨平台行为：

| 命令 | 行为 |
|---|---|
| `/new [prompt]` | 选择 workspace/executor 后创建 Gian session，可立即发首条消息 |
| `/switch [session]` | 修改 bot 的 `selected_session_id` |
| `/alter` | 修改 canonical model/mode/thinking |
| `/stop` | interrupt 当前 turn 并清理 canonical queue |
| `/status` | 读取 canonical session、queue、approval 和 model 状态 |

flow 以 bot+channel 隔离，回复 message id 路由，新的 flow 会取消旧 flow，
超时自动取消。

## 出站通知

Host 在 canonical turn 完成、审批产生或 session error 时 fan out 到所有：

- enabled；
- `selected_session_id` 等于目标 session；
- platform policy 允许通知

的 bot。

`presentation.ts` 统一完成：

- turn summary；
- interruption 文案；
- approval reply vocabulary；
- Discord 1900 / Slack 3900 字符分片。

平台 manager 只把这些内容编码为 Discord/Slack SDK 调用。Outbox 可以重试
transport 发送，但重试不得新建 Gian turn。

## 持久化边界

平台拥有：

- `discord_bots` / `slack_bots`；
- `*_inbound_events`；
- `*_outbox`。

Host 拥有：

- `sessions` / `turns` / `events`；
- `queue_entries`；
- `approvals`。

migration 039 删除了旧平台 `*_coding_sessions`,
`*_coding_turns`, `*_coding_queued_turns`。任何新代码重新引入这些镜像都
违反 ADR-0009。
