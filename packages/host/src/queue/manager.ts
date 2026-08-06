import { randomUUID } from 'node:crypto';
import type { InputItem } from '@gian/shared';
import type { Db } from '../storage/db.js';

export interface QueueEntry {
  id: string;
  sessionId: string;
  text: string;
  /** Structured input items (e.g. localImage attachments) carried with the
   *  message — drained entries pass them straight to sendMessage. */
  items?: InputItem[];
  createdAt: number;
}

interface QueueRow {
  id: string;
  session_id: string;
  text: string;
  items_json: string | null;
  sort_order: number;
  created_at: string;
}

function rowToEntry(row: QueueRow): QueueEntry {
  let items: InputItem[] | undefined;
  if (row.items_json) {
    try {
      const parsed = JSON.parse(row.items_json) as unknown;
      if (Array.isArray(parsed)) items = parsed as InputItem[];
    } catch {
      // Corrupt payload — degrade to text-only rather than losing the entry.
    }
  }
  return {
    id: row.id,
    sessionId: row.session_id,
    text: row.text,
    ...(items ? { items } : {}),
    createdAt: Date.parse(row.created_at),
  };
}

/**
 * Per-session message queue backed by SQLite (queue_entries table).
 *
 * sort_order is assigned as MAX(sort_order)+1 on insert, so newly added
 * entries always tail the queue. popNext reads the lowest sort_order. Entry
 * text is editable in place (`update`); changing position is not supported —
 * the UI has no reorder control (2026-08-05).
 */
export class QueueManager {
  constructor(private db: Db) {}

  add(sessionId: string, text: string, items?: InputItem[]): QueueEntry {
    const id = randomUUID();
    const now = new Date().toISOString();
    const maxRow = this.db
      .prepare('SELECT MAX(sort_order) AS m FROM queue_entries WHERE session_id = ?')
      .get(sessionId) as { m: number | null };
    const sortOrder = (maxRow.m ?? -1) + 1;
    const itemsJson = items && items.length > 0 ? JSON.stringify(items) : null;
    this.db
      .prepare(
        `INSERT INTO queue_entries (id, session_id, text, items_json, sort_order, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, sessionId, text, itemsJson, sortOrder, now);
    return rowToEntry({ id, session_id: sessionId, text, items_json: itemsJson, sort_order: sortOrder, created_at: now });
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

  /** Update an entry's text in place — its position (sort_order) is kept. */
  update(sessionId: string, queueId: string, text: string): void {
    this.db
      .prepare('UPDATE queue_entries SET text = ? WHERE session_id = ? AND id = ?')
      .run(text, sessionId, queueId);
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
