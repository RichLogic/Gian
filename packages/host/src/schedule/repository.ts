import { randomUUID } from 'node:crypto';
import type {
  ScheduleExecutionMode,
  ScheduleForkAnchor,
  ScheduleMisfirePolicy,
  ScheduleStatus,
  ScheduleTrigger,
} from '@gian/shared';
import {
  BLOCKING_RUN_STATUSES,
  CAPACITY_RUN_STATUSES,
  TERMINAL_RUN_STATUSES,
  type DueOutcome,
  type ScheduleCommandReceiptRow,
  type ScheduleConfirmationRow,
  type ScheduleRow,
  type ScheduleRunRow,
} from './types.js';
import type { Db } from '../storage/db.js';
import { scheduleFailure } from './errors.js';
import { enumerateDue, nextOccurrence } from './trigger.js';

/**
 * The only module allowed to read/write `schedules`, `schedule_runs`,
 * `schedule_command_receipts`, and `schedule_confirmations` (ADR-0053). Every
 * multi-row invariant runs inside a synchronous SQLite transaction; nothing
 * here awaits Proxy/Session I/O. Timestamps are always caller-injected
 * RFC 3339 instants.
 */

export interface ScheduleCursor {
  updatedAt: string;
  id: string;
}

export interface RunCursor {
  createdAt: string;
  id: string;
}

export interface ScheduleListFilter {
  statuses?: ScheduleStatus[];
  controlSessionId?: string;
  limit: number;
  cursor?: ScheduleCursor | null;
}

export interface NewScheduleInput {
  id: string;
  name: string;
  prompt: string;
  trigger: ScheduleTrigger;
  timezone: string;
  misfirePolicy: ScheduleMisfirePolicy;
  nextRunAt: string | null;
  controlSessionId: string;
  creatorActorId: string;
  now: string;
}

export interface NewRunInput {
  id?: string;
  scheduleId: string;
  triggerKind: ScheduleRunRow['trigger_kind'];
  scheduledFor: string;
  missedCount?: number;
  missedFrom?: string | null;
  missedUntil?: string | null;
  status?: ScheduleRunRow['status'];
  now: string;
}

export interface SchedulePatch {
  name?: string;
  prompt?: string;
  trigger?: ScheduleTrigger;
  timezone?: string;
  misfirePolicy?: ScheduleMisfirePolicy;
  nextRunAt?: string | null;
  clearNextRun?: boolean;
  lastRunAt?: string;
}

const TERMINAL_STATUS_PARAMS = [...TERMINAL_RUN_STATUSES]
  .map((status, index) => [`terminal${index}`, status] as const);
const TERMINAL_STATUS_PLACEHOLDERS = TERMINAL_STATUS_PARAMS
  .map(([name]) => `@${name}`)
  .join(',');

export class ScheduleRepository {
  constructor(private readonly db: Db) {}

  // ── schedules ──────────────────────────────────────────────────────────────

  /** Create under the non-archived hard cap inside one transaction so two
   *  concurrent creates can never overshoot the limit. */
  insertScheduleWithinCap(input: NewScheduleInput, maxNonArchived: number): ScheduleRow {
    return this.db.transaction((): ScheduleRow => {
      const count = this.db.prepare(
        `SELECT COUNT(*) AS n FROM schedules WHERE status != 'archived'`,
      ).get() as { n: number };
      if (count.n >= maxNonArchived) {
        throw scheduleFailure(
          'SCHEDULE_LIMIT_REACHED',
          `at most ${maxNonArchived} non-archived Schedules are allowed`,
        );
      }
      return this.insertSchedule(input);
    })();
  }

  insertSchedule(input: NewScheduleInput): ScheduleRow {
    const row: ScheduleRow = {
      id: input.id,
      name: input.name,
      prompt: input.prompt,
      status: 'active',
      status_reason: null,
      trigger_kind: input.trigger.kind,
      trigger_json: JSON.stringify(input.trigger),
      timezone: input.timezone,
      overlap_policy: 'skip',
      misfire_policy: input.misfirePolicy,
      next_run_at: input.nextRunAt,
      last_run_at: null,
      control_session_id: input.controlSessionId,
      creator_kind: 'internal_session',
      creator_actor_id: input.creatorActorId,
      created_at: input.now,
      updated_at: input.now,
      archived_at: null,
      revision: 1,
    };
    this.db.prepare(
      `INSERT INTO schedules (
         id, name, prompt, status, status_reason, trigger_kind, trigger_json, timezone,
         overlap_policy, misfire_policy, next_run_at, last_run_at,
         control_session_id, creator_kind, creator_actor_id,
         created_at, updated_at, archived_at, revision
       ) VALUES (
         @id, @name, @prompt, @status, @status_reason, @trigger_kind, @trigger_json, @timezone,
         @overlap_policy, @misfire_policy, @next_run_at, @last_run_at,
         @control_session_id, @creator_kind, @creator_actor_id,
         @created_at, @updated_at, @archived_at, @revision
       )`,
    ).run(row as unknown as Record<string, unknown>);
    return row;
  }

  scheduleRow(id: string): ScheduleRow | null {
    return (this.db.prepare('SELECT * FROM schedules WHERE id = ?').get(id) as ScheduleRow | undefined)
      ?? null;
  }

  requireScheduleRow(id: string): ScheduleRow {
    const row = this.scheduleRow(id);
    if (!row) throw scheduleFailure('SCHEDULE_NOT_FOUND', `schedule not found: ${id}`);
    return row;
  }

