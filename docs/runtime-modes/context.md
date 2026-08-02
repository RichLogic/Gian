# Context — 为什么要做这次重构

## 计费分叉（事实）

Anthropic 在 Help Center 公开过这条边界（生效日 **2026-06-15**）：

- **`claude -p` / Agent SDK / GitHub Actions / 通过 Agent SDK 认证的第三方 app** → 走单独的 **"Agent SDK monthly credit"**，不再吃 Claude 订阅 usage limits
- **Interactive Claude Code in terminal or IDE** → 继续走订阅 usage limits

**Gian 当前架构完全建在 `claude -p` 上**（`packages/proxies/cc-proxy/src/runtime/claude-mcp-runtime.ts` 里每轮 `spawn('claude', ['-p', ..., '--output-format', 'stream-json', ...])`）。意味着 6/15 之后，Gian 每次和 Claude 交互都消耗 Agent SDK credit — 对订阅用户来说成本可能爆炸。

**对应保护伞**：interactive `claude`（裸命令 + PTY）继续吃订阅 quota — 这是唯一的"省钱模式"。

## 触发对话

2026-05-14 用户 Rich 跑了一轮 ChatGPT Pro 咨询（见 `references.md`），核心结论：

1. **真的把 `claude` 交互式 CLI 放进 Gian 里跑（PTY）**：能做，技术成熟。架构是 `xterm.js` + WebSocket raw bytes + `node-pty` + `claude`。
2. **从 TTY 输出里 regex 出稳定结构化事件**：**不要做**。TTY 是 UI 不是协议，ANSI / 光标 / spinner / 重绘 / 文案随版本变 — 不稳定。
3. **既吃订阅额度又拿到完整 `-p` 结构化 session 壳**：**做不到完整版**。Anthropic 自己就是把这两条路线分开走的。
4. **正确做法**：TTY 真实交互 + **Hooks 拿结构化生命周期事件** + JSONL tail 做兜底，但**不是结构化卡片的主协议**。

## ChatGPT 的核心修正

Rich 一开始把 Hooks 和 MCP 混在一起想（Gian 现有 MCP 用作 approval bridge，所以以为 MCP 是事件总线）。ChatGPT 给出关键澄清：

- **Hooks ≠ MCP**：Hooks 是 Claude Code 生命周期回调系统；MCP 是工具集成协议。
- **MCP 不是事件总线**：MCP server 可以被 hook handler **调用**，但不能"被动监听 Claude Code 所有事件"。
- **拿全量事件 → HTTP Hook 最合适**：Claude Code 主动 POST 事件 JSON 给你的 HTTP endpoint。
- **MCP server 的 tool 调用**会作为 `mcp__<server>__<tool>` 出现在 Hook 的 PreToolUse 等事件里 — 这是 Hooks 在观察 MCP，不是反过来。

## 四种用户交互在 Pure TTY 模式下的覆盖度

ChatGPT 帮忙核对过：

| 交互 | 能否结构化承接 | Hook 类型 |
|---|---|---|
| 普通文字（实时流） | TTY 出实时 + Stop hook 回填 final | Stop |
| 多选题（1/2/3/4） | ✅ 完整 | PreToolUse + AskUserQuestion |
| 权限审批 Allow / Deny / Session | ✅ 完整 | PermissionRequest + `updatedPermissions` |
| Plan Mode approve/reject | ✅ 完整 | PreToolUse + ExitPlanMode |
| MCP server 自己问用户（OAuth/表单） | ✅ | Elicitation |
| `npm init` / `gh auth` 之类子程序自带交互 | ❌ 只能裸 TTY | — |

## Codex 那条线

用户额外提出：Codex 也加 TTY 模式（之前就想做，现在一起）。但 Codex CLI **没有 Claude-style hooks**，notification 通道只能靠 tail Codex 的 session JSONL + cwd fs.watch 凑。这点是 Codex TTY 的已知降级。

## 用户的具体偏好（这次 plan 锁定）

- 想要**三个模式**：A. Structured (`-p`)、B. Pure TTY、C. Terminal Wrapper（套壳）
- C 暂不做，先做 B
- **Codex 全量跟上 TTY**，和 Claude TTY 平起平坐
- **TTY 模式下 Composer 隐藏**，只用 xterm 输入
- **现有 session 不动**，让用户手动 opt-in
- **后来又改主意**：mode 不在创建时定死，要**随时可切**（mutable）— 进 session 后 toggle 切

## 为什么 6/15 之前要赶出来

- 想给订阅用户保留"省钱通道"
- 不强迫所有人马上接受 Agent SDK credit 计费模型
- 也给项目自己留时间观察新计费的真实成本
