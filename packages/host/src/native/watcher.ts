import { closeSync, existsSync, openSync, readSync, statSync, watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Db } from '../storage/db.js';
import type { WsBroadcaster } from '../web/ws-broadcast.js';
import { EventStore } from '../session/event-store.js';
import { AttentionDispatcher } from '../session/attention.js';
import type { ChatEvent } from '@gian/shared';
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
const TERMINAL_TAIL_BYTES = 64 * 1024;

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
  private events: EventStore;

  constructor(
    private db: Db,
    private broadcaster: WsBroadcaster,
    private attention = new AttentionDispatcher(broadcaster),
  ) {
    this.events = new EventStore(db);
  }

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
    if (latestTurn?.status === 'running') {
      this.recoverTerminalFromTail(state, initialOffset);
    }
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
      const metadata = inspectNativeLine(line, state.executor);
      const parsed = parser(line);
      if (parsed) this.applyParsed(state, parsed, metadata.timestamp);
      if (metadata.completed) {
        this.completeCurrentTurn(state, metadata.timestamp ?? new Date().toISOString(), true);
      }
    }
  }

  /** Insert events + broadcast for one parsed line, opening a new turn at
   *  user-message boundaries. */
  private applyParsed(
    state: WatchedSession,
    parsed: ParsedLine,
    timestamp: string | undefined,
  ): void {
    if (parsed.boundary === 'turn-start') {
      // A terminal record may be absent from the observed tail (older files,
      // interrupted writes, or watcher restart). The next real user message
      // is also a definitive boundary for the prior running turn. Close it
      // before opening the next turn so live and replay lifecycle agree.
      const boundaryAt = timestamp ?? new Date().toISOString();
      this.completeCurrentTurn(state, boundaryAt, true);

      // Open a new turn row. Use the next available turn_number — re-query
      // every time so concurrent proxy turns can't clash with us.
      state.currentTurnNumber = this.lastTurnNumber(state.sessionId) + 1;
      state.currentTurnId = randomUUID();
      this.db
        .prepare(
          `INSERT INTO turns (id, session_id, turn_number, status, created_at, completed_at)
           VALUES (?, ?, ?, 'running', ?, NULL)`,
        )
        .run(state.currentTurnId, state.sessionId, state.currentTurnNumber, boundaryAt);

      this.persistLifecycle(state, 'started', boundaryAt, true);
      this.persistSessionStatus(state.sessionId, 'running');
    }

    if (!state.currentTurnId) {
      // 'continue' line with no preceding user message in our window. This
      // can happen on first-touch of a partial JSONL (we joined mid-turn).
      // Skip to avoid orphan-event FK errors.
      return;
    }

    for (const ev of parsed.events) {
      this.persistAndBroadcast(state, ev.callId, ev.type, ev.data, { attentionEligible: true });
    }
  }

  private persistAndBroadcast(
    state: WatchedSession,
    callId: string,
    type: string,
    data: Record<string, unknown>,
    options: {
      replaceSnapshot?: boolean;
      createdAt?: string;
      attentionEligible?: boolean;
    } = {},
  ): void {
    let inserted = true;
    try {
      const result = this.events.persist({
        sessionId: state.sessionId,
        turnId: state.currentTurnId!,
        callId,
        type,
        data,
        replaceSnapshot: options.replaceSnapshot,
        createdAt: options.createdAt,
      });
      inserted = result.inserted;
    } catch (err) {
      console.error('[jsonl-watcher] event insert failed', state.sessionId, err);
      return;
    }
    // Lifecycle writes use a stable snapshot identity. If another watcher
    // pass already persisted it, do not rebroadcast the same boundary.
    if (options.replaceSnapshot && !inserted) return;

    const stored = data.__gian_event === 2 ? data : null;
    const raw = stored?.raw && typeof stored.raw === 'object' && !Array.isArray(stored.raw)
      ? stored.raw as Record<string, unknown>
      : data;
    const display = stored?.display && typeof stored.display === 'object' && !Array.isArray(stored.display)
      ? stored.display as import('@gian/shared').ChatDisplay
      : undefined;
    const provider = stored?.provider === 'claude'
      || stored?.provider === 'codex'
      || stored?.provider === 'kimi'
      ? stored.provider
      : state.executor;
    const event: ChatEvent = {
      session_id: state.sessionId,
      turn: state.currentTurnNumber,
      call_id: callId,
      event: type,
      ts: options.createdAt ? Date.parse(options.createdAt) : Date.now(),
      data: raw,
      provider,
      ...(display ? { display } : {}),
    };
    this.broadcaster.broadcast({ type: 'event', ...event });
    if (inserted && options.attentionEligible) this.attention.broadcast(event);
    if (display?.type === 'interaction.approval' || display?.type === 'interaction.question') {
      this.persistSessionStatus(state.sessionId, 'pending');
    } else if (display?.type === 'interaction.resolved') {
      this.persistSessionStatus(state.sessionId, 'running');
    }
  }

  /** Persist one Gian-owned lifecycle boundary exactly once per turn. */
  private persistLifecycle(
    state: WatchedSession,
    lifecycle: 'started' | 'completed',
    createdAt: string,
    attentionEligible: boolean,
  ): void {
    const turnId = state.currentTurnId;
    if (!turnId) return;

    const displayType = lifecycle === 'started'
      ? 'state.turn-started'
      : 'state.turn-completed';
    const eventType = lifecycle === 'started'
      ? 'gian.turn.started'
      : 'gian.turn.completed';

    // A replay or provider-owned live path may already have supplied the
    // same display lifecycle with a different call id/type. Treat that as
    // terminal evidence too, otherwise watcher restart would duplicate it.
    if (this.hasLifecycleEvent(state.sessionId, turnId, lifecycle)) return;

    this.persistAndBroadcast(
      state,
      `gian:${turnId}:${lifecycle}`,
      eventType,
      {
        __gian_event: 2,
        provider: state.executor,
        raw: {
          turnId,
          status: lifecycle === 'started' ? 'running' : 'completed',
        },
        display: {
          type: displayType,
          data: { turnId },
        },
      },
      { replaceSnapshot: true, createdAt, attentionEligible },
    );
  }

  /**
   * Finalize the current turn before emitting its terminal lifecycle. An
   * existing lifecycle (replay/provider/restart) is authoritative: preserve
   * its completed_at, but heal a partially-written running/null row.
   */
  private completeCurrentTurn(
    state: WatchedSession,
    completedAt: string,
    attentionEligible: boolean,
  ): void {
    const turnId = state.currentTurnId;
    if (!turnId) return;
    const row = this.db
      .prepare(
        `SELECT status, completed_at
         FROM turns
         WHERE id = ? AND session_id = ?`,
      )
      .get(turnId, state.sessionId) as {
        status: string;
        completed_at: string | null;
      } | undefined;
    if (!row) {
      state.currentTurnId = null;
      return;
    }

    const terminalStatus = row.status === 'completed'
      || row.status === 'error'
      || row.status === 'stopped';
    const alreadyCompleted = this.hasLifecycleEvent(state.sessionId, turnId, 'completed');
    if (terminalStatus && alreadyCompleted) {
      state.currentTurnId = null;
      return;
    }

    // A terminal DB row is authoritative even when its lifecycle event was
    // lost. Preserve both its status and completed_at and repair only the
    // missing boundary. Running/partial rows are healed in place.
    const effectiveCompletedAt = normalizedTimestamp(row.completed_at) ?? completedAt;
    if (!terminalStatus || row.completed_at == null) {
      this.db
        .prepare(
          `UPDATE turns
           SET status = CASE
                 WHEN status IN ('completed', 'error', 'stopped') THEN status
                 ELSE 'completed'
               END,
               completed_at = COALESCE(completed_at, ?)
           WHERE id = ? AND session_id = ?`,
        )
        .run(effectiveCompletedAt, turnId, state.sessionId);
    }
    this.persistLifecycle(state, 'completed', effectiveCompletedAt, attentionEligible);
    this.persistSessionStatus(
      state.sessionId,
      row.status === 'error' ? 'error' : 'done',
      row.status === 'stopped' ? 0 : 1,
    );
    state.currentTurnId = null;
  }

  /**
   * Restart repair for the narrow crash window where the native terminal line
   * reached disk but Host died before persisting it. Read only a bounded tail
   * and inspect the last complete JSON record; historical content is never
   * replayed from this path.
   */
  private recoverTerminalFromTail(state: WatchedSession, fileSize: number): void {
    if (!state.currentTurnId || fileSize <= 0 || !existsSync(state.filePath)) return;
    const start = Math.max(0, fileSize - TERMINAL_TAIL_BYTES);
    let tail: string;
    try {
      const fd = openSync(state.filePath, 'r');
      try {
        const buffer = Buffer.alloc(fileSize - start);
        readSync(fd, buffer, 0, buffer.length, start);
        tail = buffer.toString('utf8');
      } finally {
        closeSync(fd);
      }
    } catch {
      return;
    }
    if (start > 0) {
      const firstNewline = tail.indexOf('\n');
      if (firstNewline === -1) return;
      tail = tail.slice(firstNewline + 1);
    }
    const candidates = tail.split('\n').map(line => line.trim()).filter(Boolean);
    for (let index = candidates.length - 1; index >= 0; index--) {
      const line = candidates[index]!;
      try {
        JSON.parse(line);
      } catch {
        continue;
      }
      const metadata = inspectNativeLine(line, state.executor);
      if (metadata.completed) {
        // Restart repair is historical recovery, not a new live boundary.
        this.completeCurrentTurn(
          state,
          metadata.timestamp ?? new Date().toISOString(),
          false,
        );
      }
      return;
    }
  }

  private hasLifecycleEvent(
    sessionId: string,
    turnId: string,
    lifecycle: 'started' | 'completed',
  ): boolean {
    const rows = this.db
      .prepare(
        `SELECT type, data
         FROM events
         WHERE session_id = ? AND turn_id = ?`,
      )
      .all(sessionId, turnId) as Array<{ type: string; data: string }>;
    const displayType = lifecycle === 'started'
      ? 'state.turn-started'
      : 'state.turn-completed';
    const nativeTypes = lifecycle === 'started'
      ? new Set(['gian.turn.started', 'turn.started', 'turn_started'])
      : new Set(['gian.turn.completed', 'turn.completed', 'turn_completed']);

    return rows.some(row => {
      if (nativeTypes.has(row.type)) return true;
      const decoded = this.events.decode(row.data);
      const display = decoded.display;
      return !!display
        && typeof display === 'object'
        && !Array.isArray(display)
        && (display as { type?: unknown }).type === displayType;
    });
  }

  private lastTurnNumber(sessionId: string): number {
    return this.latestTurn(sessionId)?.turnNumber ?? 0;
  }

  private latestTurn(sessionId: string): {
    id: string;
    turnNumber: number;
    status: string;
  } | null {
    const row = this.db
      .prepare(
        `SELECT id, turn_number, status
         FROM turns
         WHERE session_id = ?
         ORDER BY turn_number DESC
         LIMIT 1`,
      )
      .get(sessionId) as { id: string; turn_number: number; status: string } | undefined;
    if (!row) return null;
    return { id: row.id, turnNumber: row.turn_number, status: row.status };
  }

  private persistSessionStatus(
    sessionId: string,
    status: 'pending' | 'running' | 'done' | 'error',
    unread?: 0 | 1,
  ): void {
    const now = new Date().toISOString();
    const result = unread === undefined
      ? this.db
          .prepare('UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?')
          .run(status, now, sessionId)
      : this.db
          .prepare('UPDATE sessions SET status = ?, unread = ?, updated_at = ? WHERE id = ?')
          .run(status, unread, now, sessionId);
    if (result.changes <= 0) return;
    this.broadcaster.broadcast({
      type: 'session:updated',
      session: { id: sessionId, status, ...(unread === undefined ? {} : { unread }), updated_at: now },
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

interface NativeLineMetadata {
  timestamp?: string;
  completed: boolean;
}

/**
 * Inspect only explicit native lifecycle evidence. Do not infer completion
 * from EOF, quiet periods, or the last visible assistant message.
 */
function inspectNativeLine(
  line: string,
  executor: 'claude' | 'codex',
): NativeLineMetadata {
  let parsed: Record<string, unknown>;
  try {
    const value = JSON.parse(line) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { completed: false };
    }
    parsed = value as Record<string, unknown>;
  } catch {
    return { completed: false };
  }

  const timestamp = normalizedTimestamp(parsed.timestamp);
  if (executor === 'codex') {
    const payload = parsed.payload;
    const completed = parsed.type === 'event_msg'
      && !!payload
      && typeof payload === 'object'
      && !Array.isArray(payload)
      && (payload as { type?: unknown }).type === 'task_complete';
    return { timestamp, completed };
  }

  const completed = parsed.type === 'system'
    && parsed.subtype === 'turn_duration'
    && parsed.isSidechain !== true;
  return { timestamp, completed };
}

function normalizedTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : undefined;
}
