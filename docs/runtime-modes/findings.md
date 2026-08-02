# Findings — Claude Code 技术能力清单（实施时翻这个）

这一份是 2026-05-14 这轮调研里从 Claude Code 官方文档拿到的事实，挑实施时会反复用到的列出来。**有变动时优先看官方文档**（见 `references.md`），这里是当时的快照。

## CLI flags 关键项（claude v2.1.140 时点）

| Flag | 行为 | 用在哪 |
|---|---|---|
| `--settings <path>` | 路径指向 settings JSON 文件，或直接 inline JSON string。这些值会**覆盖**同 key 的 `settings.json` 文件值；省略的 key 保持文件值 | TTY 模式 per-session 注入 hook 配置 |
| `--session-id <uuid>` | 用指定的 UUID 作为这次对话的 session id（首次创建） | 首次 spawn 任一 mode |
| `-r <session>` / `--resume <session>` | 按 ID 或 name 恢复 session | 后续 spawn 任一 mode |
| `-c` / `--continue` | 当前目录最近一次会话 | 不用，我们要按 id 精确控制 |
| `--name <n>` | 设置 session 显示名（resume 列表里用） | 可选，给 Gian session 加 display name |
| `--add-dir <path>` | 给 Claude 额外的可读写目录 | 注入 workspace 路径 |
| `--permission-mode <mode>` | 起始 permission mode：`default / acceptEdits / plan / auto / dontAsk / bypassPermissions` | 任一模式 per-spawn 控制 |
| `--mcp-config <json>` | 加载 MCP server（多个空格分隔） | Structured 模式继续用 |
| `--permission-prompt-tool <tool>` | 指定 MCP tool 处理 permission prompt | **仅 non-interactive (`-p`) 模式可用** |
| `--include-hook-events` | hook lifecycle events 进 stream-json 输出 | 仅 `-p` 模式 |
| `--bare` | 跳过 hooks / skills / plugins / MCP / CLAUDE.md 自动发现 | 给 probe（model 发现、slash 列表）用最合适 |
| `--init-only` | 只跑 Setup + SessionStart hooks 然后退出 | 可能用于 hook 连通性自检 |

## Settings precedence

> 摘自 settings 文档：

> "When the same setting appears in multiple scopes, Claude Code applies them in priority order:
> 1. Managed (highest) - can't be overridden by anything
> 2. Command line arguments - temporary session overrides
> 3. Local - overrides project and user settings
> 4. Project - overrides user settings
> 5. User (lowest)"

实操：`--settings` flag > `.claude/settings.local.json` > `.claude/settings.json` > `~/.claude/settings.json`

## Hooks 关键事实

### Hook applicability

> "Hooks fire identically in both modes." (interactive vs `-p`)

只有 **Setup** 事件限定 print mode（用 `--init` / `--maintenance` / `--init-only` 触发）。其他事件 interactive 和 `-p` 行为一致。

### HTTP hook 请求 / 响应形态

**Request**：
- POST
- `Content-Type: application/json`
- Body = hook event 的 JSON input
- Headers 支持 `headers` 字段 + 环境变量插值（`$VAR_NAME`）

**Response**：
- `2xx + JSON body` → 按 JSON output schema 解析（含 decision 字段）
- `2xx + 纯文本 body` → 文本进 context
- `2xx + 空 body` → success no-op
- **非 2xx 或连接失败 → non-blocking error，执行继续**

**Timeout**：默认 30s（prompt hook 30, command hook 600, agent hook 60）

> "HTTP hooks cannot signal a blocking error through status codes alone. To block a tool call or deny a permission, return a 2xx response with a JSON body containing the appropriate decision fields."

### 安全设置

| Setting key | 用途 |
|---|---|
| `allowedHttpHookUrls` | URL 通配模式 allowlist，HTTP hook 只能打 list 内的 URL |
| `httpHookAllowedEnvVars` | hook header 里允许插值的 env var 白名单 |
| `disableAllHooks` | 一刀切关掉所有 hooks |
| `allowManagedHooksOnly` | 只信 managed / SDK / 强制启用的 plugin hook |

实操：Gian 在 per-session settings.json 里写 `"allowedHttpHookUrls": ["http://127.0.0.1:8990/*"]`，把 hook URL 锁死在 localhost。

### `session_id` 字段

每个 hook payload 都带 `session_id`（Common Input Fields 首字段）：

```json
{
  "session_id": "abc123",
  "transcript_path": "/home/user/...",
  "cwd": "/home/user/my-project"
}
```

但实操我们**不需要从 payload 读 session_id 做映射** — 因为我们把 Gian session id 编在 hook URL path 里（`/internal/hooks/claude/<gianSessionId>/<event>`），路由本身就是路由 key。

## Hook event 清单

### Session-scoped

