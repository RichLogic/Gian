---
id: ADR-0003
title: Ship macOS as an Electron shell over the independent Gian daemon
status: accepted
date: 2026-07-28
deciders: Rich, Claude (research), Codex (implementation)
---

## Context

Gian is already split into a React web client and a Node/TypeScript host. The
host owns SQLite state, agent and proxy subprocesses, terminals, bots, tunnels,
and long-running sessions. Production runs it as the `com.gian.host` launchd
service on `127.0.0.1:8990`; GianDev uses the isolated `8991` host and `5191`
Vite server.

A 2026-07-21 desktop investigation compared Tauri v2 and Electron. Both render
the existing React UI as JavaScript in a web engine. Tauri would use WKWebView
and add a Rust toolchain; Electron uses Chromium and keeps the shell in
TypeScript. Gian is not moving the host into either shell: coupling the host to
the window would make Cmd-Q, crashes, and app updates terminate active agents.

Electron is preferred because memory and bundle size are not primary
constraints, while Chromium parity with current development, xterm.js, and
Playwright plus a single TypeScript toolchain reduce ongoing maintenance.

## Decision

Add `packages/desktop` as a thin, security-hardened Electron application.

- The existing React page remains the sole UI. Development loads `5191`;
  packaged production loads the host-owned page on `8990`.
- The host remains an independent launchd daemon and the sole state owner.
  Closing or quitting Electron never stops it.
- The packaged shell probes the public `/health` endpoint and may kickstart the
  existing `com.gian.host` LaunchAgent when `8990` is unavailable. Development
  never manages the production service.
- Renderers use Chromium sandboxing, context isolation, no Node integration,
  and an origin allowlist. The preload exposes only retry and open-logs
  operations.
- The first increment provides a runnable `.app`, recoverable unavailable
  state, native menus, and packaging. Signing, notarization, auto-update,
  multi-window workflows, and a combined host installer are follow-up work.

## Consequences

- Positive: the web application, relative `/api` calls, cookie authentication,
  and WebSocket routing work unchanged under the same origin.
- Positive: desktop UI restarts cannot kill background agents.
- Positive: desktop-shell behavior can be covered with Electron/Playwright
  while existing browser e2e remains valid.
- Negative: Electron adds a Chromium runtime and a substantially larger app
  bundle than Tauri.
- Negative: the first packaged app depends on Gian's host already being
  installed; host and shell release compatibility must be managed.
- Negative: remote localhost content becomes an Electron security boundary, so
  sandbox and navigation restrictions are architectural requirements.

## Links

- Claude Code research session: `ed6a31fc-bbd9-42aa-b412-7f16610c2e9e`
- Traceability: `DESKTOP-001`
- Risk register: `R-006`
