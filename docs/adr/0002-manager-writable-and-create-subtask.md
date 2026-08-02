---
id: ADR-0002
title: Per-Task Manager is writable and proposes Subtasks via a confirm-gated text protocol
status: accepted
date: 2026-06-28
deciders: Rich, codex (review R1/R2 + impl review), claude (implementation)
supersedes: PRD-v3 §A1 (read-only Manager, no structured create_subtask channel)
---

## Context

PRD-v3 introduced the per-Task **Manager**: a `type='manager'` Codex session,
cwd = the hidden root workspace (`~/Coding`, spanning every project), that helps
the user understand/plan a Task. PRD-v3 §A1 locked it as **read-only**
(`sandbox:'read-only'` forced every turn) with **no structured way to create
Subtasks** — the Manager could only suggest in prose; the user hand-filled a
form.

The user pushed back (2026-06-28): "read-only" and "doesn't do the work itself"
are different concepts. They want the Manager to be able to **create Subtasks**
(with a final user confirmation), while still not doing the coding work itself.

Two facts constrain *how* a real `create_subtask` tool could be given to the
Manager:

1. The Manager drives Codex through **codex-proxy's app-server protocol**
   (`CodexAppServerClient`, `turn/start` / `StartTurnParams`). `StartTurnParams`
   has **no field for host-injected tool schemas**; Codex's external tools come
   in via **MCP**, which codex-proxy does not configure. So a "real" schema tool
   is feasible *only* by standing up an MCP server in codex-proxy — real work.
2. Claude Subtasks must get their first message through the **TTY-first
   billing-safe path** (`docs/runtime-modes/`); routing them through structured
   `claude -p` would split billing.

## Decision

1. **Manager is writable.** Force `sandbox:'workspace-write'` +
   `approvalPolicy:'never'` every turn (`never` because the Manager panel has no
   approval-card UI). It may read/write/run within `~/Coding` but, by soft
   prompt convention, proposes Subtasks rather than doing the work itself.

2. **`create_subtask` is a confirm-gated text protocol, not a tool.** The
   Manager emits an ASCII-delimited block in its reply:

   ```
   <<gian:create_subtask>>
   { "name": "...", "workspace": "<name|abs path>", "executor": "codex|claude", "prompt": "..." }
   <</gian:create_subtask>>
   ```

   The web parses the latest block (`parseCreateSubtaskProposal`), hides the raw
   block from the transcript (`stripCreateSubtaskBlocks`), and renders an
   editable confirm card prefilled with the proposal. workspace name/path →
   `workspace_id`: exact path first, then a **unique** case-insensitive name
   (names aren't unique → ambiguous/none leaves it unset for the user to pick).
   We took this low-risk route over wiring MCP into codex-proxy.

3. **First-prompt delivery reuses the existing billing-safe first-message
   routing.** On confirm, the prompt is staged client-side
   (`pendingFirstMessageRef`) and delivered by the `session:created` handler via
   `planCreatedSessionFirstMessage` (Claude → TTY `pty:input`, Codex →
   structured). No new backend/shared field; the prompt never reaches the host
   as a `sendMessage`.

## Consequences

- **Security surface**: a writable Manager at the `~/Coding` root can edit files
  / run commands across all projects. Accepted by the user. The confirm gate
  only governs Subtask creation; it does not (and cannot, with a writable shell)
  stop the Manager from self-mutating files — the prompt steers it to propose.
- Existing read-only assertions were updated: `p3-manager.test.ts`,
  `buildManagerSystemPrompt`, and the PRD-v3 / `protocol-proxy.md` wording (the
  PRD text is superseded by this ADR, not edited).
- Re-evaluate if codex-proxy ever gains MCP: a real schema tool with
  host-mediated approval would be the cleaner long-term shape.

Full design + the other parts of this change (subtask completion split from turn
status, status-icon redesign, Tasks list restructure) live in
`docs/superpowers/specs/2026-06-28-tasks-manager-status-redesign.md`.
