import { createHash } from 'node:crypto';
import { normalizeSearchText } from '@gian/shared';
import type { Db } from '../storage/db.js';

export const SEARCH_DIRTY_PAGE = 10;
export const SEARCH_SOURCE_PAGE = 40;
export const SEARCH_TURN_PAGE = 5;
export const SEARCH_SCAN_BUDGET = 200;

export interface SearchStateRow {
  schema_version: number;
  index_revision: number;
  backfill_stage: string;
  backfill_cursor: string | null;
  backfill_complete: number;
  fts_mode: string;
  /** 1 while an empty or partial trigram table is being filled. */
  fts_rebuild: number;
  fts_cursor: string | null;
  last_error: string | null;
  agent_marker: string | null;
}

export interface SearchDocumentRow {
  id: string;
  kind: string;
  source_id: string;
  owner_id: string | null;
  workspace_id: string | null;
  group_key: string | null;
  source_revision: string;
  title: string;
  subtitle: string | null;
  search_text: string;
  normalized_text: string;
  normalized_title: string;
  anchor_json: string;
  archived: number;
  sort_turn: number | null;
  sort_pos: number;
  updated_at: string;
}

export interface SearchDocumentInput {
  kind: string;
  sourceId: string;
  ownerId: string | null;
  workspaceId: string | null;
  groupKey: string | null;
  sourceRevision: string;
  title: string;
  subtitle?: string | null;
  searchText: string;
  anchor: unknown;
  archived: boolean;
  sortTurn?: number | null;
  sortPos?: number;
  updatedAt: string;
}

export function documentId(kind: string, sourceId: string): string {
  const digest = createHash('sha256').update(kind).update('\0').update(sourceId).digest('hex');
  return `${kind.slice(0, 1)}:${digest}`;
}

