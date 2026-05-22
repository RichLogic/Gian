# Contributing to Gian

## Branch model

Development currently happens on `init/phase-2-vertical-slice`. Feature work
is done on short-lived branches off that base; open a PR to merge back. There
is no separate `main` yet — treat the base branch as `main` until a stable
release.

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

Run both of these and fix any errors before opening a PR:

```bash
pnpm -r typecheck
pnpm -F @gian/web build
```

There are no automated CI checks yet; these are the gate.

## Monorepo layout

```
packages/shared/   shared TypeScript types — no business logic
packages/host/     Hono API + WebSocket server + all backend subsystems
packages/web/      React SPA (Vite)
scripts/           daemon install/uninstall scripts
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
