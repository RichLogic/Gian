// Action executor (proposal §4A.A) — the orchestration seam between a parsed
// Gian action and its side effects. Given a completed turn's action, it:
//   1. computes the deterministic action_id and DEDUPES against task_actions
//      (JSONL replay / restart re-parse / stream+final double-reads / retry all
//      collapse to one execution);
//   2. records the action, resolves the workspace, and AUTHORIZES it
//      (action-authorize) against the task's active loop;
//   3. EXECUTES (execute) / STAGES (user confirm) / REJECTS accordingly, via
//      injected side-effect deps so this stays unit-testable with fakes.
//
// The manager binds `deps` to its real create-subtask / message / summary /
// wake operations; tests bind fakes. All DB work is synchronous; the side
// effects are async.

import type { Db } from '../storage/db.js';
import type {
  Executor,
  GianAction,
  Session,
  SubmitStepParams,
  TaskAction,
} from '@gian/shared';
import { computeActionId, computePayloadHash } from './action-parser.js';
import { roleForSessionType } from './role-injector.js';
import { authorizeAction } from './action-authorize.js';
import {
  getAction,
  getActiveLoop,
  insertAction,
  isTerminalStatus,
  updateAction,
  updateLoop,
} from './task-store.js';

/** Outcome of delivering a message to an existing subtask (state machine,
 *  §4A.A ⑤). */
export type MessageOutcome = 'delivered' | 'queued' | 'paused' | 'failed';

export interface ActionExecutorDeps {
  /** Resolve a workspace name or absolute path to a canonical workspace id, or
   *  null when it does not resolve (execution contract ⑧). */
  resolveWorkspaceId(nameOrPath: string): string | null;
  /** Create a subtask session under a task and deliver its brief. Returns the
   *  new subtask session id. */
  createSubtask(input: {
    taskId: string;
    workspaceId: string;
    executor: Executor;
    name?: string;
    brief: string;
  }): Promise<string>;
  /** Deliver a message to an existing subtask, honoring its busy/terminal state. */
  messageSubtask(input: { taskId: string; subtaskId: string; text: string }): Promise<MessageOutcome>;
  /** Persist the engineer's step summary onto its session (sessions.summary). */
  writeStepSummary(input: { session: Session; params: SubmitStepParams }): void;
  /** React to a completed step: advance the loop + wake the PM (Slice 3). */
  onStepSubmitted(input: { taskId: string; session: Session; params: SubmitStepParams }): void | Promise<void>;
}

export interface ActionContext {
  session: Session;
  action: GianAction;
  /** Verbatim `<<gian:action>>…<</gian:action>>` block (hashed for idempotency). */
  blockText: string;
  /** Host DB turn UUID the action was parsed from. */
  hostTurnId: string | null;
  /** Runtime-native turn key (Codex turnId / Claude message id / TTY key).
   *  Falls back to hostTurnId for structured where they are 1:1. */
  sourceTurnKey: string | null;
}

export class ActionExecutor {
  constructor(
    private readonly db: Db,
    private readonly deps: ActionExecutorDeps,
  ) {}

  /**
   * Process one parsed action from a completed turn. Idempotent: a duplicate
   * action_id returns the existing row without re-running. Returns the action
   * row after processing (or null when the session is not part of a task).
   */
  async handle(ctx: ActionContext): Promise<TaskAction | null> {
    const rec = this.recordParsed(ctx);
    if (!rec) return null;
    if (isTerminalStatus(rec.status) || rec.status === 'staged' || rec.status === 'queued') return rec;
    return this.driveRecorded(rec.action_id, ctx.session);
  }

  /**
   * SYNCHRONOUSLY record a parsed action (durability floor). Called on the
   * completed-turn path BEFORE the async side effect, so the row exists even if
   * the host crashes before execution — a startup scan then re-drives it
   * (`resume`). Idempotent by `action_id`:
   *   • terminal / staged / queued → return the existing row untouched;
   *   • executing → a side effect may be half-done → mark failed (never silently
   *     re-run a create_subtask);
   *   • parsed / validated / authorized → return the row so the caller re-drives;
   *   • absent → insert as `parsed`.
   * Returns null only when the session is not part of a Task.
   */
  recordParsed(ctx: ActionContext): TaskAction | null {
    const { session, action, blockText } = ctx;
    if (!session.task_id) return null;

    const payloadHash = computePayloadHash(blockText);
    const sourceKey = ctx.sourceTurnKey ?? ctx.hostTurnId ?? '';
    const actionId = computeActionId(session.id, sourceKey, payloadHash);

    const existing = getAction(this.db, actionId);
    if (existing) {
      if (existing.status === 'executing') {
        updateAction(this.db, actionId, { status: 'failed', error: 'interrupted mid-execution' });
        return getAction(this.db, actionId);
      }
      return existing;
    }
    insertAction(this.db, {
      action_id: actionId,
      task_id: session.task_id,
      session_id: session.id,
      host_turn_id: ctx.hostTurnId,
      source_turn_key: ctx.sourceTurnKey,
      method: action.method,
      payload_hash: payloadHash,
      payload: JSON.stringify(action),
      status: 'parsed',
    });
    return getAction(this.db, actionId);
  }

