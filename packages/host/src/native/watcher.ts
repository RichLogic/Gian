import { closeSync, existsSync, openSync, readSync, statSync, watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Db } from '../storage/db.js';
import type { WsBroadcaster } from '../web/ws-broadcast.js';
import { parseCcLine, parseCodexLine, type ParsedLine } from './replay.js';

/**
 * Live Sync v2 — watches each active session's native JSONL for external
 * appends and mirrors them into Gian's events table + WS broadcast.
 *
 * Use case: user opens a Gian session in the browser AND simultaneously
 * runs `claude --resume <id>` (or `codex resume <id>`) in a terminal. The
 * external CLI appends new turns to the same JSONL. Gian must reflect them
 * live.
 *
 * ## Why a byteOffset state machine
 *
 * The proxies cc/codex also write to the same JSONL while a turn runs;
 * their stdio notifications already drive INSERTs into the events table.
 * If the watcher reads those same lines we'd double-insert.
 *
 * Solution: maintain a `byteOffset` per session and only sync ranges
 * [offset, currentSize) AFTER the proxy reports turn-completed (or while
 * truly idle). The proxy lifecycle hooks pause/resume the watcher; resume
 * advances offset to current EOF so the just-flushed proxy turn is skipped.
 *
 * ## macOS fs.watch caveat
 *
 * fs.watch() on macOS (FSEvents) is known-unreliable — sometimes events
 * are coalesced or dropped. We add a 5s setInterval as a defensive
 * size-comparison fallback. This is fine because Gian is a single-machine
 * local tool; we're not at scale.
 */

const DEBOUNCE_MS = 100;
const POLL_INTERVAL_MS = 5000;

interface WatchedSession {
  sessionId: string;
  filePath: string;
  executor: 'claude' | 'codex';
  watcher: FSWatcher | null;
  pollTimer: NodeJS.Timeout | null;
  byteOffset: number;
  paused: boolean;
  debounceTimer: NodeJS.Timeout | null;
  /** Carryover bytes between reads — a single JSONL line can split across
   *  fs.watch boundaries (cc writes a line in two writes occasionally).
   *  We hold the trailing partial line until the next newline arrives. */
  lineBuffer: string;
  /** Currently-open turn id for line-by-line attribution. Null when no
   *  user message has been seen since we started watching this session. */
  currentTurnId: string | null;
  currentTurnNumber: number;
}

export class NativeJsonlWatcher {
  private sessions = new Map<string, WatchedSession>();

  constructor(private db: Db, private broadcaster: WsBroadcaster) {}

  /**
   * Begin watching `filePath` for `sessionId`. Idempotent — re-calling with
   * the same sessionId is a no-op (we don't re-seek). If the file doesn't
   * exist yet we still register, set offset=0, and rely on the poll fallback
   * to detect the eventual creation.
   */
  start(sessionId: string, filePath: string, executor: 'claude' | 'codex'): void {
    if (this.sessions.has(sessionId)) return;

    const initialOffset = existsSync(filePath) ? safeSize(filePath) : 0;
    const latestTurn = this.latestTurn(sessionId);
    const state: WatchedSession = {
      sessionId,
      filePath,
      executor,
      watcher: null,
      pollTimer: null,
      byteOffset: initialOffset,
      paused: false,
      debounceTimer: null,
      lineBuffer: '',
      currentTurnId: latestTurn?.id ?? null,
      currentTurnNumber: latestTurn?.turnNumber ?? 0,
    };
    this.sessions.set(sessionId, state);
    this.attachWatcher(state);
    state.pollTimer = setInterval(() => this.scheduleSync(state), POLL_INTERVAL_MS);
  }

  /** Stop watching this session. Idempotent. */
  stop(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    if (state.watcher) {
      try { state.watcher.close(); } catch { /* ignore */ }
    }
    if (state.pollTimer) clearInterval(state.pollTimer);
    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    this.sessions.delete(sessionId);
  }

  /** Pause syncing. Called when the host is about to start a proxy turn —
   *  the proxy will write to the JSONL and emit stdio events; we mustn't
   *  re-insert those same events from the file. */
  pause(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    state.paused = true;
    if (state.debounceTimer) {
      clearTimeout(state.debounceTimer);
      state.debounceTimer = null;
    }
  }

  /** Resume syncing. Advances byteOffset to current EOF so the proxy's
   *  just-written turn (which we already persisted via stdio events) is
   *  skipped. Subsequent external appends will be picked up. */
  resume(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    if (existsSync(state.filePath)) {
      state.byteOffset = safeSize(state.filePath);
    }
    // Refresh turn-number anchor — proxy may have inserted turns we don't
    // know about (job mode, queued sends, etc.) so re-base from the DB.
    state.currentTurnNumber = this.lastTurnNumber(sessionId);
    state.currentTurnId = null;
    state.lineBuffer = '';
    state.paused = false;
  }

