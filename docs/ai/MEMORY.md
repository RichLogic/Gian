# Project memory — long-term truths

> Read at the start of every session. Update **only** when a long-term fact
> changes. This is not a journal — process history goes to `SESSION_LOG.md`.
> Architectural decisions go to `../adr/` as numbered ADR files.

Each entry is one fact + (optional) one-line reason. If it stops being true,
delete it. If it needs nuance, link an ADR.

## Architecture invariants

- **Host is the sole state owner.** Web and IM are consumers; Discord/Slack
  persist only bot, inbound-dedupe, and outbox state. Selected sessions,
  turns, queues, approvals, and models come from canonical Host services.
  See ADR-0009.
- **`packages/shared/src/`** is types only — no business logic, no runtime
  side effects.
- **Event taxonomy** lives in `packages/shared/src/events.ts` and is mirrored
  in `docs/protocol-proxy.md`. Claude, Codex, and Kimi normalize raw
  notifications into this taxonomy in
  `packages/host/src/event/normalize-{cc,codex,kimi}.ts`.
- **macOS desktop is a thin Electron shell; the host remains independent.**
  Packaged Electron loads the host-owned UI on `8990`, while GianDev loads
  `5191` and checks `8991`. Root `pnpm dev` launches the isolated `GianDev`
  shell by default; `pnpm dev:web` is the browser-only escape hatch. Quitting
  the UI must not stop agents. See ADR-0003 and ADR-0012.
- **Kimi uses a shared ACP runtime with native configuration semantics.** Gian
  manages CLI binaries but not credentials, does not map Kimi modes, and never
  blindly restarts the shared process. See ADR-0004.
- **Structured Composer controls preserve native CLI semantics.** Model and
  effort choices are CLI-owned; Kimi ACP values round-trip unchanged; Codex
  permission presets apply on each turn and `custom` restores the effective
  thread configuration captured at start/resume. Capability/config discovery
  failure is non-fatal and must remain retryable rather than poison a cache or
  crash session navigation. See ADR-0005.
- **Session usage is replaceable metadata, not transcript history.** Structured
  Claude (`claude -p`), Codex, and Kimi persist provider-derived current context
  on the session row; both explicit and provider-initiated compaction invalidate
  the old numerator, reject summarization usage, and wait for the next
  authoritative sample. Cumulative usage is shown only when the host knows it
  observed the native conversation from its start. See ADR-0006.
- **Gian's primary mark is Dragon G.** Keep the selected charging silhouette
  as its coiled body, eye-free, with two short whiskers. Product icons layer
  that monochrome mark over the existing theme/accent-derived `g1/g2/g3`
  colors using an icon-only one-way `g1 0% → g2 42% → g3 100%` interpolation.
  Project status/loading gradients keep their existing `g1` return. Discarded
  hair, eye, stripe, and baseball refinements are not alternate marks. Web
  favicons remain full-canvas; macOS Dock/`.icns` tiles use 84% centered scale
  so their visible footprint matches normal macOS app icons.
  GianDev overlays a black, white-outlined `DEV` pill in the upper-right of its
  dynamic favicon/Dock icon; packaged production Gian keeps the unbadged mark.

## Runtime / billing

- **All executor sessions use structured runtimes.** Claude uses `claude -p`,
  Codex uses app-server, and Kimi uses ACP. Claude and Codex session TTY modes
  were removed; the Workbench Terminal (`term:*`) is Gian's only PTY and is
  independent of session execution. See ADR-0008.
- **Login is a startup boundary with surface-specific identity.** Electron
  uses GitHub Device Flow with no scopes; the main process encrypts the token
  through macOS safeStorage and exposes only the public profile. Browser-only
  mode retains the Host password/session-token flow. Neither path starts the
  WebSocket or loads business data before login. See ADR-0010 and ADR-0013.
- **Electron first-run setup is GitHub → Agents → project directory.** Each
  Agent combines its vendor CLI (detected, explicitly configured, or installed
  from the official vendor channel) with a versioned Gian Proxy from GitHub
  Releases. `workspace_root` is the selected project parent, and Gian-created
  workspaces live under `<workspace_root>/workspaces`; adopted paths are left
  in place. See ADR-0014.
- **Every Claude turn uses Agent SDK credit.** Since 2026-06-15 `claude -p`
  is metered separately from the interactive `claude` subscription.
  Background in `docs/runtime-modes/` is a historical decision snapshot.

## Process invariants

- **Two GitHub remotes by design.** `Gian-Dev` (private dev tree, `main` is
  the single dev branch as of 2026-05-17 — the old `wip` trunk was retired,
  hard-reset into `main`, and deleted) vs `Gian` (public, only `main`,
  curated subset that strips internal docs / design / e2e). All dev pushes
  go to `Gian-Dev/main`; publishing to `Gian/main` is a separate curated
  step.
- **Gian Manager subtask routing preference.** When proposing implementation
  / feature / fix subtasks, prefer `executor: "claude"`; when proposing review
  / audit subtasks, prefer `executor: "codex"`.
- **Node ≥22 < 25.** v25 silently kills `better-sqlite3`. Enforced by
  `engines` + `engine-strict` + `scripts/check-node.js` preinstall hook.
- **Traceability is CI-gated.** Relevant product/test/script diffs must update
  `docs/quality/traceability.md`, unless the run explicitly sets
  `TRACEABILITY_NOT_REQUIRED=1` for maintenance-only work.
- **Builds remove stale compiler output before emitting.** Deleted TypeScript
  modules must not survive under `dist/` and accidentally run in tests or the
  daemon. Workspace TypeScript enables unused-local/parameter checks.
- **Real PTY smoke tests require an unsandboxed host process.** Starting the
  GianDev host from an agent's restricted exec context makes `node-pty`
  children inherit that filesystem sandbox, so zsh cannot update
  `~/.cache`, `.zcompdump`, or `.zsh_history`. Launch the host from the user's
  Terminal or user launchd context before testing workbench or CLI terminals.

## Port reservations

- `8990` / `5190` — production `com.gian.host` daemon (host / web). Off-limits
  while debugging GianDev.
- `8991` / `5191` — GianDev (this working copy).
- rvc (`remote-vibe-coding`) reserved ports — must never appear in this repo.
