---
id: ADR-0014
title: Complete desktop initialization in three explicit stages
status: accepted
date: 2026-08-01
deciders: RichLogic
---

## Context

GitHub identity alone does not make a fresh Gian installation usable. Each
supported Agent needs both its vendor CLI and Gian's matching Proxy, and Gian
also needs a predictable parent directory for projects it creates. Gian has no
application server and must keep this setup local while obtaining vendor CLIs
from their official channels and Gian Proxies from GitHub Releases.

## Decision

Electron first-run initialization is a three-stage gate: GitHub Device Flow,
Agent setup, then project-directory selection. The Agent stage detects an
existing Codex, Claude Code, or Kimi Code CLI, accepts an explicit absolute CLI
path, or runs that vendor's official installer; matching versioned Proxies come
from the `RichLogic/Gian` GitHub Release. Initialization can finish only when
all three Agent pairs are ready.

The selected `workspace_root` is the project parent (for example `~/Coding`).
Gian creates its managed workspaces under `<workspace_root>/workspaces`, while
adopted repositories keep their original paths. Completion is persisted in the
Host config and can be cleared from Settings to run setup again. Electron does
not start business-data or WebSocket loading until both GitHub login and this
Host-owned onboarding state are complete; browser-only development retains its
existing login behavior and bypasses the desktop onboarding gate.

## Consequences

- A fresh install exposes all prerequisites before entering an unusable shell.
- Vendor CLI credentials and self-update behavior remain vendor-owned.
- Public releases must publish compatible Proxy artifacts before users can
  finish setup.
- Changing the project root does not move existing repositories or adopted
  workspaces.
- Re-running setup is explicit and does not sign the GitHub user out.

## Links

- Related: ADR-0013
- Host state: `packages/host/src/onboarding/state.ts`
- Host routes: `packages/host/src/web/routes/onboarding.ts`
- Renderer flow: `packages/web/src/views/OnboardingView.tsx`
- Agent manager: `packages/host/src/agents/manager.ts`
