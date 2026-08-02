---
id: ADR-0006
title: Treat provider-authoritative context usage as replaceable session state
status: accepted
date: 2026-07-29
deciders: Rich, Codex
---

## Context

Gian previously tried to show session token usage from generic accumulated
counts. That value became stale after compaction because a context window is
replaceable state, not a monotonic transcript total. The three structured
runtimes also expose different sources: Codex app-server separates `last` from
`total`, Claude `-p` emits current prompt usage on assistant messages and
per-invocation aggregate usage on the result, and current Kimi ACP versions may
require the native `/status` command for an exact context value.

The UI also wants an optional whole-conversation total. An adopted native
session may predate Gian's observation, so summing only newly observed turns
would look precise while being incomplete.

## Decision

Persist context usage as session metadata owned by Host, separate from
transcript events.

- Current context is a replaceable `{used, window}` sample. Codex uses
  `last.totalTokens`, Claude uses assistant input plus cache tokens, and Kimi
  uses ACP usage or a captured, non-transcript `/status` result.
- `/compact` writes an explicit context invalidation before invoking native
  compaction. The next authoritative provider sample replaces it; Gian never
  keeps displaying the pre-compact numerator.
- Conversation usage is tracked separately as provider-authoritative absolute
  values or deduplicated per-turn deltas. The UI displays it only when a
  completeness bit proves Gian observed the native conversation from its
  beginning.
- Usage updates do not alter transcript history or session recency.
- This contract applies only to structured runtimes. Claude and Codex TTY are
  out of scope.

## Consequences

- Positive: compaction cannot leave a plausible but stale percentage on
  screen.
- Positive: the compact ring and hover details share one persisted source
  across reloads without polluting the event timeline.
- Positive: adopted sessions degrade honestly to current context instead of
  presenting a partial value as a conversation total.
- Negative: each CLI version's usage shape is a compatibility boundary and
  requires contract fixtures.
- Negative: Kimi's current text `/status` fallback can drift until ACP emits a
  stable structured context update.
- Neutral: the context window capacity may remain known while its numerator is
  temporarily unknown during compaction.

## Links

- Requirement: `SES-005`
- Risk: `R-009`
