---
id: ADR-0010
title: Gate the Web shell on the HTTP login boundary
status: accepted
date: 2026-07-31
deciders: Rich, Codex (implementation)
---

## Context

Gian already had password endpoints, an auth cookie, ephemeral session tokens,
and `LoginView`, but the React app opened its WebSocket and loaded business
data before checking the current user. That made the login UI effectively
detached from application startup and complicated hook ordering with route
specific early returns.

Login remains a required product surface even though the unrelated persistent
API-token table had no caller.

## Decision

The Web app checks `/api/auth/me` before starting the application shell.
Unauthenticated clients render `LoginView` and do not open the WebSocket or
load settings, bots, apps, sessions, or working trees. A successful login
transitions through the same auth controller and then starts the normal shell.

Authentication continues to use the configured password plus an in-memory,
restart-invalidated `gian_session` token. The unused persistent `tokens` table
and its unreachable manager are not part of this design.

## Consequences

- Login is a real startup boundary rather than a dormant component.
- Protected application data is not fetched before authentication completes.
- Restarting the Host invalidates browser sessions by design.
- Logout and password-change HTTP capabilities remain available for their
  eventual UI, without restoring a second token model.

## Links

- Web controller: `packages/web/src/controllers/use-app-auth.ts`
- Host auth: `packages/host/src/auth/`
- Migration: `packages/host/migrations/041_drop_unused_auth_and_queue_tables.sql`
