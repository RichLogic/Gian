---
id: ADR-0009
title: Use canonical Host state for every IM conversation
status: accepted
date: 2026-07-31
deciders: Rich, Codex (implementation)
---

## Context

Discord and Slack were originally adapted from a separate IM service. Each
platform retained private copies of coding sessions, turns, and queued turns,
then `GianBridgedRepos` translated between those records and Gian sessions.
That created two state owners for the same conversation and duplicated model,
approval, queue, status, and routing logic in both platform managers.

The duplicate repositories were not authoritative: Web and the executor
runtime already used `SessionManager`, `QueueManager`, and the canonical
`sessions`/`turns`/`events` tables. Keeping both models made reconnects and
session switching vulnerable to drift.

## Decision

The Host owns one session model for every surface. Discord and Slack resolve
their selected Gian session and invoke the same session, queue, approval, and
configuration services used by Web.

Platform storage is limited to platform-owned concerns:

- bot configuration and selected session id;
- inbound-event deduplication;
- outbound delivery state.

Shared IM presentation and session-selection behavior lives under
`packages/host/src/im/messaging/`. Platform managers retain only transport and
platform interaction code. Migration 039 removes the duplicated platform
session, turn, and queue tables and repoints outbox session foreign keys to
canonical `sessions`.

## Consequences

- Web, Discord, and Slack observe one status, queue, approval, and transcript.
- Platform managers become adapters instead of alternate application servers.
- The old `rvc` record vocabulary and translator layer are removed.
- A platform transport may still retry its own outbox without duplicating the
  Gian turn or queue.
- Legacy `bots` storage remains only as a one-shot upgrade source for existing
  installations; new runtime state uses platform bot tables.

## Links

- Migration: `packages/host/migrations/039_remove_legacy_im_sessions.sql`
- Shared IM context: `packages/host/src/im/messaging/session-context.ts`
- Shared IM presentation: `packages/host/src/im/messaging/presentation.ts`