  /** Tear down all watchers. Call from host shutdown. */
  stopAll(): void {
    for (const id of [...this.sessions.keys()]) this.stop(id);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private attachWatcher(state: WatchedSession): void {
    // fs.watch on a non-existent file throws; if the file isn't there yet,
    // skip — the poll-fallback will pick it up when it appears.
    if (!existsSync(state.filePath)) return;
    try {
      state.watcher = watch(state.filePath, { persistent: false }, () => {
        this.scheduleSync(state);
      });
      state.watcher.on('error', err => {
        console.error('[jsonl-watcher] fs.watch error', state.sessionId, err);
        // Drop the broken watcher; poll fallback continues.
        try { state.watcher?.close(); } catch { /* ignore */ }
        state.watcher = null;
      });
    } catch (err) {
      // EPERM / ENOENT can race with file deletion; fall back to polling.
      console.error('[jsonl-watcher] fs.watch attach failed', state.sessionId, err);
      state.watcher = null;
    }
  }

  /** Coalesce bursty fs.watch events into a single sync. */
  private scheduleSync(state: WatchedSession): void {
    if (state.paused) return;
    if (state.debounceTimer) return;
    state.debounceTimer = setTimeout(() => {
      state.debounceTimer = null;
      this.syncSession(state);
    }, DEBOUNCE_MS);
  }

  /** Read the new tail of the JSONL, parse line-by-line, persist + broadcast. */
  private syncSession(state: WatchedSession): void {
    if (state.paused) return;
    if (!existsSync(state.filePath)) return;

    // First sighting of a previously-missing file: attach the watcher now.
    if (!state.watcher) this.attachWatcher(state);

    const size = safeSize(state.filePath);
    if (size <= state.byteOffset) {
      // File was truncated or rewritten (cc /clear, codex archive). Reset
      // to current size; we'll pick up future appends.
      if (size < state.byteOffset) state.byteOffset = size;
      return;
    }

    const length = size - state.byteOffset;
    let chunk: string;
    try {
      const fd = openSync(state.filePath, 'r');
      try {
        const buf = Buffer.alloc(length);
        readSync(fd, buf, 0, length, state.byteOffset);
        chunk = buf.toString('utf8');
      } finally {
        closeSync(fd);
      }
    } catch (err) {
      console.error('[jsonl-watcher] read failed', state.sessionId, err);
      return;
    }

    state.byteOffset = size;
    const combined = state.lineBuffer + chunk;
    const newlineIdx = combined.lastIndexOf('\n');
    let toProcess: string;
    if (newlineIdx === -1) {
      // No complete line yet; stash and wait for more.
      state.lineBuffer = combined;
      return;
    }
    toProcess = combined.slice(0, newlineIdx);
    state.lineBuffer = combined.slice(newlineIdx + 1);

    const parser = state.executor === 'claude' ? parseCcLine : parseCodexLine;
    const lines = toProcess.split('\n');
    for (const line of lines) {
      const parsed = parser(line);
      if (!parsed) continue;
      this.applyParsed(state, parsed);
    }
  }

  /** Insert events + broadcast for one parsed line, opening a new turn at
   *  user-message boundaries. */
  private applyParsed(state: WatchedSession, parsed: ParsedLine): void {
    if (parsed.boundary === 'turn-start') {
      // Open a new turn row. Use the next available turn_number — re-query
      // every time so concurrent proxy turns can't clash with us.
      state.currentTurnNumber = this.lastTurnNumber(state.sessionId) + 1;
      state.currentTurnId = randomUUID();
      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO turns (id, session_id, turn_number, status, created_at, completed_at)
           VALUES (?, ?, ?, 'completed', ?, ?)`,
        )
        .run(state.currentTurnId, state.sessionId, state.currentTurnNumber, now, now);
    }

    if (!state.currentTurnId) {
      // 'continue' line with no preceding user message in our window. This
      // can happen on first-touch of a partial JSONL (we joined mid-turn).
      // Skip to avoid orphan-event FK errors.
      return;
    }

    for (const ev of parsed.events) {
      this.persistAndBroadcast(state, ev.callId, ev.type, ev.data);
    }
  }

  private persistAndBroadcast(
    state: WatchedSession,
    callId: string,
    type: string,
    data: Record<string, unknown>,
  ): void {
    const id = randomUUID();
    try {
      this.db
        .prepare(
          `INSERT INTO events (id, session_id, turn_id, call_id, type, data)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(id, state.sessionId, state.currentTurnId, callId, type, JSON.stringify(data));
    } catch (err) {
      console.error('[jsonl-watcher] event insert failed', state.sessionId, err);
      return;
    }
    this.broadcaster.broadcast({
      type: 'event',
      session_id: state.sessionId,
      turn: state.currentTurnNumber,
      call_id: callId,
      event: type,
      ts: Date.now(),
      data,
    });
    if (type === 'approval_requested') {
      this.persistSessionStatus(state.sessionId, 'pending');
    } else if (type === 'approval_resolved') {
      this.persistSessionStatus(state.sessionId, 'running');
    }
  }

  private lastTurnNumber(sessionId: string): number {
    return this.latestTurn(sessionId)?.turnNumber ?? 0;
  }

  private latestTurn(sessionId: string): { id: string; turnNumber: number } | null {
    const row = this.db
      .prepare(
        `SELECT id, turn_number
         FROM turns
         WHERE session_id = ?
         ORDER BY turn_number DESC
         LIMIT 1`,
      )
      .get(sessionId) as { id: string; turn_number: number } | undefined;
    if (!row) return null;
    return { id: row.id, turnNumber: row.turn_number };
  }

  private persistSessionStatus(sessionId: string, status: 'pending' | 'running'): void {
    const now = new Date().toISOString();
    const result = this.db
      .prepare('UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, now, sessionId);
    if (result.changes <= 0) return;
    this.broadcaster.broadcast({
      type: 'session:updated',
      session: { id: sessionId, status, updated_at: now },
    });
  }
}

function safeSize(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}
