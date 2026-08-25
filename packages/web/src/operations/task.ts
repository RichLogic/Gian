/**
 * UI Operation Layer — Task-domain definitions (Phase 3a of
 * `docs/archive/proposals/ui-operation-layer.md`). Every Task mutation the UI can
 * trigger is registered here on the product registry; TasksView (and the
 * App-level subtask banner) dispatch by name instead of calling `ws.send` /
 * the subtask REST helpers directly.
 *
 * Entity keys are `task:<id>` for existing tasks; creates run on fresh
 * `pending:task.create:<uuid>` / `pending:task.createSubtask:<uuid>` keys
 * (proposal §4.3 — the entity does not exist yet, and concurrent creates are
 * never duplicate submissions). Optimistic writes target flat Task fields
 * (`name`, `status`, `pinned_at`); rendering merges `canonical + overlays`
 * via `applyTaskOverlays` (hooks in use-operations.ts).
 *
 * Canonical convergence:
 * - task WS commands: the host broadcasts `task:created` / `task:updated` /
 *   `task:deleted` before the correlated `operation:result` (§4.4 ordering,
 *   ws-handler.ts), so result arrival settles the run against already-current
 *   canonical state; `use-app-socket.ts` absorbs matching overlays on those
 *   broadcasts and on `state_sync`.
 * - Subtask REST commands: the host broadcasts `session:created`
 *   (createSubtask) / `session:updated` (complete/reopen) synchronously
 *   inside the REST handler (routes/tasks.ts → subtask-lifecycle.ts), but
 *   the WS and HTTP channels have no ordering guarantee, so
 *   complete/reopen additionally patch canonical session state directly in
 *   `reconcile` via the injected sink (inventory §4 note 7 treats these as
 *   response/refetch-converged; the patch is idempotent with the broadcast).
 *
 * `task.delete` is pending with the duplicate destructive guard: the row
 * stays visible with a pending affordance (TasksView) until `task:deleted`
 * lands — a failed delete never requires a surprising reinsert (§5).
 */
import {
  usesNativeExecutorConfig,
  type ApprovalMode,
  type Executor,
  type Session,
  type Task,
  type ThinkingEffort,
} from '@gian/shared';

import { completeSubtask, createSubtask, reopenSubtask } from '../api.js';
import { toast } from '../feedback.js';
import { registry } from './registry.js';
import { sessionEntityKey } from './session.js';
import type { OperationDefinition, OptimisticOverlay } from './types.js';

/** Entity key for an existing task. */
export function taskEntityKey(taskId: string): string {
  return `task:${taskId}`;
}

/** WS round-trips are normally well under this; expiry marks the outcome
 *  unknown (never failed) per proposal §4.3. */
const WS_TIMEOUT_MS = 10_000;
/** Subtask creation spins up the executor/proxy — bounded like session create. */
const SUBTASK_CREATE_TIMEOUT_MS = 30_000;

/**
 * Canonical session patch applied on subtask complete/reopen success — see
 * the header. Wired by App with the canonical `setSessions`; tests
 * substitute a fake.
 */
let subtaskCanonicalSink: ((sessionId: string, partial: Partial<Session>) => void) | null = null;

export function wireSubtaskCanonicalSink(
  sink: ((sessionId: string, partial: Partial<Session>) => void) | null,
): void {
  subtaskCanonicalSink = sink;
}

interface TaskIdInput {
  taskId: string;
}

const taskRename: OperationDefinition<TaskIdInput & { name: string }> = {
  policy: 'optimistic',
  entityKey: input => taskEntityKey(input.taskId),
  optimisticWrites: input => [{ field: 'name', value: input.name.trim() }],
  buildMessage: input => ({ type: 'task:update', task_id: input.taskId, name: input.name }),
  timeoutMs: WS_TIMEOUT_MS,
};

const taskToggleDone: OperationDefinition<TaskIdInput & { status: 'open' | 'done' }> = {
  policy: 'optimistic',
  entityKey: input => taskEntityKey(input.taskId),
  optimisticWrites: input => [{ field: 'status', value: input.status }],
  buildMessage: input => ({ type: 'task:update', task_id: input.taskId, status: input.status }),
  timeoutMs: WS_TIMEOUT_MS,
};

const taskPin: OperationDefinition<TaskIdInput & { pinned: boolean }> = {
  policy: 'optimistic',
  entityKey: input => taskEntityKey(input.taskId),
  // The host stamps/clears `pinned_at` (TaskUpdateMessage); the overlay
  // mirrors the outcome with a local timestamp, exactly like session.pin.
  optimisticWrites: input => [{ field: 'pinned_at', value: input.pinned ? new Date().toISOString() : null }],
  buildMessage: input => ({ type: 'task:update', task_id: input.taskId, pinned: input.pinned }),
  timeoutMs: WS_TIMEOUT_MS,
};

const taskCreate: OperationDefinition<{ name: string; description?: string }> = {
  policy: 'pending',
  // Fresh pending key per run (proposal §4.3): concurrent creates are not
  // duplicate submissions. The canonical row arrives via `task:created`.
  entityKey: () => `pending:task.create:${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`,
  buildMessage: input => ({
    type: 'task:create',
    name: input.name,
    ...(input.description ? { description: input.description } : {}),
  }),
  timeoutMs: WS_TIMEOUT_MS,
};

