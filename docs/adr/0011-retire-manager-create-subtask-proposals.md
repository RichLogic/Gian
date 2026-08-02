---
id: ADR-0011
title: Retire Manager create-subtask proposal blocks
status: accepted
date: 2026-07-31
deciders: Rich, Codex (implementation)
---

## Context

ADR-0002 introduced `<<gian:create_subtask>>` JSON blocks that the Web parsed
into proposal cards. The Task action pipeline later replaced that surface
specific protocol with the host-owned `<<gian:action>>` envelope, authorization,
idempotency ledger, and execution flow.

The old parser no longer had a production caller. Only transcript cleanup still
needed the sentinels because existing native histories may contain old blocks.

## Decision

Manager-authored subtask creation uses the canonical Gian action protocol.
The shared package no longer exports `CreateSubtaskProposal` or
`parseCreateSubtaskProposal`.

`CREATE_SUBTASK_OPEN`, `CREATE_SUBTASK_CLOSE`, and
`stripCreateSubtaskBlocks` remain as display compatibility for historical
transcripts. They must not be used to execute new work.

## Consequences

- Subtask execution has one Host authorization and deduplication path.
- Web transcript rendering remains clean for sessions created before the
  action protocol.
- New code cannot accidentally revive the unconfirmed Web-only parser.

## Links

- Supersedes in part: [ADR-0002](0002-manager-writable-and-create-subtask.md)
- Action parser: `packages/host/src/task/action-parser.ts`
- Compatibility strip: `packages/shared/src/manager.ts`
