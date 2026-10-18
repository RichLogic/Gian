import {
  SearchContractError,
  assertCursorFresh,
  encodeSearchCursor,
  findLiteralRanges,
  scanLiteralRanges,
  ftsTrigramLiteral,
  normalizeSearchText,
  searchMatchStrategy,
  snippetAround,
  type FindPage,
  type ParsedContextQuery,
  type ParsedFindQuery,
  type ParsedSearchQuery,
  type SearchBusinessKind,
  type SearchContextPage,
  type SearchCoverage,
  type SearchCursor,
  type SearchMatchStrategy,
  type SearchPage,
  type SearchResult,
  type SearchStatus,
  type SearchTarget,
} from '@gian/shared';
import type { Db } from '../storage/db.js';
import { SessionHistoryStore } from '../session/history-store.js';
import { foldTurnMessages, foldedSearchText } from './fold.js';
import {
  SEARCH_SCAN_BUDGET,
  dirtyCount,
  documentCount,
  isDirty,
  readState,
  textRevision,
  type SearchDocumentRow,
} from './store.js';

const COLUMNS = `id, kind, source_id, owner_id, workspace_id, group_key, source_revision,
  title, subtitle, search_text, normalized_text, normalized_title, anchor_json,
  archived, sort_turn, sort_pos, updated_at`;

interface ScanBatch {
  rows: SearchDocumentRow[];
  finished: boolean;
  examined: number;
}

/**
 * Name ranks are exact, prefix, then contains. Body rank is last.
 * Rank 0 and 1 are bound SQL. Rank 2 and 3 share one scan budget.
 * A budget stop returns a continuation cursor and partial coverage.
 * It is not an exhaustive zero.
 */
export function searchGlobal(db: Db, parsed: ParsedSearchQuery, scanBudget = SEARCH_SCAN_BUDGET): SearchPage {
  const state = readState(db);
  const strategy = searchMatchStrategy(parsed.q, state.fts_mode === 'trigram' ? 'trigram' : 'unavailable');
  const cursor = freshCursor(parsed.cursor, state.index_revision, strategy);
  const needle = normalizeSearchText(parsed.q);
  const results: SearchResult[] = [];
  let rank = cursor?.rank ?? 0;
  let updatedAt = cursor?.updatedAt ?? null;
  let id = cursor?.id ?? null;
  let budgetLeft = scanBudget;
  let stoppedEarly = false;
  let exhausted = false;

  while (results.length < parsed.limit && rank <= 3) {
    if (rank >= 2 && budgetLeft <= 0) {
      stoppedEarly = true;
      break;
    }
    const room = parsed.limit - results.length;
    const batch = rank <= 1
      ? titleBatch(db, parsed, needle, rank as 0 | 1, updatedAt, id, room + 1)
      : scanBatch(db, parsed, needle, rank, updatedAt, id, budgetLeft, strategy);
    if (rank >= 2) budgetLeft -= batch.examined;
    let index = 0;
    for (; index < batch.rows.length && results.length < parsed.limit; index += 1) {
      const row = batch.rows[index]!;
      updatedAt = row.updated_at;
      id = row.id;
      if (!acceptRow(db, row)) continue;
      const hit = matchRank(db, row, rank, parsed.q, needle);
      if (!hit) continue;
      results.push(hit);
    }
    const reachedEnd = batch.finished && index === batch.rows.length;
    if (results.length === parsed.limit) {
      if (reachedEnd && rank < 3) {
        rank += 1;
        updatedAt = null;
        id = null;
      }
      break;
    }
    if (reachedEnd) {
      rank += 1;
      updatedAt = null;
      id = null;
      if (rank > 3) exhausted = true;
      continue;
    }
    stoppedEarly = true;
    break;
  }
  if (rank > 3) exhausted = true;

  const next = exhausted
    ? null
    : encodeSearchCursor(positionCursor(
      parsed,
      state.index_revision,
      strategy,
      Math.min(rank, 3),
      updatedAt,
      id,
    ));
  const scan = stoppedEarly && results.length < parsed.limit ? 'budget' : 'done';
  return {
    results,
    next_cursor: next,
    index_revision: String(state.index_revision),
    coverage: coverage(db, scan),
  };
}

