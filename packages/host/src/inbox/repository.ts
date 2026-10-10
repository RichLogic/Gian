import type { InboxSourceKind, InboxStatus } from '@gian/shared';
import type { Db } from '../storage/db.js';

export interface InboxRow {
  id: string;
  source_key: string;
  source_kind: InboxSourceKind;
  status: InboxStatus;
  generation: number;
  revision: number;
  read_at: string | null;
  read_generation: number | null;
  notified_generation: number | null;
  title: string;
  summary: string;
  target_json: string;
  display_json: string;
  candidate_version: string | null;
  candidate_channel: string | null;
  skipped_version: string | null;
  skipped_channel: string | null;
  source_epoch: number | null;
  /** 1 when this generation's display is an unfilled safe tombstone. */
  tombstone: number;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export type InboxListFilter = 'pending' | 'closed' | 'all';

export interface InboxCursor {
  updated_at: string;
  id: string;
}

const COLUMNS = `
  id, source_key, source_kind, status, generation, revision,
  read_at, read_generation, notified_generation, title, summary,
  target_json, display_json, candidate_version, candidate_channel,
  skipped_version, skipped_channel, source_epoch, tombstone, created_at, updated_at, closed_at
`;

export class InboxRepository {
  constructor(private readonly db: Db) {}

  revision(): number {
    const row = this.db.prepare('SELECT revision FROM inbox_meta WHERE id = 1').get() as { revision: number };
    return row.revision;
  }

  collectionRevision(): number {
    const row = this.db.prepare(
      'SELECT collection_revision FROM inbox_meta WHERE id = 1',
    ).get() as { collection_revision: number };
    return row.collection_revision;
  }

  bumpRevision(): number {
    this.db.prepare(
      `UPDATE inbox_meta
       SET revision = revision + 1, collection_revision = collection_revision + 1
       WHERE id = 1`,
    ).run();
    return this.revision();
  }

  bumpCollectionRevision(): number {
    this.db.prepare(
      'UPDATE inbox_meta SET collection_revision = collection_revision + 1 WHERE id = 1',
    ).run();
    return this.collectionRevision();
  }

  getById(id: string): InboxRow | null {
    return this.one('SELECT ' + COLUMNS + ' FROM inbox_items WHERE id = ?', id);
  }

  getBySourceKey(sourceKey: string): InboxRow | null {
    return this.one('SELECT ' + COLUMNS + ' FROM inbox_items WHERE source_key = ?', sourceKey);
  }

  pendingCount(): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) AS n FROM inbox_items WHERE status = 'pending'`,
    ).get() as { n: number };
    return row.n;
  }

  listPending(limit: number): InboxRow[] {
    return this.db.prepare(
      `SELECT ${COLUMNS} FROM inbox_items WHERE status = 'pending'
       ORDER BY updated_at DESC, id DESC LIMIT ?`,
    ).all(limit) as InboxRow[];
  }

  listPendingAll(): InboxRow[] {
    return this.db.prepare(
      `SELECT ${COLUMNS} FROM inbox_items WHERE status = 'pending'
       ORDER BY updated_at DESC, id DESC`,
    ).all() as InboxRow[];
  }

  list(filter: InboxListFilter, cursor: InboxCursor | null, limit: number): InboxRow[] {
    const statusClause = filter === 'pending'
      ? `status = 'pending'`
      : filter === 'closed'
        ? `status != 'pending'`
        : '1 = 1';
    return this.db.prepare(
      `SELECT ${COLUMNS} FROM inbox_items
       WHERE ${statusClause}
         AND (? IS NULL OR updated_at < ? OR (updated_at = ? AND id < ?))
       ORDER BY updated_at DESC, id DESC
       LIMIT ?`,
    ).all(
      cursor?.updated_at ?? null,
      cursor?.updated_at ?? null,
      cursor?.updated_at ?? null,
      cursor?.id ?? null,
      limit,
    ) as InboxRow[];
  }

  insert(row: InboxRow): void {
    this.db.prepare(
      `INSERT INTO inbox_items (
         id, source_key, source_kind, status, generation, revision,
         read_at, read_generation, notified_generation, title, summary,
         target_json, display_json, candidate_version, candidate_channel,
         skipped_version, skipped_channel, source_epoch, tombstone, created_at, updated_at, closed_at
       ) VALUES (
         @id, @source_key, @source_kind, @status, @generation, @revision,
         @read_at, @read_generation, @notified_generation, @title, @summary,
         @target_json, @display_json, @candidate_version, @candidate_channel,
         @skipped_version, @skipped_channel, @source_epoch, @tombstone, @created_at, @updated_at, @closed_at
       )`,
    ).run(row);
  }

  save(row: InboxRow): void {
    const result = this.db.prepare(
      `UPDATE inbox_items SET
         status = @status,
         generation = @generation,
         revision = @revision,
         read_at = @read_at,
         read_generation = @read_generation,
         notified_generation = @notified_generation,
         title = @title,
         summary = @summary,
         target_json = @target_json,
         display_json = @display_json,
         candidate_version = @candidate_version,
         candidate_channel = @candidate_channel,
         skipped_version = @skipped_version,
         skipped_channel = @skipped_channel,
         source_epoch = @source_epoch,
         tombstone = @tombstone,
         updated_at = @updated_at,
         closed_at = @closed_at
       WHERE id = @id AND source_key = @source_key`,
    ).run(row);
    if (result.changes !== 1) throw new Error(`inbox row disappeared: ${row.id}`);
  }

  /**
   * Record a producer epoch that did not change the public row.
   * The list revision, timestamps, and display stay as they were.
   * The collection fence moves so an in-flight snapshot cannot pass it.
   */
  rememberEpoch(id: string, epoch: number): void {
    const result = this.db.prepare(
      `UPDATE inbox_items
       SET source_epoch = ?
       WHERE id = ? AND (source_epoch IS NULL OR source_epoch < ?)`,
    ).run(epoch, id, epoch);
    if (result.changes !== 1) throw new Error(`inbox epoch was not recorded: ${id}`);
    this.bumpCollectionRevision();
  }

  /** The same-generation open confirmed the placeholder. No public field changes. */
  clearTombstone(id: string): void {
    const result = this.db.prepare(
      'UPDATE inbox_items SET tombstone = 0 WHERE id = ? AND tombstone = 1',
    ).run(id);
    if (result.changes !== 1) throw new Error(`inbox tombstone was not cleared: ${id}`);
  }

  private one(sql: string, id: string): InboxRow | null {
    return (this.db.prepare(sql).get(id) as InboxRow | undefined) ?? null;
  }
}