| Event | 触发 | 输入字段 | 决策能力 |
|---|---|---|---|
| `SessionStart` | session 启动 | `source` (`startup`/`resume`/`clear`/`compact`), `model` | `additionalContext` |
| `SessionEnd` | session 结束 | matcher: `clear`/`resume`/`logout`/... | 无 |
| `Setup` | `--init-only` / `--init` / `--maintenance` | matcher: `init`/`maintenance` | `additionalContext` |

### Per-turn

| Event | 触发 | 输入 | 决策 |
|---|---|---|---|
| `UserPromptSubmit` | 用户提交 prompt | `prompt` | `decision: 'block'`, `reason`, `additionalContext`, `sessionTitle` |
| `Stop` | Claude 完成回复 | `last_assistant_message` ✨ | `decision: 'block'`, `reason` |
| `StopFailure` | 出错停止 | matcher: error 类型 | 无 |

### Agentic loop (per tool call)

| Event | 输入 | 决策 |
|---|---|---|
| `PreToolUse` | `tool_name`, `tool_input`, `tool_use_id` | `hookSpecificOutput.permissionDecision: 'allow'/'deny'/'ask'/'defer'`, `updatedInput`, `updatedPermissions` |
| `PostToolUse` | `tool_response` + 上面字段 | `decision: 'block'`, `reason` |
| `PostToolUseFailure` | `error` + 上面 | `decision: 'block'`, `reason` |
| `PermissionRequest` | `tool_name`, `tool_input`, `rule` | `hookSpecificOutput.decision.behavior: 'allow'/'deny'`, `updatedInput`, `updatedPermissions` |
| `PermissionDenied` | `denial_reason` | `hookSpecificOutput.retry: true` |
| `PostToolBatch` | `tool_calls`, `tool_responses` | `decision: 'block'`, `reason` |

### 子 agent / task

`SubagentStart` / `SubagentStop` / `TaskCreated` / `TaskCompleted` / `TeammateIdle`

### 观察性（async，非阻塞）

| Event | 输入 / matcher | 用途 |
|---|---|---|
| `Notification` | matcher: `permission_prompt` / `idle_prompt` / `auth_success` / `elicitation_dialog` / `elicitation_complete` / `elicitation_response` | **Pure TTY 模式做红点/badge/IM push 主要靠它** |
| `FileChanged` | matcher: filename (literal, 不支持 regex) | Files tab 增量更新 |
| `CwdChanged` | `cwd` | 监 cwd 变化 |
| `PreCompact` / `PostCompact` | matcher: `manual`/`auto` | compact 边界 |
| `WorktreeCreate` / `WorktreeRemove` | `worktree_path` | worktree 生命周期 |
| `Elicitation` / `ElicitationResult` | MCP server 向用户问输入 | `hookSpecificOutput.action: 'accept'/'decline'/'cancel'`, `content` |
| `InstructionsLoaded` / `ConfigChange` / `UserPromptExpansion` | 见文档 | 暂不需要 |

## TTY 模式具体 spawn 命令（参考形态）

首次 spawn（Gian session 刚切到 TTY）：
```bash
claude \
  --settings /tmp/gian-claude-<sid>/settings.json \
  --session-id <claudeSessionUuid> \
  --add-dir <workspaceCwd>
```

resume spawn（之前已经在 Structured 或 TTY 跑过，有 native_session_id）：
```bash
claude \
  --settings /tmp/gian-claude-<sid>/settings.json \
  --resume <claudeSessionUuid> \
  --add-dir <workspaceCwd>
```

Bracketed paste 输入序列（写 PTY stdin）：
```
\x1b[200~ + <user text, '\r\n' → '\n'> + \x1b[201~ + \r
```

## 现存 cc-proxy 代码里要小心的几个点

- `claude-mcp-runtime.ts` 的整个 stream-json 解析、approval-server、MCP bridge 都是 Structured 模式独有 — TTY 模式都不走
- `service.ts:listCapabilities` 会调 `runtime.awaitModelDiscovery()` + slash probe；这两个 probe 用 `claude -p --bare`（`packages/proxies/cc-proxy/src/core/slash.ts`）即可，TTY session 共用结果
- `--permission-prompt-tool mcp__cc_approval__approval_prompt` **只能在 `-p` 模式用**，TTY 不要带这个 flag，否则会报错或被忽略

## 没确认的事

- Codex CLI 是否支持 `--settings` 类似 flag（基本可以确定不支持 Claude-style hooks）
- Codex session JSONL 真实路径（猜 `~/.codex/sessions/`，需 B5 阶段实地确认）
- `Stop` hook 的 `last_assistant_message` payload 上限尺寸（Anthropic 没说）
- `--init-only` 跑完之后产生的 hook 是否能让 Gian 提前知道 Claude 自身的 session_id（可能能用于 first-spawn 时确认 mapping）
