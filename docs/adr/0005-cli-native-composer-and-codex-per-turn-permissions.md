---
id: ADR-0005
title: Keep composer controls native and apply Codex permissions per turn
status: accepted
date: 2026-07-29
deciders: Rich, Codex
---

## Context

Gian's structured Composer had accumulated provider-specific controls and a
small cross-provider `ApprovalMode` vocabulary. That made Codex reasoning
levels stale, hid the user's `config.toml` permission profile, and encouraged
mapping Kimi ACP values onto semantics that do not belong to Kimi.

Codex app-server exposes models and supported reasoning efforts, and accepts
sandbox, approval policy, reviewer, or a named permission profile on
`turn/start`. Its thread start/resume response also reports the effective
permission configuration. Kimi ACP exposes native configuration options whose
IDs and values must remain opaque.

## Decision

Use one Composer layout while preserving each CLI's native configuration
semantics.

- Model and effort are separate controls. Effort choices come from the CLI
  capability response and remain open strings rather than a Gian-owned enum.
- Kimi model, effort, and mode controls render ACP configuration options and
  return the exact option value. Gian does not translate them.
- Codex exposes four permission presets: Custom, Ask for approval, Approve for
  me, and Full access. Ask, Approve, and Full map to explicit app-server
  permission fields; Custom reuses the effective configuration captured when
  the native thread is started or resumed.
- Permission fields are sent on every `turn/start`, so a Composer change
  applies to the next turn without recreating the process or native session.
  Gian persists the selected preset only as UI/session state.
- `Fast` remains a Codex-only service-tier control. Visible slash and Remote
  buttons are removed; typed slash discovery remains available.

## Consequences

- Positive: CLI upgrades can add reasoning levels and Kimi configuration
  values without a Gian enum migration.
- Positive: switching from Full access back to Custom restores the native
  Codex permission profile instead of approximating it.
- Positive: all structured executors share a predictable Composer layout
  without pretending they share one permission model.
- Negative: Codex app-server permission response/request shapes are now a
  compatibility boundary and need contract coverage when upgrading the CLI.
- Negative: legacy `ApprovalMode` remains in persistence until provider-native
  configuration and orchestration state are fully separated.

## Links

- Related: ADR-0004
- Requirements: `MODEL-001`, `UI-COMPOSER-001`, `SEC-012`
