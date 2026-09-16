import { randomUUID } from 'node:crypto';
import { MAX_CONCURRENT_SCHEDULE_RUNS, SCHEDULE_RUN_SUMMARY_MAX_CHARS } from '@gian/shared';
import type { AttentionMessage, Executor, ScheduleForkAnchor } from '@gian/shared';
import { resolveForkAnchor } from '../session/fork.js';
import type { ScheduledTaskOrigin, SessionManager } from '../session/manager.js';
import type { Db } from '../storage/db.js';
import type { WsBroadcaster } from '../web/ws-broadcast.js';
import { markScheduleLog, markScheduleWarn } from './log.js';
import { scheduleFailure } from './errors.js';
import type { ScheduleService } from './service.js';
import type { ScheduleRow, ScheduleRunRow } from './types.js';

/**
 * Turns materialized `scheduled` Runs into Turns of the bound control
 * conversation: idle → a new Turn in the control Session; busy (running Turn
 * or queued user delivery) → a durable hidden Fork from the last stable
 * completed Turn, gated on the Proxy's `session.fork.atTurn` capability
 * (ADR-0053, contracts F–K). Every step persists its dispatch evidence
 * BEFORE crossing the next external boundary; recovery converges from
 * canonical Session/Turn/event rows, never memory, and never re-sends a
 * prompt that may have reached the Provider.
 */

const COMMAND_LEASE_MS = 30_000;

const TERMINAL_RUN_MAPPED = new Set(['succeeded', 'failed', 'interrupted']);

/** Busy-class send failures: the control conversation was claimed by a real
 *  Turn between our idle check and our send. Nothing crossed the boundary
 *  (the turn rows were rolled back), so escalation to the Fork path is safe. */
function isBusySendFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /turn already in flight|\[SESSION_BUSY\]/.test(message);
}

/** Deterministic, pre-boundary failures are safe to record as `failed`;
 *  anything else after an external boundary may or may not have taken
 *  effect and becomes `unknown` (never retried automatically). */
export function isDeterministicSendFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const code = error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : '';
  return /agent was deleted/i.test(message)
    || code === 'AGENT_DELETED'
    || /session is completed|closed for input|archived|merged|discarded/i.test(message)
    || /rejected|denied|declined|refused/i.test(message);
}

function trimMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 2_048 ? `${message.slice(0, 2_048)}…` : message;
}

export interface DispatcherOptions {
  now?: () => { ms: number; iso: string };
  maxConcurrentRuns?: number;
  /** Required: broadcasts Host→Desktop error attention for Run failures that
   *  happen before any Turn exists (fork failures, lifecycle fail-closed,
   *  unknown). Making it non-optional keeps production assembly honest — the
   *  compiler rejects a dispatcher constructed without it. */
  broadcaster: WsBroadcaster;
  /** Same user-level gate the session AttentionDispatcher applies: failure
   *  attention (kind `error`) must not broadcast when the master switch or
   *  the errors category is off. */
  attentionGate?: import('../session/attention.js').AttentionGate;
}

export class ScheduleRunDispatcher {
  constructor(
    private readonly service: ScheduleService,
    private readonly sessions: SessionManager,
    private readonly db: Db,
    private readonly options: DispatcherOptions,
  ) {}

  private clock(): { ms: number; iso: string } {
    const ms = Date.now();
    return { ms, iso: new Date(ms).toISOString() };
  }

  private now(): { ms: number; iso: string } {
    return this.options.now ? this.options.now() : this.clock();
  }

  /** FIFO across Schedules, bounded by the global capacity. */
  async dispatchReadyRuns(): Promise<void> {
    const capacity = (this.options.maxConcurrentRuns ?? MAX_CONCURRENT_SCHEDULE_RUNS)
      - this.service.countRunsByStatuses(['starting', 'running', 'waiting_interaction']);
    if (capacity <= 0) return;
    const ready = this.service.oldestScheduledRuns(capacity);
    for (const run of ready) {
      await this.dispatchRun(run);
    }
  }

