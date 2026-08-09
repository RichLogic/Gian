import type { ChatDisplay, DisplayEventType, EventEnvelope } from '@gian/shared';
import type { Db } from '../storage/db.js';
import {
  EventStore,
  type EventStoreOptions,
  type PersistEventResult,
} from './event-store.js';

interface StoredEventRow {
  id: string;
  session_id: string;
  call_id: string;
  type: string;
  data: string;
  created_at: string;
  turn_number: number | null;
}

interface StoredTurnPageRow {
  id: string;
  turn_number: number;
  status: string;
  created_at: string;
  completed_at: string | null;
}

/** Stay below both modern and legacy SQLite variable limits. */
const EVENT_DELETE_BATCH_SIZE = 500;
const TERMINAL_TURN_STATUSES = new Set(['completed', 'error', 'stopped']);

export interface EventHistoryPage {
  events: EventEnvelope[];
  nextCursor: number | null;
  hasMore: boolean;
}

export interface SnapshotCompactionResult {
  groups: number;
  removed: number;
}

export interface StreamCompactionResult {
  groups: number;
  removed: number;
}

export class SessionHistoryStore {
  private events: EventStore;

  constructor(private db: Db, options: EventStoreOptions = {}) {
    this.events = new EventStore(db, options);
  }

  listEvents(sessionId: string): EventEnvelope[] {
    const order = this.events.usesSequence ? 'e.sequence' : 'e.rowid';
    const rows = this.db
      .prepare(
        `SELECT e.id, e.session_id, e.call_id, e.type, e.data, e.created_at, t.turn_number
         FROM events e
         LEFT JOIN turns t ON t.id = e.turn_id
         WHERE e.session_id = ?
         ORDER BY ${order} ASC`,
      )
      .all(sessionId) as StoredEventRow[];
    return rows.map(row => eventEnvelope(this.events, sessionId, row, true));
  }