export function findInSession(db: Db, parsed: ParsedFindQuery, scanBudget = SEARCH_SCAN_BUDGET): FindPage {
  const session = visibleSession(db, parsed.sessionId);
  if (!session) throw new SearchContractError('not_found', 'session not found');
  const state = readState(db);
  const strategy = searchMatchStrategy(parsed.q, state.fts_mode === 'trigram' ? 'trigram' : 'unavailable');
  const cursor = freshCursor(parsed.cursor, state.index_revision, strategy);
  let position = findPosition(cursor);
  const matches: FindPage['matches'] = [];
  let examined = 0;
  let finished = false;
  let lastExamined: { turn: number; pos: number; id: string; scanAfterId: string } | null = null;

  while (matches.length < parsed.limit && examined < scanBudget) {
    const includeSame = position.docDone ? 0 : 1;
    const row = db.prepare(
      `SELECT ${COLUMNS} FROM search_documents
       WHERE kind = 'message' AND owner_id = ?
         AND (
           sort_turn > ?
           OR (sort_turn = ? AND sort_pos > ?)
           OR (sort_turn = ? AND sort_pos = ? AND id > ?)
           OR (? = 1 AND sort_turn = ? AND sort_pos = ? AND id = ?)
         )
       ORDER BY sort_turn ASC, sort_pos ASC, id ASC
       LIMIT 1`,
    ).get(
      parsed.sessionId,
      position.turn,
      position.turn, position.pos,
      position.turn, position.pos, position.id ?? '',
      includeSame, position.turn, position.pos, position.id ?? '',
    ) as SearchDocumentRow | undefined;
    if (!row) {
      finished = true;
      break;
    }
    examined += 1;
    const continuing = includeSame === 1 && row.id === position.id;
    let resume: number | null = null;
    if (acceptRow(db, row)) {
      const scan = scanLiteralRanges(row.search_text, parsed.q, {
        from: continuing ? position.resume : 0,
        limit: parsed.limit - matches.length,
      });
      for (const range of scan.ranges) {
        const snippet = snippetAround(row.search_text, [range]);
        matches.push({
          id: `${row.id}:${range.start}:${range.end}`,
          document_id: row.id,
          target: messageTarget(row),
          range,
          snippet: snippet.snippet,
        });
      }
      resume = scan.resume;
    }
    const docDone = resume === null;
    const turn = row.sort_turn ?? 0;
    lastExamined = {
      turn,
      pos: row.sort_pos,
      id: row.id,
      scanAfterId: docDone ? `${row.sort_pos}:done` : `${row.sort_pos}:${resume}`,
    };
    position = { turn, pos: row.sort_pos, id: row.id, resume: resume ?? 0, docDone };
    if (matches.length >= parsed.limit || examined >= scanBudget) break;
  }

  const sessionDirty = isDirty(db, [['session', parsed.sessionId]])
    || db.prepare(
      `SELECT 1 AS hit FROM search_dirty
       WHERE kind = 'turn' AND source_key IN (SELECT id FROM turns WHERE session_id = ?)`,
    ).get(parsed.sessionId) !== undefined;
  const ready = state.backfill_complete === 1 && !sessionDirty && !state.last_error;
  const seen = (cursor?.counted ?? 0) + matches.length;
  const budgetStopped = !finished && matches.length < parsed.limit;
  const next = finished || !lastExamined
    ? null
    : encodeSearchCursor({
      ...claims(parsed, String(state.index_revision)),
      phase: 'body',
      rank: 3,
      updatedAt: String(lastExamined.turn),
      id: lastExamined.id,
      scanAfterId: lastExamined.scanAfterId,
      scanMode: strategy,
      counted: seen,
    });
  return {
    matches,
    next_cursor: next,
    query_revision: parsed.queryRevision,
    total: seen,
    total_complete: finished && ready && historyComplete(db, parsed.sessionId),
    coverage: coverage(db, budgetStopped ? 'budget' : 'done', parsed.sessionId),
  };
}