export function textRevision(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function readState(db: Db): SearchStateRow {
  const row = db.prepare('SELECT * FROM search_state WHERE id = 1').get() as SearchStateRow | undefined;
  if (!row) throw new Error('search_state is missing');
  return row;
}

export function probeFts(db: Db): 'trigram' | 'unavailable' {
  try {
    db.exec(
      "CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(document_id UNINDEXED, normalized, tokenize = 'trigram')",
    );
    return 'trigram';
  } catch {
    return 'unavailable';
  }
}

/**
 * One synchronous index mutation. Document rows, FTS rows, dirty cursors,
 * and the revision bump commit together. The caller must not await inside
 * `work`. A throw rolls the unit back, including a document written before
 * a failing FTS insert.
 */
export function commitSearchUnit(db: Db, work: () => boolean): boolean {
  let wrote = false;
  db.transaction(() => {
    wrote = work();
    if (wrote) bumpRevision(db);
  })();
  return wrote;
}

/**
 * Trigram availability is not the same as a populated index. An empty FTS
 * table stays out of query mode until `rebuildFtsPage` copies documents.
 * Returns true only when the query mode itself changes.
 */
export function planFtsMode(db: Db, available: boolean): boolean {
  const state = readState(db);
  if (!available) {
    if (state.fts_mode === 'unavailable' && state.fts_rebuild !== 1) return false;
    db.prepare(
      `UPDATE search_state
       SET fts_mode = 'unavailable', fts_rebuild = 0, fts_cursor = NULL
       WHERE id = 1`,
    ).run();
    return state.fts_mode !== 'unavailable';
  }
  const docs = documentCount(db);
  const indexed = ftsRowCount(db);
  const behind = state.fts_mode !== 'trigram' || state.fts_rebuild === 1 || indexed < docs;
  if (!behind) return false;
  if (docs === 0 && state.fts_rebuild !== 1) {
    db.prepare(
      `UPDATE search_state
       SET fts_mode = 'trigram', fts_rebuild = 0, fts_cursor = NULL
       WHERE id = 1`,
    ).run();
    return state.fts_mode !== 'trigram';
  }
  const leftTrigram = state.fts_mode === 'trigram';
  db.prepare(
    `UPDATE search_state SET fts_mode = 'unavailable', fts_rebuild = 1 WHERE id = 1`,
  ).run();
  return leftTrigram;
}

/** Copy one page of documents into FTS. The last page turns trigram queries on. */
export function rebuildFtsPage(db: Db, pageSize: number): boolean {
  const state = readState(db);
  if (state.fts_rebuild !== 1) return false;
  const rows = db.prepare(
    `SELECT id, normalized_text FROM search_documents
     WHERE (? IS NULL OR id > ?)
     ORDER BY id ASC
     LIMIT ?`,
  ).all(state.fts_cursor, state.fts_cursor, pageSize) as Array<{ id: string; normalized_text: string }>;
  const remove = db.prepare('DELETE FROM search_fts WHERE document_id = ?');
  const insert = db.prepare('INSERT INTO search_fts (document_id, normalized) VALUES (?, ?)');
  for (const row of rows) {
    remove.run(row.id);
    insert.run(row.id, row.normalized_text);
  }
  if (rows.length >= pageSize && pageSize > 0) {
    db.prepare('UPDATE search_state SET fts_cursor = ? WHERE id = 1').run(rows[rows.length - 1]!.id);
    return false;
  }
  db.prepare(
    `UPDATE search_state
     SET fts_mode = 'trigram', fts_rebuild = 0, fts_cursor = NULL
     WHERE id = 1`,
  ).run();
  return true;
}

function ftsRowCount(db: Db): number {
  try {
    const row = db.prepare('SELECT COUNT(*) AS n FROM search_fts').get() as { n: number };
    return row.n;
  } catch {
    return 0;
  }
}

export function bumpRevision(db: Db): string {
  db.prepare('UPDATE search_state SET index_revision = index_revision + 1 WHERE id = 1').run();
  return String(readState(db).index_revision);
}

export function setLastError(db: Db, message: string | null): void {
  db.prepare('UPDATE search_state SET last_error = ? WHERE id = 1').run(message);
}

export function upsertDocument(db: Db, input: SearchDocumentInput, fts: boolean): void {
  const id = documentId(input.kind, input.sourceId);
  const normalizedText = normalizeSearchText(input.searchText);
  const normalizedTitle = normalizeSearchText(input.title);
  db.prepare(
    `INSERT INTO search_documents (
      id, kind, source_id, owner_id, workspace_id, group_key, source_revision,
      title, subtitle, search_text, normalized_text, normalized_title, anchor_json,
      archived, sort_turn, sort_pos, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      kind = excluded.kind,
      source_id = excluded.source_id,
      owner_id = excluded.owner_id,
      workspace_id = excluded.workspace_id,
      group_key = excluded.group_key,
      source_revision = excluded.source_revision,
      title = excluded.title,
      subtitle = excluded.subtitle,
      search_text = excluded.search_text,
      normalized_text = excluded.normalized_text,
      normalized_title = excluded.normalized_title,
      anchor_json = excluded.anchor_json,
      archived = excluded.archived,
      sort_turn = excluded.sort_turn,
      sort_pos = excluded.sort_pos,
      updated_at = excluded.updated_at`,
  ).run(
    id,
    input.kind,
    input.sourceId,
    input.ownerId,
    input.workspaceId,
    input.groupKey,
    input.sourceRevision,
    input.title,
    input.subtitle ?? null,
    input.searchText,
    normalizedText,
    normalizedTitle,
    JSON.stringify(input.anchor),
    input.archived ? 1 : 0,
    input.sortTurn ?? null,
    input.sortPos ?? 0,
    input.updatedAt,
  );
  if (!fts) return;
  db.prepare('DELETE FROM search_fts WHERE document_id = ?').run(id);
  db.prepare('INSERT INTO search_fts (document_id, normalized) VALUES (?, ?)').run(id, normalizedText);
}

export function deleteDocuments(db: Db, ids: readonly string[], fts: boolean): void {
  for (let offset = 0; offset < ids.length; offset += 200) {
    const slice = ids.slice(offset, offset + 200);
    const placeholders = slice.map(() => '?').join(', ');
    db.prepare(`DELETE FROM search_documents WHERE id IN (${placeholders})`).run(...slice);
    if (!fts) continue;
    db.prepare(`DELETE FROM search_fts WHERE document_id IN (${placeholders})`).run(...slice);
  }
}

export function deleteWhere(db: Db, where: string, params: readonly unknown[], fts: boolean): number {
  const ids = db.prepare(`SELECT id FROM search_documents WHERE ${where}`).all(...params) as Array<{ id: string }>;
  deleteDocuments(db, ids.map(row => row.id), fts);
  return ids.length;
}

export function enqueueDirty(db: Db, kind: string, sourceKey: string): void {
  db.prepare('INSERT OR IGNORE INTO search_dirty (kind, source_key) VALUES (?, ?)').run(kind, sourceKey);
}

export function takeDirty(db: Db, limit: number): Array<{ kind: string; source_key: string }> {
  return db.prepare(
    'SELECT kind, source_key FROM search_dirty ORDER BY kind, source_key LIMIT ?',
  ).all(limit) as Array<{ kind: string; source_key: string }>;
}

export function clearDirty(db: Db, kind: string, sourceKey: string): void {
  db.prepare('DELETE FROM search_dirty WHERE kind = ? AND source_key = ?').run(kind, sourceKey);
}

export function dirtyCount(db: Db): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM search_dirty').get() as { n: number };
  return row.n;
}

export function documentCount(db: Db): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM search_documents').get() as { n: number };
  return row.n;
}

export function isDirty(db: Db, checks: Array<[string, string | null]>): boolean {
  for (const [kind, key] of checks) {
    if (!key) continue;
    const row = db.prepare(
      'SELECT 1 AS hit FROM search_dirty WHERE kind = ? AND source_key = ?',
    ).get(kind, key) as { hit: number } | undefined;
    if (row) return true;
  }
  return false;
}
