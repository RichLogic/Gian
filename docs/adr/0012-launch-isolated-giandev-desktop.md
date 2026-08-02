---
id: ADR-0012
title: Launch an isolated GianDev desktop from the default dev command
status: accepted
date: 2026-07-31
deciders: RichLogic
---

## Context

The old root `pnpm dev` started package watchers and left the developer to open
the Vite URL in a browser. That did not exercise the Electron surface used by
the product, and ad-hoc development launches could inherit production ports,
data, profile state, or launchd management. The installed Gian app and the
development shell must also be able to run at the same time.

## Decision

Root `pnpm dev` is a coordinator. It pins the Host and Vite servers to
`8991`/`5191`, uses `~/.config/gian-dev`, builds proxy entrypoints, waits for
both services, and then launches Electron. The unpackaged shell identifies as
`GianDev`, uses a dedicated Electron `userData` directory, and cannot manage
the production LaunchAgent. A complete already-running development stack is
reused; a partial stack fails explicitly. `pnpm dev:web` remains the opt-in
browser-only command. Packaged Gian keeps its production identity, profile,
port, and launchd behavior.

## Consequences

- Positive: normal development now tests the real desktop shell by default.
- Positive: Gian and GianDev can run concurrently without sharing locks,
  cookies, Chromium state, SQLite data, or service ports.
- Positive: service readiness and early process exits are surfaced by one
  owner instead of leaving an empty desktop window.
- Negative: the default dev command requires a graphical Electron session;
  headless work must use `pnpm dev:web`.
- Neutral: package builds must delete `*.tsbuildinfo` together with `dist`, or
  TypeScript may report success without re-emitting Electron's entrypoint.

## Links

- Related: ADR-0003
