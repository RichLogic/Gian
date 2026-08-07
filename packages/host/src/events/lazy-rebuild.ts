import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Db } from '../storage/db.js';
import {
  parseCcLine,
  parseCodexLine,
  parseNativeJsonlLines,
  replayNativeJsonl,
  type NormalizedTurn,
} from '../native/replay.js';
import { EventStore } from '../session/event-store.js';
import { hasEventStorageV3 } from '../storage/event-storage-v3-schema.js';

/**
 * Lazy rebuild of the events hot-cache from JSONL.
 *
 * If a session's `events` rows have been swept (cold session), we rebuild
 * them on demand from the on-disk native JSONL using the same parser the
 * adoption flow uses. This is called from the events list endpoint so the
 * user gets a fully populated transcript on first cold-session open.
 *
 * Idempotent: if events already exist for the session, this is a no-op.
 * Safe to call on every events fetch.
 */

export interface RebuildResult {
  turnsInserted: number;
  eventsInserted: number;
}

const COLD_TURN_ANCHOR = 2_000_000_000;
const TAIL_READ_START_BYTES = 256 * 1024;

interface RebuildState {
  source_path: string;
  source_size: number;
  next_offset: number;
  next_turn_number: number;
  complete: number;
}

interface SessionRow {
  native_session_id: string | null;
  executor: 'claude' | 'codex';
  workspace_id: string;
}

interface WorkspaceRow {
  path: string;
}

export function ensureEventsRebuilt(db: Db, sessionId: string, force = false): RebuildResult {
  // Fast path: hot cache already populated. Skipped when `force` is set — a
  // forced rebuild re-derives the transcript from the authoritative JSONL even
  // when events exist, healing sessions whose rows were duplicated/corrupted by
  // older append-style replays. Safe because `replayNativeJsonl` now clears the
  // session's rows before re-inserting (a true rebuild, not an append).
  if (!force) {
    const eventsCount = db
      .prepare('SELECT COUNT(*) AS c FROM events WHERE session_id = ?')
      .get(sessionId) as { c: number } | undefined;
    if (eventsCount && eventsCount.c > 0) {
      return { turnsInserted: 0, eventsInserted: 0 };
    }
  }

  const session = db
    .prepare('SELECT native_session_id, executor, workspace_id FROM sessions WHERE id = ?')
    .get(sessionId) as SessionRow | undefined;
  if (!session) {
    // Caller's responsibility to validate session existence before this.
    // Returning zeros keeps the events endpoint forgiving.
    return { turnsInserted: 0, eventsInserted: 0 };
  }
  if (!session.native_session_id) {
    // Post-PR1 invariant: every session has a native_session_id. The
    // only way to hit null is a corrupted row — surface it loudly.
    throw new Error(
      `session ${sessionId} has null native_session_id; cannot rebuild events from JSONL`,
    );
  }

  const ws = db
    .prepare('SELECT path FROM workspaces WHERE id = ?')
    .get(session.workspace_id) as WorkspaceRow | undefined;
  if (!ws) {
    // Can't rebuild without a cwd to look up cc storage / verify codex.
    // Treat as no-op rather than crashing the events endpoint.
    return { turnsInserted: 0, eventsInserted: 0 };
  }

  const jsonlPath = session.executor === 'claude'
    ? findClaudeJsonl(ws.path, session.native_session_id)
    : findCodexJsonlByThreadId(session.native_session_id);

  if (!jsonlPath) {
    // No on-disk JSONL — cold session with no recoverable transcript.
    // This is a normal state for very old sessions whose files were
    // archived externally; transcript stays empty.
    return { turnsInserted: 0, eventsInserted: 0 };
  }

  const result = replayNativeJsonl(db, sessionId, jsonlPath, session.executor);
  if (hasEventStorageV3(db)) {
    db.prepare('DELETE FROM event_rebuild_state WHERE session_id = ?').run(sessionId);
  }
  return {
    turnsInserted: result.turnCount,
    eventsInserted: result.eventCount,
  };
}

/**
 * Rebuild only the JSONL turns needed by the requested history page.
 *
 * Legacy databases retain the old full-rebuild behavior. The incremental
 * path exists only after the explicit P0 schema installation, so preparing
 * and testing this code cannot mutate the current Gian database.
 */