  countNonArchivedSchedules(): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) AS n FROM schedules WHERE status != 'archived'`,
    ).get() as { n: number };
    return row.n;
  }

  listScheduleRows(filter: ScheduleListFilter): { rows: ScheduleRow[]; nextCursor: ScheduleCursor | null } {
    const clauses: string[] = [];
    const params: Record<string, unknown> = { limit: filter.limit + 1 };
    if (filter.statuses && filter.statuses.length > 0) {
      clauses.push(`status IN (${filter.statuses.map((_, index) => `@status${index}`).join(',')})`);
      filter.statuses.forEach((status, index) => {
        params[`status${index}`] = status;
      });
    }
    if (filter.controlSessionId) {
      clauses.push('control_session_id = @controlSessionId');
      params.controlSessionId = filter.controlSessionId;
    }
    if (filter.cursor) {
      clauses.push('(updated_at > @cursorUpdatedAt OR (updated_at = @cursorUpdatedAt AND id > @cursorId))');
      params.cursorUpdatedAt = filter.cursor.updatedAt;
      params.cursorId = filter.cursor.id;
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db.prepare(
      `SELECT * FROM schedules ${where}
        ORDER BY updated_at, id
        LIMIT @limit`,
    ).all(params) as ScheduleRow[];
    const page = rows.slice(0, filter.limit);
    const last = page.at(-1);
    return {
      rows: page,
      nextCursor: rows.length > filter.limit && last
        ? { updatedAt: last.updated_at, id: last.id }
        : null,
    };
  }

  /** Column update guarded by optional revision/status preconditions. Bumps
   *  revision and updated_at; mismatch raises SCHEDULE_REVISION_CONFLICT. */
  private updateScheduleWhere(
    id: string,
    assignments: string[],
    params: Record<string, unknown>,
    options: { expectedRevision?: number; requireStatuses?: ScheduleStatus[]; now: string },
  ): ScheduleRow {
    const fullParams: Record<string, unknown> = {
      ...params,
      id,
      now: options.now,
      ...(options.expectedRevision !== undefined ? { expectedRevision: options.expectedRevision } : {}),
    };
    const statusClause = options.requireStatuses && options.requireStatuses.length > 0
      ? ` AND status IN (${options.requireStatuses.map((_, index) => `@reqStatus${index}`).join(',')})`
      : '';
    options.requireStatuses?.forEach((status, index) => {
      fullParams[`reqStatus${index}`] = status;
    });
    const revisionClause = options.expectedRevision !== undefined
      ? ' AND revision = @expectedRevision'
      : '';
    const result = this.db.prepare(
      `UPDATE schedules SET ${assignments.join(', ')} WHERE id = @id${statusClause}${revisionClause}`,
    ).run(fullParams);
    if (result.changes !== 1) {
      const row = this.scheduleRow(id);
      if (!row) throw scheduleFailure('SCHEDULE_NOT_FOUND', `schedule not found: ${id}`);
      throw scheduleFailure(
        'SCHEDULE_REVISION_CONFLICT',
        `schedule revision conflict: expected ${options.expectedRevision ?? 'any'}, found ${row.revision}`,
        { revision: row.revision },
      );
    }
    return this.requireScheduleRow(id);
  }

  updateScheduleColumns(
    id: string,
    patch: SchedulePatch,
    options: { expectedRevision?: number; requireStatuses?: ScheduleStatus[]; now: string },
  ): ScheduleRow {
    const assignments: string[] = ['updated_at = @now', 'revision = revision + 1'];
    const params: Record<string, unknown> = {};
    if (patch.name !== undefined) {
      assignments.push('name = @name');
      params.name = patch.name;
    }
    if (patch.prompt !== undefined) {
      assignments.push('prompt = @prompt');
      params.prompt = patch.prompt;
    }
    if (patch.trigger !== undefined) {
      assignments.push('trigger_kind = @triggerKind', 'trigger_json = @triggerJson');
      params.triggerKind = patch.trigger.kind;
      params.triggerJson = JSON.stringify(patch.trigger);
    }
    if (patch.timezone !== undefined) {
      assignments.push('timezone = @timezone');
      params.timezone = patch.timezone;
    }
    if (patch.misfirePolicy !== undefined) {
      assignments.push('misfire_policy = @misfirePolicy');
      params.misfirePolicy = patch.misfirePolicy;
    }
    if (patch.nextRunAt !== undefined) {
      assignments.push('next_run_at = @nextRunAt');
      params.nextRunAt = patch.nextRunAt;
    }
    if (patch.clearNextRun) assignments.push('next_run_at = NULL');
    if (patch.lastRunAt !== undefined) {
      assignments.push('last_run_at = @lastRunAt');
      params.lastRunAt = patch.lastRunAt;
    }
    return this.updateScheduleWhere(id, assignments, params, options);
  }

  setScheduleState(
    id: string,
    patch: {
      status: ScheduleStatus;
      statusReason: ScheduleRow['status_reason'];
      nextRunAt?: string | null;
      clearNextRun?: boolean;
    },
    options: { expectedRevision?: number; requireStatuses?: ScheduleStatus[]; now: string },
  ): ScheduleRow {
    const assignments: string[] = [
      'status = @status',
      'status_reason = @statusReason',
      'updated_at = @now',
      'revision = revision + 1',
    ];
    const params: Record<string, unknown> = {
      status: patch.status,
      statusReason: patch.statusReason,
    };
    if (patch.nextRunAt !== undefined) {
      assignments.push('next_run_at = @nextRunAt');
      params.nextRunAt = patch.nextRunAt;
    }
    if (patch.clearNextRun) assignments.push('next_run_at = NULL');
    if (patch.status === 'archived') {
      assignments.push('archived_at = @archivedAt');
      params.archivedAt = options.now;
    }
    return this.updateScheduleWhere(id, assignments, params, options);
  }

  /** Atomically pauses a non-archived Schedule whose Run entered `unknown`.
   *  Applies to paused/completed Schedules too: an unknown Run must never be
   *  resumable without the explicit archive-and-recreate confirmation, and a
   *  once Schedule may already have completed before its Run failed. */
  pauseScheduleForUnknownRun(scheduleId: string, now: string): void {
    this.db.prepare(
      `UPDATE schedules
          SET status = 'paused', status_reason = 'unknown_run', next_run_at = NULL,
              updated_at = ?, revision = revision + 1
        WHERE id = ? AND status IN ('active', 'paused', 'completed')`,
    ).run(now, scheduleId);
  }

  /** Atomically pauses a non-archived Schedule whose control conversation can
   *  no longer receive the scheduled prompt (fail-closed, contract J). */
  pauseScheduleForLifecycle(scheduleId: string, now: string): void {
    this.db.prepare(
      `UPDATE schedules
          SET status = 'paused', status_reason = 'lifecycle_blocked', next_run_at = NULL,
              updated_at = ?, revision = revision + 1
        WHERE id = ? AND status IN ('active', 'paused', 'completed')`,
    ).run(now, scheduleId);
  }

  /** Atomic fail-closed terminal: settles the Run terminal AND pauses the
   *  Schedule (unknown_run or lifecycle_blocked) inside one transaction, so a
   *  crash between the two writes can never leave a terminal Run behind an
   *  active/paused-manual/completed Schedule. Archived Schedules are never
   *  resurrected; a non-archived Schedule always ends paused with the reason. */
  settleRunAndPauseSchedule(
    runId: string,
    status: ScheduleRunRow['status'],
    pauseReason: 'unknown_run' | 'lifecycle_blocked',
    patch: Parameters<ScheduleRepository['settleRun']>[2],
    now: string,
  ): ScheduleRunRow | null {
    return this.db.transaction((): ScheduleRunRow | null => {
      const settled = this.settleRun(runId, status, patch, now);
      if (!settled) return null;
      this.db.prepare(
        `UPDATE schedules
            SET status = 'paused', status_reason = ?, next_run_at = NULL,
                updated_at = ?, revision = revision + 1
          WHERE id = ? AND status IN ('active', 'paused', 'completed')`,
      ).run(pauseReason, now, settled.schedule_id);
      return this.runRow(runId);
    })();
  }

  /** Atomic fail-closed for a lifecycle-blocked dispatch: the Run settles
   *  failed and the (non-archived) Schedule pauses in one transaction. */
  settleRunFailedAndPauseLifecycle(
    runId: string,
    errorCode: string,
    errorMessage: string,
    now: string,
  ): ScheduleRunRow | null {
    return this.db.transaction((): ScheduleRunRow | null => {
      const settled = this.settleRun(runId, 'failed', {
        errorCode,
        errorMessage,
      }, now);
      if (!settled) return null;
      this.db.prepare(
        `UPDATE schedules
            SET status = 'paused', status_reason = 'lifecycle_blocked', next_run_at = NULL,
                updated_at = ?, revision = revision + 1
          WHERE id = ? AND status IN ('active', 'paused', 'completed')`,
      ).run(now, settled.schedule_id);
      return this.runRow(runId);
    })();
  }

  // ── runs ───────────────────────────────────────────────────────────────────

  insertRun(input: NewRunInput): ScheduleRunRow {
    const row: ScheduleRunRow = {
      id: input.id ?? randomUUID(),
      schedule_id: input.scheduleId,
      trigger_kind: input.triggerKind,
      scheduled_for: input.scheduledFor,
      status: input.status ?? 'scheduled',
      execution_mode: null,
      target_session_id: null,
      fork_anchor_json: null,
      turn_id: null,
      missed_count: input.missedCount ?? 0,
      missed_from: input.missedFrom ?? null,
      missed_until: input.missedUntil ?? null,
      resolved_config_json: null,
      summary: null,
      error_code: null,
      error_message: null,
      dispatch_phase: 'none',
      lease_token: null,
      lease_expires_at: null,
      created_at: input.now,
      started_at: null,
      finished_at: null,
      updated_at: input.now,
      revision: 1,
    };
    this.db.prepare(
      `INSERT INTO schedule_runs (
         id, schedule_id, trigger_kind, scheduled_for, status, execution_mode,
         target_session_id, fork_anchor_json, turn_id,
         missed_count, missed_from, missed_until, resolved_config_json, summary,
         error_code, error_message, dispatch_phase,
         lease_token, lease_expires_at, created_at, started_at, finished_at,
         updated_at, revision
       ) VALUES (
         @id, @schedule_id, @trigger_kind, @scheduled_for, @status, @execution_mode,
         @target_session_id, @fork_anchor_json, @turn_id,
         @missed_count, @missed_from, @missed_until, @resolved_config_json, @summary,
         @error_code, @error_message, @dispatch_phase,
         @lease_token, @lease_expires_at, @created_at, @started_at, @finished_at,
         @updated_at, @revision
       )`,
    ).run(row as unknown as Record<string, unknown>);
    return row;
  }

  runRow(id: string): ScheduleRunRow | null {
    return (this.db.prepare('SELECT * FROM schedule_runs WHERE id = ?').get(id) as ScheduleRunRow | undefined)
      ?? null;
  }

  requireRunRow(id: string): ScheduleRunRow {
    const row = this.runRow(id);
    if (!row) throw scheduleFailure('SCHEDULE_RUN_NOT_FOUND', `schedule run not found: ${id}`);
    return row;
  }

  listRunRowsForSchedule(scheduleId: string, limit: number, cursor?: RunCursor | null): {
    rows: ScheduleRunRow[];
    nextCursor: RunCursor | null;
  } {
    const params: Record<string, unknown> = { scheduleId, limit: limit + 1 };
    let where = 'WHERE schedule_id = @scheduleId';
    if (cursor) {
      // Descending keyset: the next page starts strictly "before" the last
      // row of this page.
      where += ' AND (created_at < @cursorCreatedAt OR (created_at = @cursorCreatedAt AND id < @cursorId))';
      params.cursorCreatedAt = cursor.createdAt;
      params.cursorId = cursor.id;
    }
    const rows = this.db.prepare(
      `SELECT * FROM schedule_runs ${where} ORDER BY created_at DESC, id DESC LIMIT @limit`,
    ).all(params) as ScheduleRunRow[];
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      rows: page,
      nextCursor: rows.length > limit && last ? { createdAt: last.created_at, id: last.id } : null,
    };
  }

  runRowsByIds(ids: string[]): ScheduleRunRow[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    return this.db.prepare(
      `SELECT * FROM schedule_runs WHERE id IN (${placeholders}) ORDER BY created_at, id`,
    ).all(...ids) as ScheduleRunRow[];
  }

  nonTerminalRunRows(limit = 200): ScheduleRunRow[] {
    const statuses = ['scheduled', 'starting', 'running', 'waiting_interaction'];
    const placeholders = statuses.map(() => '?').join(',');
    return this.db.prepare(
      `SELECT * FROM schedule_runs WHERE status IN (${placeholders})
        ORDER BY created_at, id LIMIT ?`,
    ).all(...statuses, limit) as ScheduleRunRow[];
  }

  runRowsByStatuses(statuses: Iterable<ScheduleRunRow['status']>, limit = 200): ScheduleRunRow[] {
    const list = [...statuses];
    if (list.length === 0) return [];
    const placeholders = list.map(() => '?').join(',');
    return this.db.prepare(
      `SELECT * FROM schedule_runs WHERE status IN (${placeholders})
        ORDER BY created_at, id LIMIT ?`,
    ).all(...list, limit) as ScheduleRunRow[];
  }

  startingRunRowsWithExpiredLease(nowIso: string, limit = 100): ScheduleRunRow[] {
    return this.db.prepare(
      `SELECT * FROM schedule_runs
        WHERE status = 'starting' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
        ORDER BY created_at, id LIMIT ?`,
    ).all(nowIso, limit) as ScheduleRunRow[];
  }

  /** CAS `turn_requested -> accepted`, binds the Turn, and clears the lease
   *  once the Provider accepted the send. */
  markRunRunning(runId: string, turnId: string, now: string): ScheduleRunRow | null {
    const result = this.db.prepare(
      `UPDATE schedule_runs
          SET status = 'running', dispatch_phase = 'accepted', turn_id = ?,
              lease_token = NULL, lease_expires_at = NULL,
              updated_at = ?, revision = revision + 1
        WHERE id = ? AND dispatch_phase = 'turn_requested'`,
    ).run(turnId, now, runId);
    return result.changes === 1 ? this.runRow(runId) : null;
  }

  oldestScheduledRunRows(limit: number): ScheduleRunRow[] {
    return this.db.prepare(
      `SELECT * FROM schedule_runs WHERE status = 'scheduled' ORDER BY created_at, id LIMIT ?`,
    ).all(limit) as ScheduleRunRow[];
  }

  countRunsByStatuses(statuses: Iterable<ScheduleRunRow['status']>): number {
    const list = [...statuses];
    if (list.length === 0) return 0;
    const placeholders = list.map(() => '?').join(',');
    const row = this.db.prepare(
      `SELECT COUNT(*) AS n FROM schedule_runs WHERE status IN (${placeholders})`,
    ).get(...list) as { n: number };
    return row.n;
  }

  blockingRunExists(scheduleId: string): boolean {
    const statuses = [...BLOCKING_RUN_STATUSES];
    const placeholders = statuses.map(() => '?').join(',');
    const row = this.db.prepare(
      `SELECT 1 AS hit FROM schedule_runs
        WHERE schedule_id = ? AND status IN (${placeholders}) LIMIT 1`,
    ).get(scheduleId, ...statuses) as { hit: number } | undefined;
    return row !== undefined;
  }

  /** CAS: `scheduled -> starting/claimed`. Writes the 30s dispatch lease.
   *  The execution mode is decided by the dispatcher after this claim and
   *  persisted by `resolveRunMode` — from that point on it never switches
   *  back except for the monotonic busy-race escalation to fork. */
  claimRunForDispatch(
    runId: string,
    leaseToken: string,
    leaseExpiresAt: string,
    now: string,
  ): ScheduleRunRow | null {
    const result = this.db.prepare(
      `UPDATE schedule_runs
          SET status = 'starting', dispatch_phase = 'claimed', lease_token = ?,
              lease_expires_at = ?, started_at = ?,
              updated_at = ?, revision = revision + 1
        WHERE id = ? AND status = 'scheduled'`,
    ).run(leaseToken, leaseExpiresAt, now, now, runId);
    return result.changes === 1 ? this.runRow(runId) : null;
  }

  /** CAS: persist the dispatch decision (contract H). `targetSessionId` is the
   *  Fork Session id for `fork` mode or the control Session id for
   *  `bound_session`. */
  resolveRunMode(
    runId: string,
    mode: ScheduleExecutionMode,
    targetSessionId: string,
    forkAnchor: ScheduleForkAnchor | null,
    now: string,
  ): ScheduleRunRow | null {
    const result = this.db.prepare(
      `UPDATE schedule_runs
          SET execution_mode = ?, target_session_id = ?, fork_anchor_json = ?,
              dispatch_phase = 'resolved', updated_at = ?, revision = revision + 1
        WHERE id = ? AND status = 'starting' AND dispatch_phase = 'claimed'`,
    ).run(
      mode,
      targetSessionId,
      forkAnchor ? JSON.stringify(forkAnchor) : null,
      now,
      runId,
    );
    return result.changes === 1 ? this.runRow(runId) : null;
  }

  /** Monotonic busy-race escalation (contract G): a bound_session claim whose
   *  main-conversation send lost the idle race may escalate to a hidden Fork
   *  exactly once, and only while still `starting`. */
  escalateRunToFork(
    runId: string,
    targetSessionId: string,
    forkAnchor: ScheduleForkAnchor,
    now: string,
  ): ScheduleRunRow | null {
    const result = this.db.prepare(
      `UPDATE schedule_runs
          SET execution_mode = 'fork', target_session_id = ?, fork_anchor_json = ?,
              dispatch_phase = 'resolved', updated_at = ?, revision = revision + 1
        WHERE id = ? AND status = 'starting' AND execution_mode = 'bound_session'
          AND dispatch_phase IN ('claimed', 'resolved')`,
    ).run(targetSessionId, JSON.stringify(forkAnchor), now, runId);
    return result.changes === 1 ? this.runRow(runId) : null;
  }

  /** CAS `resolved -> dispatched/running`: the Provider accepted the send.
   *  Binds the Turn, stores the resolved config snapshot, and clears the
   *  lease — the canonical Session/Turn rows own the Run from here on. */
  markRunDispatched(
    runId: string,
    turnId: string,
    resolvedConfig: object | null,
    now: string,
  ): ScheduleRunRow | null {
    const result = this.db.prepare(
      `UPDATE schedule_runs
          SET status = 'running', dispatch_phase = 'dispatched', turn_id = ?,
              resolved_config_json = COALESCE(?, resolved_config_json),
              lease_token = NULL, lease_expires_at = NULL,
              updated_at = ?, revision = revision + 1
        WHERE id = ? AND status = 'starting' AND dispatch_phase = 'resolved'`,
    ).run(turnId, resolvedConfig ? JSON.stringify(resolvedConfig) : null, now, runId);
    return result.changes === 1 ? this.runRow(runId) : null;
  }

  /** CAS terminal transition; never overrides an already-terminal status. */
  settleRun(
    runId: string,
    status: ScheduleRunRow['status'],
    patch: {
      turnId?: string | null;
      targetSessionId?: string | null;
      executionMode?: ScheduleExecutionMode | null;
      forkAnchor?: ScheduleForkAnchor | null;
      resolvedConfig?: object | null;
      summary?: string | null;
      errorCode?: string | null;
      errorMessage?: string | null;
    } | undefined,
    now: string,
  ): ScheduleRunRow | null {
    if (!TERMINAL_RUN_STATUSES.has(status)) {
      throw new Error(`settleRun requires a terminal status, got ${status}`);
    }
    const assignments = [
      'status = @status',
      'finished_at = @now',
      'updated_at = @now',
      'revision = revision + 1',
      'lease_token = NULL',
      'lease_expires_at = NULL',
    ];
    const params: Record<string, unknown> = {
      runId,
      status,
      now,
      ...Object.fromEntries(TERMINAL_STATUS_PARAMS),
    };
    if (patch?.turnId !== undefined) {
      assignments.push('turn_id = @turnId');
      params.turnId = patch.turnId;
    }
    if (patch?.targetSessionId !== undefined) {
      assignments.push('target_session_id = @targetSessionId');
      params.targetSessionId = patch.targetSessionId;
    }
    if (patch?.executionMode !== undefined) {
      assignments.push('execution_mode = @executionMode');
      params.executionMode = patch.executionMode;
    }
    if (patch?.forkAnchor !== undefined) {
      assignments.push('fork_anchor_json = @forkAnchorJson');
      params.forkAnchorJson = patch.forkAnchor ? JSON.stringify(patch.forkAnchor) : null;
    }
    if (patch?.resolvedConfig !== undefined) {
      assignments.push('resolved_config_json = @resolvedConfig');
      params.resolvedConfig = patch.resolvedConfig === null ? null : JSON.stringify(patch.resolvedConfig);
    }
    if (patch?.summary !== undefined) {
      assignments.push('summary = @summary');
      params.summary = patch.summary;
    }
    if (patch?.errorCode !== undefined) {
      assignments.push('error_code = @errorCode');
      params.errorCode = patch.errorCode;
    }
    if (patch?.errorMessage !== undefined) {
      assignments.push('error_message = @errorMessage');
      params.errorMessage = patch.errorMessage;
    }
    const result = this.db.prepare(
      `UPDATE schedule_runs SET ${assignments.join(', ')}
        WHERE id = @runId AND status NOT IN (${TERMINAL_STATUS_PLACEHOLDERS})`,
    ).run(params);
    return result.changes === 1 ? this.runRow(runId) : null;
  }

  /** Non-terminal run update used by reconciliation (binds evidence, tracks
   *  waiting_interaction, etc.). */
  updateRunColumns(
    runId: string,
    patch: {
      status?: ScheduleRunRow['status'];
      turnId?: string | null;
      targetSessionId?: string | null;
      executionMode?: ScheduleExecutionMode | null;
      forkAnchor?: ScheduleForkAnchor | null;
      resolvedConfig?: object | null;
      summary?: string | null;
      errorCode?: string | null;
      errorMessage?: string | null;
      startedAt?: string;
    },
    now: string,
  ): ScheduleRunRow | null {
    const assignments: string[] = ['updated_at = @now', 'revision = revision + 1'];
    const params: Record<string, unknown> = { runId, now };
    if (patch.status !== undefined) {
      assignments.push('status = @status');
      params.status = patch.status;
    }
    if (patch.turnId !== undefined) {
      assignments.push('turn_id = @turnId');
      params.turnId = patch.turnId;
    }
    if (patch.targetSessionId !== undefined) {
      assignments.push('target_session_id = @targetSessionId');
      params.targetSessionId = patch.targetSessionId;
    }
    if (patch.executionMode !== undefined) {
      assignments.push('execution_mode = @executionMode');
      params.executionMode = patch.executionMode;
    }
    if (patch.forkAnchor !== undefined) {
      assignments.push('fork_anchor_json = @forkAnchorJson');
      params.forkAnchorJson = patch.forkAnchor ? JSON.stringify(patch.forkAnchor) : null;
    }
    if (patch.resolvedConfig !== undefined) {
      assignments.push('resolved_config_json = @resolvedConfig');
      params.resolvedConfig = patch.resolvedConfig === null ? null : JSON.stringify(patch.resolvedConfig);
    }
    if (patch.summary !== undefined) {
      assignments.push('summary = @summary');
      params.summary = patch.summary;
    }
    if (patch.errorCode !== undefined) {
      assignments.push('error_code = @errorCode');
      params.errorCode = patch.errorCode;
    }
    if (patch.errorMessage !== undefined) {
      assignments.push('error_message = @errorMessage');
      params.errorMessage = patch.errorMessage;
    }
    if (patch.startedAt !== undefined) {
      assignments.push('started_at = @startedAt');
      params.startedAt = patch.startedAt;
    }
    const result = this.db.prepare(
      `UPDATE schedule_runs SET ${assignments.join(', ')} WHERE id = @runId`,
    ).run(params);
    return result.changes === 1 ? this.runRow(runId) : null;
  }

  // ── due materialization (§8.2/§8.3/§8.4) ───────────────────────────────────

  /**
   * One synchronous transaction over at most `maxSchedules` due Schedules.
   * Applies misfire policy and overlap audit, inserts Runs, and advances
   * next_run_at/last_run_at/revision. Never awaits I/O. The partial unique
   * index on (schedule_id, scheduled_for) is the final duplicate boundary.
   */
  materializeDueRuns(options: {
    nowMs: number;
    nowIso: string;
    graceMs: number;
    maxSchedules: number;
    enumerationCap: number;
  }): DueOutcome[] {
    return this.db.transaction((): DueOutcome[] => {
      const due = this.db.prepare(
        `SELECT * FROM schedules
          WHERE status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ?
          ORDER BY next_run_at, id
          LIMIT ?`,
      ).all(options.nowIso, options.maxSchedules) as ScheduleRow[];
      return due.map(schedule => this.materializeScheduleDue(schedule, options));
    })();
  }

  private materializeScheduleDue(
    schedule: ScheduleRow,
    options: { nowMs: number; nowIso: string; graceMs: number; enumerationCap: number },
  ): DueOutcome {
    const trigger = JSON.parse(schedule.trigger_json) as ScheduleTrigger;
    const from = schedule.next_run_at!;
    const { occurrences, truncated } = enumerateDue(
      trigger,
      schedule.timezone,
      Date.parse(from),
      options.nowMs,
      options.enumerationCap,
    );

    if (occurrences.length === 0) {
      // Defensive: next_run_at pointed into the past but enumerated nothing.
      // Recompute from `now` so the Schedule always makes progress.
      const fallback = nextOccurrence(trigger, schedule.timezone, options.nowMs);
      this.updateScheduleColumns(schedule.id, {
        nextRunAt: fallback ?? undefined,
        clearNextRun: fallback === null,
      }, { now: options.nowIso });
      return { scheduleId: schedule.id, runId: null, skippedOverlap: false, nextRunAt: fallback, truncated: false };
    }

    const advanceAfter = occurrences.at(-1)!;
    const nextRunAt = trigger.kind === 'once'
      ? null
      : nextOccurrence(trigger, schedule.timezone, Date.parse(advanceAfter));
    const scheduledFor = advanceAfter;
    const missedCount = occurrences.length - 1;

    const blocked = this.blockingRunExists(schedule.id);
    let run: ScheduleRunRow;
    if (blocked) {
      // §8.4: audit the overlap instead of silently advancing time.
      run = this.insertRun({
        scheduleId: schedule.id,
        triggerKind: 'scheduled',
        scheduledFor,
        status: 'skipped_overlap',
        missedCount,
        missedFrom: occurrences[0]!,
        missedUntil: missedCount > 0 ? occurrences[occurrences.length - 2]! : null,
        now: options.nowIso,
      });
    } else {
      const missed = occurrences.filter(at => Date.parse(at) < options.nowMs - options.graceMs);
      const isMisfire = Date.parse(scheduledFor) < options.nowMs - options.graceMs;
      if (isMisfire && schedule.misfire_policy === 'skip') {
        // One terminal aggregate for the whole missed window. The latest
        // occurrence is itself missed and recorded in the window bounds.
        run = this.insertRun({
          scheduleId: schedule.id,
          triggerKind: 'scheduled',
          scheduledFor,
          status: 'missed',
          missedCount: occurrences.length,
          missedFrom: occurrences[0]!,
          missedUntil: scheduledFor,
          now: options.nowIso,
        });
      } else {
        // One dispatchable run at the latest occurrence; the bounded missed
        // window rides along. Normal grace occurrences are never recorded as
        // missed (§8.3).
        const normalExists = !isMisfire;
        run = this.insertRun({
          scheduleId: schedule.id,
          triggerKind: 'scheduled',
          scheduledFor,
          missedCount: missed.length,
          missedFrom: normalExists ? missed[0] ?? null : occurrences[0]!,
          missedUntil: normalExists ? missed.at(-1) ?? null : (missedCount > 0 ? occurrences[occurrences.length - 2]! : null),
          now: options.nowIso,
        });
      }
    }

    if (trigger.kind === 'once') {
      // The single occurrence materialized (even as audit) → definition done.
      this.setScheduleState(schedule.id, {
        status: 'completed',
        statusReason: null,
        clearNextRun: true,
      }, { now: options.nowIso });
    } else {
      this.updateScheduleColumns(schedule.id, {
        nextRunAt,
        clearNextRun: nextRunAt === null,
        lastRunAt: scheduledFor,
      }, { now: options.nowIso });
    }
    return { scheduleId: schedule.id, runId: run.id, skippedOverlap: blocked, nextRunAt, truncated };
  }

  // ── command receipts (§6/§11) ──────────────────────────────────────────────

  receipt(actorKey: string, idempotencyKey: string): ScheduleCommandReceiptRow | null {
    return (this.db.prepare(
      'SELECT * FROM schedule_command_receipts WHERE actor_key = ? AND idempotency_key = ?',
    ).get(actorKey, idempotencyKey) as ScheduleCommandReceiptRow | undefined) ?? null;
  }

  insertReceipt(row: ScheduleCommandReceiptRow): void {
    this.db.prepare(
      `INSERT INTO schedule_command_receipts (
         actor_key, idempotency_key, method, input_hash, status, domain_id,
         lease_token, lease_expires_at, response_json, error_json, created_at, updated_at
       ) VALUES (
         @actor_key, @idempotency_key, @method, @input_hash, @status, @domain_id,
         @lease_token, @lease_expires_at, @response_json, @error_json, @created_at, @updated_at
       )`,
    ).run(row as unknown as Record<string, unknown>);
  }

  succeedReceipt(actorKey: string, idempotencyKey: string, response: unknown, now: string): void {
    this.db.prepare(
      `UPDATE schedule_command_receipts
          SET status = 'succeeded', response_json = ?, error_json = NULL, updated_at = ?
        WHERE actor_key = ? AND idempotency_key = ?`,
    ).run(JSON.stringify(response), now, actorKey, idempotencyKey);
  }

  failReceipt(actorKey: string, idempotencyKey: string, error: unknown, now: string): void {
    this.db.prepare(
      `UPDATE schedule_command_receipts
          SET status = 'failed', response_json = NULL, error_json = ?, updated_at = ?
        WHERE actor_key = ? AND idempotency_key = ?`,
    ).run(JSON.stringify(error), now, actorKey, idempotencyKey);
  }

  /** CAS takeover of an expired in-progress receipt with the same input hash.
   *  A different hash can never take over. */
  takeoverExpiredReceipt(options: {
    actorKey: string;
    idempotencyKey: string;
    inputHash: string;
    leaseToken: string;
    leaseExpiresAt: string;
    nowIso: string;
  }): boolean {
    const result = this.db.prepare(
      `UPDATE schedule_command_receipts
          SET lease_token = ?, lease_expires_at = ?, updated_at = ?
        WHERE actor_key = ? AND idempotency_key = ? AND input_hash = ?
          AND status = 'in_progress'
          AND (lease_expires_at IS NULL OR lease_expires_at <= ?)`,
    ).run(
      options.leaseToken,
      options.leaseExpiresAt,
      options.nowIso,
      options.actorKey,
      options.idempotencyKey,
      options.inputHash,
      options.nowIso,
    );
    return result.changes === 1;
  }

  /** Keeps at most `maxTerminal` terminal receipts, newest first. */
  pruneReceipts(maxTerminal = 10_000): void {
    this.db.prepare(
      `DELETE FROM schedule_command_receipts
        WHERE (actor_key, idempotency_key) IN (
          SELECT actor_key, idempotency_key FROM schedule_command_receipts
           WHERE status IN ('succeeded', 'failed')
           ORDER BY updated_at DESC LIMIT -1 OFFSET ?
        )`,
    ).run(maxTerminal);
  }

  /** Rows currently counted against the global dispatch capacity. */
  capacityInUse(): number {
    return this.countRunsByStatuses([...CAPACITY_RUN_STATUSES]);
  }

  // ── create confirmations (contract L) ──────────────────────────────────────

  insertConfirmation(input: {
    id: string;
    controlSessionId: string;
    payload: object;
    scheduleId: string | null;
    createdByActorId: string;
    toolRequestId: string | null;
    expiresAt: string;
    now: string;
  }): ScheduleConfirmationRow {
    const row: ScheduleConfirmationRow = {
      id: input.id,
      control_session_id: input.controlSessionId,
      status: 'pending',
      payload_json: JSON.stringify(input.payload),
      schedule_id: input.scheduleId,
      created_by_actor_id: input.createdByActorId,
      tool_request_id: input.toolRequestId,
      expires_at: input.expiresAt,
      created_at: input.now,
      updated_at: input.now,
      resolved_at: null,
    };
    this.db.prepare(
      `INSERT INTO schedule_confirmations (
         id, control_session_id, status, payload_json, schedule_id,
         created_by_actor_id, tool_request_id, expires_at,
         created_at, updated_at, resolved_at
       ) VALUES (
         @id, @control_session_id, @status, @payload_json, @schedule_id,
         @created_by_actor_id, @tool_request_id, @expires_at,
         @created_at, @updated_at, @resolved_at
       )`,
    ).run(row as unknown as Record<string, unknown>);
    return row;
  }

  confirmationRow(id: string): ScheduleConfirmationRow | null {
    return (this.db.prepare(
      'SELECT * FROM schedule_confirmations WHERE id = ?',
    ).get(id) as ScheduleConfirmationRow | undefined) ?? null;
  }

  requireConfirmationRow(id: string): ScheduleConfirmationRow {
    const row = this.confirmationRow(id);
    if (!row) {
      throw scheduleFailure('SCHEDULE_CONFIRMATION_NOT_FOUND', `schedule confirmation not found: ${id}`);
    }
    return row;
  }

  confirmationRowByToolRequest(toolRequestId: string): ScheduleConfirmationRow | null {
    return (this.db.prepare(
      'SELECT * FROM schedule_confirmations WHERE tool_request_id = ?',
    ).get(toolRequestId) as ScheduleConfirmationRow | undefined) ?? null;
  }

  listConfirmationRows(options: {
    controlSessionId?: string;
    status?: ScheduleConfirmationRow['status'];
    limit: number;
  }): ScheduleConfirmationRow[] {
    const clauses: string[] = [];
    const params: Record<string, unknown> = { limit: options.limit };
    if (options.controlSessionId) {
      clauses.push('control_session_id = @controlSessionId');
      params.controlSessionId = options.controlSessionId;
    }
    if (options.status) {
      clauses.push('status = @status');
      params.status = options.status;
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db.prepare(
      `SELECT * FROM schedule_confirmations ${where}
        ORDER BY created_at DESC, id DESC LIMIT @limit`,
    ).all(params) as ScheduleConfirmationRow[];
  }

  /** CAS resolve: only a still-pending confirmation can transition, and only
   *  before its expiry instant. */
  resolveConfirmation(
    id: string,
    decision: 'approved' | 'rejected' | 'expired',
    scheduleId: string | null,
    now: string,
  ): ScheduleConfirmationRow | null {
    const result = this.db.prepare(
      `UPDATE schedule_confirmations
          SET status = ?, schedule_id = COALESCE(?, schedule_id),
              resolved_at = ?, updated_at = ?
        WHERE id = ? AND status = 'pending' AND expires_at > ?`,
    ).run(decision, scheduleId, now, now, id, now);
    return result.changes === 1 ? this.confirmationRow(id) : null;
  }

  /** Marks a pending row `approved` once the Schedule commit landed, keeping
   *  the schedule id binding (used by the wait loop after the CAS resolve). */
  attachScheduleToConfirmation(id: string, scheduleId: string, now: string): void {
    this.db.prepare(
      `UPDATE schedule_confirmations
          SET schedule_id = ?, updated_at = ?
        WHERE id = ?`,
    ).run(scheduleId, now, id);
  }

  /** Lazily expires stale pending rows; returns the ids it transitioned. */
  expirePendingConfirmations(nowIso: string, limit = 100): string[] {
    return this.db.transaction((): string[] => {
      const rows = this.db.prepare(
        `SELECT id FROM schedule_confirmations
          WHERE status = 'pending' AND expires_at <= ? LIMIT ?`,
      ).all(nowIso, limit) as Array<{ id: string }>;
      if (rows.length === 0) return [];
      const update = this.db.prepare(
        `UPDATE schedule_confirmations
            SET status = 'expired', resolved_at = ?, updated_at = ?
          WHERE id = ? AND status = 'pending'`,
      );
      for (const row of rows) update.run(nowIso, nowIso, row.id);
      return rows.map(row => row.id);
    })();
  }

  /** Prunes terminal confirmations, keeping the newest `maxTerminal`. */
  pruneConfirmations(maxTerminal = 2_000): void {
    this.db.prepare(
      `DELETE FROM schedule_confirmations
        WHERE id IN (
          SELECT id FROM schedule_confirmations
           WHERE status IN ('approved', 'rejected', 'expired')
           ORDER BY updated_at DESC LIMIT -1 OFFSET ?
        )`,
    ).run(maxTerminal);
  }
}
