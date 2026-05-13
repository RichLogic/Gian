import { randomUUID } from 'node:crypto';
import type { Db } from '../storage/db.js';

export interface QueueEntry {
  id: string;
  sessionId: string;
  text: string;
  createdAt: number;
}

interface QueueRow {
  id: string;
  session_id: string;
  text: string;
  sort_order: number;
  created_at: string;
}

function rowToEntry(row: QueueRow): QueueEntry {
  return {
    id: row.id,
    sessionId: row.session_id,
    text: row.text,
    createdAt: Date.parse(row.created_at),
  };
}

/**
 * Per-session message queue backed by SQLite (queue_entries table).
 *
 * sort_order is assigned as MAX(sort_order)+1 on insert, so newly added
 * entries always tail the queue. popNext reads the lowest sort_order, which
 * stays correct even after reorder operations reassign sort_order values
 * sequentially (0, 1, 2…).
 */
export class QueueManager {
  constructor(private db: Db) {}

  add(sessionId: string, text: string): QueueEntry {
    const id = randomUUID();
    const now = new Date().toISOString();
    const maxRow = this.db
      .prepare('SELECT MAX(sort_order) AS m FROM queue_entries WHERE session_id = ?')
      .get(sessionId) as { m: number | null };
    const sortOrder = (maxRow.m ?? -1) + 1;
    this.db
      .prepare(
        `INSERT INTO queue_entries (id, session_id, text, sort_order, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, sessionId, text, sortOrder, now);
    return rowToEntry({ id, session_id: sessionId, text, sort_order: sortOrder, created_at: now });
  }

  list(sessionId: string): QueueEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM queue_entries WHERE session_id = ? ORDER BY sort_order ASC')
      .all(sessionId) as QueueRow[];
    return rows.map(rowToEntry);
  }

  remove(sessionId: string, queueId: string): void {
    this.db
      .prepare('DELETE FROM queue_entries WHERE session_id = ? AND id = ?')
      .run(sessionId, queueId);
  }

  reorder(sessionId: string, orderedIds: string[]): void {
    const update = this.db.prepare(
      'UPDATE queue_entries SET sort_order = ? WHERE session_id = ? AND id = ?',
    );
    this.db.transaction(() => {
      for (let i = 0; i < orderedIds.length; i++) {
        update.run(i, sessionId, orderedIds[i]);
      }
    })();
  }

  clear(sessionId: string): void {
    this.db.prepare('DELETE FROM queue_entries WHERE session_id = ?').run(sessionId);
  }

  /** Pop the entry with the lowest sort_order, delete it, and return it. */
  popNext(sessionId: string): QueueEntry | null {
    const row = this.db
      .prepare(
        'SELECT * FROM queue_entries WHERE session_id = ? ORDER BY sort_order ASC LIMIT 1',
      )
      .get(sessionId) as QueueRow | undefined;
    if (!row) return null;
    this.db.prepare('DELETE FROM queue_entries WHERE id = ?').run(row.id);
    return rowToEntry(row);
  }

  /** Pop ALL entries in order, clear the queue, return drained list. */
  sendNow(sessionId: string): QueueEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM queue_entries WHERE session_id = ? ORDER BY sort_order ASC')
      .all(sessionId) as QueueRow[];
    this.db.prepare('DELETE FROM queue_entries WHERE session_id = ?').run(sessionId);
    return rows.map(rowToEntry);
  }
}
