# Proxy ↔ Host 协议

> 版本 0.2 · 2026-04-26
>
> 基于 cc-proxy / codex-proxy 现有实现。Host 通过 stdio NDJSON 与 Proxy 子进程通信，采用 JSON-RPC 风格的请求-响应 + 异步通知模式。

## 通信基础

- **通道**：stdin（Host → Proxy）/ stdout（Proxy → Host）
- **格式**：NDJSON（每条消息一行 JSON，`\n` 结尾）
- **编码**：UTF-8
- **stderr**：Proxy 的 stderr 由 Host 捕获写入日志，不参与协议

## 消息格式

### 请求（Host → Proxy）

```json
{ "id": 1, "method": "session.create", "params": { "sessionKey": "abc", "cwd": "/path" } }
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| id | number \| string | ✓ | 请求 ID，Proxy 响应时原样返回 |
| method | string | ✓ | 方法名 |
| params | object | ✗ | 方法参数 |

### 成功响应（Proxy → Host）

```json
{ "id": 1, "result": { "session": { ... } } }
```

### 错误响应（Proxy → Host）

```json
{ "id": 1, "error": { "code": "SESSION_NOT_FOUND", "message": "Session not found." } }
```

### 通知（Proxy → Host）

异步事件推送，无 `id` 字段。Host 不需要回复。

```json
{ "method": "turn.started", "params": { "sessionId": "sess_...", ... } }
```

---

## 生命周期

```
Host spawn proxy 进程
       │
       ▼
  Host → initialize              // 握手，获取协议版本和方法列表
  Proxy → { protocolVersion, methods }
       │
       ▼
  Host → capabilities.list       // 获取可用模式、模型、thinking/effort 能力
  Proxy → { modes, models }
       │
       ▼
  Host → session.create          // 创建 Session
  Proxy → { session }
       │
       ▼
  Host → turn.start              // 发送用户消息，开始 Turn
  Proxy → { session, turn }
  Proxy → 通知流（turn.started, output.*, approval.*, turn.completed/failed）
       │
       ▼
  Host → session.close / shutdown  // 关闭
