import { MISFIRE_GRACE_MS, MAX_DUE_ENUMERATION, MAX_DUE_SCHEDULES_PER_PULSE } from '@gian/shared';
import type { WsBroadcaster } from '../web/ws-broadcast.js';
import type { Db } from '../storage/db.js';
import type { SessionManager } from '../session/manager.js';
import { markScheduleLog, markScheduleWarn } from './log.js';
import type { ScheduleRunDispatcher } from './dispatcher.js';
import type { ScheduleService } from './service.js';

/**
 * The only Schedule module that owns a timer (ADR-0053). Pulses run at most
 * once per second, are single-flight, and every mutation elsewhere only calls
 * `wake()` to request a coalesced pulse. Boot recovery runs the full
 * recovery matrix once before the first tick; afterwards a light lease sweep
 * covers dispatches that died mid-flight.
 */

/** Attach retry policy: 1s, 2s, 4s, … capped at 60s; after ten failed
 *  attempts across pulses the Run fails closed (unknown + pause). */
const MAX_ATTACH_ATTEMPTS = 10;
const MAX_ATTACH_BACKOFF_MS = 60_000;

function attachBackoffMs(attempt: number): number {
  return Math.min(1_000 * 2 ** (attempt - 1), MAX_ATTACH_BACKOFF_MS);
}

export interface OrchestratorTimers {
  setInterval(handler: () => void, ms: number): { unref?(): void };
  clearInterval(handle: unknown): void;
  setTimeout(handler: () => void, ms: number): { unref?(): void };
  clearTimeout(handle: unknown): void;
}

