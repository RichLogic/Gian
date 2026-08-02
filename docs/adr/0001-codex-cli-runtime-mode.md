---
id: ADR-0001
title: Codex CLI runtime mode uses `codex resume <native_session_id>` over a host-side PTY
status: accepted
date: 2026-05-20
deciders: Rich, codex (review), claude (implementation)
---

## Context

Gian sessions on the `claude` executor have a `CLI` runtime mode (since the
`docs/runtime-modes/` work landed) — host spawns interactive `claude` in a
PTY, xterm.js renders it, the WS protocol `pty:*` carries bytes both
ways, and `sessions.runtime_mode` toggles between `'structured'` and
`'tty'`. Codex sessions were the planned twin (`plan.md` B5) but never
shipped, so they had no CLI option in the session header.

The user's ask (2026-05-20) was "do the same logic for codex sessions,
allow codex resume". Three nontrivial differences vs claude blocked a
naive copy-paste:

1. **No `--session-id` flag on `codex`.** Claude takes a pre-minted UUID
   on first spawn (`--session-id <uuid>`) and `--resume <uuid>` after.
   Codex CLI only supports `codex resume <SESSION_ID>` against an
   already-existing thread.
2. **codex-proxy is a single shared process for all sessions** (vs
   cc-proxy's per-session lifecycle). Notification routing has to carry
   a per-session id distinct from the host-side `gianSessionId`.
3. **No hooks.** Codex has no `--settings` HTTP hook surface — the
   notification surface that claude TtyManager rewires from
   `UserPromptSubmit/Stop/...` doesn't exist for codex.

Alternatives considered for the UUID handoff on a brand-new session
(Case 2 in `docs/superpowers/specs/2026-05-20-codex-cli-runtime-design.md`):

- (a) **Use the existing `thread/start` path** (codex-proxy's structured
  service already mints a codex thread UUID + persists it to
  `sessions.native_session_id` inside `SessionManager.bringUpProxySession`).
  Then PTY-spawn `codex resume <that uuid>` and trust codex's on-disk
  rollout JSONL.
- (b) Spawn `codex` cold, tail `~/.codex/session_index.jsonl` to discover
  the new UUID, write it back.
- (c) Force the user to send at least one structured turn first.

S0 validation on 2026-05-20 with codex-cli 0.130.0 confirmed that a
`thread/start` response immediately persists the session rollout file on
disk, and `codex resume <returned uuid>` against that 0-turn session
works — proving (a) is sufficient and (b)/(c) are unnecessary.

For the dual-id discipline on the wire: cc-proxy passes a single
`sessionId` in tty notifications (because cc-proxy is per-session, so the
two ids are always identical). codex-proxy needs `params.sessionId =
proxySessionId` (the routing key the shared host already uses) plus
`params.gianSessionId` (the WS broadcast key) so the host's
`CodexTtyManager` can broadcast `pty:output` with the correct
`session_id` to the browser. Tests would catch a reversal but the explicit
split makes the contract visible at every layer.

## Decision

Codex CLI runtime mode reuses the existing `runtime_mode='tty'` toggle,
WS `pty:*` family, `<Terminal>` component, and `<TerminalWire>` adapter
from the claude side. We add per-executor managers and per-proxy
services:

- `TtyCodexRuntime` in codex-proxy holds the `Map<gianSessionId, IPty>`
  + ring buffer; spawn arg is hard-coded as
  `codex resume <codexThreadId> -C <cwd> --add-dir <cwd> [-m <model>]`.
- `TtyCodexService` exposes `tty.start / tty.input / tty.resize /
  tty.replay / tty.kill` JSON-RPC methods. Notifications are
  `tty.output { sessionId: proxySessionId, gianSessionId, data }` and
  `tty.exited { sessionId, gianSessionId, code, signal }`.
- `CodexProxySessionClient` gains 5 typed passthrough methods +
  `getProxySessionId()` so the host's `CodexTtyManager` can read the
  routing key it needs to put on the wire.
- `CodexTtyManager` mirrors `TtyManager` minus all hook plumbing. It
  rebroadcasts `tty.output` as `pty:output` keyed on `gianSessionId` (the
  WS-side session id), NOT on `proxySessionId`.
- `SessionManager.switchRuntime` dispatches by `session.executor` to
  `TtyManager` (claude) or `CodexTtyManager` (codex); it re-reads the
  session row after `ensureProxySession` so the freshly-minted
  `native_session_id` is visible to the codex branch. A worktree-finalized
  guard is added for both executors (UI hides the button on finalized
  worktrees, but server should defend too).
- `SessionManager.sendMessage`, `sendQueuedNow`, and `maybeAutoSendNext`
  reject when `session.runtime_mode === 'tty'` so structured turns can't
  race the PTY for the same codex thread (or create ghost turns on
  claude). `sendQueuedNow` checks runtime before `popNext` so the queue
  head survives the rejection.
- Web UI gates the CLI tab via
  `ttySupported = session.executor === 'claude' || session.executor === 'codex'`
  (one-line change).

Notification parity (turn.started / completed via codex JSONL tail,
FileChanged via cwd fs.watch) is **deliberately out of scope** for this
chunk — same as claude's TTY mode today, which has the hook wiring but
only emits generic `tty.hook.<event>` broadcasts (no normalizer). A
future chunk lands the per-executor normalizers for both at once.

## Consequences

**Positive:**

- Codex subscription users get a "省钱通道" before the 2026-06-15
  Anthropic billing split — symmetric with claude.
- The dual-id discipline is now explicit on the codex-proxy wire and
  enforced by tests, preventing a class of "wrong session_id broadcast"
  bugs.
- `CodexTtyManager` duck-types the proxy facade via `isCodexTtyClient`,
  so unit tests don't need to spawn a real codex-proxy subprocess.

**Negative:**

- `CodexTtyManager` is a near-mirror of `TtyManager` minus hooks — some
  code duplication. Worth living with vs. an abstract base class
  prematurely; the two managers will diverge further when each gets its
  own normalizer (claude hooks vs. codex JSONL tail).
- Reusing `cc-proxy/scripts/fix-node-pty-permissions.cjs` from
  codex-proxy's `postinstall` means the log prefix says `[cc-proxy]`
  even when fired from codex-proxy install. Cosmetic; leaving as-is.

**Neutral:**

- `CodexProxySessionClient.getProxySessionId()` exposes a previously-
  private field. Read-only via getter; nobody mutates it.
- CONTRACT-003 `DEFERRED_PROXY_METHODS` and CONTRACT-004
  `DEFERRED_NOTIFICATION_METHODS` keep `tty.*` deferred (reason text
  updated from "pruned" to "direct routing via TtyManager /
  CodexTtyManager, not via structured registry / normalizer"). They live
  on a parallel channel from the structured RPC family by design — not
  worth promoting into the shared registry just because they're now
  live on both proxies.
- `CODEX-TTY-001` traceability row stays `GAP` despite 47 automated
  tests; an e2e harness against real `codex resume` history continuity
  is the bar for `COVERED`. Fake PTY tests can't prove that.

## Links

- Spec: `docs/superpowers/specs/2026-05-20-codex-cli-runtime-design.md`
- Implementation plan: `docs/superpowers/plans/2026-05-20-codex-cli-runtime.md`
- Long-form runtime-modes context: `docs/runtime-modes/` (5 files)
- Active plan snapshot: `~/.claude/plans/graceful-foraging-scroll.md` (B5)
- Risk row: `docs/quality/risk-register.md` R-003
- Traceability row: `docs/quality/traceability.md` CODEX-TTY-001
- Related ADR(s): _none yet — first ADR_