```

---

## 方法

两个 Proxy 实现暴露完全相同的 11 个方法（顺序与 `PROXY_METHODS` 一致）：

| 方法 | 说明 |
|------|------|
| `initialize` | 握手，返回协议版本和支持的方法列表 |
| `capabilities.list` | 返回可用模式、模型及 thinking/effort 能力 |
| `slash.list` | 列出内置 + user-level + 可选 project-level 的 slash 命令 |
| `session.create` | 创建新 Session |
| `session.get` | 查询 Session 状态 |
| `turn.start` | 发送用户消息，启动 Turn |
| `turn.interrupt` | 中断当前 Turn |
| `approval.respond` | 回复审批请求 |
| `session.snapshot` | 获取完整 Session 快照（含 Turn 历史 / Thread 数据） |
| `session.close` | 关闭 Session |
| `shutdown` | 优雅关闭 Proxy 进程 |

---

## 方法详情

### `initialize`

握手。无参数。

**响应**（两个 Proxy 一致）：

```json
{
  "id": 1,
  "result": {
    "mode": "spawn",
    "protocolVersion": "0.1.0",
    "methods": [
      "initialize",
      "capabilities.list",
      "session.create",
      "session.get",
      "turn.start",
      "turn.interrupt",
      "approval.respond",
      "session.snapshot",
      "session.close",
      "shutdown"
    ]
  }
}
```

### `capabilities.list`

获取 Executor 能力。**Proxy 启动时自动探测可用模型**，此方法返回探测结果。

> 这是获取模型列表和 thinking/effort 支持信息的唯一入口。Host 在收到 `capabilities.list` 响应后，才能为 Web UI 的 Model 选择器和 IM 的 `/alter` 命令提供选项。

#### cc-proxy 响应

```json
{
  "id": 2,
  "result": {
    "protocolVersion": "0.1.0",
    "defaultMode": "agent",
    "modes": [
      {
        "id": "agent",
        "description": "Agent execution with permission approval relayed to the upstream client.",
        "approvalBehavior": "relay"
      }
    ],
    "models": [
      {
        "id": "claude-sonnet-4-6",
        "model": "claude-sonnet-4-6",
        "displayName": "Claude Sonnet 4.6",
        "description": "",
        "hidden": false,
        "isDefault": true,
        "defaultEffort": "high",
        "supportedEfforts": ["low", "medium", "high"]
      },
      {
        "id": "claude-opus-4-6",
        "model": "claude-opus-4-6",
        "displayName": "Claude Opus 4.6",
        "description": "",
        "hidden": false,
        "isDefault": false,
        "defaultEffort": "high",
        "supportedEfforts": ["low", "medium", "high", "max"]
      },
      {
        "id": "claude-haiku-4-5-20251001",
        "model": "claude-haiku-4-5-20251001",
        "displayName": "Claude Haiku 4.5",
        "description": "",
        "hidden": false,
        "isDefault": false,
        "defaultEffort": "medium",
        "supportedEfforts": ["low", "medium", "high"]
      }
    ]
  }
}
```

模型探测方式：对每个 alias（sonnet/opus/haiku）spawn 一个临时 `claude -p 'x' --model <alias> --output-format stream-json --verbose` 进程，读取 `system/init` 事件中的 `model` 字段获取完整模型 ID。

#### codex-proxy 响应

```json
{
  "id": 2,
  "result": {
    "protocolVersion": "0.1.0",
    "defaultMode": "safe-agent",
    "modes": [
      {
        "id": "llm",
        "description": "Text-only interaction. Tools are blocked and network escalation is disabled.",
        "toolsEnabled": false,
        "sandbox": "read-only",
        "networkDefault": "deny",
        "networkEscalation": "block",
        "approvalBehavior": "none"
      },
      {
        "id": "safe-agent",
        "description": "Agent execution with proxy-managed approvals and workspace boundaries.",
        "toolsEnabled": true,
        "sandbox": "workspace-write",
        "networkDefault": "deny",
        "networkEscalation": "proxy",
        "approvalBehavior": "proxy"
      },
      {
        "id": "unsafe-agent",
        "description": "Agent execution with approvals relayed upstream.",
        "toolsEnabled": true,
        "sandbox": "workspace-write",
        "networkDefault": "deny",
        "networkEscalation": "relay",
        "approvalBehavior": "relay"
      }
    ],
    "models": [
      {
        "id": "...",
        "model": "...",
        "displayName": "...",
        "description": "...",
        "hidden": false,
        "isDefault": true,
        "defaultThinking": "high",
        "supportedThinking": ["minimal", "low", "medium", "high", "xhigh"]
      }
    ]
  }
}
```

模型探测方式：通过 WebSocket 调用 Codex app-server 的 `model/list` RPC，分页获取。运行时的 `supportedReasoningEfforts` 和 `defaultReasoningEffort` 字段映射为 `supportedThinking` / `defaultThinking`。

#### 模型能力类型定义

```typescript
// cc-proxy
type EffortLevel = 'low' | 'medium' | 'high' | 'max';

interface ModelCapabilities {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  isDefault: boolean;
  defaultEffort: EffortLevel;
  supportedEfforts: EffortLevel[];
}

// codex-proxy
type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

interface ModelCapabilities {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  isDefault: boolean;
  defaultThinking: ThinkingLevel | null;
  supportedThinking: ThinkingLevel[];
}
```

#### 模式能力类型定义

```typescript
// cc-proxy — 单模式
type ProxyMode = 'agent';

interface ModeCapabilities {
  id: ProxyMode;
  description: string;
  approvalBehavior: 'relay';
}

// codex-proxy — 三模式
type ProxyMode = 'llm' | 'safe-agent' | 'unsafe-agent';

