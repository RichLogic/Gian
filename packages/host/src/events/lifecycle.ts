import type { Db } from '../storage/db.js';

/**
 * Hot-cache lifecycle for the events table.
 *
 * Post-PR2 the proxies are stateless and JSONL on disk is the source of
 * truth for the transcript. The `events` / `turns` rows in our SQLite are
 * a *hot cache* layer used to make the Coding view render instantly: we
 * keep events for recently active sessions, and evict (sweep) events for
 * old / archived ones. The sessions row itself stays — only its events /
 * turns rows go. When the user later reopens the cold session, the events
 * list endpoint lazily rehydrates from JSONL.
 */

export interface SweepResult {
  sessionsSwept: number;
  eventsDeleted: number;
  turnsDeleted: number;
}

interface ColdSessionRow {
  id: string;
}

/**
 * Default TTL for "hot" sessions in days. Anything older or archived is
 * eligible for sweeping. Override at runtime via the
 * `GIAN_EVENT_SWEEP_TTL_DAYS` env var (handy for manual testing).
 */
const DEFAULT_TTL_DAYS = 30;

function resolveTtlDays(opts?: { ttlDays?: number }): number {
  if (opts?.ttlDays !== undefined && Number.isFinite(opts.ttlDays)) {
    return Math.max(0, opts.ttlDays);
  }
  const fromEnv = process.env['GIAN_EVENT_SWEEP_TTL_DAYS'];
  if (fromEnv) {
    const parsed = Number.parseFloat(fromEnv);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return DEFAULT_TTL_DAYS;
}

/**
 * Delete events / turns rows for sessions that haven't been accessed
 * recently. Sessions matching either condition are swept:
 *   - archived = 1 (any archived session — cheap to rehydrate from JSONL)
 *   - last_accessed_at IS NULL AND created_at < now - ttlDays
 *   - last_accessed_at < now - ttlDays
 *
 * Sessions rows themselves are preserved (with native_session_id intact)
 * so they remain visible in the sidebar / spaces. Their events are
 * lazy-rebuilt from JSONL on next open.
 *
 * Designed to be cheap and idempotent; safe to call on every host boot.
 */
export function sweepColdEvents(db: Db, opts?: { ttlDays?: number }): SweepResult {
  const ttlDays = resolveTtlDays(opts);
  const cutoffMs = Date.now() - ttlDays * 24 * 60 * 60 * 1000;
  const cutoffIso = new Date(cutoffMs).toISOString();

  // Pick the sessions whose events we'll evict. We compare `created_at`
  // and `last_accessed_at` as ISO-8601 strings — SQLite's lexicographic
  // ordering matches chronological ordering for that format.
  const cold = db
    .prepare(
      `SELECT id FROM sessions
       WHERE archived = 1
          OR (last_accessed_at IS NULL AND created_at < ?)
          OR (last_accessed_at IS NOT NULL AND last_accessed_at < ?)`,
    )
    .all(cutoffIso, cutoffIso) as ColdSessionRow[];

  if (cold.length === 0) {
    return { sessionsSwept: 0, eventsDeleted: 0, turnsDeleted: 0 };
  }

  // Restrict the IN-list to sessions that actually have rows to delete,
  // so the result counts reflect real work and the log line is honest.
  const sessionsWithEvents = new Set<string>();
  const sessionsWithTurns = new Set<string>();
  const checkEvents = db.prepare('SELECT 1 FROM events WHERE session_id = ? LIMIT 1');
  const checkTurns = db.prepare('SELECT 1 FROM turns WHERE session_id = ? LIMIT 1');
  for (const row of cold) {
    if (checkEvents.get(row.id)) sessionsWithEvents.add(row.id);
    if (checkTurns.get(row.id)) sessionsWithTurns.add(row.id);
  }

  const sessionsToSweep = new Set<string>([
    ...sessionsWithEvents,
    ...sessionsWithTurns,
  ]);
  if (sessionsToSweep.size === 0) {
    return { sessionsSwept: 0, eventsDeleted: 0, turnsDeleted: 0 };
  }

  let eventsDeleted = 0;
  let turnsDeleted = 0;

  // Delete in a single transaction. We prepare per-id statements to keep
  // the SQL simple (better-sqlite3 doesn't bind arrays); the row count
  // is small in practice (at most a few hundred per boot).
  const sweep = db.transaction(() => {
    const delEvents = db.prepare('DELETE FROM events WHERE session_id = ?');
    const delTurns = db.prepare('DELETE FROM turns WHERE session_id = ?');
    for (const id of sessionsToSweep) {
      const evRes = delEvents.run(id);
      eventsDeleted += Number(evRes.changes ?? 0);
      const tRes = delTurns.run(id);
      turnsDeleted += Number(tRes.changes ?? 0);
    }
  });
  sweep();

  return {
    sessionsSwept: sessionsToSweep.size,
    eventsDeleted,
    turnsDeleted,
  };
}

/** Update sessions.last_accessed_at = now for the given session. */
export function markAccessed(db: Db, sessionId: string): void {
  db.prepare('UPDATE sessions SET last_accessed_at = ? WHERE id = ?')
    .run(new Date().toISOString(), sessionId);
}
