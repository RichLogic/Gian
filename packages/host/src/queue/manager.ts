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

export class QueueRevisionConflict extends Error {
  readonly code = 'PRECONDITION_FAILED' as const;

  constructor(
    readonly revision: string,
    readonly queue: QueueEntry[],
  ) {
    super('queue revision mismatch');
    this.name = 'QueueRevisionConflict';
  }
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
 *
 * Every mutation advances sessions.queue_revision in the same transaction.
 */
export class QueueManager {
  constructor(private db: Db) {}

  getRevision(sessionId: string): string {
    return String(this.revisionNumber(sessionId));
  }

  list(sessionId: string): QueueEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM queue_entries WHERE session_id = ? ORDER BY sort_order ASC')
      .all(sessionId) as QueueRow[];
    return rows.map(rowToEntry);
  }

  get(sessionId: string, queueId: string): QueueEntry | null {
    const row = this.db
      .prepare('SELECT * FROM queue_entries WHERE session_id = ? AND id = ?')
      .get(sessionId, queueId) as QueueRow | undefined;
    return row ? rowToEntry(row) : null;
  }

  findByToolRequest(toolRequestId: string): QueueEntry | null {
    const row = this.db.prepare('SELECT * FROM queue_entries WHERE tool_request_id = ?')
      .get(toolRequestId) as QueueRow | undefined;
    return row ? rowToEntry(row) : null;
  }

  add(
    sessionId: string,
    text: string,
    items?: InputItem[],
    options: {
      id?: string;
      toolRequestId?: string;
      contextItems?: MessageContextItem[];
      composerDocument?: ComposerDocument;
      expectedRevision?: string;
    } = {},
  ): QueueEntry {
    return this.mutate(sessionId, options.expectedRevision, () => this.insert(sessionId, text, items, options));
  }

  restore(sessionId: string, entries: QueueEntry[], expectedRevision?: string): QueueEntry[] {
    return this.mutate(sessionId, expectedRevision, () => (
      entries.map(entry => this.insert(sessionId, entry.text, entry.items, {
        id: entry.id,
        toolRequestId: entry.toolRequestId,
        contextItems: entry.contextItems,
        composerDocument: entry.composerDocument,
        createdAt: entry.createdAt,
      }))
    ));
  }

  remove(sessionId: string, queueId: string, expectedRevision?: string): QueueEntry | null {
    return this.mutate(sessionId, expectedRevision, () => {
      const current = this.get(sessionId, queueId);
      if (!current) return null;
      this.db.prepare('DELETE FROM queue_entries WHERE session_id = ? AND id = ?').run(sessionId, queueId);
      return current;
    }, result => result !== null);
  }

  /** Update an entry's text in place — its position (sort_order) is kept. */
  update(sessionId: string, queueId: string, text: string, expectedRevision?: string): QueueEntry | null {
    return this.mutate(sessionId, expectedRevision, () => {
      const current = this.get(sessionId, queueId);
      if (!current) return null;
      this.db.prepare('UPDATE queue_entries SET text = ? WHERE session_id = ? AND id = ?')
        .run(text, sessionId, queueId);
      return { ...current, text };
    }, result => result !== null);
  }

  clear(sessionId: string, expectedRevision?: string): QueueEntry[] {
    return this.mutate(sessionId, expectedRevision, () => {
      const current = this.list(sessionId);
      this.db.prepare('DELETE FROM queue_entries WHERE session_id = ?').run(sessionId);
      return current;
    });
  }

  /** Pop the entry with the lowest sort_order, delete it, and return it. */
  popNext(sessionId: string, expectedRevision?: string): QueueEntry | null {
    return this.mutate(sessionId, expectedRevision, () => {
      const row = this.db
        .prepare(
          'SELECT * FROM queue_entries WHERE session_id = ? ORDER BY sort_order ASC LIMIT 1',
        )
        .get(sessionId) as QueueRow | undefined;
      if (!row) return null;
      this.db.prepare('DELETE FROM queue_entries WHERE id = ?').run(row.id);
      return rowToEntry(row);
    }, result => result !== null);
  }

  /** Pop ALL entries in order, clear the queue, return drained list. */
  sendNow(sessionId: string, expectedRevision?: string): QueueEntry[] {
    return this.mutate(sessionId, expectedRevision, () => {
      const rows = this.db
        .prepare('SELECT * FROM queue_entries WHERE session_id = ? ORDER BY sort_order ASC')
        .all(sessionId) as QueueRow[];
      this.db.prepare('DELETE FROM queue_entries WHERE session_id = ?').run(sessionId);
      return rows.map(rowToEntry);
    }, result => result.length > 0);
  }

  private mutate<T>(
    sessionId: string,
    expected: string | undefined,
    fn: () => T,
    shouldBump: boolean | ((result: T) => boolean) = true,
  ): T {
    return this.db.transaction(() => {
      const current = this.getRevision(sessionId);
      if (expected !== undefined && expected !== current) {
        throw new QueueRevisionConflict(current, this.list(sessionId));
      }
      const result = fn();
      const bump = typeof shouldBump === 'function' ? shouldBump(result) : shouldBump;
      if (bump) {
        this.db.prepare(
          'UPDATE sessions SET queue_revision = queue_revision + 1 WHERE id = ?',
        ).run(sessionId);
      }
      return result;
    })();
  }

  private revisionNumber(sessionId: string): number {
    const row = this.db.prepare('SELECT queue_revision FROM sessions WHERE id = ?')
      .get(sessionId) as { queue_revision: number } | undefined;
    return row?.queue_revision ?? 0;
  }

  private insert(
    sessionId: string,
    text: string,
    items: InputItem[] | undefined,
    options: {
      id?: string;
      toolRequestId?: string;
      contextItems?: MessageContextItem[];
      composerDocument?: ComposerDocument;
      createdAt?: number;
    },
  ): QueueEntry {
    const id = options.id ?? randomUUID();
    const now = options.createdAt ? new Date(options.createdAt).toISOString() : new Date().toISOString();
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
}
