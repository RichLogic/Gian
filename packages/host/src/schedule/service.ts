import { randomUUID } from 'node:crypto';
import type {
  Schedule,
  ScheduleConfirmation,
  ScheduleConfirmationPayload,
  ScheduleMisfirePolicy,
  SchedulePreviewRequest,
  SchedulePreviewResponse,
  ScheduleRun,
  ScheduleStatus,
  ScheduleTrigger,
} from '@gian/shared';
import {
  MAX_NON_ARCHIVED_SCHEDULES,
  MAX_PAGE_SIZE,
  MAX_PROMPT_BYTES,
  MAX_NAME_CODEPOINTS,
  SCHEDULE_CONFIRMATION_TTL_MS,
  SCHEDULE_PREVIEW_LIMIT,
} from '@gian/shared';
import type { Db } from '../storage/db.js';
import type { WsBroadcaster } from '../web/ws-broadcast.js';
import { scheduleFailure } from './errors.js';
import {
  ScheduleRepository,
  type RunCursor,
  type ScheduleCursor,
} from './repository.js';
import { normalizeTimezone, normalizeTrigger, nextOccurrence, previewOccurrences } from './trigger.js';
import {
  type ControlSessionDisplay,
  type ScheduleConfirmationRow,
  type ScheduleRunRow,
  toConfirmation,
  toRun,
  toSchedule,
} from './types.js';

/**
 * The one domain command/query layer both the REST routes and the Gian Tool
 * call into (ADR-0053). Routes never re-implement validation or the status
 * machine; the Tool access controller applies actor scope before calling in.
 * Every Schedule is bound to one immutable control Session derived from the
 * creating credential — no workspace/task/agent selection exists here.
 */

export interface ScheduleServiceDeps {
  db: Db;
  broadcaster: WsBroadcaster;
  /** Fail-closed lifecycle gate from SessionManager; absent in minimal tests. */
  assertControlSessionReady?: (sessionId: string) => void;
  /** Wired to the orchestrator's coalescing wake after construction. */
  wake?: () => void;
  now?: () => { ms: number; iso: string };
}

export interface CreateScheduleInput {
  name: string;
  prompt: string;
  trigger: unknown;
  timezone: string;
  misfire_policy?: ScheduleMisfirePolicy;
  controlSessionId: string;
  creatorActorId: string;
  /** Pre-allocated id from a receipt/ledger claim; crash+retry convergence. */
  domainId?: string | null;
}

export interface UpdateScheduleInput {
  schedule_id: string;
  expected_revision: number;
  name?: string;
  prompt?: string;
  trigger?: unknown;
  timezone?: string;
  misfire_policy?: ScheduleMisfirePolicy;
}

export interface RunNowInput {
  schedule_id: string;
  domainId?: string | null;
}

export interface CreateConfirmationInput {
  name: string;
  prompt: string;
  trigger: unknown;
  timezone: string;
  misfire_policy?: ScheduleMisfirePolicy;
  controlSessionId: string;
  createdByActorId: string;
  /** Pre-allocated Schedule id from the Tool idempotency ledger. */
  scheduleDomainId: string | null;
  toolRequestId: string | null;
}

export type ConfirmationDecision = 'approve' | 'reject';

const SCHEDULE_CHANGED_REASONS = [
  'created', 'updated', 'state_changed', 'run_created', 'run_updated', 'archived',
] as const;

type ScheduleChangedReason = (typeof SCHEDULE_CHANGED_REASONS)[number];

const RISK_NOTE = 'Runs execute inside the bound conversation with its Agent, workspace, and quota. '
  + 'Model, thinking, and approval follow the conversation at run time; approvals still surface for review.';

export class ScheduleService {
  private readonly repo: ScheduleRepository;
  private readonly clock: () => { ms: number; iso: string };

  constructor(private readonly deps: ScheduleServiceDeps) {
    this.repo = new ScheduleRepository(deps.db);
    this.clock = deps.now ?? (() => {
      const ms = Date.now();
      return { ms, iso: new Date(ms).toISOString() };
    });
  }

  /** Wired by createApp after both objects exist (breaks the cycle). */
  setWake(wake: () => void): void {
    this.deps.wake = wake;
  }

  private wake(): void {
    try {
      this.deps.wake?.();
    } catch {
      // Wake failures must never fail the command.
    }
  }

