# Runtime modes — `claude -p` 计费分叉与多模式重构

> **2026-07-31 更新**：所有 executor session TTY 均已移除（见
> [`ADR-0008`](../adr/0008-remove-all-session-tty-runtimes.md)）。Claude
> 只使用 `claude -p`，Codex 只使用 app-server，Kimi 只使用 ACP。
> Workbench Terminal 的 `term:*` 是 Gian 唯一保留的 PTY，且不是 session
> runtime。本目录完整保留为历史决策快照，里面的多模式方案均不代表现状。

> **新 session 必读**：这个目录是 2026-05-14 Rich 和 Claude 之间一轮长对话的"封装快照"。Anthropic 在 2026-06-15 把 `claude -p` / Agent SDK 切出 Claude 订阅 usage limits，单独走 "Agent SDK monthly credit"。Gian 整个 cc-proxy 都建在 `claude -p` 上，6/15 之后每次互动都计入 Agent SDK credit — 这件事是 Gian 后续架构演进的源头驱动。这个目录记的就是这次决策和落地方案。

如果你被叫来做任何**和 Claude / Codex runtime / TTY / hook / `claude -p` / 计费**沾边的事，先把这五份文档过一遍：

| 文件 | 内容 | 看的目的 |
|---|---|---|
| [`context.md`](./context.md) | 计费分叉的事实 + ChatGPT 那轮咨询的核心结论 | 知道为什么要改 |
| [`architecture.md`](./architecture.md) | 三模式架构（Structured / TTY / Wrapper）+ 锁定的关键决策 | 知道改成什么样 |
| [`findings.md`](./findings.md) | Claude Code hook / `--settings` / session-id 延续等技术事实 | 实施时翻这个 |
| [`plan.md`](./plan.md) | 实施 plan（B1~B8 sub-tasks），含 critical files + verification | 干活照着这个 |
| [`references.md`](./references.md) | ChatGPT 分享链接 + Claude Code 官方文档链接 | 想看原始来源 |

## 一句话总结

**6/15 之前，把 Gian 改成"同一个 session 可在 Structured (`-p`) 和 TTY (interactive `claude`) 之间随时切换"的形态**。两个模式共享 Claude/Codex 自身的 session id（用 `--session-id` + `--resume`），历史天然延续。TTY 模式下 host 通过 HTTP hooks 接收生命周期事件做通知 / 状态 / IM 推送，**不重做结构化卡片**。

## 当前进度

- 2026-05-14：plan 写完，等用户拍板执行（见 `~/.claude/plans/graceful-foraging-scroll.md`，内容和 `plan.md` 一致，是更"工作流"形态的副本）
- 实施未开始

如果你看到这条目录里的 `plan.md` 和 `~/.claude/plans/graceful-foraging-scroll.md` 不一致，**以 `~/.claude/plans/` 那份为准**（那是 active 工作 plan，本目录是冻结快照）。
