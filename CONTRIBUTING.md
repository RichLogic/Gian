# Contributing to Gian

## Branch model

Development happens on `main`. Create a short-lived branch from the latest
`main`, keep each pull request focused, and open the pull request back to
`main`.

## Commit style

Follow the pattern in the existing log — conventional commits, lowercase
sentence fragment, no period:

```
feat: add X
fix: correct Y in Z
chore: update deps / tooling / config
refactor: split A into B and C
docs: update README
```

Keep the subject line under 72 characters. Add a body if the why is not
obvious from the subject.

## Node version

Use **Node.js v22**. Node v25 breaks the `better-sqlite3` native binding.
Use `nvm` or `fnm` to pin to v22 if your machine has multiple versions:

```bash
nvm use 22
```

## Checks before pushing

Run these and fix any errors before opening a PR:

```bash
pnpm typecheck
pnpm test
pnpm build
```

Release tags also run the signed and notarized macOS packaging workflow.

## Monorepo layout

```
packages/shared/   shared TypeScript types — no business logic
packages/host/     Hono API + WebSocket server + all backend subsystems
packages/web/      React SPA (Vite)
packages/desktop/  Electron launcher and macOS packaging
packages/proxies/  independently released Agent protocol adapters
scripts/           development and release tooling
docs/              architecture, protocol, roadmap, AI/quality/ADR docs
```

Changes to `packages/shared/src/` affect all three packages — rebuild shared
first:

```bash
pnpm -F @gian/shared build
```

## Agent-assisted development

This repo was built using a team-of-agents pattern. See
[`docs/roadmap.md`](docs/roadmap.md) for the milestone history, per-track file
ownership rules, and parallel constraint protocol used to coordinate multiple
agents without conflicts. If you are using an AI agent to contribute, follow
the same rules: each agent owns only the files listed in its brief, types flow
through `packages/shared/`, and import paths use the `.js` extension.