  private broadcast(scheduleId: string, reason: ScheduleChangedReason, revision: number, runId?: string): void {
    this.deps.broadcaster.broadcast({
      type: 'schedule:changed',
      schedule_id: scheduleId,
      reason,
      revision,
      ...(runId ? { run_id: runId } : {}),
    });
  }

  private broadcastConfirmation(confirmation: ScheduleConfirmation): void {
    this.deps.broadcaster.broadcast({
      type: 'schedule:confirmation',
      confirmation,
    });
  }

  /** Run-level invalidation used by the orchestrator/dispatcher after a Run
   *  row changed (materialized, dispatched, reconciled). */
  broadcastRunUpdated(scheduleId: string, runId: string): void {
    const row = this.repo.scheduleRow(scheduleId);
    this.broadcast(scheduleId, 'run_updated', row?.revision ?? 0, runId);
  }

  /** Schedule-level invalidation when only definition fields (next_run_at,
   *  last_run_at, revision) advanced during materialization. */
  broadcastScheduleAdvanced(scheduleId: string): void {
    const row = this.repo.scheduleRow(scheduleId);
    if (row) this.broadcast(scheduleId, 'state_changed', row.revision);
  }

  broadcastScheduleStateChanged(scheduleId: string): void {
    const row = this.repo.scheduleRow(scheduleId);
    if (row) this.broadcast(scheduleId, 'state_changed', row.revision);
  }

  // ── validation helpers ─────────────────────────────────────────────────────

  private validateName(name: unknown): string {
    if (typeof name !== 'string' || name.trim().length === 0) {
      throw scheduleFailure('INVALID_ARGUMENT', 'name must be a non-empty string');
    }
    if ([...name].length > MAX_NAME_CODEPOINTS) {
      throw scheduleFailure('INVALID_ARGUMENT', `name must be at most ${MAX_NAME_CODEPOINTS} code points`);
    }
    return name.trim();
  }

  private validatePrompt(prompt: unknown): string {
    if (typeof prompt !== 'string' || prompt.trim().length === 0) {
      throw scheduleFailure('INVALID_ARGUMENT', 'prompt must be a non-empty string');
    }
    if (Buffer.byteLength(prompt, 'utf8') > MAX_PROMPT_BYTES) {
      throw scheduleFailure('INVALID_ARGUMENT', `prompt must be at most ${MAX_PROMPT_BYTES} UTF-8 bytes`);
    }
    return prompt;
  }

  private validateMisfirePolicy(value: unknown): ScheduleMisfirePolicy {
    if (value === undefined) return 'skip';
    if (value !== 'skip' && value !== 'run_once') {
      throw scheduleFailure('INVALID_ARGUMENT', 'misfire_policy must be skip or run_once');
    }
    return value;
  }

  private validateDefinition(input: {
    name: unknown;
    prompt: unknown;
    trigger: unknown;
    timezone: unknown;
    misfire_policy?: unknown;
  }): { name: string; prompt: string; trigger: ScheduleTrigger; timezone: string; misfirePolicy: ScheduleMisfirePolicy } {
    const name = this.validateName(input.name);
    const prompt = this.validatePrompt(input.prompt);
    if (typeof input.timezone !== 'string') {
      throw scheduleFailure('SCHEDULE_TIMEZONE_INVALID', 'timezone must be an IANA name');
    }
    const timezone = normalizeTimezone(input.timezone);
    const trigger = normalizeTrigger(input.trigger, timezone, this.clock().ms);
    return { name, prompt, trigger, timezone, misfirePolicy: this.validateMisfirePolicy(input.misfire_policy) };
  }

  private assertOnceIsFarEnough(trigger: ScheduleTrigger, nowMs: number): void {
    if (trigger.kind === 'once' && Date.parse(trigger.at) <= nowMs + 30_000) {
      throw scheduleFailure(
        'SCHEDULE_HAS_NO_FUTURE_OCCURRENCE',
        'a new active once Schedule must fire at least 30 seconds in the future',
      );
    }
  }

  private computeNextRunAt(trigger: ScheduleTrigger, timezone: string, ms: number): string | null {
    return nextOccurrence(trigger, timezone, ms);
  }

