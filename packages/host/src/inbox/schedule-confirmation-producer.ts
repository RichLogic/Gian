import type { AttentionInboxRef, ScheduleConfirmation } from '@gian/shared';
import { scheduleFailure } from '../schedule/errors.js';
import { markScheduleWarn } from '../schedule/log.js';
import type { Db } from '../storage/db.js';

/** One confirmation id is one Inbox generation. The id is not reused. */
const SCHEDULE_CONFIRMATION_GENERATION = 1;
const SOURCE_KIND = 'schedule.confirmation';

export interface ScheduleConfirmationInboxSink {
  applySignal(input: unknown): unknown;
}

export interface ScheduleConfirmationInboxObserver {
  /**
   * Mirrors one confirmation. Returns the Inbox ref only when this call
   * inserted a new unread pending row. A duplicate, a failure, or a later
   * repair returns null so the caller does not pop an OS notification.
   */
  opened(confirmation: ScheduleConfirmation): AttentionInboxRef | null;
  /** Closes a pending row. A confirmation that never opened stays absent. */
  closed(
    confirmationId: string,
    outcome: 'resolved' | 'rejected' | 'expired',
    actor: 'user' | 'system',
  ): void;
  /** One confirmation, after a retry found the row already stored. */
  project(confirmation: ScheduleConfirmation): void;
  /** Fills a missing open or a lagging close. Does not throw. */
  repair(confirmation: ScheduleConfirmation): void;
  /** Startup mirror. No poller. */
  reconcile(): void;
}

/**
 * Inbox mirror for a schedule confirmation. Generation stays 1.
 * Closing a missing row does not insert a tombstone, so expiry cannot
 * come back as generation 2.
 */
export function scheduleConfirmationInboxObserver(
  db: Db,
  inbox: ScheduleConfirmationInboxSink,
): ScheduleConfirmationInboxObserver {
  return {
    opened(confirmation) {
      const written = isolateProjection(db, confirmation.id, 'open', null, null, () => (
        inbox.applySignal(openSignal(confirmation))
      ));
      return freshScheduleConfirmationRef(written);
    },
    closed(confirmationId, outcome, actor) {
      isolateProjection(db, confirmationId, 'close', outcome, actor, () => {
        const pending = db.prepare(
          `SELECT 1 AS ok FROM inbox_items
            WHERE source_key = ? AND status = 'pending' AND tombstone = 0`,
        ).get(sourceKey(confirmationId)) as { ok: number } | undefined;
        if (!pending) return;
        inbox.applySignal({
          kind: 'schedule.confirmation.closed',
          confirmation_id: confirmationId,
          generation: SCHEDULE_CONFIRMATION_GENERATION,
          outcome,
          actor,
        });
      });
    },
    project(confirmation) {
      this.repair(confirmation);
    },
    repair(confirmation) {
      const mirror = inboxMirrorState(db, confirmation.id);
      if (mirror === 'error') return;
      if (confirmation.status === 'pending') {
        if (mirror === 'absent') {
          this.opened(confirmation);
          return;
        }
        forgetRetryIfPresent(db, confirmation.id);
        return;
      }
      const mapped = terminalMirror(confirmation.status);
      if (!mapped || mirror !== 'pending') {
        // A terminal confirmation that never opened stays absent.
        forgetRetryIfPresent(db, confirmation.id);
        return;
      }
      this.closed(confirmation.id, mapped.outcome, mapped.actor);
    },
    reconcile() {
      let pending: Array<{ id: string; control_session_id: string; payload_json: string }> = [];
      try {
        pending = db.prepare(
          `SELECT id, control_session_id, payload_json
             FROM schedule_confirmations
            WHERE status = 'pending'`,
        ).all() as Array<{ id: string; control_session_id: string; payload_json: string }>;
      } catch (error) {
        markScheduleWarn('schedule confirmation inbox reconcile scan failed', error);
      }
      for (const row of pending) {
        openStoredConfirmation(db, this, row);
      }
      let openRows: Array<{ source_key: string }> = [];
      try {
        openRows = db.prepare(
          `SELECT source_key FROM inbox_items
            WHERE source_kind = ? AND status = 'pending' AND tombstone = 0`,
        ).all(SOURCE_KIND) as Array<{ source_key: string }>;
      } catch (error) {
        markScheduleWarn('schedule confirmation inbox reconcile scan failed', error);
      }
      for (const item of openRows) {
        const confirmationId = item.source_key.slice(`${SOURCE_KIND}:`.length);
        let stored: { status: string } | undefined;
        try {
          stored = db.prepare(
            'SELECT status FROM schedule_confirmations WHERE id = ?',
          ).get(confirmationId) as { status: string } | undefined;
        } catch (error) {
          markScheduleWarn(`schedule confirmation inbox reconcile read failed id=${confirmationId}`, error);
          continue;
        }
        if (!stored || stored.status === 'expired') {
          this.closed(confirmationId, 'expired', 'system');
        } else if (stored.status === 'approved') {
          this.closed(confirmationId, 'resolved', recordedCloseActor(db, confirmationId) ?? 'system');
        } else if (stored.status === 'rejected') {
          this.closed(confirmationId, 'rejected', recordedCloseActor(db, confirmationId) ?? 'system');
        }
      }
      drainScheduleConfirmationInboxRetries(db, this);
    },
  };
}