export function readContext(db: Db, parsed: ParsedContextQuery): SearchContextPage {
  const session = db.prepare(
    'SELECT id, name, archived, hidden, workspace_id, task_id FROM sessions WHERE id = ?',
  ).get(parsed.sessionId) as {
    id: string; name: string | null; archived: number; hidden: number;
    workspace_id: string | null; task_id: string | null;
  } | undefined;
  if (!session || session.hidden) throw new SearchContractError('not_found', 'session not found');
  const turn = resolveTurn(db, parsed);
  if (parsed.documentId || parsed.messageId) {
    const located = assertMessageLocator(db, parsed, turn.id);
    assertCanonicalRevision(db, parsed, turn.id, located);
  }
  const fromTurn = Math.max(0, turn.turn_number - parsed.before);
  const toTurn = turn.turn_number + parsed.after;
  const turns = db.prepare(
    `SELECT id, turn_number FROM turns
     WHERE session_id = ? AND turn_number >= ? AND turn_number <= ?
     ORDER BY turn_number ASC`,
  ).all(session.id, fromTurn, toTurn) as Array<{ id: string; turn_number: number }>;
  const history = new SessionHistoryStore(db);
  const events = turns.flatMap(row => history.canonicalTurnEvents(row.id));
  return {
    session: {
      id: session.id,
      name: session.name,
      archived: session.archived === 1 ? 1 : 0,
      read_only: session.archived === 1,
      workspace_id: session.workspace_id,
      task_id: session.task_id,
      projection: 'search-context',
    },
    events,
    history_complete: historyComplete(db, session.id),
    window: {
      turn_id: turn.id,
      turn: turn.turn_number,
      before: parsed.before,
      after: parsed.after,
      from_turn: fromTurn,
      to_turn: toTurn,
    },
  };
}

export function searchStatus(db: Db): SearchStatus {
  const state = readState(db);
  return {
    schema_version: state.schema_version,
    index_revision: String(state.index_revision),
    fts: state.fts_mode === 'trigram' ? 'trigram' : 'unavailable',
    coverage: coverage(db, 'done'),
    backfill_complete: state.backfill_complete === 1,
  };
}

function titleBatch(
  db: Db,
  parsed: ParsedSearchQuery,
  needle: string,
  rank: 0 | 1,
  updatedAt: string | null,
  id: string | null,
  limit: number,
): ScanBatch {
  const filter = filters(parsed);
  const compare = rank === 0
    ? 'normalized_title = ?'
    : "normalized_title LIKE ? ESCAPE '\\' AND normalized_title != ?";
  const params = rank === 0
    ? [needle]
    : [`${escapeLike(needle)}%`, needle];
  const rows = db.prepare(
    `SELECT ${COLUMNS} FROM search_documents
     WHERE kind != 'message' AND ${compare}
       ${filter.sql}
       ${keyset(updatedAt, id)}
     ORDER BY updated_at DESC, id ASC
     LIMIT ?`,
  ).all(...params, ...filter.params, ...keysetParams(updatedAt, id), limit) as SearchDocumentRow[];
  return { rows, finished: rows.length < limit, examined: rows.length };
}