  /** Read-time display join of the control conversation (contract N). */
  private controlDisplay(sessionId: string): ControlSessionDisplay {
    const row = this.deps.db.prepare(
      `SELECT s.name AS title, s.agent_id AS agentId, s.agent_name AS agentName,
              s.workspace_id AS workspaceId, w.name AS workspaceName
         FROM sessions s
         LEFT JOIN workspaces w ON w.id = s.workspace_id
        WHERE s.id = ?`,
    ).get(sessionId) as {
      title: string | null;
      agentId: string | null;
      agentName: string | null;
      workspaceId: string | null;
      workspaceName: string | null;
    } | undefined;
    if (!row) return { title: null, agent_id: null, agent_name: null, workspace_id: null, workspace_name: null };
    return {
      title: row.title,
      agent_id: row.agentId,
      agent_name: row.agentName,
      workspace_id: row.workspaceId,
      workspace_name: row.workspaceName,
    };
  }

  // ── create confirmation (contract L) ───────────────────────────────────────

  /** Validates the definition up front, then persists a durable pending
   *  confirmation for the user. The Schedule commits only after an explicit
   *  approval; the Host enforces this, not a Skill reminder. */
  createConfirmation(input: CreateConfirmationInput): ScheduleConfirmation {
    const now = this.clock();
    const definition = this.validateDefinition(input);
    this.assertOnceIsFarEnough(definition.trigger, now.ms);
    const occurrences = previewOccurrences(definition.trigger, definition.timezone, now.ms, SCHEDULE_PREVIEW_LIMIT);
    const display = this.controlDisplay(input.controlSessionId);
    const payload: ScheduleConfirmationPayload = {
      name: definition.name,
      prompt: definition.prompt,
      prompt_summary: summarizePrompt(definition.prompt),
      trigger: definition.trigger,
      trigger_summary: describeTrigger(definition.trigger),
      timezone: definition.timezone,
      misfire_policy: definition.misfirePolicy,
      next_occurrences: occurrences.slice(0, 3),
      control_session: {
        id: input.controlSessionId,
        title: display.title,
        agent_name: display.agent_name,
        workspace_name: display.workspace_name,
      },
      risk_note: RISK_NOTE,
    };
    const row = this.repo.insertConfirmation({
      id: randomUUID(),
      controlSessionId: input.controlSessionId,
      payload,
      scheduleId: input.scheduleDomainId,
      createdByActorId: input.createdByActorId,
      toolRequestId: input.toolRequestId,
      expiresAt: new Date(now.ms + SCHEDULE_CONFIRMATION_TTL_MS).toISOString(),
      now: now.iso,
    });
    const confirmation = toConfirmation(row);
    this.broadcastConfirmation(confirmation);
    return confirmation;
  }

  /** Idempotent recovery: an interrupted create returns its pending (or
   *  resolved) confirmation instead of minting a second one. */
  confirmationForToolRequest(toolRequestId: string): ScheduleConfirmation | null {
    const row = this.repo.confirmationRowByToolRequest(toolRequestId);
    return row ? toConfirmation(row) : null;
  }

  /** Bounded poll until the user resolves the confirmation or the deadline
   *  passes. The Tool call stays in flight so the Agent observes the result.
   *  The deadline uses wall-clock time on purpose: the injected domain clock
   *  may be frozen, but this wait must always terminate. */
  async waitForConfirmation(input: {
    confirmationId: string;
    timeoutMs: number;
    sleep?: (ms: number) => Promise<void>;
  }): Promise<{ outcome: 'approved'; schedule: Schedule } | { outcome: 'rejected' } | { outcome: 'timeout'; confirmation: ScheduleConfirmation }> {
    const deadline = Date.now() + Math.max(0, input.timeoutMs);
    const sleep = input.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
    for (;;) {
      const confirmation = this.getConfirmation(input.confirmationId);
      if (confirmation.status === 'approved') {
        if (!confirmation.schedule_id) {
          throw scheduleFailure('INTERNAL_ERROR', 'approved confirmation has no Schedule');
        }
        return { outcome: 'approved', schedule: this.getSchedule(confirmation.schedule_id) };
      }
      if (confirmation.status === 'rejected') return { outcome: 'rejected' };
      if (confirmation.status === 'expired') {
        return { outcome: 'timeout', confirmation };
      }
      if (Date.now() >= deadline) {
        return { outcome: 'timeout', confirmation };
      }
      await sleep(50);
    }
  }