const productionTimers: OrchestratorTimers = {
  setInterval(handler, ms) {
    const handle = setInterval(handler, ms);
    handle.unref?.();
    return handle;
  },
  clearInterval: handle => clearInterval(handle as ReturnType<typeof setInterval>),
  setTimeout(handler, ms) {
    const handle = setTimeout(handler, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface ScheduleOrchestratorOptions {
  pulseMs?: number;
  timers?: OrchestratorTimers;
  /** Injectable clock for tests; production uses Date.now(). */
  now?: () => { ms: number; iso: string };
  maxDueSchedules?: number;
  enumerationCap?: number;
  /** Test seam: skip the boot recovery pass when it is exercised directly. */
  skipBootRecovery?: boolean;
}

export class ScheduleOrchestrator {
  private timerHandle: unknown = null;
  private wakeHandle: unknown = null;
  private pulseRunning = false;
  private pendingWake = false;
  private bootPromise: Promise<void> | null = null;
  private stopped = false;
  /** Bounded attach backoff per target session: failed attaches back off
   *  exponentially (1s…60s) so an unattachable target cannot spawn or log
   *  once per pulse; after `MAX_ATTACH_ATTEMPTS` the Run fails closed. */
  private attachAttempts = new Map<string, number>();
  private attachNextAttemptAt = new Map<string, number>();

  constructor(
    private readonly deps: {
      service: ScheduleService;
      dispatcher: ScheduleRunDispatcher;
      broadcaster: WsBroadcaster;
      db: Db;
      /** Used to reattach live Run targets after a Host restart (P1: hidden
       *  Forks have no user path that would trigger the lazy attach). */
      sessions?: SessionManager;
    },
    private readonly options: ScheduleOrchestratorOptions = {},
  ) {}

  start(): void {
    if (this.timerHandle !== null || this.stopped) return;
    if (!this.options.skipBootRecovery) {
      this.bootPromise = this.recoverStartingRunsSafely();
    }
    const pulseMs = this.options.pulseMs ?? 1_000;
    this.timerHandle = (this.options.timers ?? productionTimers).setInterval(
      () => void this.runPulse(),
      pulseMs,
    );
    markScheduleLog(`orchestrator started (pulse ${pulseMs}ms)`);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const timers = this.options.timers ?? productionTimers;
    if (this.timerHandle !== null) {
      timers.clearInterval(this.timerHandle);
      this.timerHandle = null;
    }
    if (this.wakeHandle !== null) {
      timers.clearTimeout(this.wakeHandle);
      this.wakeHandle = null;
    }
    // Never leave an in-flight pulse racing process shutdown.
    await this.bootPromise?.catch(() => undefined);
    await this.pulsePromise?.catch(() => undefined);
    markScheduleLog('orchestrator stopped');
  }

  /** Coalesced wake: mutations call this after commit; at most one pulse ever
   *  runs at a time and trailing requests collapse into one follow-up. */
  wake(): void {
    if (this.stopped) return;
    if (this.pulseRunning) {
      this.pendingWake = true;
      return;
    }
    const timers = this.options.timers ?? productionTimers;
    if (this.wakeHandle !== null) return;
    this.wakeHandle = timers.setTimeout(() => {
      this.wakeHandle = null;
      void this.runPulse();
    }, 0);
  }

  private pulsePromise: Promise<void> | null = null;

  /** One ordered pulse: boot recovery (if still running) → lease sweep → due
   *  materialize → dispatch → reconcile. Boot recovery executes inside the
   *  same single-flight barrier: timer ticks and wake() calls during a slow
   *  boot recovery queue behind it instead of racing it on the same Run. */
  runPulse(): Promise<void> {
    if (this.pulseRunning) {
      this.pendingWake = true;
      return this.pulsePromise ?? Promise.resolve();
    }
    this.pulseRunning = true;
    const boot = this.bootPromise
      ? this.bootPromise.catch(() => undefined)
      : Promise.resolve();
    const run = boot.then(() => {
      if (this.stopped) return;
      return this.executePulse();
    }).finally(() => {
      this.pulseRunning = false;
      if (this.pendingWake && !this.stopped) {
        this.pendingWake = false;
        this.wake();
      }
    });
    this.pulsePromise = run;
    return run;
  }

  private async executePulse(): Promise<void> {
    const { service, dispatcher } = this.deps;
    const { ms, iso } = this.options.now
      ? this.options.now()
      : { ms: Date.now(), iso: new Date().toISOString() };
    const repo = service.repository;

    // 1. Light lease sweep: a starting Run whose lease expired belongs to a
    // dead dispatch; recover it from canonical evidence.
    for (const run of repo.startingRunRowsWithExpiredLease(iso)) {
      try {
        await dispatcher.recoverRun(run);
      } catch (error) {
        markScheduleWarn(`lease sweep failed for run ${run.id}`, error);
      }
    }

    // 2. Atomic due materialization (transaction inside the repository).
    let outcomes;
    try {
      outcomes = repo.materializeDueRuns({
        nowMs: ms,
        nowIso: iso,
        graceMs: MISFIRE_GRACE_MS,
        maxSchedules: this.options.maxDueSchedules ?? MAX_DUE_SCHEDULES_PER_PULSE,
        enumerationCap: this.options.enumerationCap ?? MAX_DUE_ENUMERATION,
      });
    } catch (error) {
      markScheduleWarn('due materialization failed', error);
      return;
    }
    for (const outcome of outcomes) {
      if (outcome.runId) {
        service.broadcastRunUpdated(outcome.scheduleId, outcome.runId);
      }
      // The Schedule row itself advanced; pages refresh via snapshot.
      service.broadcastScheduleAdvanced(outcome.scheduleId);
    }
    if (outcomes.length > 0) {
      markScheduleLog(`materialized ${outcomes.length} due schedule(s)`);
    }

    // 3. Capacity-bounded dispatch.
    try {
      await dispatcher.dispatchReadyRuns();
    } catch (error) {
      markScheduleWarn('dispatch pass failed', error);
    }

    // 4. Reconcile non-terminal Runs against canonical tables and expire
    // stale create confirmations.
    try {
      await this.reconcileNonTerminalRuns();
    } catch (error) {
      markScheduleWarn('reconcile pass failed', error);
    }
    try {
      service.expireStaleConfirmations(iso);
    } catch (error) {
      markScheduleWarn('confirmation expiry pass failed', error);
    }
  }

  async reconcileNonTerminalRuns(nowMs = Date.now()): Promise<void> {
    const { service, dispatcher, db, sessions } = this.deps;
    const repo = service.repository;
    for (const run of repo.nonTerminalRunRows()) {
      if (run.status === 'scheduled' || run.status === 'starting') continue;
      // Bound runs execute in the control Session; fork runs in their hidden
      // Fork Session. Both are recorded as the run's target session.
      const session = run.target_session_id
        ? db.prepare('SELECT id, status, hidden FROM sessions WHERE id = ?').get(run.target_session_id) as { id: string; status: string; hidden: number } | undefined
        : undefined;
      if (!session) {
        // Canonical evidence lost (user delete / cache sweep) while the Run
        // is still live: contradictory → unknown, Schedule pauses.
        dispatcher.markUnknown(run.id, 'SCHEDULE_DISPATCH_UNKNOWN', 'canonical evidence missing during reconcile');
        service.broadcastRunUpdated(run.schedule_id, run.id);
        continue;
      }
      let turn = run.turn_id
        ? db.prepare('SELECT id, status FROM turns WHERE id = ?').get(run.turn_id) as { id: string; status: string } | undefined
        : undefined;
      if (!turn) {
        // Canonical evidence lost (user delete / cache sweep) while the Run
        // is still live: contradictory → unknown, Schedule pauses.
        dispatcher.markUnknown(run.id, 'SCHEDULE_DISPATCH_UNKNOWN', 'canonical evidence missing during reconcile');
        service.broadcastRunUpdated(run.schedule_id, run.id);
        continue;
      }

      // A Host restart leaves the proxy detached; lazy attach only happens on
      // user interaction, which a hidden Fork never gets. Reattach here so a
      // Provider-side completion (or an interaction request) can be observed
      // and the Run cannot sit `running` forever. Attempts back off
      // exponentially and a target that never attaches fails closed instead
      // of spinning once per pulse.
      if (sessions) {
        const attempts = this.attachAttempts.get(session.id) ?? 0;
        const nextAttemptAt = this.attachNextAttemptAt.get(session.id) ?? 0;
        if (turn.status === 'running' && nextAttemptAt <= nowMs) {
          try {
            await sessions.ensureProxyAttached(session.id, turn.id);
            this.attachAttempts.delete(session.id);
            this.attachNextAttemptAt.delete(session.id);
          } catch (error) {
            const nextAttempts = attempts + 1;
            this.attachAttempts.set(session.id, nextAttempts);
            this.attachNextAttemptAt.set(session.id, nowMs + attachBackoffMs(nextAttempts));
            markScheduleWarn(
              `reconcile could not attach run target ${session.id} (attempt ${nextAttempts})`,
              error,
            );
            if (nextAttempts >= MAX_ATTACH_ATTEMPTS) {
              this.attachAttempts.delete(session.id);
              this.attachNextAttemptAt.delete(session.id);
              sessions.settleUnattachableScheduledTurn(session.id, turn.id);
              dispatcher.markUnknown(
                run.id,
                'SCHEDULE_DISPATCH_UNKNOWN',
                'the run target session could not be reattached after restart',
              );
              continue;
            }
          }
        }
        // Attach may synchronously deliver the terminal event. Re-read before
        // reconciling so the Run observes the new canonical status now.
        turn = db.prepare('SELECT id, status FROM turns WHERE id = ?').get(turn.id) as { id: string; status: string } | undefined;
        if (!turn) {
          dispatcher.markUnknown(run.id, 'SCHEDULE_DISPATCH_UNKNOWN', 'canonical evidence missing during reconcile');
          service.broadcastRunUpdated(run.schedule_id, run.id);
          continue;
        }
      }
      const changed = dispatcher.reconcileRunAgainstEvidence(run.id, session, turn);
      if (changed === 'changed') {
        service.broadcastRunUpdated(run.schedule_id, run.id);
      }
    }
  }

  private async recoverStartingRunsSafely(): Promise<void> {
    try {
      await this.deps.dispatcher.recoverStartingRuns();
    } catch (error) {
      markScheduleWarn('boot recovery failed', error);
    }
  }
}