interface ModeCapabilities {
  id: ProxyMode;
  description: string;
  toolsEnabled: boolean;
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
  networkDefault: 'deny' | 'allow';
  networkEscalation: 'block' | 'proxy' | 'relay';
  approvalBehavior: 'none' | 'proxy' | 'relay';
}
```

### `session.create`

创建新 Session，绑定到工作目录。

#### cc-proxy

```json
{
  "id": 3, "method": "session.create",
  "params": {
    "sessionKey": "my-session",
    "cwd": "/Users/you/Code/project"
  }
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| sessionKey | string | ✓ | 用户提供的唯一标识符 |
| cwd | string | ✓ | 工作目录绝对路径 |
| mode | `"agent"` | ✗ | 固定为 agent，可省略 |
| model | string | ✗ | 模型 ID，null 时使用默认 |

内部生成 `claudeSessionId`（UUID），用于 Claude CLI 的 `--session-id` / `--resume` 参数。此时不启动进程。

#### codex-proxy

```json
{
  "id": 3, "method": "session.create",
  "params": {
    "sessionKey": "my-session",
    "mode": "safe-agent",
    "cwd": "/Users/you/Code/project",
    "model": "...",
    "thinking": "high"
  }
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| sessionKey | string | ✓ | 用户提供的唯一标识符 |
| mode | ProxyMode | ✓ | 运行模式（默认 safe-agent） |
| cwd | string | ✓ | 工作目录绝对路径 |
| model | string | ✗ | 模型 ID |
| thinking | ThinkingLevel | ✗ | thinking 等级 |

内部调用 `thread/start` RPC 在 Codex app-server 中创建 thread，获取 `threadId`。

#### 响应（结构一致，字段略有差异）

```json
{
  "id": 3,
  "result": {
    "session": {
      "id": "sess_xxxxxxxx",
      "sessionKey": "my-session",
      "mode": "...",
      "cwd": "/Users/you/Code/project",
      "model": null,
      "status": "idle",
      "createdAt": "2026-04-26T10:00:00.000Z",
      "updatedAt": "2026-04-26T10:00:00.000Z",
      "lastError": null
    }
  }
}
```

cc-proxy 额外返回 `claudeSessionId`、`processAlive`。codex-proxy 额外返回 `threadId`、`thinking`。

### `session.get`

查询 Session。通过 sessionId 或 sessionKey 定位。

```json
{ "id": 4, "method": "session.get", "params": { "sessionId": "sess_..." } }
// 或
{ "id": 4, "method": "session.get", "params": { "sessionKey": "my-session" } }
```

### `turn.start`

发送用户消息，启动新 Turn。

#### cc-proxy

```json
{
  "id": 5, "method": "turn.start",
  "params": {
    "sessionId": "sess_...",
    "input": [
      { "type": "text", "text": "Help me implement OAuth 2.0" },
      { "type": "localImage", "path": "/tmp/screenshot.png" }
    ],
    "model": "claude-opus-4-6",
    "securityProfile": "repo-write",
    "approvalMode": "auto"
  }
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| sessionId | string | ✓ | Session ID |
| input | InputItem[] | ✓ | 用户输入（text / localImage） |
| model | string | ✗ | 覆盖本次 Turn 使用的模型 |
| securityProfile | string | ✗ | 安全等级，影响 Claude CLI 的 permission-mode |
| approvalMode | string | ✗ | 审批模式，影响 Claude CLI 的 permission-mode |

**进程模型**：每次 `turn.start` spawn 一个新的 `claude -p` 进程，Turn 结束后进程退出。Session 连续性通过 `--session-id`（首次）/ `--resume`（后续）维持。

**Permission-mode 映射**：

| securityProfile | approvalMode | Claude CLI 参数 |
|-----------------|-------------|----------------|
| `full-host` | 任意 | `--dangerously-skip-permissions` |
| 任意 | `full-auto` | `--dangerously-skip-permissions` |
| `repo-write` | `auto` / `minimal` / `less-interruption` | `--permission-mode acceptEdits` |
| `repo-write` | 其他 | `--permission-mode default` |
| 其他 | 其他 | `--permission-mode default` |

#### codex-proxy

```json
{
  "id": 5, "method": "turn.start",
  "params": {
    "sessionId": "sess_...",
    "input": [
      { "type": "text", "text": "Help me implement OAuth 2.0" }
    ],
    "model": "...",
    "thinking": "high"
  }
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| sessionId | string | ✓ | Session ID |
| input | InputItem[] | ✓ | 用户输入（text / localImage） |
| model | string | ✗ | 覆盖本次 Turn 使用的模型 |
| thinking | ThinkingLevel | ✗ | 覆盖本次 Turn 的 thinking 等级 |

**进程模型**：Codex app-server 为长驻进程，Turn 通过 WebSocket RPC `turn/start` 下发，无需每次 spawn。

#### 响应（一致）

```json
{
  "id": 5,
  "result": {
    "session": { "id": "sess_...", "status": "running", ... },
    "turn": { "id": "turn_...", "status": "running" }
  }
}
```

#### InputItem 类型

```typescript
type InputItem = TextInputItem | LocalImageInputItem;

interface TextInputItem {
  type: 'text';
  text: string;
}

interface LocalImageInputItem {
  type: 'localImage';
  path: string;   // 本地绝对路径
}
```

### `turn.interrupt`

中断当前正在执行的 Turn。

```json
{ "id": 6, "method": "turn.interrupt", "params": { "sessionId": "sess_..." } }
```

cc-proxy：kill 当前 Claude 进程。codex-proxy：调用 `turn/interrupt` RPC。

### `approval.respond`

回复审批请求。

#### cc-proxy

```json
{
  "id": 7, "method": "approval.respond",
  "params": {
    "sessionId": "sess_...",
    "approvalId": "appr_...",
    "behavior": "allow"
  }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| behavior | `"allow"` \| `"deny"` | 审批决策 |

> 注意：cc-proxy 当前的 per-turn 进程模型下 `respondPermission` 实际为 no-op，权限由 CLI flag 控制。

#### codex-proxy

```json
{
  "id": 7, "method": "approval.respond",
  "params": {
    "sessionId": "sess_...",
    "approvalId": "123",
    "decision": "accept",
    "scope": "session"
  }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| decision | `"accept"` \| `"decline"` | 审批决策 |
| scope | `"once"` \| `"session"` | 授权范围（可选，默认 once） |

codex-proxy 根据审批类型调用不同的 Codex app-server 响应：
- `commandExecution` → `{ decision: 'accept' | 'decline' | 'acceptForSession' }`
- `fileChange` → `{ decision: 'accept' | 'decline' | 'acceptForSession' }`
- `permissions` → `{ permissions: {...}, scope: 'turn' | 'session' }`

### `session.snapshot`

获取完整 Session 快照。

```json
{ "id": 8, "method": "session.snapshot", "params": { "sessionId": "sess_..." } }
```

cc-proxy 返回 Session 含 `turns[]` 数组。codex-proxy 返回 Session + Codex 的 `thread` 对象（含 Turn items 详情）。

### `session.close`

关闭 Session。要求无活跃 Turn。

```json
{ "id": 9, "method": "session.close", "params": { "sessionId": "sess_..." } }
```

cc-proxy：kill 进程、移除 Session。codex-proxy：调用 `thread/unsubscribe`、移除 Session。

### `shutdown`

优雅关闭 Proxy 进程。无参数。

```json
{ "id": 10, "method": "shutdown" }
```

Proxy 持久化状态后退出进程。

---

## 通知（Proxy → Host）

Turn 执行期间，Proxy 通过通知推送事件。通知无 `id`，Host 无需回复。

### 通知信封

```typescript
// codex-proxy 的完整信封定义（cc-proxy 无 rawRuntimeEvent）
interface ProxyNotification<T> {
  method: string;
  params: {
    requestId?: number | string;    // 触发此 Turn 的 turn.start 请求 ID
    sessionId: string;
    sessionKey: string;
    turnId?: string;
    data: T;
    rawRuntimeEvent?: {              // codex-proxy 专属，透传原始运行时事件
      method: string;
      params?: unknown;
    };
  };
}
```

### 共有通知

以下通知两个 Proxy 都会发送：

#### `turn.started`

Turn 开始执行。

```json
{
  "method": "turn.started",
  "params": {
    "requestId": 5,
    "sessionId": "sess_...",
    "sessionKey": "my-session",
    "turnId": "turn_...",
    "data": { "turnId": "turn_...", "status": "running" }
  }
}
```

#### `turn.completed`

Turn 正常完成。

**cc-proxy**：

```json
{
  "method": "turn.completed",
  "params": {
    "requestId": 5,
    "sessionId": "sess_...",
    "sessionKey": "my-session",
    "turnId": "turn_...",
    "data": { "status": "completed", "result": "Here's the OAuth implementation..." }
  }
}
```

**codex-proxy**：

```json
{
  "method": "turn.completed",
  "params": {
    "requestId": 5,
    "sessionId": "sess_...",
    "sessionKey": "my-session",
    "turnId": "turn_...",
    "data": {
      "status": "completed",
      "summary": {
        "turnId": "turn_...",
        "status": "completed",
        "assistantText": "Here's the implementation...",
        "commands": [
          { "id": "cmd_...", "command": "npm test", "cwd": "/path", "status": "completed", "exitCode": 0, "aggregatedOutput": "..." }
        ],
        "fileChanges": [
          { "id": "file_...", "status": "completed", "changes": [{ "path": "src/auth.ts", "kind": "update", "diff": "..." }] }
        ],
        "threadPreview": "..."
      }
    }
  }
}
```

#### `turn.failed`

Turn 异常结束。

```json
{
  "method": "turn.failed",
  "params": {
    "requestId": 5,
    "sessionId": "sess_...",
    "sessionKey": "my-session",
    "turnId": "turn_...",
    "data": { "status": "failed", "error": "Claude Code process exited (code=139, signal=null)" }
  }
}
```

#### `approval.requested`

审批请求。Session 阻塞直到 Host 调用 `approval.respond`。

**cc-proxy**：

```json
{
  "method": "approval.requested",
  "params": {
    "requestId": 5,
    "sessionId": "sess_...",
    "sessionKey": "my-session",
    "turnId": "turn_...",
    "data": {
      "approvalId": "appr_...",
      "sessionId": "sess_...",
      "sessionKey": "my-session",
      "requestId": "...",
      "toolName": "Bash",
      "description": "Run npm install",
      "inputPreview": "npm install google-auth-library",
      "createdAt": "2026-04-26T10:01:00.000Z"
    }
  }
}
```

**codex-proxy**（仅 unsafe-agent 模式中继，safe-agent 自动处理）：

```json
{
  "method": "approval.requested",
  "params": {
    "requestId": 5,
    "sessionId": "sess_...",
    "sessionKey": "my-session",
    "turnId": "turn_...",
    "data": {
      "approvalId": "123",
      "sessionId": "sess_...",
      "sessionKey": "my-session",
      "rpcRequestId": 123,
      "method": "item/commandExecution/requestApproval",
      "title": "Approve command execution",
      "risk": "npm install google-auth-library",
      "scopeOptions": ["once", "session"],
      "payload": { ... },
      "createdAt": "2026-04-26T10:01:00.000Z"
    }
  }
}
```

#### `approval.resolved`

审批已处理（包括自动处理的情况）。

**cc-proxy**：

```json
{
  "method": "approval.resolved",
  "params": {
    "sessionId": "sess_...",
    "sessionKey": "my-session",
    "turnId": "turn_...",
    "data": { "approvalId": "appr_...", "behavior": "allow" }
  }
}
```

**codex-proxy**：

```json
{
  "method": "approval.resolved",
  "params": {
    "sessionId": "sess_...",
    "sessionKey": "my-session",
    "turnId": "turn_...",
    "data": { "approvalId": "123", "decision": "accept", "scope": "once", "auto": true }
  }
}
```

`auto: true` 表示由 Proxy 根据模式策略自动处理（safe-agent 模式下的命令自动批准等）。

#### `debug`

调试信息。

```json
{ "method": "debug", "params": { "message": "[runtime] Discovering available models..." } }
```

### cc-proxy 专有通知

#### `output.text`

Turn 完成时的 AI 完整回复文本。在 `turn.completed` 之前发送。

```json
{
  "method": "output.text",
  "params": {
    "requestId": 5,
    "sessionId": "sess_...",
    "sessionKey": "my-session",
    "turnId": "turn_...",
    "data": { "text": "I've implemented the OAuth 2.0 flow..." }
  }
}
```

#### `tool.use`

AI 调用了一个工具。从 Claude stream-json 的 `assistant` 事件中 `tool_use` content block 提取。

```json
{
  "method": "tool.use",
  "params": {
    "requestId": 5,
    "sessionId": "sess_...",
    "sessionKey": "my-session",
    "turnId": "turn_...",
    "data": { "toolName": "Edit", "input": { "file_path": "src/auth.ts", ... } }
  }
}
```

### codex-proxy 专有通知

#### `output.text.delta`

AI 文本流式片段。

```json
{
  "method": "output.text.delta",
  "params": {
    "requestId": 5,
    "sessionId": "sess_...",
    "sessionKey": "my-session",
    "turnId": "turn_...",
    "data": { "delta": "I'll implement the", "itemId": "item_01" },
    "rawRuntimeEvent": { "method": "item/agentMessage/delta", "params": { ... } }
  }
}
```

#### `output.command.delta`

命令执行输出流式片段。

```json
{
  "method": "output.command.delta",
  "params": {
    "requestId": 5,
    "sessionId": "sess_...",
    "sessionKey": "my-session",
    "turnId": "turn_...",
    "data": { "delta": "> vitest run\n ✓ auth.test.ts", "itemId": "item_02" },
    "rawRuntimeEvent": { "method": "item/commandExecution/outputDelta", "params": { ... } }
  }
}
```

#### `diff.updated`

文件变更通知。

```json
{
  "method": "diff.updated",
  "params": {
    "requestId": 5,
    "sessionId": "sess_...",
    "sessionKey": "my-session",
    "turnId": "turn_...",
    "data": { "params": { ... } },
    "rawRuntimeEvent": { "method": "turn/diff/updated", "params": { ... } }
  }
}
```

#### `token_usage.updated`

Session 级 Token 用量更新。Host 将其持久化到 session metadata，不写入
transcript events，也不借此刷新 session 排序时间。

```json
{
  "method": "token_usage.updated",
  "params": {
    "requestId": 5,
    "sessionId": "sess_...",
    "turnId": "turn_...",
    "data": {
      "context": { "used": 63000, "window": 258000 },
      "conversation": {
        "mode": "absolute",
        "inputTokens": 1129236,
        "outputTokens": 14930,
        "cachedInputTokens": 382000,
        "totalTokens": 1144166
      }
    }
  }
}
```

`context` 是可替换的当前窗口状态；`context: null` 表示手动或 provider
自动 compact 后旧 numerator 已失效。`conversation.mode` 可为 provider-authoritative
`absolute`、每 turn 仅可应用一次的 `delta`，或 session rotation 的
`reset`。Codex proxy 为保留 app-server wire fidelity，仍可转发
`data.params.tokenUsage`；Host 必须用 `last.totalTokens`（不是
`last.inputTokens`）作为当前 context，并用 `total` 作为累计值。
Claude proxy 用 assistant message 的 input + cache token 作为当前
context；容量优先取 result `modelUsage.contextWindow`，旧 CLI 缺失时
只可使用 detected model id 的显式 `[1m]` marker，不得默认猜 200k。
conversation delta 优先聚合 result `modelUsage` 的 whole-tree token
breakdown，旧 CLI 没有该 breakdown 时才回退顶层 `result.usage`。
Compact/summarization 自身产生的 usage 不是 post-compact context：
Claude proxy 必须识别 native `system/compact_boundary`、清除此前缓存的
assistant context，并丢弃手动 compact turn 的 `context`（可保留
conversation delta）。Codex proxy 必须识别 `contextCompaction` item；
item 运行期间的 summarization/recompute sample 不可信，自动 compact
只接受 item 完成后的下一条真实 model usage，手动 compact 等下一次普通
turn。Kimi proxy 同样抑制 compact turn 的 ACP `usage_update`，再用捕获
且不进入 transcript 的 `/status` 结果替换 context。

#### `runtime.error`

运行时错误（非 Turn 级别的 Proxy 错误）。

```json
{
  "method": "runtime.error",
  "params": {
    "sessionId": "sess_...",
    "sessionKey": "my-session",
    "data": { "message": "..." }
  }
}
```

---

## Session 状态机

两个 Proxy 使用相同的状态枚举：

```typescript
type SessionStatus = 'idle' | 'running' | 'needs-approval' | 'stale' | 'closed' | 'error';
```

```
                    turn.start
            ┌────────────────────────┐
            │                        ▼
          idle ◁── turn.completed ── running ──▷ needs-approval
            ↑                        │                │
            │        turn.failed     │    approval.respond
            └────────────────────────┘                │
            └─────────────────────────────────────────┘

  idle / running ──(session.close)──▷ closed

  running / needs-approval ──(proxy restart)──▷ stale

  running ──(process crash / runtime error)──▷ error
```

| 状态 | 说明 |
|------|------|
| `idle` | 就绪，无活跃 Turn |
| `running` | Turn 执行中 |
| `needs-approval` | 等待审批回复 |
| `stale` | Proxy 重启后未恢复的 Session（上次 running/needs-approval） |
| `closed` | 用户主动关闭 |
| `error` | 进程崩溃或运行时错误 |

### Proxy 重启后的状态恢复

两个 Proxy 都使用 `state.json` 文件持久化 Session（原子写入：先写临时文件再 rename）。重启时：

1. 加载 `state.json` 中的所有 Session
2. 将 `running` / `needs-approval` 状态的 Session 标记为 `stale`
3. 清除 `activeTurnId`
4. cc-proxy：设置 `processAlive = false`
5. codex-proxy：设置 `hydrated = false`，后续需 `thread/resume` 恢复

---

## 错误码

| 代码 | HTTP 语义 | 说明 |
|------|----------|------|
| `INVALID_REQUEST` | 400 | 参数缺失或无效 |
| `SESSION_NOT_FOUND` | 404 | Session 不存在 |
| `APPROVAL_NOT_FOUND` | 404 | 审批记录不存在 |
| `SESSION_ALREADY_EXISTS` | 409 | sessionKey 重复 |
| `SESSION_BUSY` | 409 | 已有活跃 Turn，或关闭前需先停止 Turn |
| `SESSION_CLOSED` | 409 | Session 已关闭，不能操作 |
| `SESSION_STALE` | 409 | codex-proxy：Thread 不可用（需 resume 或新建） |
| `SESSION_ERROR` | 409 | codex-proxy：Session 处于 error 状态 |
| `PROCESS_SPAWN_FAILED` | 500 | Executor 进程启动失败 |
| `INTERNAL_ERROR` | 500 | 内部错误 |

---

## Executor 差异总结

| 维度 | cc-proxy (Claude Code) | codex-proxy (Codex) |
|------|----------------------|---------------------|
| 进程模型 | 每 Turn spawn `claude -p` 进程 | 长驻 `codex app-server` + WebSocket |
| 运行模式 | 单模式 `agent` | `llm` / `safe-agent` / `unsafe-agent` |
| 能力字段名 | `defaultEffort` / `supportedEfforts` | `defaultThinking` / `supportedThinking` |
| 等级枚举 | `low` / `medium` / `high` / `max` | `minimal` / `low` / `medium` / `high` / `xhigh` |
| turn.start 额外参数 | `securityProfile` / `approvalMode` | `thinking` |
| 审批参数 | `behavior: allow / deny` | `decision: accept / decline` + `scope: once / session` |
| 审批策略 | 所有审批均中继 | 按 mode 分层（none / proxy 自动 / relay 中继） |
| 流式通知 | 无流式（Turn 结束后一次性 output.text） | 有流式（output.text.delta / output.command.delta） |
| Session 绑定 | `claudeSessionId`（UUID） | `threadId`（Codex thread） |
| Session 恢复 | `--resume <claudeSessionId>` | `thread/resume` RPC |
| 模型探测 | spawn 临时进程读 init 事件 | `model/list` RPC 分页查询 |

---

## 迁移指南

### 目录映射

| 现有文件 | Gian 目标路径 | 说明 |
|---------|-------------|------|
| `cc-proxy/src/cli/spawn.ts` | `packages/proxy/claude/index.ts` | 入口，读 stdin 分发 RPC |
| `cc-proxy/src/core/service.ts` | `packages/proxy/claude/service.ts` | 业务逻辑，基本平移 |
| `cc-proxy/src/runtime/claude-mcp-runtime.ts` | `packages/proxy/claude/runtime.ts` | Claude CLI spawn + stream-json 解析 |
| `cc-proxy/src/runtime/types.ts` | `packages/proxy/claude/runtime-types.ts` | 运行时事件接口 |
| `codex-proxy/src/cli/spawn.ts` | `packages/proxy/codex/index.ts` | 入口 |
| `codex-proxy/src/core/service.ts` | `packages/proxy/codex/service.ts` | 业务逻辑，基本平移 |
| `codex-proxy/src/core/capabilities.ts` | `packages/proxy/codex/capabilities.ts` | model/list → ModelCapabilities 映射 |
| `codex-proxy/src/core/modes.ts` | `packages/proxy/codex/modes.ts` | 模式定义 |
| `codex-proxy/src/runtime/codex-app-server-client.ts` | `packages/proxy/codex/runtime.ts` | WebSocket 客户端 |
| `codex-proxy/src/runtime/types.ts` | `packages/proxy/codex/runtime-types.ts` | 运行时事件接口 |

### 共享模块 → `packages/proxy/shared/`

以下模块在两个项目中实现一致，直接提取复用：

| 模块 | 说明 |
|------|------|
| `protocol.ts` | `writeJsonLine` / `protocolError` / `createProtocolWriter`，代码完全一致 |
| `state-store.ts` | `JsonStateStore`，JSON 文件原子读写，逻辑一致 |
| `errors.ts` | `AppError` 类和 `createAppError` 工厂，一致 |
| `input.ts` | `normalizeInputItems`，InputItem 校验 + localImage 路径 resolve，一致 |
| `utils.ts` | `randomId`（`sess_`/`turn_`/`appr_` 前缀 ID 生成）、`nowIso`，一致 |
| `types.ts` | 共用类型提取：`SessionStatus`、`InputItem`、`InitializePayload`、`JsonRpcLikeRequest` |

### 迁移步骤

1. **初始化 monorepo**：在 `packages/proxy/` 下创建 `shared/`、`claude/`、`codex/` 三个子包
2. **提取 shared**：从两个项目中提取完全一致的模块，合并共用类型
3. **平移 cc-proxy**：`service.ts` + `runtime.ts` 基本原样迁入，调整 import 路径指向 shared
4. **平移 codex-proxy**：`service.ts` + `runtime.ts` + `capabilities.ts` + `modes.ts` 基本原样迁入
5. **适配入口**：`spawn.ts` 的 CLI 参数（`--data-dir`、`--codex-bin`）改由 Host ProxyManager spawn 时传入

### 不需要改动的部分

- Service 层核心逻辑（session/turn/approval 状态机）
- Runtime 层（Claude CLI spawn 逻辑、Codex WebSocket 客户端）
- 模型探测逻辑
- 通知输出（已经是 stdout NDJSON）
- 状态持久化

### 需要改动的部分

| 改动点 | 说明 |
|--------|------|
| `--data-dir` 路径 | 由 Host ProxyManager 统一分配（如 `$GIAN_DATA_DIR/proxy/<executor>/`），通过 CLI 参数传入 |
| Executor 可执行文件路径 | `CLAUDE_BIN` / `CODEX_BIN` 环境变量由 Host 设置，或通过 CLI 参数传入 |
| 进程信号处理 | 保留 SIGINT/SIGTERM graceful shutdown，Host 通过 `shutdown` RPC 或信号关闭 Proxy |
