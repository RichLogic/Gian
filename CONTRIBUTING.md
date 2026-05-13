# Contributing to Gian

## Node version

Use **Node.js v22**. Node v25 currently breaks `better-sqlite3` native
bindings. If you have multiple Node versions installed, pin with `nvm`
or `fnm`:

```bash
nvm use 22
```

## Build

```bash
pnpm install
pnpm -F @gian/shared build
pnpm -F @gian/host build
pnpm -F @gian/web build
```

Changes to `packages/shared/src/` affect both `host` and `web` — rebuild
`@gian/shared` first if you've touched the shared types.

## Checks before pushing

Run both and fix any errors before opening a PR:

```bash
pnpm -r typecheck
pnpm -F @gian/web build
```

## Commit style

Conventional commits, lowercase sentence fragment, no trailing period:

```
feat: add X
fix: correct Y in Z
chore: bump deps / tooling
refactor: split A into B and C
docs: update README
```

Subject line under 72 characters. Add a body when the *why* isn't obvious
from the subject.

## Monorepo layout

```
packages/shared/    shared TypeScript types
packages/host/      Hono API + WebSocket server + backend subsystems
packages/web/       React SPA (Vite)
packages/proxies/   vendored cc-proxy and codex-proxy
scripts/            daemon install/uninstall scripts
```
