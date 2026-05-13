# codex-proxy

`codex-proxy` 是一个给 Codex 会话用的 `spawn + stdio(JSONL)` 代理层。

## 第一部分：给 Vibe-Coding 的接入说明

### 1. 启动服务

```bash
npm install
npm run build
npm start
```

等价命令：

```bash
node dist/cli/spawn.js --data-dir /abs/path/to/state --codex-bin /abs/path/to/codex
```

可选参数：

- `--data-dir`：状态目录，默认 `./.codex-proxy`
- `--codex-bin`：`codex` 可执行文件路径，也可用环境变量 `CODEX_BIN`

### 2. 传输与消息格式

- 请求走 `stdin`，一行一个 JSON。
- 响应/事件走 `stdout`，一行一个 JSON。
- 请求格式：`{"id":1,"method":"...","params":{...}}`
- 成功响应：`{"id":1,"result":{...}}`
- 失败响应：`{"id":1,"error":{"code":"...","message":"..."}}`
- 异步通知：`{"method":"...","params":{...}}`

### 3. 最小接入流程

1. `initialize`
2. `capabilities.list`
3. `session.create`（传 `sessionKey`、`mode`、`cwd`）
4. `turn.start`（传 `sessionId` 和 `input`）
5. 监听流式事件直到 `turn.completed` 或 `turn.failed`
6. 需要时 `session.snapshot`
7. 不用时 `session.close`
8. 进程退出前发 `shutdown`

示例：

```json
{"id":1,"method":"initialize"}
{"id":2,"method":"capabilities.list"}
{"id":3,"method":"session.create","params":{"sessionKey":"demo","mode":"safe-agent","cwd":"/abs/path/to/repo"}}
{"id":4,"method":"turn.start","params":{"sessionId":"sess_xxx","input":[{"type":"text","text":"inspect this repository"}]}}
```

### 4. 方法列表

- `initialize`
- `capabilities.list`
- `session.create`
- `session.get`
- `turn.start`
- `turn.interrupt`
- `approval.respond`
- `session.snapshot`
- `session.close`
- `shutdown`

### 5. 输入与事件

`turn.start.input` 支持：

- `{"type":"text","text":"..."}`
- `{"type":"localImage","path":"relative/or/absolute/path"}`

常见通知：

- `turn.started`
- `output.text.delta`
- `output.command.delta`
- `diff.updated`
- `token_usage.updated`
- `approval.requested`
- `approval.resolved`
- `turn.completed`
- `turn.failed`
- `runtime.error`

通知 `params` 统一包含 `sessionId`、`sessionKey`、`turnId`（可空）和 `data`。

### 6. 模式与审批语义

- `llm`：工具关闭、`read-only`、审批自动拒绝。
- `safe-agent`：工具开启、`workspace-write`、代理自动处理审批。
- `unsafe-agent`：工具开启、`workspace-write`、审批转交上层（你需要处理 `approval.requested` 并调用 `approval.respond`）。

### 7. 接入注意点

- 一个 `session` 同时只能有一个 active turn。
- `sessionKey` 在代理内唯一，重复创建会返回冲突错误。
- 会话绑定关系 `sessionKey -> threadId` 会落盘到 `state.json`。
- 代理重启时，正在运行的会话会标记为 `stale`。

## 第二部分：给人看的项目介绍

`codex-proxy` 的目标是把原始 Codex app-server 封装成一个更稳定、更容易对接的本地服务层。

它主要解决三件事：

- 会话管理：把业务侧 `sessionKey` 稳定绑定到底层 `threadId`，并持久化状态。
- 安全控制：通过 `llm / safe-agent / unsafe-agent` 三种模式统一工具权限和审批行为。
- 事件归一化：把文本增量、命令输出、diff、token usage、审批、turn 结束等事件统一成固定 JSONL 通道。

典型链路：

`Vibe-Coding(orchestrator) -> codex-proxy(stdio) -> codex app-server(websocket/json-rpc) -> Codex runtime`

如果你要做一个可恢复、有审批策略、可观测的 Codex Agent 接入层，这个项目就是这个目的。