function scanBatch(
  db: Db,
  parsed: ParsedSearchQuery,
  needle: string,
  rank: number,
  updatedAt: string | null,
  id: string | null,
  budget: number,
  strategy: SearchMatchStrategy,
): ScanBatch {
  const filter = filters(parsed);
  const kindSql = rank === 3 ? '' : "AND kind != 'message'";
  if (strategy === 'trigram' && rank === 3) {
    const rows = db.prepare(
      `SELECT ${COLUMNS} FROM search_documents
       WHERE id IN (SELECT document_id FROM search_fts WHERE search_fts MATCH ?)
         ${filter.sql}
         ${keyset(updatedAt, id)}
       ORDER BY updated_at DESC, id ASC
       LIMIT ?`,
    ).all(ftsTrigramLiteral(needle), ...filter.params, ...keysetParams(updatedAt, id), budget) as SearchDocumentRow[];
    return { rows, finished: rows.length < budget, examined: rows.length };
  }
  const rows = db.prepare(
    `SELECT ${COLUMNS} FROM search_documents
     WHERE 1 = 1 ${kindSql}
       ${filter.sql}
       ${keyset(updatedAt, id)}
     ORDER BY updated_at DESC, id ASC
     LIMIT ?`,
  ).all(...filter.params, ...keysetParams(updatedAt, id), budget) as SearchDocumentRow[];
  return { rows, finished: rows.length < budget, examined: rows.length };
}

function matchRank(
  db: Db,
  row: SearchDocumentRow,
  rank: number,
  query: string,
  needle: string,
): SearchResult | null {
  if (rank <= 2) {
    const ranges = findLiteralRanges(row.title, query);
    if (ranges.length === 0) return null;
    if (rank === 0 && row.normalized_title !== needle) return null;
    if (rank === 1 && (row.normalized_title === needle || !row.normalized_title.startsWith(needle))) return null;
    if (rank === 2 && (row.normalized_title === needle || row.normalized_title.startsWith(needle))) return null;
    const snippet = snippetAround(row.title, ranges);
    return resultOf(db, row, snippet.snippet, snippet.ranges);
  }
  return bodyHit(db, row, query);
}

function bodyHit(db: Db, row: SearchDocumentRow, query: string): SearchResult | null {
  const ranges = scanLiteralRanges(row.search_text, query, { limit: 16 }).ranges;
  if (ranges.length === 0) return null;
  if (row.kind !== 'message') {
    const titleRanges = findLiteralRanges(row.title, query);
    if (titleRanges.length > 0) return null;
  }
  const snippet = snippetAround(row.search_text, ranges.slice(0, 1));
  return resultOf(db, row, snippet.snippet, snippet.ranges);
}

function findPosition(cursor: SearchCursor | null): {
  turn: number; pos: number; id: string | null; resume: number; docDone: boolean;
} {
  if (!cursor?.id) return { turn: -1, pos: -1, id: null, resume: 0, docDone: false };
  const scan = cursor.scanAfterId ?? '';
  const splitAt = scan.indexOf(':');
  const pos = Number(splitAt < 0 ? scan : scan.slice(0, splitAt));
  const rest = splitAt < 0 ? '' : scan.slice(splitAt + 1);
  const turn = Number(cursor.updatedAt);
  if (!Number.isSafeInteger(turn) || !Number.isSafeInteger(pos)) {
    throw new SearchContractError('invalid_argument', 'cursor is invalid');
  }
  if (rest === 'done') return { turn, pos, id: cursor.id, resume: 0, docDone: true };
  const resume = Number(rest);
  if (!Number.isSafeInteger(resume) || resume < 0) {
    throw new SearchContractError('invalid_argument', 'cursor is invalid');
  }
  return { turn, pos, id: cursor.id, resume, docDone: false };
}

function resultOf(
  db: Db,
  row: SearchDocumentRow,
  snippet: string,
  ranges: SearchResult['ranges'],
): SearchResult {
  return {
    id: row.id,
    kind: row.kind as SearchBusinessKind,
    title: liveTitle(db, row),
    ...(row.subtitle ? { subtitle: row.subtitle } : {}),
    snippet,
    ranges,
    target: targetOf(row),
    updated_at: row.updated_at,
    archived: row.archived === 1,
  };
}

function liveTitle(db: Db, row: SearchDocumentRow): string {
  if (row.kind !== 'message' || !row.owner_id) return row.title;
  const session = db.prepare('SELECT name FROM sessions WHERE id = ? AND hidden = 0')
    .get(row.owner_id) as { name: string | null } | undefined;
  const name = session?.name?.trim();
  return name || row.title;
}

