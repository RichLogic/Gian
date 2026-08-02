# Host ↔ Web 协议

> 版本 0.2 · 2026-07-31
>
> Web 前端通过 WebSocket 与 Host 双向通信。
> `packages/shared/src/web.ts` 是完整且权威的可执行契约；本文仅记录核心流程。

## 连接

### 端点

```
ws://{host}:{port}/ws
```

默认 `ws://127.0.0.1:8990/ws`。

### 认证

WebSocket 连接建立后，Client 发送的第一条消息必须是 `auth`：

```json
{
  "type": "auth",
  "token": "session-cookie-value"
}
```

Host 验证通过后回复：

```json
{
  "type": "auth_ok",
  "user": "rich"
}
```

验证失败则关闭连接（close code 4001）。

### 认证后

认证成功后 Host 立即发送 `state_sync`（全量状态），之后进入正常消息交换。

---

## 消息信封

所有消息共享以下结构：

```typescript
interface WsMessage {
  type: string;          // 消息类型
  [key: string]: any;    // 类型特定字段
}
```

---

## Server → Client 消息

### `state_sync` — 全量状态同步

连接建立后、或重连后发送。Client 收到后用此数据完全替换本地状态。

```json
{
  "type": "state_sync",
  "runner": {
    "host": "mbp-16.local",
    "latency": 12,
    "started_ago": "4h",
    "agents": 2,
    "disk": "134 GB free",
    "codex_version": "v1.0.4",
    "cc_version": "v0.8.2",
    "ws_root": "~/Coding"
  },
  "sessions": [ /* Session[] */ ],
  "workspaces": [ /* Workspace[] */ ],
  "bots": [ /* Bot[] */ ],
  "approvals": [ /* Approval[] */ ],
  "config": { /* SystemConfig */ }
}
```

各数据结构详见 [data-model.md](data-model.md)。

### `event` — 实时事件

Proxy 上报的事件保留原生名称和 payload，Host 只附加可选的页面展示投影。

```json
{
  "type": "event",
  "session_id": "s1",
  "turn": 1,
  "call_id": "at_01",
  "provider": "codex",
  "event": "output.text.delta",
  "ts": 1714012321000,
  "data": {
    "delta": "I'll implement the OAuth 2.0 flow."
  },
  "display": {
    "type": "message",
    "data": {
      "text": "I'll implement the OAuth 2.0 flow.",
      "delta": true,
      "itemId": "at_01"
    }
  }
}
```

`event/data` 是 provider-native source of truth；`display` 只描述当前 UI。
未知事件也可以发送，此时省略 `display`，页面应忽略但 Host 会保留原始证据。
一个原生事件影响多个页面区域时可以发送多个 envelope，`event/data` 相同而
`display` 不同。旧 history 行可能没有 `provider/display`，由读取边界兼容。

完整分类见 [chat-event-display.md](chat-event-display.md)。

以下两个 shape 是早期 Host-generated history 的兼容示例，不是新 CLI 的
统一事件规范；新链路应保留实际 source event 并附加 Interaction/State display。

#### Legacy `approval_resolved`

```json
{
  "type": "event",
  "session_id": "s1",
  "turn": 1,
  "call_id": "ares_01",
  "event": "approval_resolved",
  "ts": 1714012332000,
  "data": {
    "approval_id": "apr_01",
    "category": "command",
    "title": "Run shell command",
    "command": "npm install google-auth-library",
    "decision": "approved",
    "resolved_by": "web"
  }
}
```

#### Legacy `system_notice`

```json
{
  "type": "event",
  "session_id": "s1",
  "turn": 1,
  "call_id": "sn_01",
  "event": "system_notice",
  "ts": 1714012333000,
  "data": {
    "kind": "slash-result",
    "text": "Compacted 47 messages → summary; 18.2k tokens reclaimed."
  }
}
```

### `session:updated` — Session 状态变更

Session 字段变化时推送。Client 用 `id` 定位并合并更新。

```json
{
  "type": "session:updated",
  "session": {
    "id": "s1",
    "status": "running",
    "active_channel": "web",
    "model": "gpt-5-codex",
    "updated_at": "2026-04-25T14:32:00Z"
  }
}
```

只包含变更的字段 + `id`。

### `session:created` — 新 Session

```json
{
  "type": "session:created",
  "session": { /* 完整 Session 对象 */ }
}
```

### `session:deleted` — Session 删除