export function ensureEventPageRebuilt(
  db: Db,
  sessionId: string,
  beforeTurn: number | null,
  pageSize = 3,
  force = false,
): RebuildResult {
  if (!hasEventStorageV3(db) || force) return ensureEventsRebuilt(db, sessionId, force);

  const limit = Math.max(1, Math.min(10, Math.trunc(pageSize)));
  const eventCount = (db.prepare(
    'SELECT COUNT(*) AS n FROM events WHERE session_id = ?',
  ).get(sessionId) as { n: number }).n;
  let state = db.prepare(
    `SELECT source_path, source_size, next_offset, next_turn_number, complete
     FROM event_rebuild_state WHERE session_id = ?`,
  ).get(sessionId) as RebuildState | undefined;

  if (eventCount > 0 && !state) return { turnsInserted: 0, eventsInserted: 0 };
  if (state?.complete) return { turnsInserted: 0, eventsInserted: 0 };
  if (beforeTurn !== null && eventCount > 0) {
    const available = (db.prepare(
      'SELECT COUNT(*) AS n FROM turns WHERE session_id = ? AND turn_number < ?',
    ).get(sessionId, beforeTurn) as { n: number }).n;
    if (available >= limit) return { turnsInserted: 0, eventsInserted: 0 };
  } else if (beforeTurn === null && eventCount > 0) {
    return { turnsInserted: 0, eventsInserted: 0 };
  }

  const source = resolveNativeSource(db, sessionId);
  if (!source) return { turnsInserted: 0, eventsInserted: 0 };
  const sourceStat = statSync(source.path);
  if (!state) {
    state = {
      source_path: source.path,
      source_size: sourceStat.size,
      next_offset: sourceStat.size,
      next_turn_number: COLD_TURN_ANCHOR,
      complete: 0,
    };
    db.prepare(
      `INSERT INTO event_rebuild_state
        (session_id, source_path, source_size, next_offset, next_turn_number, complete)
       VALUES (?, ?, ?, ?, ?, 0)`,
    ).run(
      sessionId,
      state.source_path,
      state.source_size,
      state.next_offset,
      state.next_turn_number,
    );
  }

  if (state.source_path !== source.path || state.next_offset > sourceStat.size) {
    throw new Error(`native history changed during paged rebuild for session ${sessionId}`);
  }

  const page = readPreviousTurns(
    source.path,
    state.next_offset,
    source.executor,
    limit,
  );
  if (page.turns.length === 0) {
    db.prepare(
      `UPDATE event_rebuild_state
       SET next_offset = 0, complete = 1, updated_at = datetime('now')
       WHERE session_id = ?`,
    ).run(sessionId);
    return { turnsInserted: 0, eventsInserted: 0 };
  }

  const newestTurnNumber = state.next_turn_number;
  const oldestTurnNumber = newestTurnNumber - page.turns.length + 1;
  const newestTime = sourceStat.mtimeMs;
  let eventsInserted = 0;
  db.transaction(() => {
    eventsInserted = persistColdPage(
      db,
      sessionId,
      source.executor,
      page.turns,
      oldestTurnNumber,
      newestTime,
    );
    db.prepare(
      `UPDATE event_rebuild_state
       SET source_size = ?, next_offset = ?, next_turn_number = ?, complete = ?,
           updated_at = datetime('now')
       WHERE session_id = ?`,
    ).run(
      sourceStat.size,
      page.nextOffset,
      oldestTurnNumber - 1,
      page.nextOffset === 0 ? 1 : 0,
      sessionId,
    );
  })();
  return { turnsInserted: page.turns.length, eventsInserted };
}

function resolveNativeSource(
  db: Db,
  sessionId: string,
): { path: string; executor: 'claude' | 'codex' } | null {
  const session = db
    .prepare('SELECT native_session_id, executor, workspace_id FROM sessions WHERE id = ?')
    .get(sessionId) as SessionRow | undefined;
  if (!session?.native_session_id) return null;
  const ws = db.prepare('SELECT path FROM workspaces WHERE id = ?')
    .get(session.workspace_id) as WorkspaceRow | undefined;
  if (!ws) return null;
  const path = session.executor === 'claude'
    ? findClaudeJsonl(ws.path, session.native_session_id)
    : findCodexJsonlByThreadId(session.native_session_id);
  return path ? { path, executor: session.executor } : null;
}

function readPreviousTurns(
  filePath: string,
  endOffset: number,
  executor: 'claude' | 'codex',
  limit: number,
): { turns: NormalizedTurn[]; nextOffset: number } {
  const fd = openSync(filePath, 'r');
  try {
    let windowBytes = Math.min(TAIL_READ_START_BYTES, endOffset);
    const parser = executor === 'claude' ? parseCcLine : parseCodexLine;
    while (true) {
      const start = Math.max(0, endOffset - windowBytes);
      const buffer = Buffer.allocUnsafe(endOffset - start);
      readSync(fd, buffer, 0, buffer.byteLength, start);
      const lines = completeJsonlLines(buffer, start, start > 0);
      const boundaries: number[] = [];
      for (let index = 0; index < lines.length; index++) {
        if (parser(lines[index]!.text)?.boundary === 'turn-start') boundaries.push(index);
      }
      if (boundaries.length >= limit || start === 0) {
        const firstBoundary = boundaries[Math.max(0, boundaries.length - limit)];
        if (firstBoundary === undefined) return { turns: [], nextOffset: 0 };
        const selected = lines.slice(firstBoundary);
        return {
          turns: parseNativeJsonlLines(selected.map(line => line.text), executor),
          nextOffset: selected[0]!.offset,
        };
      }
      windowBytes = Math.min(endOffset, windowBytes * 2);
    }
  } finally {
    closeSync(fd);
  }
}