function targetOf(row: SearchDocumentRow): SearchTarget {
  const anchor = JSON.parse(row.anchor_json) as Record<string, unknown>;
  if (row.kind === 'message') return messageTarget(row);
  if (row.kind === 'session') {
    return { type: 'session', session_id: String(anchor.session_id), archived: row.archived === 1 };
  }
  if (row.kind === 'workspace') return { type: 'workspace', workspace_id: String(anchor.workspace_id) };
  if (row.kind === 'worktree') {
    return {
      type: 'worktree',
      working_tree_id: String(anchor.working_tree_id),
      workspace_id: String(anchor.workspace_id ?? ''),
      session_id: anchor.session_id == null ? null : String(anchor.session_id),
      archived: row.archived === 1,
    };
  }
  if (row.kind === 'task') return { type: 'task', task_id: String(anchor.task_id) };
  if (row.kind === 'agent') return { type: 'agent', agent_id: String(anchor.agent_id) };
  if (row.kind === 'schedule') {
    return {
      type: 'schedule',
      schedule_id: String(anchor.schedule_id),
      archived: row.archived === 1,
    };
  }
  return {
    type: 'inbox',
    inbox_id: String(anchor.inbox_id),
    generation: Number(anchor.generation),
  };
}

function messageTarget(row: SearchDocumentRow): Extract<SearchTarget, { message_id: string }> {
  const anchor = JSON.parse(row.anchor_json) as {
    session_id: string; turn_id: string; turn: number; message_id: string;
    message_kind: 'user' | 'assistant'; text_revision: string; archived: boolean;
  };
  return {
    type: 'session',
    session_id: anchor.session_id,
    turn_id: anchor.turn_id,
    turn: anchor.turn,
    message_id: anchor.message_id,
    message_kind: anchor.message_kind,
    text_revision: anchor.text_revision,
    archived: row.archived === 1,
  };
}

function acceptRow(db: Db, row: SearchDocumentRow): boolean {
  if (isDirty(db, [
    ['turn', row.group_key],
    ['session', row.owner_id],
    ['workspace', row.workspace_id],
    [row.kind, row.source_id],
  ])) return false;
  if (row.kind === 'session' || row.kind === 'message' || (row.kind === 'worktree' && row.owner_id)) {
    const sessionId = row.owner_id ?? row.source_id;
    const session = db.prepare('SELECT hidden FROM sessions WHERE id = ?').get(sessionId) as { hidden: number } | undefined;
    // Source triggers already enqueue maintenance. A query must not delete
    // documents or FTS rows after index_revision was read.
    if (!session || session.hidden) return false;
  }
  if (row.kind === 'workspace' || row.kind === 'task' || row.kind === 'schedule' || row.kind === 'inbox') {
    const table = row.kind === 'workspace' ? 'workspaces'
      : row.kind === 'task' ? 'tasks'
        : row.kind === 'schedule' ? 'schedules'
          : 'inbox_items';
    const found = db.prepare(`SELECT 1 AS hit FROM ${table} WHERE id = ?`).get(row.source_id);
    if (!found) return false;
  }
  return true;
}

function filters(parsed: ParsedSearchQuery): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  let sql = '';
  if (parsed.types.length !== 8) {
    sql += ` AND kind IN (${parsed.types.map(() => '?').join(', ')})`;
    params.push(...parsed.types);
  }
  if (!parsed.includeArchived) sql += ' AND archived = 0';
  if (parsed.workspaceId) {
    sql += ` AND (
      workspace_id = ?
      OR (kind = 'task' AND source_id IN (
        SELECT task_id FROM sessions WHERE workspace_id = ? AND hidden = 0 AND task_id IS NOT NULL
      ))
      OR (kind = 'agent' AND source_id IN (
        SELECT agent_id FROM sessions WHERE workspace_id = ? AND hidden = 0 AND agent_id IS NOT NULL
      ))
    )`;
    params.push(parsed.workspaceId, parsed.workspaceId, parsed.workspaceId);
  }
  return { sql, params };
}