```json
{
  "type": "session:deleted",
  "session_id": "s1"
}
```

### `approval:created` — 新审批

```json
{
  "type": "approval:created",
  "approval": {
    "id": "apr_01",
    "session_id": "s1",
    "category": "command",
    "description": "npm install google-auth-library",
    "status": "pending"
  }
}
```

### `approval:updated` — 审批状态变更

```json
{
  "type": "approval:updated",
  "approval": {
    "id": "apr_01",
    "status": "approved",
    "resolved_by": "web",
    "resolved_at": "2026-04-25T14:33:00Z"
  }
}
```

### `queue:updated` — 队列变更

推送完整队列（队列通常很短，全量推送更简单）。

```json
{
  "type": "queue:updated",
  "session_id": "s1",
  "queue": [
    { "id": "q1", "text": "Add session token refresh logic." },
    { "id": "q2", "text": "Write unit tests for the callback endpoint." }
  ]
}
```

### `bot:updated` — Bot 状态变更

```json
{
  "type": "bot:updated",
  "bot": {
    "id": "b1",
    "online": true,
    "last_msg": "1m ago"
  }
}
```

### `runner:updated` — Runner 状态变更

```json
{
  "type": "runner:updated",
  "runner": {
    "latency": 15,
    "agents": 3,
    "disk": "130 GB free"
  }
}
```

---

## Client → Server 消息

### `session:create` — 创建 Session

```json
{
  "type": "session:create",
  "name": "Implement OAuth flow",
  "workspace_id": "gian",
  "executor": "codex",
  "model": "gpt-5-codex",
  "approval_mode": "default"
}
```

Host 创建 Session 后回复 `session:created`。

### `message:send` — 发送消息

```json
{
  "type": "message:send",
  "session_id": "s1",
  "text": "Help me implement OAuth 2.0 login flow.",
  "attachments": []
}
```

Host 将消息转发给 Proxy。如果 Session 当前正在执行 Turn，消息进入队列。

### `approval:resolve` — 审批决策

```json
{
  "type": "approval:resolve",
  "approval_id": "apr_01",
  "decision": "allow_once"
}
```

| decision | 说明 |
|----------|------|
| `allow_once` | 仅本次批准 |
| `allow_session` | 本 Session 同类自动批准 |
| `decline` | 拒绝 |

### `session:stop` — 停止当前 Turn

```json
{
  "type": "session:stop",
  "session_id": "s1"
}
```

### `session:rename` — 重命名

```json
{
  "type": "session:rename",
  "session_id": "s1",
  "name": "OAuth implementation"
}
```

### `session:archive` — 归档/取消归档

```json
{
  "type": "session:archive",
  "session_id": "s1",
  "archived": true
}
```

### `session:delete` — 删除 Session

```json
{
  "type": "session:delete",
  "session_id": "s1"
}
```

### `session:set_mode` — 切换审批模式

```json
{
  "type": "session:set_mode",
  "session_id": "s1",
  "approval_mode": "auto"
}
```

### `session:set_model` — 切换模型

```json
{
  "type": "session:set_model",
  "session_id": "s1",
  "model": "o3-mini"
}
```

### `queue:add` — 添加队列消息

```json
{
  "type": "queue:add",
  "session_id": "s1",
  "text": "Write unit tests for the callback endpoint."
}
```

### `queue:remove` — 移除队列消息

```json
{
  "type": "queue:remove",
  "session_id": "s1",
  "queue_id": "q1"
}
```

### `queue:reorder` — 队列排序

```json
{
  "type": "queue:reorder",
  "session_id": "s1",
  "order": ["q2", "q1"]
}
```

### `queue:send_now` — 立即发送队列

```json
{
  "type": "queue:send_now",
  "session_id": "s1"
}
```

### `queue:clear` — 清空队列

```json
{
  "type": "queue:clear",
  "session_id": "s1"
}
```

---

## 重连策略

1. WebSocket 断开后 Client 自动重连（指数退避：1s → 2s → 4s → ... → 30s）
2. 重连后重新发送 `auth`
3. 认证成功后 Host 发送 `state_sync` 全量同步
4. Client 丢弃本地状态，用 `state_sync` 完全替换

> 单用户场景下全量同步足够简单且可靠。不需要事件序列号或增量同步。

## 心跳

- Host 每 30 秒发送 WebSocket ping frame
- Client 未收到 ping 超过 60 秒视为断连，触发重连
- Client 也可主动发送 ping 检测连接状态
