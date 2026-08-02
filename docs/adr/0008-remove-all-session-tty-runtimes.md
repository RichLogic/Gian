---
id: ADR-0008
title: Remove all session TTY runtimes; keep only the Workbench terminal
status: accepted
date: 2026-07-31
deciders: Rich, Codex (implementation)
---

## Context

ADR-0007 removed Claude TTY but deliberately left Codex TTY in place. That
left Gian with two execution models for Codex: the structured app-server path
and an interactive `codex resume` process behind `tty.*` proxy calls,
`pty:*` WebSocket messages, `runtime_mode` persistence, and a host-side
`CodexTtyManager`.

The retained path had no web entry point after the Claude cleanup and no
remaining product use. It still expanded the session lifecycle, proxy
protocol, teardown rules, queue behavior, data model, tests, and dependency
surface. Gian also had a separate, useful PTY: the Workbench terminal. That
terminal is workspace tooling, not an executor session runtime, and already
has an independent `term:*` protocol and lifecycle.

The same review found adjacent product remnants with no reachable workflow:
Job Mode/multi-turn continuation, Tunnel management, old Inbox and settings
components, and protocol messages with no sender or receiver. Login and auth
are intentionally excluded from this cleanup because they remain planned.

## Decision

All Claude, Codex, and Kimi executor sessions use their structured proxy
runtime only. Gian no longer exposes a session runtime toggle or any
session-owned PTY.

The Workbench terminal is the only PTY feature retained. It remains isolated
behind `term:*` WebSocket messages and `packages/host/src/term/manager.ts`;
it must not acquire session execution responsibilities.

Concretely:

- remove Codex `tty.*` proxy methods, runtime/service code, `node-pty`
  dependency, host manager, session switching, `pty:*` messages, and web
  terminal surface;
- remove Job Mode and its `turns` control/automatic continuation;
- remove Tunnel runtime/config UI and other unreachable UI, protocol, and
  compatibility shims found by the cleanup;
- keep auth endpoints, token handling, auth configuration, and `LoginView`
  for the planned login flow;
- add migration 038 to normalize legacy `runtime_mode`, `turns`, and
  `tty_turn_seq` values. The old SQLite columns remain for migration
  compatibility but are no longer part of the application model.

This decision supersedes ADR-0001's Codex CLI runtime decision and ADR-0007's
neutral decision to retain Codex TTY.

## Consequences

- Session execution has one lifecycle and one event channel per executor.
- The proxy and WebSocket contracts no longer carry unreachable TTY methods
  or messages, and the Codex proxy no longer depends on `node-pty`.
- Workbench shell access remains available without coupling terminal state to
  an AI session.
- Existing databases keep historical columns because rebuilding SQLite tables
  adds risk without product value; application code treats those columns as
  compatibility-only.
- Interactive Codex TUI and subscription-style terminal execution are no
  longer available inside a Gian session.
- The frozen `docs/runtime-modes/` snapshot remains useful as decision
  history, but does not describe the current runtime architecture.

## Links

- Supersedes: [ADR-0001](0001-codex-cli-runtime-mode.md)
- Supersedes in part: [ADR-0007](0007-remove-claude-tty-mode.md)
- Historical context: `docs/runtime-modes/`
- Migration: `packages/host/migrations/038_remove_session_tty_and_job_mode.sql`