  resolveConfirmation(input: {
    confirmationId: string;
    decision: ConfirmationDecision;
  }): ScheduleConfirmation {
    const now = this.clock();
    const row = this.repo.confirmationRow(input.confirmationId);
    if (!row) {
      throw scheduleFailure('SCHEDULE_CONFIRMATION_NOT_FOUND', `confirmation not found: ${input.confirmationId}`);
    }
    if (row.status === 'expired') {
      // The caller must learn that their decision could not commit anything.
      throw scheduleFailure(
        'SCHEDULE_CONFIRMATION_EXPIRED',
        'confirmation expired before a decision was recorded',
      );
    }
    if (row.status !== 'pending') {
      return toConfirmation(row); // idempotent repeat converges
    }
    if (Date.parse(row.expires_at) <= now.ms) {
      const expired = this.repo.resolveConfirmation(input.confirmationId, 'expired', null, now.iso);
      const confirmation = toConfirmation(expired ?? row);
      this.broadcastConfirmation(confirmation);
      throw scheduleFailure(
        'SCHEDULE_CONFIRMATION_EXPIRED',
        'confirmation expired before a decision was recorded',
      );
    }

    if (input.decision === 'reject') {
      const rejected = this.repo.resolveConfirmation(input.confirmationId, 'rejected', null, now.iso);
      if (!rejected) return toConfirmation(this.repo.requireConfirmationRow(input.confirmationId));
      const confirmation = toConfirmation(rejected);
      this.broadcastConfirmation(confirmation);
      return confirmation;
    }

    // Approve: commit the Schedule first (using the pre-allocated domain id),
    // then CAS the confirmation to approved. If the CAS loses (expired under
    // us), archive the just-created Schedule so an expired confirmation never
    // leaves an active Schedule behind.
    const schedule = this.commitApprovedSchedule(row);
    const resolved = this.repo.resolveConfirmation(input.confirmationId, 'approved', schedule.id, now.iso);
    if (!resolved) {
      try {
        this.archiveSchedule(schedule.id);
      } catch {
        // Already archived/converged — nothing left to undo.
      }
      throw scheduleFailure(
        'SCHEDULE_CONFIRMATION_EXPIRED',
        'confirmation expired while the approval was being committed',
      );
    }
    const confirmation = toConfirmation(resolved);
    this.broadcastConfirmation(confirmation);
    this.wake();
    return confirmation;
  }

  /** The only path that turns a pending confirmation into a live Schedule. */
  private commitApprovedSchedule(row: ScheduleConfirmationRow): Schedule {
    const payload = JSON.parse(row.payload_json) as ScheduleConfirmationPayload;
    return this.createScheduleFromConfirmation({
      domainId: row.schedule_id,
      name: payload.name,
      prompt: payload.prompt,
      trigger: payload.trigger,
      timezone: payload.timezone,
      misfirePolicy: payload.misfire_policy ?? 'skip',
      controlSessionId: row.control_session_id,
      creatorActorId: row.created_by_actor_id,
    });
  }

  getConfirmation(id: string): ScheduleConfirmation {
    return toConfirmation(this.repo.requireConfirmationRow(id));
  }

  listConfirmations(options: {
    controlSessionId?: string;
    status?: ScheduleConfirmation['status'];
    limit?: number;
  }): ScheduleConfirmation[] {
    const limit = parseLimit(options.limit);
    return this.repo.listConfirmationRows({
      controlSessionId: options.controlSessionId,
      status: options.status,
      limit,
    }).map(toConfirmation);
  }

  /** Orchestrator pulse hook: lazily expires stale pending confirmations. */
  expireStaleConfirmations(nowIso: string): void {
    const expired = this.repo.expirePendingConfirmations(nowIso);
    for (const id of expired) {
      const row = this.repo.confirmationRow(id);
      if (row) this.broadcastConfirmation(toConfirmation(row));
    }
  }

  // ── commands ───────────────────────────────────────────────────────────────

