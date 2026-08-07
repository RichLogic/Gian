import type { ChatDisplay, DisplayEventType, EventEnvelope } from '@gian/shared';
import type { Db } from '../storage/db.js';
import { EventStore, type PersistEventResult } from './event-store.js';

interface StoredEventRow {
  id: string;
  session_id: string;
  call_id: string;
  type: string;
  data: string;
  created_at: string;
  turn_number: number | null;
}

export interface EventHistoryPage {
  events: EventEnvelope[];
  nextCursor: number | null;
  hasMore: boolean;
}

export class SessionHistoryStore {
  private events: EventStore;

  constructor(private db: Db) {
    this.events = new EventStore(db);
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
        `SELECT id, turn_number
         FROM turns
         WHERE session_id = ? AND (? IS NULL OR turn_number < ?)
         ORDER BY turn_number DESC
         LIMIT ?`,
      )
      .all(sessionId, beforeTurn, beforeTurn, limit + 1) as Array<{
        id: string;
        turn_number: number;
      }>;
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
    return {
      events: compactHistoryEnvelopes(
        rows.map(row => eventEnvelope(this.events, sessionId, row, false)),
      ),
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

  /** Merge safe streaming fragments once a turn is terminal. */
  compactTurnStreams(turnId: string): number {
    // Existing Gian databases remain read-only until the packaged migration is
    // explicitly run. Automatic compaction is enabled only by that schema.
    if (!this.events.usesSequence) return 0;
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
      const display = event.display;
      if (!display || !isCompactableDisplay(display.type)) continue;
      const key = `${display.type}\u0000${event.call_id}`;
      const group = groups.get(key) ?? [];
      group.push({ row, event });
      groups.set(key, group);
    }

    let removed = 0;
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
        const obsolete = group.slice(0, -1).map(item => item.row.id);
        const placeholders = obsolete.map(() => '?').join(', ');
        this.db.prepare(`DELETE FROM events WHERE id IN (${placeholders})`).run(...obsolete);
        removed += obsolete.length;
      }
    })();
    return removed;
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
    ts: Date.parse(row.created_at),
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
function compactHistoryEnvelopes(events: EventEnvelope[]): EventEnvelope[] {
  const out: EventEnvelope[] = [];
  const compacted = new Map<string, number>();
  for (const event of events) {
    const display = event.display;
    if (!display || !isCompactableDisplay(display.type)) {
      out.push(event);
      continue;
    }
    const key = `${event.turn}\u0000${display.type}\u0000${event.call_id}`;
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
    out[existingIndex] = {
      ...existing,
      ts: event.ts,
      data: event.data,
      display: { type: display.type, data: nextData } as unknown as ChatDisplay,
    };
  }
  return out;
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
    session_error: 'state.error',
    'output.text': 'message',
    'output.text.delta': 'message',
  } as Record<string, DisplayEventType | undefined>)[type];
  return mapped ? { type: mapped, data } as unknown as ChatDisplay : undefined;
}