function completeJsonlLines(
  buffer: Buffer,
  baseOffset: number,
  startsMidLine: boolean,
): Array<{ offset: number; text: string }> {
  const lines: Array<{ offset: number; text: string }> = [];
  let lineStart = 0;
  if (startsMidLine) {
    const firstNewline = buffer.indexOf(0x0a);
    if (firstNewline === -1) return [];
    lineStart = firstNewline + 1;
  }
  for (let index = lineStart; index <= buffer.length; index++) {
    if (index !== buffer.length && buffer[index] !== 0x0a) continue;
    if (index > lineStart) {
      lines.push({
        offset: baseOffset + lineStart,
        text: buffer.subarray(lineStart, index).toString('utf8'),
      });
    }
    lineStart = index + 1;
  }
  return lines;
}

function persistColdPage(
  db: Db,
  sessionId: string,
  executor: 'claude' | 'codex',
  turns: NormalizedTurn[],
  oldestTurnNumber: number,
  newestTime: number,
): number {
  const events = new EventStore(db);
  let eventCount = 0;
  db.transaction(() => {
    for (let index = 0; index < turns.length; index++) {
      const turn = turns[index]!;
      const turnNumber = oldestTurnNumber + index;
      const turnId = randomUUID();
      const turnTime = newestTime - (COLD_TURN_ANCHOR - turnNumber) * 1_000;
      const startedAt = new Date(turnTime).toISOString();
      const completedAt = new Date(turnTime + 500).toISOString();
      db.prepare(
        `INSERT INTO turns (id, session_id, turn_number, status, created_at, completed_at)
         VALUES (?, ?, ?, 'completed', ?, ?)`,
      ).run(turnId, sessionId, turnNumber, startedAt, completedAt);
      events.persist({
        sessionId,
        turnId,
        callId: randomUUID(),
        type: 'gian.turn.started',
        data: lifecycleEvent(executor, turnId, 'running', 'state.turn-started'),
        createdAt: startedAt,
      });
      eventCount += 1;
      for (let eventIndex = 0; eventIndex < turn.events.length; eventIndex++) {
        const event = turn.events[eventIndex]!;
        events.persist({
          sessionId,
          turnId,
          callId: event.callId,
          type: event.type,
          data: event.data,
          createdAt: new Date(turnTime + 1 + eventIndex * 10).toISOString(),
        });
        eventCount += 1;
      }
      events.persist({
        sessionId,
        turnId,
        callId: randomUUID(),
        type: 'gian.turn.completed',
        data: lifecycleEvent(executor, turnId, 'completed', 'state.turn-completed'),
        createdAt: completedAt,
      });
      eventCount += 1;
    }
  })();
  return eventCount;
}

function lifecycleEvent(
  provider: 'claude' | 'codex',
  turnId: string,
  status: 'running' | 'completed',
  type: 'state.turn-started' | 'state.turn-completed',
): Record<string, unknown> {
  return {
    __gian_event: 2,
    provider,
    raw: { turnId, status },
    display: { type, data: { turnId } },
  };
}

// ---------------------------------------------------------------------------
// JSONL path resolution
// ---------------------------------------------------------------------------

/** Encode an absolute path the way Claude Code's project dir does:
 *  every `/` becomes `-`. e.g. `/Users/me/proj` → `-Users-me-proj`. */
function encodeCcProjectDir(absPath: string): string {
  return absPath.replaceAll('/', '-');
}

function findClaudeJsonl(workspacePath: string, nativeId: string): string | null {
  const filePath = join(
    homedir(),
    '.claude',
    'projects',
    encodeCcProjectDir(workspacePath),
    `${nativeId}.jsonl`,
  );
  return existsSync(filePath) ? filePath : null;
}

/**
 * Codex stores rollouts under ~/.codex/sessions/YYYY/MM/DD/rollout-*-<id>.jsonl
 * with date-derived directories. There's no path-based shortcut, so we walk
 * the tree (depth-bounded) and find the file whose name contains the thread
 * id. Exported so other modules / future callers can reuse the lookup.
 */
export function findCodexJsonlByThreadId(threadId: string): string | null {
  const root = join(homedir(), '.codex', 'sessions');
  if (!existsSync(root)) return null;

  // Walk YYYY/MM/DD; bail at depth 3 to stay cheap. Files live at depth 3.
  return walkForId(root, threadId, 0, 3);
}

function walkForId(dir: string, needle: string, depth: number, maxDepth: number): string | null {
  if (depth > maxDepth) return null;
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      const found = walkForId(full, needle, depth + 1, maxDepth);
      if (found) return found;
    } else if (
      stat.isFile() &&
      entry.endsWith('.jsonl') &&
      entry.startsWith('rollout-') &&
      entry.includes(needle)
    ) {
      return full;
    }
  }
  return null;
}