  /** Commit path for an approved confirmation. Re-validates the trigger
   *  against the current clock: a user who approves late must never create a
   *  once Schedule whose occurrence already passed. */
  private createScheduleFromConfirmation(input: {
    domainId: string | null;
    name: string;
    prompt: string;
    trigger: ScheduleTrigger;
    timezone: string;
    misfirePolicy: ScheduleMisfirePolicy;
    controlSessionId: string;
    creatorActorId: string;
  }): Schedule {
    const now = this.clock();
    // Crash recovery: a pre-allocated id converges on the canonical Schedule.
    if (input.domainId) {
      const existing = this.repo.scheduleRow(input.domainId);
      if (existing) return toSchedule(existing, this.controlDisplay(existing.control_session_id));
    }
    const nextRunAt = this.computeNextRunAt(input.trigger, input.timezone, now.ms);
    if (nextRunAt === null) {
      throw scheduleFailure(
        'SCHEDULE_HAS_NO_FUTURE_OCCURRENCE',
        'the trigger has no future occurrence anymore; ask for a new confirmation',
      );
    }
    const row = this.repo.insertScheduleWithinCap({
      id: input.domainId ?? randomUUID(),
      name: input.name,
      prompt: input.prompt,
      trigger: input.trigger,
      timezone: input.timezone,
      misfirePolicy: input.misfirePolicy,
      nextRunAt,
      controlSessionId: input.controlSessionId,
      creatorActorId: input.creatorActorId,
      now: now.iso,
    }, MAX_NON_ARCHIVED_SCHEDULES);
    const schedule = toSchedule(row, this.controlDisplay(row.control_session_id));
    this.broadcast(schedule.id, 'created', schedule.revision);
    this.wake();
    return schedule;
  }

  /** Direct create for tests and future Host-internal callers only: the
   *  Tool path must go through createConfirmation + resolveConfirmation. */
  createSchedule(input: CreateScheduleInput): Schedule {
    const now = this.clock();
    if (input.domainId) {
      const existing = this.repo.scheduleRow(input.domainId);
      if (existing) return toSchedule(existing, this.controlDisplay(existing.control_session_id));
    }
    const definition = this.validateDefinition(input);
    this.assertOnceIsFarEnough(definition.trigger, now.ms);
    const nextRunAt = this.computeNextRunAt(definition.trigger, definition.timezone, now.ms);
    const row = this.repo.insertScheduleWithinCap({
      id: input.domainId ?? randomUUID(),
      name: definition.name,
      prompt: definition.prompt,
      trigger: definition.trigger,
      timezone: definition.timezone,
      misfirePolicy: definition.misfirePolicy,
      nextRunAt,
      controlSessionId: input.controlSessionId,
      creatorActorId: input.creatorActorId,
      now: now.iso,
    }, MAX_NON_ARCHIVED_SCHEDULES);
    const schedule = toSchedule(row, this.controlDisplay(row.control_session_id));
    this.broadcast(schedule.id, 'created', schedule.revision);
    this.wake();
    return schedule;
  }

  async updateSchedule(input: UpdateScheduleInput): Promise<Schedule> {
    const now = this.clock();
    const row = this.repo.requireScheduleRow(input.schedule_id);
    if (row.status === 'archived') {
      throw scheduleFailure('SCHEDULE_ARCHIVED', 'archived Schedules cannot be updated');
    }
    if (row.status === 'completed') {
      throw scheduleFailure('SCHEDULE_COMPLETED', 'completed once Schedules can only be archived or run now');
    }
    const patch: Parameters<ScheduleRepository['updateScheduleColumns']>[1] = {};
    if (input.name !== undefined) patch.name = this.validateName(input.name);
    if (input.prompt !== undefined) patch.prompt = this.validatePrompt(input.prompt);
    if (input.timezone !== undefined) {
      if (typeof input.timezone !== 'string') {
        throw scheduleFailure('SCHEDULE_TIMEZONE_INVALID', 'timezone must be an IANA name');
      }
      patch.timezone = normalizeTimezone(input.timezone);
    }
    const timezone = patch.timezone ?? row.timezone;
    if (input.trigger !== undefined) {
      patch.trigger = normalizeTrigger(input.trigger, timezone, now.ms);
    }
    if (input.misfire_policy !== undefined) {
      patch.misfirePolicy = this.validateMisfirePolicy(input.misfire_policy);
    }
    // Active Schedules recompute the next occurrence from the command commit
    // time; paused ones recompute on resume.
    const effectiveTrigger = (patch.trigger ?? JSON.parse(row.trigger_json)) as ScheduleTrigger;
    if (row.status === 'active') {
      if (effectiveTrigger.kind === 'once' && Date.parse(effectiveTrigger.at) <= now.ms + 30_000) {
        throw scheduleFailure(
          'SCHEDULE_HAS_NO_FUTURE_OCCURRENCE',
          'an active once Schedule must fire at least 30 seconds in the future',
        );
      }
      patch.nextRunAt = this.computeNextRunAt(effectiveTrigger, timezone, now.ms);
    }
    const updated = this.repo.updateScheduleColumns(row.id, patch, {
      expectedRevision: input.expected_revision,
      now: now.iso,
    });
    const schedule = toSchedule(updated, this.controlDisplay(updated.control_session_id));
    this.broadcast(schedule.id, 'updated', schedule.revision);
    this.wake();
    return schedule;
  }