export function assertScheduleConfirmationInbox(
  db: Db,
  confirmationId: string,
  expected: { id: string; generation: number },
  pending: boolean,
): void {
  if (typeof expected.id !== 'string' || expected.id.length === 0) fail();
  if (!Number.isInteger(expected.generation) || expected.generation < 1) fail();
  const row = db.prepare(
    `SELECT source_key, source_kind, status, generation, tombstone, target_json
       FROM inbox_items WHERE id = ?`,
  ).get(expected.id) as {
    source_key: string;
    source_kind: string;
    status: string;
    generation: number;
    tombstone: number;
    target_json: string;
  } | undefined;
  if (!row || row.tombstone !== 0) fail();
  if (pending && row.status !== 'pending') fail();
  if (row.generation !== expected.generation) fail();
  if (row.source_kind !== SOURCE_KIND) fail();
  if (row.source_key !== sourceKey(confirmationId)) fail();
  let target: unknown;
  try {
    target = JSON.parse(row.target_json);
  } catch {
    fail();
  }
  if (
    typeof target !== 'object'
    || target === null
    || (target as { type?: unknown }).type !== 'schedule_confirmation'
    || (target as { confirmation_id?: unknown }).confirmation_id !== confirmationId
  ) {
    fail();
  }
}

function fail(): never {
  throw scheduleFailure('PRECONDITION_FAILED', 'schedule confirmation inbox ref does not match');
}

function sourceKey(confirmationId: string): string {
  return `${SOURCE_KIND}:${confirmationId}`;
}

function openSignal(confirmation: ScheduleConfirmation): Record<string, unknown> {
  return {
    kind: 'schedule.confirmation',
    confirmation_id: confirmation.id,
    control_session_id: confirmation.control_session_id,
    generation: SCHEDULE_CONFIRMATION_GENERATION,
    title: confirmation.payload.name,
    summary: confirmation.payload.trigger_summary,
  };
}

function openStoredConfirmation(
  db: Db,
  observer: ScheduleConfirmationInboxObserver,
  row: { id: string; control_session_id: string; payload_json: string },
): void {
  let confirmation: ScheduleConfirmation;
  try {
    confirmation = confirmationFromRow(row);
  } catch (error) {
    markScheduleWarn(`schedule confirmation inbox reconcile open failed id=${row.id}`, error);
    rememberScheduleConfirmationInboxRetry(db, row.id, 'open', null, null, error);
    return;
  }
  observer.opened(confirmation);
}

function confirmationFromRow(row: {
  id: string;
  control_session_id: string;
  payload_json: string;
}): ScheduleConfirmation {
  const payload = JSON.parse(row.payload_json) as ScheduleConfirmation['payload'];
  return {
    id: row.id,
    status: 'pending',
    payload,
    control_session_id: row.control_session_id,
    schedule_id: null,
    expires_at: '',
    created_at: '',
    updated_at: '',
    resolved_at: null,
  };
}

type MirrorOutcome = 'resolved' | 'rejected' | 'expired';
type MirrorActor = 'user' | 'system';

function terminalMirror(status: string): { outcome: MirrorOutcome; actor: MirrorActor } | null {
  if (status === 'approved') return { outcome: 'resolved', actor: 'user' };
  if (status === 'rejected') return { outcome: 'rejected', actor: 'user' };
  if (status === 'expired') return { outcome: 'expired', actor: 'system' };
  return null;
}

function inboxMirrorState(db: Db, confirmationId: string): 'pending' | 'closed' | 'absent' | 'error' {
  try {
    const row = db.prepare(
      `SELECT status FROM inbox_items
        WHERE source_key = ? AND tombstone = 0`,
    ).get(sourceKey(confirmationId)) as { status: string } | undefined;
    if (!row) return 'absent';
    return row.status === 'pending' ? 'pending' : 'closed';
  } catch (error) {
    markScheduleWarn(`schedule confirmation inbox lookup failed id=${confirmationId}`, error);
    return 'error';
  }
}

function forgetRetryIfPresent(db: Db, confirmationId: string): void {
  if (!retryRecorded(db, confirmationId)) return;
  forgetScheduleConfirmationInboxRetry(db, confirmationId);
}

function retryRecorded(db: Db, confirmationId: string): boolean {
  try {
    const row = db.prepare(
      'SELECT 1 AS ok FROM schedule_confirmation_inbox_retries WHERE confirmation_id = ?',
    ).get(confirmationId) as { ok: number } | undefined;
    return row !== undefined;
  } catch (error) {
    markScheduleWarn(`schedule confirmation inbox retry read failed id=${confirmationId}`, error);
    return false;
  }
}

/** A projection error stays off the domain result. The retry row is the
 *  recoverable record; the next read or reconcile applies it again. */