function keyset(updatedAt: string | null, id: string | null): string {
  if (!updatedAt || !id) return '';
  return 'AND (updated_at < ? OR (updated_at = ? AND id > ?))';
}

function keysetParams(updatedAt: string | null, id: string | null): unknown[] {
  return updatedAt && id ? [updatedAt, updatedAt, id] : [];
}

function freshCursor(
  cursor: SearchCursor | null,
  indexRevision: number,
  strategy: SearchMatchStrategy,
): SearchCursor | null {
  if (!cursor) return null;
  assertCursorFresh(cursor, {
    endpoint: cursor.endpoint,
    schema: cursor.schema,
    indexRevision: String(indexRevision),
    queryRevision: cursor.queryRevision,
    q: cursor.q,
    types: cursor.types,
    workspaceId: cursor.workspaceId,
    includeArchived: cursor.includeArchived,
    sessionId: cursor.sessionId,
  });
  if (cursor.scanMode && cursor.scanMode !== strategy) {
    throw new SearchContractError('stale_cursor', 'cursor does not match this query');
  }
  return cursor;
}

function positionCursor(
  parsed: ParsedSearchQuery,
  indexRevision: number,
  strategy: SearchMatchStrategy,
  rank: number,
  updatedAt: string | null,
  id: string | null,
): SearchCursor {
  return {
    ...claims(parsed, String(indexRevision)),
    phase: rank >= 3 ? 'body' : 'name',
    rank,
    updatedAt,
    id,
    scanAfterId: null,
    scanMode: strategy,
    counted: 0,
  };
}

function claims(
  parsed: ParsedSearchQuery | ParsedFindQuery,
  indexRevision: string,
): Omit<SearchCursor, 'phase' | 'rank' | 'updatedAt' | 'id' | 'scanAfterId' | 'scanMode' | 'counted'> {
  if ('types' in parsed) {
    return {
      v: 1,
      endpoint: 'search',
      schema: 1,
      indexRevision,
      queryRevision: parsed.queryRevision,
      q: parsed.q,
      types: parsed.types,
      workspaceId: parsed.workspaceId,
      includeArchived: parsed.includeArchived,
      sessionId: null,
    };
  }
  return {
    v: 1,
    endpoint: 'find',
    schema: 1,
    indexRevision,
    queryRevision: parsed.queryRevision,
    q: parsed.q,
    types: ['message'],
    workspaceId: null,
    includeArchived: true,
    sessionId: parsed.sessionId,
  };
}

function coverage(db: Db, scan: 'done' | 'budget', sessionId?: string): SearchCoverage {
  const state = readState(db);
  const pending = dirtyCount(db);
  const indexed = documentCount(db);
  if (state.last_error) return { state: 'error', complete: false, indexed, pending };
  if (scan === 'budget') return { state: 'partial', complete: false, indexed, pending };
  if (
    state.backfill_complete !== 1
    || pending > 0
    || state.fts_rebuild === 1
    || coldHistoryOpen(db, sessionId)
  ) {
    return { state: 'building', complete: false, indexed, pending };
  }
  return { state: 'ready', complete: true, indexed, pending };
}

/** Cold rebuild is open for one session, or for any visible session when omitted. */
function coldHistoryOpen(db: Db, sessionId?: string): boolean {
  const table = db.prepare(
    "SELECT 1 AS hit FROM sqlite_master WHERE type = 'table' AND name = 'event_rebuild_state'",
  ).get();
  if (!table) return false;
  if (sessionId) {
    const row = db.prepare(
      'SELECT complete FROM event_rebuild_state WHERE session_id = ?',
    ).get(sessionId) as { complete: number } | undefined;
    return row?.complete === 0;
  }
  const row = db.prepare(
    `SELECT 1 AS hit FROM event_rebuild_state r
     JOIN sessions s ON s.id = r.session_id
     WHERE s.hidden = 0 AND r.complete = 0
     LIMIT 1`,
  ).get();
  return row !== undefined;
}