  pauseSchedule(scheduleId: string, options: { expectedRevision?: number } = {}): Schedule {
    const now = this.clock();
    const row = this.repo.requireScheduleRow(scheduleId);
    if (row.status === 'archived') {
      throw scheduleFailure('SCHEDULE_ARCHIVED', 'archived Schedules cannot be paused');
    }
    if (row.status === 'completed') {
      throw scheduleFailure('SCHEDULE_COMPLETED', 'completed once Schedules cannot be paused');
    }
    const updated = this.repo.setScheduleState(scheduleId, {
      status: 'paused',
      statusReason: 'manual',
      clearNextRun: true,
    }, { expectedRevision: options.expectedRevision, now: now.iso });
    const schedule = toSchedule(updated, this.controlDisplay(updated.control_session_id));
    this.broadcast(schedule.id, 'state_changed', schedule.revision);
    return schedule;
  }

  resumeSchedule(scheduleId: string, options: { expectedRevision?: number } = {}): Promise<Schedule> {
    return (async () => {
      const now = this.clock();
      const row = this.repo.requireScheduleRow(scheduleId);
      if (row.status === 'archived') {
        throw scheduleFailure('SCHEDULE_ARCHIVED', 'archived Schedules cannot be resumed');
      }
      if (row.status === 'completed') {
        throw scheduleFailure('SCHEDULE_COMPLETED', 'completed once Schedules cannot resume');
      }
      if (row.status_reason === 'unknown_run') {
        // Risk confirmation requires an explicit user action; a plain resume
        // must not silently reactivate a Schedule blocked by an unknown Run.
        throw scheduleFailure(
          'SCHEDULE_REVISION_CONFLICT',
          'Schedule is paused for an unknown run; archive it and create a new one to confirm the risk',
        );
      }
      if (row.status === 'active') {
        // Desired-state idempotency: a crash between commit and receipt
        // re-executes the same resume harmlessly.
        return toSchedule(row, this.controlDisplay(row.control_session_id));
      }
      // Fail-closed re-validation before reactivating (contract J): the bound
      // conversation must still be able to receive the scheduled prompt.
      try {
        this.deps.assertControlSessionReady?.(row.control_session_id);
      } catch (error) {
        throw scheduleFailure(
          'SCHEDULE_CONTROL_SESSION_BLOCKED',
          `control conversation cannot receive scheduled prompts: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const trigger = JSON.parse(row.trigger_json) as ScheduleTrigger;
      const nextRunAt = this.computeNextRunAt(trigger, row.timezone, now.ms);
      if (nextRunAt === null) {
        throw scheduleFailure('SCHEDULE_HAS_NO_FUTURE_OCCURRENCE', 'the trigger has no future occurrence');
      }
      if (row.trigger_kind === 'once' && Date.parse(nextRunAt) <= now.ms + 30_000) {
        throw scheduleFailure('SCHEDULE_HAS_NO_FUTURE_OCCURRENCE', 'the once trigger is not at least 30 seconds in the future');
      }
      const updated = this.repo.setScheduleState(scheduleId, {
        status: 'active',
        statusReason: null,
        nextRunAt,
      }, { expectedRevision: options.expectedRevision, now: now.iso });
      const schedule = toSchedule(updated, this.controlDisplay(updated.control_session_id));
      this.broadcast(schedule.id, 'state_changed', schedule.revision);
      this.wake();
      return schedule;
    })();
  }

  archiveSchedule(scheduleId: string, options: { expectedRevision?: number } = {}): Schedule {
    const now = this.clock();
    const row = this.repo.requireScheduleRow(scheduleId);
    if (row.status === 'archived') {
      // v1 archive is irreversible; repeating it converges on the same row.
      return toSchedule(row, this.controlDisplay(row.control_session_id));
    }
    const updated = this.repo.setScheduleState(scheduleId, {
      status: 'archived',
      statusReason: 'manual',
      clearNextRun: true,
    }, { expectedRevision: options.expectedRevision, now: now.iso });
    const schedule = toSchedule(updated, this.controlDisplay(updated.control_session_id));
    this.broadcast(schedule.id, 'archived', schedule.revision);
    return schedule;
  }

  runNow(input: RunNowInput): ScheduleRun {
    const now = this.clock();
    const row = this.repo.requireScheduleRow(input.schedule_id);
    if (row.status === 'archived') {
      throw scheduleFailure('SCHEDULE_ARCHIVED', 'archived Schedules cannot run');
    }
    // Crash recovery: a recovered receipt converges on the same Run.
    if (input.domainId) {
      const existing = this.repo.runRow(input.domainId);
      if (existing) return toRun(existing);
    }
    if (this.repo.blockingRunExists(row.id)) {
      // Overlap applies to manual runs too — record the skip, never queue.
      const run = this.repo.insertRun({
        id: input.domainId ?? undefined,
        scheduleId: row.id,
        triggerKind: 'manual',
        scheduledFor: now.iso,
        status: 'skipped_overlap',
        now: now.iso,
      });
      this.repo.updateRunColumns(run.id, { errorCode: 'SCHEDULE_OVERLAP_SKIPPED' }, now.iso);
      const settled = this.repo.runRow(run.id)!;
      this.broadcast(row.id, 'run_created', row.revision, settled.id);
      return toRun(settled);
    }
    const run = this.repo.insertRun({
      id: input.domainId ?? undefined,
      scheduleId: row.id,
      triggerKind: 'manual',
      scheduledFor: now.iso,
      now: now.iso,
    });
    this.broadcast(row.id, 'run_created', row.revision, run.id);
    this.wake();
    return toRun(run);
  }

  // ── queries ────────────────────────────────────────────────────────────────

  getSchedule(id: string): Schedule {
    const row = this.repo.requireScheduleRow(id);
    return toSchedule(row, this.controlDisplay(row.control_session_id));
  }

  scheduleRow(id: string) {
    return this.repo.requireScheduleRow(id);
  }

  listSchedules(filter: {
    statuses?: ScheduleStatus[];
    controlSessionId?: string;
    limit?: number;
    cursor?: string | null;
  }): { schedules: Schedule[]; next_cursor: string | null } {
    const limit = parseLimit(filter.limit);
    // Archived Schedules stay out of the default list; an explicit
    // status filter is required to include them.
    const statuses = filter.statuses ?? (['active', 'paused', 'completed'] as ScheduleStatus[]);
    const cursor = decodeScheduleCursor(filter.cursor);
    const page = this.repo.listScheduleRows({
      statuses,
      controlSessionId: filter.controlSessionId,
      limit,
      cursor,
    });
    return {
      schedules: page.rows.map(row => toSchedule(row, this.controlDisplay(row.control_session_id))),
      next_cursor: page.nextCursor ? encodeScheduleCursor(page.nextCursor) : null,
    };
  }

  getRun(id: string): ScheduleRun {
    return toRun(this.repo.requireRunRow(id));
  }

  runRow(id: string): ScheduleRunRow {
    return this.repo.requireRunRow(id);
  }

  listRuns(scheduleId: string, options: { limit?: number; cursor?: string | null }): {
    runs: ScheduleRun[];
    next_cursor: string | null;
  } {
    // Existence check yields 404 instead of an empty page.
    this.repo.requireScheduleRow(scheduleId);
    const limit = parseLimit(options.limit);
    const cursor = decodeRunCursor(options.cursor);
    const page = this.repo.listRunRowsForSchedule(scheduleId, limit, cursor);
    return {
      runs: page.rows.map(toRun),
      next_cursor: page.nextCursor ? encodeRunCursor(page.nextCursor) : null,
    };
  }

  nonTerminalRunRows(limit?: number): ScheduleRunRow[] {
    return this.repo.nonTerminalRunRows(limit);
  }

  countRunsByStatuses(statuses: Iterable<ScheduleRunRow['status']>): number {
    return this.repo.countRunsByStatuses(statuses);
  }

  oldestScheduledRuns(limit: number): ScheduleRunRow[] {
    return this.repo.oldestScheduledRunRows(limit);
  }

  /** Exposed for the orchestrator/reconcile paths (same transaction rules). */
  get repository(): ScheduleRepository {
    return this.repo;
  }

  preview(input: SchedulePreviewRequest): SchedulePreviewResponse {
    if (typeof input.timezone !== 'string') {
      throw scheduleFailure('SCHEDULE_TIMEZONE_INVALID', 'timezone must be an IANA name');
    }
    const timezone = normalizeTimezone(input.timezone);
    const afterMs = input.after !== undefined
      ? Date.parse(input.after)
      : this.clock().ms;
    if (!Number.isFinite(afterMs)) {
      throw scheduleFailure('INVALID_ARGUMENT', 'after must be an RFC 3339 instant');
    }
    const trigger = normalizeTrigger(input.trigger, timezone, afterMs);
    const limit = input.limit === undefined
      ? SCHEDULE_PREVIEW_LIMIT
      : Math.max(3, Math.min(Math.floor(input.limit), SCHEDULE_PREVIEW_LIMIT));
    const occurrences = previewOccurrences(trigger, timezone, afterMs, limit);
    return { trigger, timezone, occurrences };
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function summarizePrompt(prompt: string): string {
  const compact = prompt.replace(/\s+/g, ' ').trim();
  return compact.length > 280 ? `${compact.slice(0, 280)}…` : compact;
}

function describeTrigger(trigger: ScheduleTrigger): string {
  switch (trigger.kind) {
    case 'once':
      return `Once at ${trigger.at}`;
    case 'interval':
      return describeInterval(trigger.every_ms);
    case 'cron':
      return `Cron \`${trigger.expression}\``;
  }
}

function describeInterval(everyMs: number): string {
  const minuteMs = 60_000;
  const minutes = everyMs / minuteMs;
  if (minutes < 60) return `Every ${Math.round(minutes)} minutes`;
  const hours = everyMs / (60 * minuteMs);
  if (hours < 48) {
    const whole = Math.floor(hours);
    const rest = Math.round(minutes - whole * 60);
    return rest > 0 ? `Every ${whole} h ${rest} min` : `Every ${whole} hours`;
  }
  const days = Math.round(everyMs / (24 * 60 * minuteMs));
  return `Every ${days} days`;
}

// ── opaque cursors ───────────────────────────────────────────────────────────

function parseLimit(raw: number | undefined): number {
  if (raw === undefined) return 50;
  if (!Number.isInteger(raw)) {
    throw scheduleFailure('INVALID_ARGUMENT', 'limit must be an integer');
  }
  return Math.max(1, Math.min(raw, MAX_PAGE_SIZE));
}

function encodeCursor(value: object): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeCursor<T>(cursor: string | null | undefined): T | null {
  if (cursor === undefined || cursor === null || cursor === '') return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
    return parsed as T;
  } catch {
    throw scheduleFailure('INVALID_ARGUMENT', 'cursor is not a valid opaque token');
  }
}

function decodeScheduleCursor(cursor: string | null | undefined): ScheduleCursor | null {
  const parsed = decodeCursor<{ u?: unknown; i?: unknown }>(cursor);
  if (!parsed) return null;
  if (typeof parsed.u !== 'string' || typeof parsed.i !== 'string') {
    throw scheduleFailure('INVALID_ARGUMENT', 'cursor is not a valid opaque token');
  }
  return { updatedAt: parsed.u, id: parsed.i };
}

function decodeRunCursor(cursor: string | null | undefined): RunCursor | null {
  const parsed = decodeCursor<{ c?: unknown; i?: unknown }>(cursor);
  if (!parsed) return null;
  if (typeof parsed.c !== 'string' || typeof parsed.i !== 'string') {
    throw scheduleFailure('INVALID_ARGUMENT', 'cursor is not a valid opaque token');
  }
  return { createdAt: parsed.c, id: parsed.i };
}

function encodeScheduleCursor(cursor: ScheduleCursor): string {
  return encodeCursor({ u: cursor.updatedAt, i: cursor.id });
}

function encodeRunCursor(cursor: RunCursor): string {
  return encodeCursor({ c: cursor.createdAt, i: cursor.id });
}