function isolateProjection<T>(
  db: Db,
  confirmationId: string,
  op: 'open' | 'close',
  outcome: MirrorOutcome | null,
  actor: MirrorActor | null,
  run: () => T,
): T | null {
  try {
    const value = run();
    forgetScheduleConfirmationInboxRetry(db, confirmationId);
    return value;
  } catch (error) {
    rememberScheduleConfirmationInboxRetry(db, confirmationId, op, outcome, actor, error);
    return null;
  }
}

/** Only a brand-new unread pending row may become an OS notification. */
function freshScheduleConfirmationRef(written: unknown): AttentionInboxRef | null {
  if (!written || typeof written !== 'object') return null;
  const result = written as { outcome?: unknown; item?: unknown };
  if (result.outcome !== 'created' || !result.item || typeof result.item !== 'object') return null;
  const item = result.item as {
    id?: unknown;
    generation?: unknown;
    status?: unknown;
    unread?: unknown;
  };
  if (item.status !== 'pending' || item.unread !== true) return null;
  if (item.generation !== SCHEDULE_CONFIRMATION_GENERATION) return null;
  if (typeof item.id !== 'string' || item.id.length === 0 || item.id.length > 128 || item.id.includes('\0')) {
    return null;
  }
  return { id: item.id, generation: SCHEDULE_CONFIRMATION_GENERATION };
}

function rememberScheduleConfirmationInboxRetry(
  db: Db,
  confirmationId: string,
  op: 'open' | 'close',
  outcome: MirrorOutcome | null,
  actor: MirrorActor | null,
  error: unknown,
): void {
  markScheduleWarn(`schedule confirmation inbox ${op} failed id=${confirmationId}`, error);
  const detail = faultDetail(error);
  try {
    db.prepare(
      `INSERT INTO schedule_confirmation_inbox_retries
         (confirmation_id, op, outcome, actor, detail, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(confirmation_id) DO UPDATE SET
         op = excluded.op,
         outcome = excluded.outcome,
         actor = excluded.actor,
         detail = excluded.detail,
         updated_at = excluded.updated_at`,
    ).run(confirmationId, op, outcome, actor, detail, new Date().toISOString());
  } catch (recordError) {
    markScheduleWarn(`schedule confirmation inbox retry record failed id=${confirmationId}`, recordError);
  }
}

function forgetScheduleConfirmationInboxRetry(db: Db, confirmationId: string): void {
  try {
    db.prepare(
      'DELETE FROM schedule_confirmation_inbox_retries WHERE confirmation_id = ?',
    ).run(confirmationId);
  } catch (error) {
    markScheduleWarn(`schedule confirmation inbox retry clear failed id=${confirmationId}`, error);
  }
}

function recordedCloseActor(db: Db, confirmationId: string): MirrorActor | null {
  try {
    const row = db.prepare(
      `SELECT actor FROM schedule_confirmation_inbox_retries
        WHERE confirmation_id = ? AND op = 'close'`,
    ).get(confirmationId) as { actor: string | null } | undefined;
    if (row?.actor === 'user' || row?.actor === 'system') return row.actor;
  } catch (error) {
    markScheduleWarn(`schedule confirmation inbox retry read failed id=${confirmationId}`, error);
  }
  return null;
}

function drainScheduleConfirmationInboxRetries(
  db: Db,
  observer: ScheduleConfirmationInboxObserver,
): void {
  let rows: Array<{ confirmation_id: string }> = [];
  try {
    rows = db.prepare(
      'SELECT confirmation_id FROM schedule_confirmation_inbox_retries',
    ).all() as Array<{ confirmation_id: string }>;
  } catch (error) {
    markScheduleWarn('schedule confirmation inbox retry scan failed', error);
    return;
  }
  for (const retry of rows) {
    let stored: { id: string; status: string; control_session_id: string; payload_json: string } | undefined;
    try {
      stored = db.prepare(
        `SELECT id, status, control_session_id, payload_json
           FROM schedule_confirmations WHERE id = ?`,
      ).get(retry.confirmation_id) as typeof stored;
    } catch (error) {
      markScheduleWarn(`schedule confirmation inbox retry drain failed id=${retry.confirmation_id}`, error);
      continue;
    }
    if (!stored) {
      forgetScheduleConfirmationInboxRetry(db, retry.confirmation_id);
      continue;
    }
    if (stored.status === 'pending') {
      openStoredConfirmation(db, observer, stored);
      continue;
    }
    const mirror = inboxMirrorState(db, stored.id);
    if (mirror === 'error') continue;
    if (mirror !== 'pending') {
      forgetScheduleConfirmationInboxRetry(db, stored.id);
      continue;
    }
    const mapped = terminalMirror(stored.status);
    if (!mapped) {
      forgetScheduleConfirmationInboxRetry(db, stored.id);
      continue;
    }
    observer.closed(stored.id, mapped.outcome, recordedCloseActor(db, stored.id) ?? mapped.actor);
  }
}

function faultDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : 'inbox projection failed';
  const cleaned = message.replace(/[\u0000-\u001f]+/g, ' ').trim();
  return cleaned.slice(0, 200) || 'inbox projection failed';
}