  /**
   * Drive a recorded (non-terminal) action to completion: authorize against the
   * task's active loop, then execute / stage / reject. Reloads everything from
   * the row so it is safe to call from a startup scan (`resume`). No-op on a
   * terminal / staged / queued row.
   */
  async driveRecorded(actionId: string, session: Session): Promise<TaskAction | null> {
    const row = getAction(this.db, actionId);
    if (!row) return null;
    if (isTerminalStatus(row.status) || row.status === 'staged' || row.status === 'queued') return row;
    if (row.status === 'executing') {
      updateAction(this.db, actionId, { status: 'failed', error: 'interrupted mid-execution' });
      return getAction(this.db, actionId);
    }
    if (!session.task_id) return row;
    const action = JSON.parse(row.payload) as GianAction;

    let workspaceId: string | null = null;
    if (action.method === 'create_subtask') {
      workspaceId = this.deps.resolveWorkspaceId(action.params.workspace);
    }
    const auth = authorizeAction({
      action,
      senderRole: roleForSessionType(session.type),
      senderSessionId: session.id,
      loop: getActiveLoop(this.db, session.task_id),
      workspaceId,
    });
    if (auth.decision === 'rejected') {
      updateAction(this.db, actionId, { status: 'rejected', error: auth.reason });
      return getAction(this.db, actionId);
    }
    if (auth.decision === 'staged') {
      updateAction(this.db, actionId, { status: 'staged', error: auth.reason });
      return getAction(this.db, actionId);
    }
    updateAction(this.db, actionId, { status: 'authorized', error: null });
    await this.execute(actionId, session, action, workspaceId);
    return getAction(this.db, actionId);
  }

  /** Re-drive a recorded action after a restart (startup scanner). Alias for
   *  driveRecorded — the executing→failed guard handles interrupted rows. */
  resume(actionId: string, session: Session): Promise<TaskAction | null> {
    return this.driveRecorded(actionId, session);
  }

  /**
   * Confirm a STAGED action (user clicked the confirm chip). Re-validates and
   * executes it, bypassing the (absent) loop authorization — the user is the
   * authority here. No-op unless the action is currently staged.
   */
  async confirmStaged(actionId: string, ctxSession: Session): Promise<TaskAction | null> {
    const row = getAction(this.db, actionId);
    if (!row || row.status !== 'staged') return row;
    const action = JSON.parse(row.payload) as GianAction;
    // Re-resolve the workspace at confirm time (it may have changed/vanished).
    let workspaceId: string | null = null;
    if (action.method === 'create_subtask') {
      workspaceId = this.deps.resolveWorkspaceId(action.params.workspace);
      if (!workspaceId) {
        updateAction(this.db, actionId, { status: 'failed', error: 'workspace no longer resolves' });
        return getAction(this.db, actionId);
      }
    }
    updateAction(this.db, actionId, { status: 'authorized', error: null });
    await this.execute(actionId, ctxSession, action, workspaceId);
    return getAction(this.db, actionId);
  }

  /** Reject a STAGED action (user clicked reject). */
  rejectStaged(actionId: string): TaskAction | null {
    const row = getAction(this.db, actionId);
    if (!row || row.status !== 'staged') return row;
    updateAction(this.db, actionId, { status: 'rejected', error: 'rejected by user' });
    return getAction(this.db, actionId);
  }

  /** Run the side effect for an authorized action, recording done/failed. */
  private async execute(actionId: string, session: Session, action: GianAction, workspaceId: string | null): Promise<void> {
    const taskId = session.task_id as string;
    updateAction(this.db, actionId, { status: 'executing' });
    try {
      switch (action.method) {
        case 'create_subtask': {
          if (!workspaceId) throw new Error(`workspace not found: ${action.params.workspace}`);
          const subtaskId = await this.deps.createSubtask({
            taskId,
            workspaceId,
            executor: action.params.executor,
            ...(action.params.name ? { name: action.params.name } : {}),
            brief: action.params.brief,
          });
          // Point the active loop's current step at the new engineer so ONLY it
          // can submit_step (anti-spoof, contract ④). Without this any engineer
          // in the task could advance the loop.
          const loop = getActiveLoop(this.db, taskId);
          if (loop) updateLoop(this.db, loop.id, { current_step_session_id: subtaskId, expected_role: 'engineer' });
          updateAction(this.db, actionId, { status: 'done', result: JSON.stringify({ subtask_id: subtaskId }), error: null });
          return;
        }
        case 'message_subtask': {
          const outcome = await this.deps.messageSubtask({ taskId, subtaskId: action.params.subtask_id, text: action.params.text });
          // 'delivered' AND 'queued' both mean the message was handed off (sent
          // now, or enqueued for the drain). The action's job is dispatch, so
          // both close it as done — a queued action must never dangle (the queue
          // has no action_id to flip it later). Only a real delivery failure fails.
          const dispatched = outcome === 'delivered' || outcome === 'queued';
          updateAction(this.db, actionId, {
            status: dispatched ? 'done' : 'failed',
            result: JSON.stringify({ outcome }),
            error: dispatched ? null : outcome,
          });
          return;
        }
        case 'submit_step': {
          this.deps.writeStepSummary({ session, params: action.params });
          await this.deps.onStepSubmitted({ taskId, session, params: action.params });
          updateAction(this.db, actionId, { status: 'done', result: JSON.stringify({ status: action.params.status, verdict: action.params.verdict ?? null }), error: null });
          return;
        }
      }
    } catch (err) {
      updateAction(this.db, actionId, { status: 'failed', error: (err as Error).message });
    }
  }
}

export { isTerminalStatus };
