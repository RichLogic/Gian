import { randomUUID } from 'node:crypto';
import {
  normalizeComposerDocument,
  type ComposerDocument,
  type InputItem,
  type MessageContextItem,
} from '@gian/shared';
import type { Db } from '../storage/db.js';

export interface QueueEntry {
  id: string;
  sessionId: string;
  text: string;
  /** Structured input items (e.g. localImage attachments) carried with the
   *  message — drained entries pass them straight to sendMessage. */
  items?: InputItem[];
  contextItems?: MessageContextItem[];
  composerDocument?: ComposerDocument;
  toolRequestId?: string;
  createdAt: number;
}

interface QueueRow {
  id: string;
  session_id: string;
  text: string;
  items_json: string | null;
  context_items_json: string | null;
  composer_document_json: string | null;
  sort_order: number;
  created_at: string;
  tool_request_id: string | null;
}

function rowToEntry(row: QueueRow): QueueEntry {
  let items: InputItem[] | undefined;
  let contextItems: MessageContextItem[] | undefined;
  let composerDocument: ComposerDocument | undefined;
  if (row.items_json) {
    try {
      const parsed = JSON.parse(row.items_json) as unknown;
      if (Array.isArray(parsed)) items = parsed as InputItem[];
    } catch {
      // Corrupt payload — degrade to text-only rather than losing the entry.
    }
  }
  if (row.context_items_json) {
    try {
      const parsed = JSON.parse(row.context_items_json) as unknown;
      if (Array.isArray(parsed)) contextItems = parsed as MessageContextItem[];
    } catch {
      // Corrupt payload - preserve the rest of the queued message.
    }
  }
  if (row.composer_document_json) {
    try {
      composerDocument = normalizeComposerDocument(JSON.parse(row.composer_document_json)) ?? undefined;
    } catch {
      // Corrupt document - preserve the legacy text/resources fallback.
    }
  }
  return {
    id: row.id,
    sessionId: row.session_id,
    text: row.text,
    ...(items ? { items } : {}),
    ...(contextItems ? { contextItems } : {}),
    ...(composerDocument ? { composerDocument } : {}),
    ...(row.tool_request_id ? { toolRequestId: row.tool_request_id } : {}),
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

  add(
    sessionId: string,
    text: string,
    items?: InputItem[],
    options: {
      id?: string;
      toolRequestId?: string;
      contextItems?: MessageContextItem[];
      composerDocument?: ComposerDocument;
    } = {},
  ): QueueEntry {
    const id = options.id ?? randomUUID();
    const now = new Date().toISOString();
    const maxRow = this.db
      .prepare('SELECT MAX(sort_order) AS m FROM queue_entries WHERE session_id = ?')
      .get(sessionId) as { m: number | null };
    const sortOrder = (maxRow.m ?? -1) + 1;
    const itemsJson = items && items.length > 0 ? JSON.stringify(items) : null;
    const contextItemsJson = options.contextItems && options.contextItems.length > 0
      ? JSON.stringify(options.contextItems)
      : null;
    const composerDocumentJson = options.composerDocument
      ? JSON.stringify(options.composerDocument)
      : null;
    this.db
      .prepare(
        `INSERT INTO queue_entries
          (id, session_id, text, items_json, context_items_json, composer_document_json,
           sort_order, created_at, tool_request_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        sessionId,
        text,
        itemsJson,
        contextItemsJson,
        composerDocumentJson,
        sortOrder,
        now,
        options.toolRequestId ?? null,
      );
    return rowToEntry({
      id,
      session_id: sessionId,
      text,
      items_json: itemsJson,
      context_items_json: contextItemsJson,
      composer_document_json: composerDocumentJson,
      sort_order: sortOrder,
      created_at: now,
      tool_request_id: options.toolRequestId ?? null,
    });
  }

  list(sessionId: string): QueueEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM queue_entries WHERE session_id = ? ORDER BY sort_order ASC')
      .all(sessionId) as QueueRow[];
    return rows.map(rowToEntry);
  }

  findByToolRequest(toolRequestId: string): QueueEntry | null {
    const row = this.db.prepare('SELECT * FROM queue_entries WHERE tool_request_id = ?')
      .get(toolRequestId) as QueueRow | undefined;
    return row ? rowToEntry(row) : null;
  }

  remove(sessionId: string, queueId: string): boolean {
    return this.db
      .prepare('DELETE FROM queue_entries WHERE session_id = ? AND id = ?')
      .run(sessionId, queueId).changes > 0;
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