const taskDelete: OperationDefinition<TaskIdInput> = {
  policy: 'pending',
  entityKey: input => taskEntityKey(input.taskId),
  buildMessage: input => ({ type: 'task:delete', task_id: input.taskId }),
  timeoutMs: WS_TIMEOUT_MS,
};

export interface TaskCreateSubtaskInput {
  taskId: string;
  workspaceId: string;
  /** Owning saved Agent (the new-session form always carries it). */
  agentId?: string;
  executor: Executor;
  name?: string;
  /** New-session composer chips (issue #57 v2) — same semantics as
   *  SessionCreateInput; approvalMode is claude/codex-only and serviceTier
   *  is Codex-only. */
  model?: string;
  approvalMode?: ApprovalMode | null;
  thinkingEffort?: ThinkingEffort | null;
  serviceTier?: 'fast' | null;
}

const taskCreateSubtask: OperationDefinition<TaskCreateSubtaskInput, Session> = {
  policy: 'pending',
  entityKey: () => `pending:task.createSubtask:${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`,
  // The created Session is the run result: the caller selects it once the
  // run confirms. Canonical state converges via the host's `session:created`
  // broadcast (routes/tasks.ts) — no reconcile needed.
  execute: async input => {
    const session = await createSubtask(input.taskId, {
      workspace_id: input.workspaceId,
      ...(input.agentId ? { agent_id: input.agentId } : {}),
      executor: input.executor,
      ...(input.name ? { name: input.name } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(!usesNativeExecutorConfig(input.executor) && input.approvalMode
        ? { approval_mode: input.approvalMode }
        : {}),
      ...(input.thinkingEffort ? { thinking_effort: input.thinkingEffort } : {}),
      ...(input.executor === 'codex' && input.serviceTier === 'fast' ? { service_tier: 'fast' as const } : {}),
    });
    if (!session) throw new Error('create subtask failed');
    return session;
  },
  timeoutMs: SUBTASK_CREATE_TIMEOUT_MS,
};

const taskCompleteSubtask: OperationDefinition<{ sessionId: string }, { sessionId: string; completedAt: string }> = {
  policy: 'pending',
  // A Subtask IS a Session — keyed `session:<id>` so the pending affordance
  // and the duplicate guard compose with the session operations on the row.
  entityKey: input => sessionEntityKey(input.sessionId),
  // The sessionId rides the result so `reconcile` (which receives only
  // result + context) can patch the right canonical entity.
  execute: async input => {
    if (!(await completeSubtask(input.sessionId))) throw new Error('complete subtask failed');
    return { sessionId: input.sessionId, completedAt: new Date().toISOString() };
  },
  // REST no-broadcast-channel convergence (see header): patch canonical
  // session state directly; the `session:updated` broadcast is idempotent
  // with this patch.
  reconcile: result => {
    subtaskCanonicalSink?.(result.sessionId, { completed_at: result.completedAt });
  },
  // REST failures have no error envelope — surface them here (the run's
  // failure also re-enables the row toggle).
  rollback: error => toast({ kind: 'error', message: error.message }),
  timeoutMs: WS_TIMEOUT_MS,
};

const taskReopenSubtask: OperationDefinition<{ sessionId: string }, { sessionId: string }> = {
  policy: 'pending',
  entityKey: input => sessionEntityKey(input.sessionId),
  execute: async input => {
    if (!(await reopenSubtask(input.sessionId))) throw new Error('reopen subtask failed');
    return { sessionId: input.sessionId };
  },
  reconcile: result => {
    subtaskCanonicalSink?.(result.sessionId, { completed_at: null });
  },
  rollback: error => toast({ kind: 'error', message: error.message }),
  timeoutMs: WS_TIMEOUT_MS,
};

registry.register('task.rename', taskRename);
registry.register('task.toggleDone', taskToggleDone);
registry.register('task.pin', taskPin);
registry.register('task.create', taskCreate);
registry.register('task.delete', taskDelete);
registry.register('task.createSubtask', taskCreateSubtask);
registry.register('task.completeSubtask', taskCompleteSubtask);
registry.register('task.reopenSubtask', taskReopenSubtask);

/** Task fields an overlay may write (Phase 3a set). */
const TASK_OVERLAY_FIELDS = new Set(['name', 'status', 'pinned_at']);

/**
 * Render merge (proposal §4.3): `canonical + overlays`, the overlay always
 * winning. Returns the canonical object untouched when no overlay applies,
 * so unchanged tasks keep referential identity.
 */
export function applyTaskOverlays(
  task: Task,
  overlays: readonly OptimisticOverlay[],
): Task {
  const entityKey = taskEntityKey(task.id);
  let merged: Task | null = null;
  for (const overlay of overlays) {
    const field = overlay.entityFieldKey.slice(entityKey.length + 1);
    if (!TASK_OVERLAY_FIELDS.has(field)) continue;
    if (merged === null) merged = { ...task };
    (merged as unknown as Record<string, unknown>)[field] = overlay.value;
  }
  return merged ?? task;
}
