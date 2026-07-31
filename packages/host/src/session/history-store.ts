import type { EventEnvelope } from '@gian/shared';
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
    return rows.map(row => ({
      session_id: sessionId,
      turn: row.turn_number ?? 0,
      call_id: row.call_id,
      event: row.type,
      ts: Date.parse(row.created_at),
      data: JSON.parse(row.data) as Record<string, unknown>,
    }));
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
      .prepare(
        `SELECT data FROM events
         WHERE turn_id = ? AND type IN ('assistant_text','output.text')
         ORDER BY rowid ASC`,
      )
      .all(turnId) as Array<{ data: string }>;
    const parts: string[] = [];
    for (const row of rows) {
      try {
        const data = JSON.parse(row.data) as Record<string, unknown>;
        if (typeof data.text === 'string' && data.text) parts.push(data.text);
      } catch {
        // Historical corruption should not block turn completion.
      }
    }
    return parts.join('');
  }

  assistantTranscript(sessionId: string): string {
    const rows = this.db
      .prepare(
        `SELECT data FROM events
         WHERE session_id = ? AND type = 'assistant_text'
         ORDER BY rowid ASC`,
      )
      .all(sessionId) as Array<{ data: string }>;
    const parts: string[] = [];
    for (const row of rows) {
      try {
        const data = JSON.parse(row.data) as Record<string, unknown>;
        const text = String(data.text ?? data.delta ?? '');
        if (text) parts.push(text);
      } catch {
        // Summarization is best-effort and tolerates malformed history rows.
      }
    }
    return parts.join('');
  }
}