  /**
   * Load whole turns newest-first, then return their events chronologically.
   * Snapshot-style provider notifications are compacted at this read boundary
   * so databases created before write-time replacement do not flood the host.
   */
  listEventPage(sessionId: string, beforeTurn: number | null, pageSize = 3): EventHistoryPage {
    const limit = Math.max(1, Math.min(10, Math.trunc(pageSize)));
    const orderColumn = this.events.usesSequence ? 'sequence' : 'rowid';
    const turnRows = this.db
      .prepare(
        `SELECT id, turn_number, status, created_at, completed_at
         FROM turns
         WHERE session_id = ? AND (? IS NULL OR turn_number < ?)
         ORDER BY turn_number DESC
         LIMIT ?`,
      )
      .all(sessionId, beforeTurn, beforeTurn, limit + 1) as StoredTurnPageRow[];
    const selected = turnRows.slice(0, limit);
    if (selected.length === 0) return { events: [], nextCursor: null, hasMore: false };

    const placeholders = selected.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT e.id, e.session_id, e.call_id, e.type, e.data, e.created_at, t.turn_number
         FROM events e
         LEFT JOIN turns t ON t.id = e.turn_id
         WHERE e.session_id = ?
           AND e.turn_id IN (${placeholders})
           AND (
             e.type <> 'diff.updated'
             OR e.${orderColumn} = (
               SELECT MAX(snapshot.${orderColumn}) FROM events snapshot
               WHERE snapshot.turn_id = e.turn_id AND snapshot.type = e.type
             )
           )
           AND (
             e.type <> 'codex.agent'
             OR e.${orderColumn} = (
               SELECT MAX(snapshot.${orderColumn}) FROM events snapshot
               WHERE snapshot.turn_id = e.turn_id
                 AND snapshot.type = e.type
                 AND snapshot.call_id = e.call_id
             )
           )
           AND (
             e.type <> 'acp.sessionUpdate'
             OR COALESCE(
               json_extract(e.data, '$.raw.update.sessionUpdate'),
               json_extract(e.data, '$.update.sessionUpdate'),
               ''
             ) NOT IN ('tool_call', 'tool_call_update')
             OR e.${orderColumn} = (
               SELECT MAX(snapshot.${orderColumn}) FROM events snapshot
               WHERE snapshot.turn_id = e.turn_id
                 AND snapshot.type = e.type
                 AND snapshot.call_id = e.call_id
             )
           )
         ORDER BY e.${orderColumn} ASC`,
      )
      .all(sessionId, ...selected.map(turn => turn.id)) as StoredEventRow[];
    const coldRebuild = this.events.usesSequence
      ? this.db.prepare(
        'SELECT complete FROM event_rebuild_state WHERE session_id = ?',
      ).get(sessionId) as { complete: number } | undefined
      : undefined;
    const hasMore = turnRows.length > limit || coldRebuild?.complete === 0;
    const oldestTurn = Math.min(...selected.map(turn => turn.turn_number));
    const compacted = compactHistoryEnvelopes(
      rows.map(row => eventEnvelope(this.events, sessionId, row, false)),
    );
    return {
      events: synthesizeTerminalBoundaries(sessionId, selected, compacted),
      nextCursor: hasMore ? oldestTurn : null,
      hasMore,
    };
  }

  countTurns(sessionId: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM turns WHERE session_id = ?')
      .get(sessionId) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  /** Canonical replay projection shared by migration verification and history reads. */
  canonicalTurnEvents(turnId: string): EventEnvelope[] {
    const order = this.events.usesSequence ? 'sequence' : 'rowid';
    const rows = this.db.prepare(
      `SELECT e.id, e.session_id, e.call_id, e.type, e.data, e.created_at,
              t.turn_number
       FROM events e
       JOIN turns t ON t.id = e.turn_id
       WHERE e.turn_id = ?
       ORDER BY e.${order} ASC`,
    ).all(turnId) as StoredEventRow[];
    return canonicalizeHistoryEnvelopes(
      rows.map(row => eventEnvelope(this.events, row.session_id, row, true)),
    );
  }

  /** Remove only recognized full snapshots, retaining and v3-encoding the newest row. */
  compactTurnSnapshots(turnId: string): SnapshotCompactionResult {
    if (!this.events.usesSequence) return { groups: 0, removed: 0 };
    const rows = this.db.prepare(
      `SELECT e.id, e.session_id, e.call_id, e.type, e.data, e.created_at,
              t.turn_number
       FROM events e
       JOIN turns t ON t.id = e.turn_id
       WHERE e.turn_id = ?
       ORDER BY e.sequence ASC`,
    ).all(turnId) as StoredEventRow[];
    const groups = new Map<string, Array<{ row: StoredEventRow; event: EventEnvelope }>>();
    for (const row of rows) {
      const event = eventEnvelope(this.events, row.session_id, row, true);
      const identity = snapshotIdentity(event);
      if (!identity) continue;
      const group = groups.get(identity) ?? [];
      group.push({ row, event });
      groups.set(identity, group);
    }

    let groupCount = 0;
    let removed = 0;
    this.db.transaction(() => {
      for (const group of groups.values()) {
        const retained = group[group.length - 1];
        if (!retained) continue;
        this.events.replaceData(retained.row.id, this.events.decode(retained.row.data));
        if (retained.event.event === 'diff.updated') {
          this.db.prepare('UPDATE events SET call_id = ? WHERE id = ?')
            .run(`diff:${turnId}`, retained.row.id);
        }
        if (group.length < 2) continue;
        groupCount += 1;
        const obsolete = group.slice(0, -1).map(item => item.row.id);
        removed += deleteEventsById(this.db, obsolete);
      }
    })();
    return { groups: groupCount, removed };
  }

  nextTurnNumber(sessionId: string): number {
    const row = this.db
      .prepare('SELECT MAX(turn_number) AS n FROM turns WHERE session_id = ?')
      .get(sessionId) as { n: number | null } | undefined;
    return (row?.n ?? 0) + 1;
  }

  appendEvent(
    sessionId: string,
    turnId: string,
    callId: string,
    type: string,
    data: Record<string, unknown>,
    options: { replaceSnapshot?: boolean; createdAt?: string } = {},
  ): PersistEventResult {
    return this.events.persist({
      sessionId,
      turnId,
      callId,
      type,
      data,
      createdAt: options.createdAt,
      replaceSnapshot: options.replaceSnapshot,
    });
  }

  /** True when this turn already carries a provider or Gian-owned fold boundary. */
  hasTurnCompletionBoundary(turnId: string): boolean {
    const rows = this.db.prepare(
      `SELECT e.id, e.session_id, e.call_id, e.type, e.data, e.created_at,
              t.turn_number
       FROM events e
       JOIN turns t ON t.id = e.turn_id
       WHERE e.turn_id = ?
         AND e.type IN (
           'turn.completed', 'turn_completed', 'state.turn-completed', 'gian.turn.completed'
         )`,
    ).all(turnId) as StoredEventRow[];
    return rows.some(row => (
      eventEnvelope(this.events, row.session_id, row, true).display?.type
        === 'state.turn-completed'
    ));
  }

  /** Merge safe streaming fragments once a turn is terminal. */
  compactTurnStreams(turnId: string): number {
    return this.compactTurnStreamsDetailed(turnId).removed;
  }

  compactTurnStreamsDetailed(turnId: string): StreamCompactionResult {
    // Existing Gian databases remain read-only until the packaged migration is
    // explicitly run. Automatic compaction is enabled only by that schema.
    if (!this.events.usesSequence) return { groups: 0, removed: 0 };
    const order = this.events.usesSequence ? 'sequence' : 'rowid';
    const rows = this.db.prepare(
      `SELECT e.id, e.session_id, e.call_id, e.type, e.data, e.created_at,
              t.turn_number
       FROM events e
       JOIN turns t ON t.id = e.turn_id
       WHERE e.turn_id = ?
       ORDER BY e.${order} ASC`,
    ).all(turnId) as StoredEventRow[];
    const groups = new Map<string, Array<{ row: StoredEventRow; event: EventEnvelope }>>();
    for (const row of rows) {
      const event = eventEnvelope(this.events, row.session_id, row, true);
      const key = streamIdentity(event);
      if (!key) continue;
      const group = groups.get(key) ?? [];
      group.push({ row, event });
      groups.set(key, group);
    }

    let removed = 0;
    let groupCount = 0;
    this.db.transaction(() => {
      for (const group of groups.values()) {
        if (group.length < 2) continue;
        const compacted = compactHistoryEnvelopes(group.map(item => item.event));
        const merged = compacted[0];
        const retained = group[group.length - 1];
        if (!merged?.display || !retained) continue;
        this.events.replaceData(retained.row.id, {
          __gian_event: 2,
          ...(merged.provider ? { provider: merged.provider } : {}),
          raw: {
            compacted: true,
            fragments: group.length,
            event: retained.event.event,
          },
          display: merged.display,
        });
        const firstCreatedAt = group[0]!.row.created_at;
        if (retained.row.created_at !== firstCreatedAt) {
          // The retained row keeps the newest sequence position, while its
          // timestamp remains the first fragment's start time. Live reducers
          // already preserve that timestamp, so replay must match them.
          this.db.prepare('UPDATE events SET created_at = ? WHERE id = ?')
            .run(firstCreatedAt, retained.row.id);
        }
        const obsolete = group.slice(0, -1).map(item => item.row.id);
        removed += deleteEventsById(this.db, obsolete);
        groupCount += 1;
      }
    })();
    return { groups: groupCount, removed };
  }

  finalAssistantText(turnId: string): string {
    const order = this.events.usesSequence ? 'sequence' : 'rowid';
    const rows = this.db
      .prepare(`SELECT type, data FROM events WHERE turn_id = ? ORDER BY ${order} ASC`)
      .all(turnId) as Array<{ type: string; data: string }>;
    const parts: string[] = [];
    for (const row of rows) {
      try {
        const stored = this.events.decode(row.data);
        const display = stored.__gian_event === 2
          ? parseDisplay(stored.display)
          : legacyDisplay(row.type, stored);
        if (display?.type === 'message' && typeof display.data.text === 'string' && display.data.text) {
          parts.push(display.data.text);
        }
      } catch {
        // Historical corruption should not block turn completion.
      }
    }
    return parts.join('');
  }

  assistantTranscript(sessionId: string): string {
    const order = this.events.usesSequence ? 'sequence' : 'rowid';
    const rows = this.db
      .prepare(`SELECT type, data FROM events WHERE session_id = ? ORDER BY ${order} ASC`)
      .all(sessionId) as Array<{ type: string; data: string }>;
    const parts: string[] = [];
    for (const row of rows) {
      try {
        const stored = this.events.decode(row.data);
        const display = stored.__gian_event === 2
          ? parseDisplay(stored.display)
          : legacyDisplay(row.type, stored);
        if (display?.type !== 'message') continue;
        const text = String(display.data.text ?? '');
        if (text) parts.push(text);
      } catch {
        // Summarization is best-effort and tolerates malformed history rows.
      }
    }
    return parts.join('');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isExecutor(value: unknown): value is 'claude' | 'codex' | 'kimi' {
  return value === 'claude' || value === 'codex' || value === 'kimi';
}

const SQLITE_UTC_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/;

/** SQLite's datetime('now') is UTC but omits a timezone suffix. V8 parses
 *  that shape as local time, shifting restored transcript timestamps by the
 *  machine's UTC offset. Preserve explicit offsets and treat only the legacy
 *  offset-less SQLite shape as UTC. */
function parseStoredEventTimestamp(createdAt: string): number {
  const normalized = SQLITE_UTC_TIMESTAMP_RE.test(createdAt)
    ? `${createdAt.replace(' ', 'T')}Z`
    : createdAt;
  return Date.parse(normalized);
}

function synthesizeTerminalBoundaries(
  sessionId: string,
  turns: StoredTurnPageRow[],
  events: EventEnvelope[],
): EventEnvelope[] {
  const eventsByTurn = new Map<number, EventEnvelope[]>();
  for (const event of events) {
    const list = eventsByTurn.get(event.turn) ?? [];
    list.push(event);
    eventsByTurn.set(event.turn, list);
  }

  const out: EventEnvelope[] = [];
  for (const turn of [...turns].sort((left, right) => left.turn_number - right.turn_number)) {
    const turnEvents = eventsByTurn.get(turn.turn_number) ?? [];
    if (!TERMINAL_TURN_STATUSES.has(turn.status)) {
      out.push(...turnEvents);
      continue;
    }

    // Legacy/provider histories can contain an early completion followed by
    // late tool output, or multiple completion notifications for one turn.
    // Hydration must always expose one terminal boundary at the physical end
    // of the logical turn. Prefer the latest provider-owned boundary over a
    // Gian fallback so provider summaries/metadata survive canonicalization.
    const boundaries = turnEvents.filter(
      event => event.display?.type === 'state.turn-completed',
    );
    const content = turnEvents.filter(
      event => event.display?.type !== 'state.turn-completed',
    );
    out.push(...content);

    const completedAt = turn.completed_at == null
      ? Number.NaN
      : parseStoredEventTimestamp(turn.completed_at);
    const createdAt = parseStoredEventTimestamp(turn.created_at);
    const lastEventAt = content.reduce<number | undefined>(
      (latest, event) => latest === undefined ? event.ts : Math.max(latest, event.ts),
      undefined,
    );
    const providerBoundary = [...boundaries].reverse().find(
      event => event.event === 'turn.completed' || event.event === 'turn_completed',
    );
    const retained = providerBoundary ?? boundaries[boundaries.length - 1];
    const retainedAt = retained?.ts;
    const baseTimestamp = Number.isFinite(retainedAt)
      ? retainedAt!
      : (Number.isFinite(completedAt) ? completedAt : (lastEventAt ?? createdAt));
    const ts = Math.max(baseTimestamp, lastEventAt ?? Number.NEGATIVE_INFINITY);
    out.push(retained
      ? { ...retained, ts }
      : {
          session_id: sessionId,
          turn: turn.turn_number,
          call_id: `gian:turn-completed:${turn.id}`,
          event: 'gian.turn.completed',
          ts,
          data: {},
          display: {
            type: 'state.turn-completed',
            data: { turnId: turn.id },
          },
        });
  }
  return out;
}

function deleteEventsById(db: Db, eventIds: string[]): number {
  let removed = 0;
  for (let start = 0; start < eventIds.length; start += EVENT_DELETE_BATCH_SIZE) {
    const batch = eventIds.slice(start, start + EVENT_DELETE_BATCH_SIZE);
    const placeholders = batch.map(() => '?').join(', ');
    removed += db.prepare(`DELETE FROM events WHERE id IN (${placeholders})`).run(...batch).changes;
  }
  return removed;
}

function eventEnvelope(
  events: EventStore,
  sessionId: string,
  row: StoredEventRow,
  includeRaw: boolean,
): EventEnvelope {
  const stored = events.decode(
    row.data,
    includeRaw ? undefined : { skipPaths: PAGED_HISTORY_SKIPPED_PATHS },
  );
  const isNative = stored.__gian_event === 2;
  const raw = isNative && isRecord(stored.raw) ? stored.raw : stored;
  const display = isNative
    ? parseDisplay(stored.display)
    : legacyDisplay(row.type, stored);
  return {
    session_id: sessionId,
    turn: row.turn_number ?? 0,
    call_id: row.call_id,
    event: row.type,
    ts: parseStoredEventTimestamp(row.created_at),
    // Paginated transcript hydration consumes the display projection only.
    // Keep native payloads in the DB and in internal listEvents() callers,
    // but do not duplicate multi-megabyte diffs/tool output over HTTP.
    data: includeRaw || !display ? raw : {},
    ...(isNative && isExecutor(stored.provider) ? { provider: stored.provider } : {}),
    ...(display ? { display } : {}),
  };
}

const PAGED_HISTORY_SKIPPED_PATHS = new Set(['raw']);

/** Collapse streaming fragments after DB replay so the browser hydrates cards, not tokens. */
export function compactHistoryEnvelopes(events: EventEnvelope[]): EventEnvelope[] {
  const out: Array<EventEnvelope | undefined> = [];
  const compacted = new Map<string, number>();
  for (const event of events) {
    const display = event.display;
    if (!display || !isCompactableEvent(event)) {
      out.push(event);
      continue;
    }
    const key = streamIdentity(event);
    if (!key) {
      out.push(event);
      continue;
    }
    const existingIndex = compacted.get(key);
    if (existingIndex === undefined) {
      compacted.set(key, out.length);
      out.push(event);
      continue;
    }
    const existing = out[existingIndex]!;
    const previousData = existing.display?.data as unknown as Record<string, unknown> | undefined;
    const currentData = display.data as unknown as Record<string, unknown>;
    if (!previousData) {
      out.push(event);
      continue;
    }

    let nextData: Record<string, unknown>;
    if (display.type === 'message') {
      nextData = {
        ...previousData,
        ...currentData,
        text: currentData.delta === false
          ? String(currentData.text ?? '')
          : String(previousData.text ?? '') + String(currentData.text ?? ''),
        delta: false,
      };
    } else if (display.type === 'activity.reasoning') {
      nextData = {
        ...previousData,
        ...currentData,
        text: currentData.delta === false
          ? String(currentData.text ?? '')
          : String(previousData.text ?? '') + String(currentData.text ?? ''),
        delta: false,
      };
    } else if (display.type === 'activity.command') {
      const previousOutput = String(previousData.stdout ?? previousData.stdoutDelta ?? '');
      const nextOutput = currentData.stdout !== undefined
        ? String(currentData.stdout)
        : previousOutput + String(currentData.stdoutDelta ?? '');
      nextData = { ...previousData, ...currentData, stdout: nextOutput };
      delete nextData.stdoutDelta;
    } else {
      const replace = event.event === 'acp.sessionUpdate' || currentData.delta === false;
      nextData = {
        ...previousData,
        ...currentData,
        text: replace
          ? String(currentData.text ?? '')
          : String(previousData.text ?? '') + String(currentData.text ?? ''),
        delta: false,
      };
    }
    // The persisted compactor retains the newest physical row. Move the
    // canonical projection to that same sequence position, but retain the
    // first fragment timestamp just like the live reducer does.
    out[existingIndex] = undefined;
    compacted.set(key, out.length);
    out.push({
      ...existing,
      data: event.data,
      display: { type: display.type, data: nextData } as unknown as ChatDisplay,
    });
  }
  return out.filter((event): event is EventEnvelope => event !== undefined);
}

/** Stable logical identity shared by persisted and in-memory stream compaction. */
function streamIdentity(event: EventEnvelope): string | null {
  const display = event.display;
  if (!display || !isCompactableEvent(event)) return null;
  const data = display.data as unknown as Record<string, unknown>;
  const variant = display.type === 'activity.reasoning'
    ? (data.kind === 'summary' ? 'summary' : 'full')
    : '';
  return `${event.turn}\u0000${display.type}\u0000${event.call_id}\u0000${variant}`;
}

export function canonicalizeHistoryEnvelopes(events: EventEnvelope[]): EventEnvelope[] {
  const retained: EventEnvelope[] = [];
  const seenSnapshots = new Set<string>();
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (!event) continue;
    const identity = snapshotIdentity(event);
    if (identity) {
      if (seenSnapshots.has(identity)) continue;
      seenSnapshots.add(identity);
    }
    retained.push(event);
  }
  retained.reverse();
  return compactHistoryEnvelopes(retained);
}

export function snapshotIdentity(event: EventEnvelope): string | null {
  if (event.event === 'diff.updated') return `${event.turn}\u0000diff.updated`;
  if (event.event === 'codex.agent') {
    const displayData = event.display?.data as unknown as Record<string, unknown> | undefined;
    const id = stringValue(displayData?.agentId) ?? stringValue(displayData?.itemId) ?? event.call_id;
    return id ? `${event.turn}\u0000codex.agent\u0000${id}` : null;
  }
  if (event.event !== 'acp.sessionUpdate') return null;
  const update = isRecord(event.data.update) ? event.data.update : null;
  const rawUpdate = isRecord(event.data.raw) && isRecord(event.data.raw.update)
    ? event.data.raw.update
    : null;
  const kind = stringValue(rawUpdate?.sessionUpdate) ?? stringValue(update?.sessionUpdate);
  if (kind !== 'tool_call' && kind !== 'tool_call_update') return null;
  const displayData = event.display?.data as unknown as Record<string, unknown> | undefined;
  const id = stringValue(rawUpdate?.toolCallId)
    ?? stringValue(update?.toolCallId)
    ?? stringValue(displayData?.itemId);
  return id ? `${event.turn}\u0000acp.tool\u0000${id}` : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isCompactableEvent(event: EventEnvelope): boolean {
  const display = event.display;
  if (!display || !isCompactableDisplay(display.type)) return false;
  if (display.type !== 'message') return true;
  const data = display.data as unknown as Record<string, unknown>;
  return event.event !== 'user_message' && data.role !== 'user';
}

function isCompactableDisplay(type: DisplayEventType): boolean {
  return type === 'message'
    || type === 'activity.reasoning'
    || type === 'activity.command'
    || type === 'plan';
}

function parseDisplay(value: unknown): ChatDisplay | undefined {
  if (!isRecord(value) || typeof value.type !== 'string' || !isRecord(value.data)) return undefined;
  return { type: value.type as DisplayEventType, data: value.data } as unknown as ChatDisplay;
}

/** Read-only bridge for rows written before native events became the source of truth. */
function legacyDisplay(type: string, data: Record<string, unknown>): ChatDisplay | undefined {
  const mapped: DisplayEventType | undefined = ({
    assistant_text: 'message',
    reasoning: 'activity.reasoning',
    plan_update: 'plan',
    command_execution: 'activity.command',
    file_change: 'activity.file-change',
    file_read: 'activity.file-read',
    file_search: 'activity.file-search',
    web_search: 'activity.web-search',
    tool_execution: 'activity.tool',
    agent_spawn: 'agent',
    approval_requested: data.category === 'question' ? 'interaction.question' : 'interaction.approval',
    approval_resolved: 'interaction.resolved',
    auto_classifier_denied: 'activity.classifier-denied',
    auto_circuit_breaker: 'activity.circuit-breaker',
    turn_started: 'state.turn-started',
    turn_completed: 'state.turn-completed',
    'state.turn-completed': 'state.turn-completed',
    session_error: 'state.error',
    'output.text': 'message',
    'output.text.delta': 'message',
  } as Record<string, DisplayEventType | undefined>)[type];
  return mapped ? { type: mapped, data } as unknown as ChatDisplay : undefined;
}
