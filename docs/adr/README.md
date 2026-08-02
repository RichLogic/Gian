# Architecture Decision Records (ADR)

One file per decision, named `NNNN-short-kebab-title.md`. Numbering is
monotonic — never reuse, never renumber. Use `0001`-style 4-digit prefix.

ADRs are **append-only history**: once accepted, never edit the body. If a
decision changes, write a new ADR that supersedes the old one (and link both
ways).

## Template

```markdown
---
id: ADR-NNNN
title: <short imperative title>
status: proposed | accepted | superseded by ADR-XXXX | deprecated
date: YYYY-MM-DD
deciders: <names>
---

## Context
What's the situation forcing a decision? Constraints, prior art, alternatives
considered.

## Decision
What we are doing. One paragraph, written in the present tense.

## Consequences
- Positive — what gets easier / cheaper / safer.
- Negative — what gets harder / more expensive / riskier.
- Neutral — knock-on changes elsewhere in the system.

## Links
- Supersedes: ADR-XXXX (if any)
- Related work items: GIAN-NNN
```

## Index

- [ADR-0001](0001-codex-cli-runtime-mode.md) — Codex CLI runtime mode uses `codex resume <native_session_id>` over a host-side PTY
- [ADR-0002](0002-manager-writable-and-create-subtask.md) — Per-Task Manager is writable and proposes Subtasks through a confirm-gated protocol
- [ADR-0003](0003-electron-shell-independent-daemon.md) — macOS ships as an Electron shell over the independent Gian daemon
- [ADR-0004](0004-kimi-acp-and-native-cli-semantics.md) — Kimi uses shared ACP while Gian preserves native CLI semantics
- [ADR-0005](0005-cli-native-composer-and-codex-per-turn-permissions.md) — Composer uses native CLI options and Codex permission presets apply per turn
- [ADR-0006](0006-provider-authoritative-session-context.md) — Current context is provider-authoritative replaceable session state
- [ADR-0007](0007-remove-claude-tty-mode.md) — Claude TTY mode removed; `claude -p` is the only Claude runtime (Codex TTY retained)
- [ADR-0008](0008-remove-all-session-tty-runtimes.md) — All session TTY runtimes removed; Workbench Terminal is the only PTY
- [ADR-0009](0009-canonical-host-state-for-im.md) — Discord and Slack use the Host's canonical session, queue, approval, and transcript state
- [ADR-0010](0010-gate-web-shell-on-login.md) — The Web shell starts only after the HTTP login boundary succeeds
- [ADR-0011](0011-retire-manager-create-subtask-proposals.md) — Manager subtask creation uses the Host action envelope; old proposal blocks are display-only compatibility
- [ADR-0012](0012-launch-isolated-giandev-desktop.md) — The default dev command launches an isolated GianDev desktop shell
- [ADR-0013](0013-desktop-github-device-flow.md) — Electron initialization uses GitHub Device Flow with main-process encrypted local credentials
- [ADR-0014](0014-three-step-desktop-onboarding.md) — Electron first-run initialization gates the app on GitHub, Agent setup, and a managed workspace directory