  async dispatchRun(run: ScheduleRunRow): Promise<void> {
    const now = this.now();
    const repo = this.service.repository;
    const schedule = repo.scheduleRow(run.schedule_id);
    if (!schedule) {
      repo.settleRun(run.id, 'failed', { errorCode: 'SCHEDULE_NOT_FOUND', errorMessage: 'schedule disappeared' }, now.iso);
      return;
    }
    if (schedule.status === 'archived') {
      repo.settleRun(run.id, 'failed', { errorCode: 'SCHEDULE_ARCHIVED', errorMessage: 'schedule was archived before dispatch' }, now.iso);
      this.service.broadcastRunUpdated(schedule.id, run.id);
      return;
    }
    const claimed = repo.claimRunForDispatch(
      run.id,
      randomUUID(),
      new Date(now.ms + COMMAND_LEASE_MS).toISOString(),
      now.iso,
    );
    if (!claimed) return; // lost the race; a later pulse handles the rest
    try {
      await this.startDispatch(claimed, schedule);
    } catch (error) {
      // startDispatch settles the run itself; reaching here means an
      // unexpected crash-class failure in host code — fence it as unknown.
      markScheduleWarn(`run ${run.id} dispatch crashed`, error);
      this.markUnknown(run.id, 'SCHEDULE_DISPATCH_UNKNOWN', trimMessage(error));
    }
  }

  /** Dispatch decision + execution. The mode is decided here (fresh state)
   *  and persisted by `resolveRunMode` before any external boundary is
   *  crossed; from then on it never silently switches (contract H). */
  private async startDispatch(run: ScheduleRunRow, schedule: ScheduleRow): Promise<void> {
    const repo = this.service.repository;
    const now = this.now();

    // Re-read the Schedule: it may have changed between materialize and claim.
    const current = repo.scheduleRow(schedule.id);
    if (!current || current.status === 'archived') {
      repo.settleRun(run.id, 'failed', { errorCode: 'SCHEDULE_ARCHIVED', errorMessage: 'schedule was archived before dispatch' }, now.iso);
      this.service.broadcastRunUpdated(schedule.id, run.id);
      return;
    }

    // Fail-closed lifecycle gate (contract J): never silently substitute an
    // Agent, directory, or configuration — pause instead.
    try {
      this.sessions.assertReadyForScheduledTurn(current.control_session_id);
    } catch (error) {
      const code = this.lifecycleErrorCode(error);
      markScheduleWarn(`run ${run.id} control session not ready: ${code}`);
      const message = trimMessage(error);
      // Atomic: Run failed + Schedule paused/lifecycle_blocked together.
      const settled = repo.settleRunFailedAndPauseLifecycle(run.id, code, message, now.iso);
      this.service.broadcastScheduleStateChanged(current.id);
      this.service.broadcastRunUpdated(current.id, run.id);
      if (settled) this.broadcastFailureAttention(settled, code, message);
      return;
    }

    if (this.sessions.isBusyForScheduledTurn(current.control_session_id)) {
      await this.dispatchAsFork(run, current);
      return;
    }
    await this.dispatchAsBoundSession(run, current);
  }

