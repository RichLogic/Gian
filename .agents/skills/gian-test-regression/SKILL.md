---
name: gian-test-regression
description: Select, run, and report Gian regression evidence for development, merge, preview, package, release, and real Provider validation.
---

# Gian Test Regression

Use this skill whenever a Gian task changes behavior, tests, build or release
automation, migrations, shared contracts, Desktop lifecycle, or Provider
adapters. The active GitHub Issue owns one-off execution results; quality docs
own only durable mappings and standards.

## 1. Establish the stage

Choose exactly one current stage. Do not silently substitute a shallower stage.

| Stage | Required entrypoint | Extra evidence |
|---|---|---|
| Development | focused test files, then `pnpm verify:quick -- --base <task-base>` | Broaden for persistence, security, concurrency, and shared contracts |
| Local-main merge | `pnpm test:all` | Rebase/merge current local `main` first when it advanced |
| GianDev preview | `pnpm verify:preview -- --base <task-base>` | Finish user-facing acceptance in GianDev Electron via `pnpm dev` |
| Package | `pnpm quality:package` | Treat the emitted `.app` as the artifact under test |
| Release | package gate plus explicitly authorized canaries | Report deterministic, external, and manual evidence separately |

For packaged builds using independent managed Proxies, publish compatible
stable `proxy-<id>-v<version>` releases to the public release repository before
the final packaged smoke. A missing stable Proxy release blocks fresh-user
onboarding and therefore blocks the App release.

`verify:preview` runs affected quick regression, a production build, the
isolated app-shell browser smoke, and the isolated Electron smoke. It does not
replace full deterministic, full E2E, packaged-app, or Provider gates.

## 2. Select the lowest stable evidence

1. Pure transforms and state machines: Unit.
2. API, persistence, controller, or module collaboration: Integration.
3. Real Git, PTY, process, port, or OS boundary: System with isolated fixtures.
4. A cross-layer user journey whose wiring is itself the risk: narrow E2E.
5. Real account, CLI, network, or vendor compatibility: Canary, never a daily
   deterministic test.

Every bug fix needs evidence that fails without the fix. Do not duplicate a
complete assertion at multiple layers unless each layer proves a different
failure boundary.

## 3. Inspect before execution

```bash
pnpm test:affected:plan -- --base <task-base>
pnpm test:affected:plan -- --base <task-base> --json
```

Read every selection reason, deferred System/E2E/smoke/canary entrypoint, and
fallback. Unknown paths fail closed. Expand the plan when the diff affects a
shared protocol, migration, process lifecycle, authentication, concurrency,
security boundary, or user-visible state transition.

## 4. Keep side effects explicit

- Unit/Integration must not access real credentials, Providers, network,
  production data, fixed production ports, or user-visible OS applications.
- Preserve ports 8990 and 5190. Use the GianDev supervisor for 8991/5191.
- E2E, Electron, packaged app, and canaries require the user's authorization.
- Real-turn canaries require `GIAN_ALLOW_REAL_AGENT_TURN=1`, temporary
  workspaces/profiles, visible quota use, and a separately reported result.
- Never describe fake canary orchestration tests as a real Provider run.

## 5. Report evidence

For each gate report: revision/base, command, PASS/FAIL/BLOCKED, duration,
artifact/log path, and residual manual or external checks. Package/preview
gates also report peak RSS, process count, open files when available, and
remaining process candidates. A failed external dependency does not erase a
passing deterministic result, but it still blocks any acceptance criterion
that requires that external evidence.

Run `pnpm quality:functional-evidence` whenever the functional inventory,
catalog, or crosswalk changes. Update traceability or regression matrix only
when their authoritative requirement/evidence or durable release standard
actually changed.
