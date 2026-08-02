---
id: ADR-0007
title: Remove Claude TTY mode; `claude -p` (Structured) is the only Claude runtime
status: accepted
date: 2026-07-30
deciders: Rich, kimi (implementation)
---

## Context

ADR-0001 and the `docs/runtime-modes/` snapshot (2026-05-14) framed a world
where every Claude session could switch between Structured (`claude -p`,
metered Agent SDK credit since the 2026-06-15 Anthropic billing split) and
TTY (interactive `claude` in a host-spawned PTY, subscription quota). That
dual-mode design shipped for Claude and was later mirrored for Codex
(ADR-0001).

Over time the Claude TTY mode became the most expensive surface in the
codebase to keep alive:

- It required a parallel event channel: an HTTP hook endpoint
  (`POST /internal/hooks/claude/*`) with a per-session hook-token registry,
  hook-driven status transitions, and a JSONL watcher reconciled against
  hook state to avoid double-writing transcripts.
- It carried a steady stream of mode-specific bugs and compensating
  machinery: AskUserQuestion deadlocks against the blocking PTY selector
  (CLAUDE-TTY-002/-005), TTY queue draining and Esc-interrupt stop
  (BETA-TTY-QSTOP-001), single-owner WS locking, remote-control passthrough,
  `PendingTtySwitch` first-message bookkeeping, and per-turn idempotency
  state (`sessions.tty_turn_seq`) that existed only for the TTY automation
  channel.
- The billing premise that justified it inverted. `claude -p` is now the
  sanctioned, metered integration path Anthropic supports for third-party
  tools; keeping a scrape-and-paste PTY path alive to dodge metered billing
  meant maintaining the fragile half of the system for a rationale that no
  longer holds.

Codex TTY does not share these problems: it has no hook surface, no
transcript reconciliation, and a much smaller footprint
(`CodexTtyManager` + `tty.*` JSON-RPC on the shared codex-proxy), and it
remains the only way to run interactive `codex` under Gian.

## Decision

Claude TTY mode is removed entirely. `claude -p` (Structured) is the only
Claude runtime; `SessionManager.switchRuntime` on a Claude session now
always fails with `SWITCH_BLOCKED`. Codex TTY is retained unchanged.

Concretely removed:

- Host: `src/tty/manager.ts` (Claude `TtyManager`) and
  `src/tty/registry.ts` (hook token registry), plus the
  `POST /internal/hooks/claude/*` HTTP hook endpoint. `src/tty/codex-manager.ts`
  stays.
- cc-proxy: `tty-claude-runtime.ts`, `tty-service.ts`, the `tty.*` methods,
  and the `node-pty` dependency.
- Web: the Claude TTY UI — Beta/CLI surfaces, the chat-surface setting
  (`claude_chat_surface` / `claude_chat_cli` prefs), remote control, and
  `tty-switch.ts`.
- Shared: the Claude-only TTY message types (`TtyLockMessage`,
  `TtyRemoteControlMessage`, `TtyClaimMessage`,
  `SessionRemoteControlMessage`, `TtySurface`).
- Data: migration `035_reset_claude_tty_sessions.sql` resets existing
  `executor='claude' AND runtime_mode='tty'` rows to `'structured'`.

This narrows ADR-0001: its *Context* describes the Claude TTY mode as the
shipped twin being mirrored, which is no longer true. The ADR-0001 decision
itself (Codex CLI runtime via `codex resume <native_session_id>`) is
unaffected and remains in force. ADRs are append-only, so 0001 is not
edited; this ADR is the corrective reference.

## Consequences

**Positive:**

- The hook endpoint and hook-token registry attack surface is gone; the
  SEC-004-class concern (hook-token theft lets an arbitrary local process
  drive session state) closes with the endpoint.
- One event channel per executor again: Claude sessions are driven solely
  by cc-proxy structured notifications + JSONL replay, ending the
  hook-vs-JSONL double-write reconciliation class of bugs.
- Large deletion of compensating machinery (TTY lock, question dock,
  `PendingTtySwitch`, tty queue drain/interrupt, remote control) and their
  tests; `switchRuntime` has a single executor branch.
- The remaining billing story is honest: every Claude turn is metered
  Agent SDK credit, and BILLING-001 now only guards against *background*
  `claude -p` spend (warmup, model/slash probes).

**Negative:**

- Subscription-quota escape hatch is gone; heavy Claude users pay Agent
  SDK credit for every turn. Accepted — that is now the sanctioned path.
- Migration 035 is a one-way reset: users mid-session on Claude TTY are
  silently flipped to Structured on upgrade.
- `sessions.tty_turn_seq` (migration 030) is now a dead column — kept in
  the schema because SQLite column drops are not worth a rebuild migration;
  nothing reads or writes it.

**Neutral:**

- Codex TTY keeps its pre-existing gap: there is no web UI entry point
  (the CLI tab left with the Claude TTY cleanup; the `codex_chat_cli` pref
  still round-trips in config but nothing renders it). Recorded on
  CODEX-TTY-001; addressing it is a separate decision.
- `docs/runtime-modes/` stays in-tree as a historical decision snapshot;
  its Claude TTY content no longer reflects the code.

## Links

- Narrows: [ADR-0001](0001-codex-cli-runtime-mode.md) (context only;
  Codex decision stands)
- Historical context: `docs/runtime-modes/` (5 files, frozen snapshot)
- Traceability: `docs/quality/traceability.md` CODEX-TTY-001 (retained),
  CLAUDE-TTY-*/BETA-TTY-*/TTY-AUTO-001 rows removed 2026-07-30
- Risk: `docs/quality/risk-register.md` R-001 (closed), R-010 (opened)
