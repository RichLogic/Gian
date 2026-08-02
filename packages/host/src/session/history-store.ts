import type { ChatDisplay, DisplayEventType, EventEnvelope } from '@gian/shared';
import { randomUUID } from 'node:crypto';
import type { Db } from '../storage/db.js';

export class SessionHistoryStore {
  constructor(private db: Db) {}

  listEvents(sessionId: string): EventEnvelope[] {
    const rows = this.db
      .prepare(
        `SELECT e.call_id, e.type, e.data, e.created_at, t.turn_number
         FROM events e
         LEFT JOIN turns t ON t.id = e.turn_id
         WHERE e.session_id = ?
         ORDER BY e.rowid ASC`,
      )
      .all(sessionId) as Array<{
        call_id: string;
        type: string;
        data: string;
        created_at: string;
        turn_number: number | null;
      }>;
    return rows.map(row => {
      const stored = parseObject(row.data);
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
        data: raw,
        ...(isNative && isExecutor(stored.provider) ? { provider: stored.provider } : {}),
        ...(display ? { display } : {}),
      };
    });
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
  ): void {
    this.db
      .prepare(
        `INSERT INTO events (id, session_id, turn_id, call_id, type, data)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(randomUUID(), sessionId, turnId, callId, type, JSON.stringify(data));
  }

  finalAssistantText(turnId: string): string {
    const rows = this.db
      .prepare('SELECT type, data FROM events WHERE turn_id = ? ORDER BY rowid ASC')
      .all(turnId) as Array<{ type: string; data: string }>;
    const parts: string[] = [];
    for (const row of rows) {
      try {
        const stored = parseObject(row.data);
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
    const rows = this.db
      .prepare('SELECT type, data FROM events WHERE session_id = ? ORDER BY rowid ASC')
      .all(sessionId) as Array<{ type: string; data: string }>;
    const parts: string[] = [];
    for (const row of rows) {
      try {
        const stored = parseObject(row.data);
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

function parseObject(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isExecutor(value: unknown): value is 'claude' | 'codex' | 'kimi' {
  return value === 'claude' || value === 'codex' || value === 'kimi';
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