function visibleSession(db: Db, sessionId: string): { id: string } | undefined {
  return db.prepare(
    'SELECT id FROM sessions WHERE id = ? AND hidden = 0',
  ).get(sessionId) as { id: string } | undefined;
}

function resolveTurn(db: Db, parsed: ParsedContextQuery): { id: string; turn_number: number } {
  if (parsed.turnId && parsed.turn !== null) {
    const row = db.prepare(
      'SELECT id, session_id, turn_number FROM turns WHERE id = ?',
    ).get(parsed.turnId) as { id: string; session_id: string; turn_number: number } | undefined;
    if (!row || row.session_id !== parsed.sessionId || row.turn_number !== parsed.turn) {
      throw new SearchContractError('invalid_argument', 'turn_id does not match turn');
    }
    return row;
  }
  if (parsed.turnId) {
    const row = db.prepare(
      'SELECT id, session_id, turn_number FROM turns WHERE id = ?',
    ).get(parsed.turnId) as { id: string; session_id: string; turn_number: number } | undefined;
    if (!row || row.session_id !== parsed.sessionId) {
      throw new SearchContractError('not_found', 'turn not found');
    }
    return row;
  }
  const row = db.prepare(
    'SELECT id, turn_number FROM turns WHERE session_id = ? AND turn_number = ?',
  ).get(parsed.sessionId, parsed.turn) as { id: string; turn_number: number } | undefined;
  if (!row) throw new SearchContractError('not_found', 'turn not found');
  return row;
}

function assertMessageLocator(db: Db, parsed: ParsedContextQuery, turnId: string): SearchDocumentRow {
  const doc = parsed.documentId
    ? db.prepare(`SELECT ${COLUMNS} FROM search_documents WHERE id = ?`).get(parsed.documentId) as SearchDocumentRow | undefined
    : messageByIdentity(db, parsed.sessionId, turnId, parsed.messageId ?? '');
  if (!doc || doc.kind !== 'message' || doc.owner_id !== parsed.sessionId) {
    throw new SearchContractError('not_found', 'message not found');
  }
  const target = messageTarget(doc);
  if (parsed.messageId && target.message_id !== parsed.messageId) {
    throw new SearchContractError('text_revision_mismatch', 'message revision does not match');
  }
  if (target.turn_id !== turnId) {
    throw new SearchContractError('text_revision_mismatch', 'message revision does not match');
  }
  return doc;
}

function assertCanonicalRevision(
  db: Db,
  parsed: ParsedContextQuery,
  turnId: string,
  doc: SearchDocumentRow,
): void {
  const target = messageTarget(doc);
  const expected = parsed.textRevision ?? target.text_revision;
  const canonical = canonicalMessageRevision(db, turnId, target.message_id);
  if (!canonical || canonical !== expected) {
    throw new SearchContractError('text_revision_mismatch', 'message revision does not match');
  }
}

function canonicalMessageRevision(db: Db, turnId: string, messageId: string): string | null {
  const history = new SessionHistoryStore(db);
  const message = foldTurnMessages(history.canonicalTurnEvents(turnId))
    .find(row => row.messageId === messageId);
  if (!message) return null;
  const text = foldedSearchText(message);
  if (!text) return null;
  return textRevision(text);
}

function historyComplete(db: Db, sessionId: string): boolean {
  return !coldHistoryOpen(db, sessionId);
}

function messageByIdentity(
  db: Db,
  sessionId: string,
  turnId: string,
  messageId: string,
): SearchDocumentRow | undefined {
  const rows = db.prepare(
    `SELECT ${COLUMNS} FROM search_documents
     WHERE kind = 'message' AND owner_id = ? AND group_key = ?`,
  ).all(sessionId, turnId) as SearchDocumentRow[];
  return rows.find(candidate => {
    try {
      return messageTarget(candidate).message_id === messageId;
    } catch {
      return false;
    }
  });
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, match => `\\${match}`);
}
