---
id: ADR-0013
title: Use GitHub Device Flow for local desktop initialization
status: accepted
date: 2026-08-01
deciders: RichLogic
---

## Context

Gian's first public release is a local macOS Electron app with no Gian account
server. It still needs a first-run identity step, initially limited to GitHub.
A native app cannot keep an OAuth client secret confidential, and a loopback
callback server would add lifecycle and routing complexity that the first
release does not need.

The existing password login remains useful for the explicit browser-hosted
development/deployment surface described by ADR-0010, but it is not the
product login for packaged Electron.

## Decision

Packaged and development Electron use GitHub OAuth Device Flow as the startup
identity boundary. The release embeds only the OAuth App's public Client ID;
no client secret is present. The request sends no OAuth scopes, so Gian reads
only the authenticated user's public profile.

Electron's main process owns the device-code exchange, polling, profile fetch,
and credential persistence. The preload exposes narrow methods and returns
only the device code, status, and public profile; it never returns the GitHub
access token to the renderer or Host. The token is encrypted with Electron
`safeStorage` and the encrypted record lives in Electron's per-app user-data
directory. A cached profile admits future offline launches. Signing out removes
the local encrypted record.

Browser-only mode retains ADR-0010's Host password flow. GitHub login is an
identity/initialization step, not an API authorization boundary and not usage
analytics. Nothing is uploaded to a Gian service.

## Consequences

- A GitHub OAuth App with Device Flow enabled is required for release builds.
- GitHub authorization opens in the user's browser without a callback server.
- Gian works offline after the first successful login.
- Revoking the OAuth authorization on GitHub does not automatically erase the
  cached local profile; a future online GitHub operation may revalidate it.
- Aggregate install or active-user counts still require a separate opt-in
  telemetry destination in a future release.

## Links

- Desktop service: `packages/desktop/src/github-auth.ts`
- Renderer boundary: `packages/desktop/src/preload.cts`
- Startup controller: `packages/web/src/controllers/use-app-auth.ts`
- Login UI: `packages/web/src/views/LoginView.tsx`