  private lifecycleErrorCode(error: unknown): string {
    const code = error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code)
      : '';
    if (code === 'AGENT_DELETED') return 'AGENT_DELETED';
    const message = error instanceof Error ? error.message : String(error);
    if (/archived/.test(message)) return 'SCHEDULE_CONTROL_SESSION_ARCHIVED';
    return 'SCHEDULE_CONTROL_SESSION_BLOCKED';
  }

  /** Idle path (contract F): a new Turn in the bound conversation. A real
   *  Turn that wins the idle race while we send escalates this Run to the
   *  Fork path exactly once (contract G). */
  private async dispatchAsBoundSession(run: ScheduleRunRow, schedule: ScheduleRow): Promise<void> {
    const repo = this.service.repository;
    const now = this.now();
    const resolved = repo.resolveRunMode(run.id, 'bound_session', schedule.control_session_id, null, now.iso);
    if (!resolved) return; // fenced by a concurrent transition
    await this.sendPrompt(run, schedule, schedule.control_session_id);
  }

  /** Fork path (contracts G–I): fork from the last stable completed Turn into
   *  a durable hidden Fork Session. The decision persists at claim time; a
   *  later idle main conversation never switches it back. */
  private async dispatchAsFork(run: ScheduleRunRow, schedule: ScheduleRow, escalation = false): Promise<void> {
    const repo = this.service.repository;
    const now = this.now();
    const controlSessionId = schedule.control_session_id;

    let anchor: ScheduleForkAnchor;
    try {
      anchor = this.latestStableForkAnchor(controlSessionId);
    } catch {
      // Contract I: no stable anchor → this Run fails; no fallback, no retry.
      const message = escalation
        ? 'main conversation turned busy during dispatch and no stable fork point exists'
        : 'control conversation is busy and no stable fork point exists';
      const settled = repo.settleRun(run.id, 'failed', {
        errorCode: 'SCHEDULE_NO_STABLE_FORK_POINT',
        errorMessage: message,
      }, now.iso);
      this.service.broadcastRunUpdated(schedule.id, run.id);
      if (settled) this.broadcastFailureAttention(settled, 'SCHEDULE_NO_STABLE_FORK_POINT', message);
      return;
    }

    const forkSessionId = randomUUID();
    const persisted = escalation
      ? repo.escalateRunToFork(run.id, forkSessionId, anchor, now.iso)
      : repo.resolveRunMode(run.id, 'fork', forkSessionId, anchor, now.iso);
    if (!persisted) return; // fenced by a concurrent transition

    let forkSessionIdPublished: string;
    try {
      const result = await this.sessions.forkSession({
        sourceSessionId: controlSessionId,
        sessionId: forkSessionId,
        anchor: { type: 'turn', turnId: anchor.turn_id, sourceTurnId: anchor.source_turn_id },
        hidden: true,
        name: `[Schedule] ${schedule.name} · ${run.scheduled_for}`,
      });
      forkSessionIdPublished = result.sessionId;
    } catch (error) {
      markScheduleWarn(`run ${run.id} fork failed`, error);
      const code = this.forkErrorCode(error);
      const message = trimMessage(error);
      const settled = repo.settleRun(run.id, 'failed', {
        errorCode: code,
        errorMessage: message,
      }, now.iso);
      this.service.broadcastRunUpdated(schedule.id, run.id);
      if (settled) this.broadcastFailureAttention(settled, code, message);
      return;
    }

    await this.sendPrompt(run, schedule, forkSessionIdPublished);
  }

  private forkErrorCode(error: unknown): string {
    const code = error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code)
      : '';
    if (code === 'CAPABILITY_NOT_SUPPORTED') return 'SCHEDULE_FORK_UNSUPPORTED';
    if (code === 'FORK_BOUNDARY_UNAVAILABLE') return 'SCHEDULE_NO_STABLE_FORK_POINT';
    return 'SCHEDULE_FORK_FAILED';
  }

  /** Last completed-and-stable Turn: terminal status AND the Provider's real
   *  sourceTurnId persisted (the same stability rule as fork boundaries). */
  private latestStableForkAnchor(sessionId: string): ScheduleForkAnchor {
    const row = this.db.prepare(
      `SELECT turns.id AS turnId, replay.provider_turn_id AS sourceTurnId
         FROM turns
         JOIN proxy_replay_turns replay
           ON replay.turn_id = turns.id AND replay.session_id = turns.session_id
        WHERE turns.session_id = ?
          AND turns.status IN ('completed', 'error', 'stopped')
          AND replay.provider_turn_id IS NOT NULL
        ORDER BY turns.turn_number DESC
        LIMIT 1`,
    ).get(sessionId) as { turnId: string; sourceTurnId: string } | undefined;
    if (!row) {
      throw scheduleFailure('SCHEDULE_NO_STABLE_FORK_POINT', 'no stable fork anchor');
    }
    // Exact-match validation against canonical rows; forkSession re-checks.
    const resolved = resolveForkAnchor(this.db, sessionId, {
      type: 'turn',
      turnId: row.turnId,
      sourceTurnId: row.sourceTurnId,
    });
    return { turn_id: resolved.turnId, source_turn_id: resolved.sourceTurnId };
  }

  /** Send the durable prompt into the target session and bind the Turn. */
  private async sendPrompt(run: ScheduleRunRow, schedule: ScheduleRow, targetSessionId: string): Promise<void> {
    const repo = this.service.repository;
    const now = this.now();
    const origin: ScheduledTaskOrigin = {
      scheduleId: schedule.id,
      runId: run.id,
      scheduleName: schedule.name,
    };
    try {
      const receipt = await this.sessions.sendMessage(targetSessionId, schedule.prompt, undefined, undefined, undefined, undefined, undefined, undefined, origin);
      if (!receipt) {
        // Only sidechat sends return null; target sessions are never sidechats.
        this.markUnknown(run.id, 'SCHEDULE_DISPATCH_UNKNOWN', 'session send returned no Turn');
        return;
      }
      repo.markRunDispatched(run.id, receipt.turnId, receipt.configSnapshot, now.iso);
      this.service.broadcastRunUpdated(schedule.id, run.id);
      markScheduleLog(`run ${run.id} accepted turn ${receipt.turnId} in ${targetSessionId}`);
    } catch (error) {
      markScheduleWarn(`run ${run.id} prompt send failed`, error);
      await this.handleSendFailure(run, schedule, targetSessionId, error);
    }
  }

  /** Send-failure classification (contracts G/I/K). A busy race escalates a
   *  bound-session attempt to the Fork path exactly once; deterministic
   *  pre-boundary rejections settle `failed`; anything else is `unknown` —
   *  the prompt is never replayed and the Schedule pauses. The canonical
   *  scheduled_task origin event is reserved for crash RECOVERY (where no
   *  error object exists), not for thrown-error classification. */
  private async handleSendFailure(
    run: ScheduleRunRow,
    schedule: ScheduleRow,
    targetSessionId: string,
    error: unknown,
  ): Promise<void> {
    const repo = this.service.repository;
    const now = this.now();
    const current = repo.runRow(run.id);
    if (!current || current.status !== 'starting') return; // already settled

    if (isBusySendFailure(error) && current.execution_mode === 'bound_session') {
      await this.dispatchAsFork(run, schedule, true);
      return;
    }

    if (isDeterministicSendFailure(error)) {
      const message = trimMessage(error);
      const settled = repo.settleRun(run.id, 'failed', {
        errorCode: 'SCHEDULE_SEND_FAILED',
        errorMessage: message,
      }, now.iso);
      this.service.broadcastRunUpdated(schedule.id, run.id);
      if (settled) this.broadcastFailureAttention(settled, 'SCHEDULE_SEND_FAILED', message);
      return;
    }
    this.markUnknown(run.id, 'SCHEDULE_DISPATCH_UNKNOWN', trimMessage(error));
    this.service.broadcastRunUpdated(schedule.id, run.id);
    void targetSessionId;
  }

  /** Locates the scheduled prompt's user_message event. NOTE: the event is
   *  persisted BEFORE startTurn, so its presence does NOT prove the send
   *  crossed into the Provider pipeline — recovery must not treat it as
   *  acceptance evidence (see recoverRun). */
  findScheduledTurnEvent(sessionId: string, runId: string): { turnId: string; turnNumber: number } | null {
    const row = this.db.prepare(
      `SELECT turn_id AS turnId, (SELECT turn_number FROM turns WHERE id = events.turn_id) AS turnNumber
         FROM events
        WHERE session_id = ? AND type = 'user_message'
          AND json_extract(data, '$.scheduled_task.run_id') = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
    ).get(sessionId, runId) as { turnId: string; turnNumber: number } | undefined;
    return row && row.turnId ? { turnId: row.turnId, turnNumber: row.turnNumber } : null;
  }

  /** Records `unknown`, which also atomically pauses the still-active
   *  Schedule so high-frequency rules cannot spin overlap rows. */
  markUnknown(runId: string, errorCode: string, errorMessage: string | undefined): void {
    const now = this.now();
    const repo = this.service.repository;
    // Atomic: a crash between the Run settle and the Schedule pause must not
    // leave a terminal Run behind an un-paused Schedule.
    const settled = repo.settleRunAndPauseSchedule(runId, 'unknown', 'unknown_run', {
      errorCode,
      errorMessage,
    }, now.iso);
    if (settled) {
      this.service.broadcastScheduleStateChanged(settled.schedule_id);
      this.service.broadcastRunUpdated(settled.schedule_id, runId);
      this.broadcastFailureAttention(settled, errorCode, errorMessage);
    }
  }

  /** Stable Host→Desktop attention for a Run that failed before any Turn
   *  exists (or entered unknown). NOTIFY-001 privacy projection: the OS
   *  notification carries only a generic bounded title and the stable error
   *  CODE — never the raw error, paths, commands, secrets, or the Schedule
   *  name. The full message stays in the durable run log. The id derives
   *  from the run id so the message de-duplicates across restarts.
   *  Navigation target: the `schedule` field points at this Run — clicking
   *  the notification opens the Timer detail whose run log matches the body. */
  private broadcastFailureAttention(
    run: ScheduleRunRow,
    errorCode: string,
    _errorMessage: string | undefined,
  ): void {
    if (this.options.attentionGate && !this.options.attentionGate('error')) return;
    const schedule = this.service.repository.scheduleRow(run.schedule_id);
    const session = schedule
      ? this.db.prepare(
          'SELECT executor FROM sessions WHERE id = ?',
        ).get(schedule.control_session_id) as { executor: Executor } | undefined
      : undefined;
    if (!schedule || !session) return;
    // AttentionMessage.turn is required by the wire contract; schedule
    // navigation uses the `schedule` field instead, so a control conversation
    // without any Turn yet still produces a deliverable message.
    const turnRow = this.db.prepare(
      'SELECT COALESCE(MAX(turn_number), 0) AS n FROM turns WHERE session_id = ?',
    ).get(schedule.control_session_id) as { n: number };
    const unknown = run.status === 'unknown';
    const message: AttentionMessage = {
      type: 'attention',
      id: `gian:attention:schedule-run-${run.id}`,
      session_id: schedule.control_session_id,
      turn: Math.max(1, turnRow.n),
      kind: 'error',
      timestamp: Date.parse(this.now().iso),
      title: unknown ? 'Scheduled run outcome unknown' : 'Scheduled run failed',
      body: unknown
        ? `A scheduled run ended with an unknown outcome (${errorCode}). Open the schedule run log for details.`
        : `A scheduled run failed (${errorCode}). Open the schedule run log for details.`,
      provider: session.executor,
      schedule: { schedule_id: schedule.id, run_id: run.id },
    };
    try {
      this.options.broadcaster.broadcast(message);
    } catch (error) {
      markScheduleWarn(`failed to broadcast attention for run ${run.id}`, error);
    }
  }

  // ── boot / lease recovery ──────────────────────────────────────────────────

  /** Full matrix pass, executed once at boot. Evidence-based: every row
   *  converges from canonical sessions/turns/events state, never memory. */
  async recoverStartingRuns(): Promise<void> {
    const starting = this.service.repository.runRowsByStatuses(['starting']);
    for (const run of starting) {
      await this.recoverRun(run);
    }
  }

  /** Evidence-based recovery for one `starting` Run. Used at boot and by the
   *  expired-lease sweep. */
  async recoverRun(run: ScheduleRunRow): Promise<void> {
    const repo = this.service.repository;
    const now = this.now();
    const schedule = repo.scheduleRow(run.schedule_id);
    if (!schedule || schedule.status === 'archived') {
      repo.settleRun(run.id, 'failed', { errorCode: 'SCHEDULE_ARCHIVED', errorMessage: 'schedule archived before the run finished' }, now.iso);
      return;
    }

    // Phase `claimed`: the dispatch decision itself may not have been made
    // (or persisted) before the crash — it is safe to restart the dispatch.
    if (run.dispatch_phase === 'claimed') {
      repo.updateRunColumns(run.id, { status: 'scheduled' }, now.iso);
      this.service.broadcastRunUpdated(schedule.id, run.id);
      return;
    }

    const targetSessionId = run.target_session_id;
    if (!targetSessionId) {
      this.markUnknown(run.id, 'SCHEDULE_DISPATCH_UNKNOWN', 'recovery found a resolved run without a target session');
      return;
    }

    if (run.execution_mode === 'fork') {
      // The fork decision crossed the claim boundary. If the hidden Fork
      // Session row is missing, the provider-side fork may already exist —
      // re-forking could duplicate it → unknown + pause, never re-send.
      const forkRow = this.db.prepare(
        'SELECT id FROM sessions WHERE id = ?',
      ).get(targetSessionId) as { id: string } | undefined;
      if (!forkRow) {
        this.markUnknown(run.id, 'SCHEDULE_DISPATCH_UNKNOWN', 'recovery found no Fork Session row for a claimed fork run');
        return;
      }
    } else if (run.execution_mode === 'bound_session' && targetSessionId !== schedule.control_session_id) {
      this.markUnknown(run.id, 'SCHEDULE_DISPATCH_UNKNOWN', 'bound run target disagrees with the control session');
      return;
    }

    // Turn evidence: the bound Turn is proof the Provider accepted (the Host
    // recorded the acceptance after startTurn returned). The canonical
    // scheduled_task origin event alone is NOT: sendMessage persists it
    // BEFORE calling startTurn, so a crash in that window leaves an event and
    // a local Turn row that the Provider never saw. Recovery treats those as
    // UNCERTAIN (unknown, never replayed), not as a successful dispatch.
    let turn = run.turn_id
      ? this.db.prepare('SELECT id, status FROM turns WHERE id = ?').get(run.turn_id) as { id: string; status: string } | undefined
      : undefined;

    if (!turn) {
      const evidence = this.findScheduledTurnEvent(targetSessionId, run.id);
      if (evidence) {
        // The acceptance was never recorded: the provider may or may not have
        // the prompt. Never re-send, never guess — unknown + pause.
        this.markUnknown(
          run.id,
          'SCHEDULE_DISPATCH_UNKNOWN',
          'the scheduled prompt was persisted locally but its Provider acceptance was never recorded before the crash',
        );
        return;
      }
      // No Turn row and no origin event: the send had not started. An orphan
      // running Turn owned by someone else still blocks the target.
      if (!this.sessions.isBusyForScheduledTurn(targetSessionId)) {
        await this.sendPrompt(run, schedule, targetSessionId);
        return;
      }
      const settled = repo.settleRun(run.id, 'failed', {
        errorCode: 'SCHEDULE_SEND_FAILED',
        errorMessage: 'target session turned busy before the scheduled prompt could be sent after recovery',
      }, now.iso);
      this.service.broadcastRunUpdated(schedule.id, run.id);
      if (settled) {
        this.broadcastFailureAttention(settled, 'SCHEDULE_SEND_FAILED', 'target session turned busy before the scheduled prompt could be sent after recovery');
      }
      return;
    }

    // Turn evidence exists and acceptance was recorded: bind and reconcile;
    // never re-send.
    repo.updateRunColumns(run.id, { turnId: turn.id }, now.iso);
    const sessionRow = this.db.prepare(
      'SELECT id, status FROM sessions WHERE id = ?',
    ).get(targetSessionId) as { id: string; status: string } | undefined;
    if (!sessionRow) {
      this.markUnknown(run.id, 'SCHEDULE_DISPATCH_UNKNOWN', 'recovery lost the run target session');
      return;
    }
    this.reconcileRunAgainstEvidence(run.id, sessionRow, turn);
  }

  /** Maps one Run onto canonical Turn/Session/Interaction evidence. */
  reconcileRunAgainstEvidence(
    runId: string,
    session: { id: string; status: string },
    turn: { id: string; status: string },
  ): 'changed' | 'unchanged' {
    const repo = this.service.repository;
    const now = this.now();
    const run = repo.runRow(runId);
    if (!run || TERMINAL_RUN_MAPPED.has(run.status) || run.status === 'unknown') {
      return 'unchanged';
    }
    let next: ScheduleRunRow['status'] | null = null;
    switch (turn.status) {
      case 'completed': next = 'succeeded'; break;
      case 'error': next = 'failed'; break;
      case 'stopped': next = 'interrupted'; break;
      case 'running': {
        if (this.hasPendingInteraction(session.id)) {
          next = run.status === 'waiting_interaction' ? null : 'waiting_interaction';
        } else if (run.status === 'waiting_interaction') {
          next = 'running';
        } else if (run.status === 'starting') {
          next = 'running';
        } else {
          next = null; // already running; nothing to do
        }
        break;
      }
      default:
        // Unrecognized Turn status with a live Run: contradictory evidence.
        next = 'unknown';
    }
    if (next === null) return 'unchanged';
    if (next === 'unknown') {
      // Atomic: Run unknown + Schedule paused/unknown_run together.
      const settled = repo.settleRunAndPauseSchedule(run.id, 'unknown', 'unknown_run', {
        errorCode: 'SCHEDULE_DISPATCH_UNKNOWN',
        errorMessage: 'canonical Turn evidence contradicts the run state',
      }, now.iso);
      if (settled) {
        this.service.broadcastScheduleStateChanged(settled.schedule_id);
        this.broadcastFailureAttention(settled, 'SCHEDULE_DISPATCH_UNKNOWN', 'canonical Turn evidence contradicts the run state');
      }
      return settled ? 'changed' : 'unchanged';
    }
    if (TERMINAL_RUN_MAPPED.has(next)) {
      const settled = repo.settleRun(run.id, next, {
        turnId: turn.id,
        summary: this.extractRunSummary(turn.id, next),
      }, now.iso);
      if (settled) this.service.broadcastRunUpdated(settled.schedule_id, run.id);
      return settled ? 'changed' : 'unchanged';
    }
    const updated = repo.updateRunColumns(run.id, { status: next, turnId: turn.id }, now.iso);
    if (updated && updated.status === next) {
      this.service.broadcastRunUpdated(updated.schedule_id, run.id);
      return 'changed';
    }
    return 'unchanged';
  }

  /** Bounded summary for the durable run log (contract D): the final
   *  assistant text of the settled Turn, capped hard. Transcripts stay in
   *  the Session; the log keeps a stable index plus this excerpt only. */
  extractRunSummary(turnId: string, status: ScheduleRunRow['status']): string | null {
    if (status === 'failed' || status === 'interrupted') return null;
    const rows = this.db.prepare(
      `SELECT call_id AS callId, data
         FROM events
        WHERE turn_id = ? AND type != 'user_message'
          AND json_extract(data, '$.display.type') = 'message'
        ORDER BY created_at ASC, id ASC
        LIMIT 500`,
    ).all(turnId) as Array<{ callId: string; data: string }>;
    const merged = new Map<string, string>();
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.data) as {
          display?: { data?: { text?: unknown; delta?: unknown } };
        };
        const text = parsed.display?.data?.text;
        if (typeof text !== 'string') continue;
        const existing = merged.get(row.callId);
        merged.set(row.callId, existing && parsed.display?.data?.delta ? existing + text : text);
      } catch {
        // Corrupt event payloads degrade to a null summary, never a crash.
      }
    }
    const last = [...merged.values()].at(-1);
    if (!last) return null;
    const compact = last.replace(/\s+/g, ' ').trim();
    return compact.length > SCHEDULE_RUN_SUMMARY_MAX_CHARS
      ? `${compact.slice(0, SCHEDULE_RUN_SUMMARY_MAX_CHARS)}…`
      : compact;
  }

  /** Pending interaction = proxy_interactions row without an outcome. */
  hasPendingInteraction(sessionId: string): boolean {
    const row = this.db.prepare(
      `SELECT 1 AS hit FROM proxy_interactions
        WHERE session_id = ? AND outcome IS NULL LIMIT 1`,
    ).get(sessionId) as { hit: number } | undefined;
    return row !== undefined;
  }
}
