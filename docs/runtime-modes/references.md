# References

## ChatGPT 咨询线（原始来源）

> Rich 在 2026-05-14 跟 ChatGPT Pro 的对话，是这次决策的引子。三轮问答覆盖：能不能跑真实 TTY、给 TTY 套结构化壳的稳定性、订阅用量下能不能保留 Gian 的 session 体验，外加四种用户交互（文字/选择/审批/Plan Mode）在 Pure TTY 下能不能结构化承接。

URL：https://chatgpt.com/share/6a056443-1950-8321-9a21-69e9c7483d6d

**ChatGPT 的核心结论摘要**（详见 `context.md`）：

- TTY 能做，且是正确做法
- TTY 文本解析（regex 出结构化事件）**不要做**——TTY 是 UI 不是协议
- 订阅用量下完整复刻 `-p` 结构化 session 壳**做不到**
- 正确路线 = TTY + Hooks (HTTP) + JSONL tail 兜底；**主协议是 Hooks**，不是 MCP
- AskUserQuestion / PermissionRequest / ExitPlanMode / Elicitation 都能通过 Hooks 接住

## Anthropic 官方文档（实施时查这个）

| 主题 | URL |
|---|---|
| Claude Code Hooks 总览 | https://code.claude.com/docs/en/hooks |
| Settings 文件 + precedence | https://code.claude.com/docs/en/settings |
| CLI Reference（所有 flags） | https://code.claude.com/docs/en/cli-reference |
| Permission modes | https://code.claude.com/docs/en/permission-modes |
| MCP servers | https://code.claude.com/docs/en/mcp |
| Headless / `--bare` 模式 | https://code.claude.com/docs/en/headless |

## Anthropic 计费分叉公告

Anthropic Help Center 写过：从 2026-06-15 开始，**Claude Agent SDK 和 `claude -p`** 不再计入 Claude plan 的普通 usage limits，改走单独的 **"Agent SDK monthly credit"**；**interactive Claude Code in terminal or IDE** 不适用这个 credit，继续用 subscription usage limits。

（具体 Help Center 页面 URL 当时没记下来，搜 "Agent SDK monthly credit" 应该能找回；如果失效，以 Anthropic 最新 pricing/billing 公告为准。）

## 项目内部相关链接

- `~/.claude/plans/graceful-foraging-scroll.md` — active 工作 plan（这份目录的 `plan.md` 是它的镜像）
- `CLAUDE.md` 顶部 "Required reading" 段引用这个目录
- 现有 cc-proxy 实现：`packages/proxies/cc-proxy/src/runtime/claude-mcp-runtime.ts`（Structured 模式的 ground truth）
- 现有 approval bridge：`packages/proxies/cc-proxy/src/mcp/approval-server.ts`（只用于 Structured 模式的 `--permission-prompt-tool`）
- 现有 codex-proxy 实现：`packages/proxies/codex-proxy/src/runtime/codex-app-server-client.ts`（codex 走 long-lived app-server + WebSocket RPC，和 cc-proxy 完全不同模式）

## 同期相关 commits（截至 2026-05-14）

- `2689b4b fix(bootstrap): seal three macOS install pitfalls + record dual-push workflow` — bootstrap 修复（Node v25 / launchd PATH 等）
- `8160b8b fix(plan-mode): repair full Claude Code plan flow + persistent plan entry` — Structured 模式下的 plan-mode UI 修复（P0~P3），这部分代码会留下来给 Structured 模式继续用
