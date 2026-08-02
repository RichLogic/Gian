---
id: ADR-0004
title: Integrate Kimi through ACP and preserve native CLI semantics
status: accepted
date: 2026-07-28
deciders: Rich, Codex, Kimi Code review
---

## Context

Gian needs to add Kimi Code without creating a third bespoke runtime path.
Kimi exposes an official ACP server over NDJSON stdio. One ACP connection can
host multiple native sessions and provides structured prompts, updates,
permissions, configuration options, load, and resume. Its lifecycle differs
from Claude's per-session `claude -p` proxy and is closer to Codex's shared
app-server, although Gian does not yet have a reusable shared-process drain
framework.

Gian's existing `ApprovalMode` also mixes provider permission semantics with
Gian job continuation. Kimi's native `default`, `plan`, `auto`, and `yolo`
modes cannot be mapped to that enum without losing behavior. Kimi ACP currently
does not advertise `session/close`, and Kimi can run background tasks whose
lifetime must not be truncated by a blind restart.

## Decision

Integrate Kimi through a shared `kimi acp` process isolated in
`packages/proxies/kimi-proxy`.

- Kimi configuration IDs and values are opaque native values. Gian displays,
  stores, and returns them exactly; it does not map Kimi modes to Gian or other
  provider modes. Gian job continuation becomes a separate orchestration
  setting.
- Gian manages CLI binaries and updates through a common RuntimeManager, but
  does not manage vendor accounts or credentials. Authentication errors tell
  the user which managed CLI command to run externally.
- RuntimeManager rollout is incremental: add the kernel and Kimi provider
  first, then migrate Claude and Codex behind executor-specific regression
  gates. The final ownership model is still one manager for all supported
  CLIs.
- Kimi uses one shared ACP process with per-session facades and explicit
  native-session routing. Every new/load/resume request carries the Gian
  session's actual workspace or worktree cwd.
- Session close is capability-gated. Without native close, Gian detaches its
  facade and waits for a globally safe process shutdown. It does not claim the
  native session was freed and does not restart on a fixed timer.
- Kimi TTY, Kimi IM integration, and a Gian login form are out of scope.

## Consequences

- Positive: Kimi uses its official structured protocol and retains native
  mode, approval, session, and configuration semantics.
- Positive: adding Kimi does not first require replacing the binary resolution
  of working Claude and Codex installations.
- Positive: the adapter can follow new ACP capabilities such as
  `session/close` without a host protocol redesign.
- Negative: shared-process crash and drain logic is new engineering work, not
  a copy of the current codex-proxy lifecycle.
- Negative: native configuration and job orchestration must be disentangled
  across shared, host, database, and web layers before `ApprovalMode` can be
  removed.
- Negative: managed and user-installed Kimi binaries share `~/.kimi-code`, so
  session-store version compatibility becomes an activation constraint.

## Links

- Design: `docs/superpowers/specs/2026-07-28-kimi-code-acp-runtime-design.md`
- Risks: `R-004`, `R-005`, `R-007`
