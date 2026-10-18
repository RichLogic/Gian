import { statSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeSearchText, parseWorkingTreeId, projectSearchText } from '@gian/shared';
import type { Db } from '../storage/db.js';
import { SessionHistoryStore } from '../session/history-store.js';
import { foldTurnMessages, foldedSearchText } from './fold.js';
import type { SearchWorkingTreeSource } from './types.js';
import {
  SEARCH_DIRTY_PAGE,
  SEARCH_SOURCE_PAGE,
  SEARCH_TURN_PAGE,
  clearDirty,
  commitSearchUnit,
  deleteDocuments,
  deleteWhere,
  documentId,
  planFtsMode,
  probeFts,
  readState,
  rebuildFtsPage,
  setLastError,
  textRevision,
  upsertDocument,
  type SearchDocumentInput,
  type SearchStateRow,
} from './store.js';

const STAGES = [
  'workspace',
  'session',
  'task',
  'schedule',
  'inbox',
  'turn',
  'worktree',
  'agent',
  'done',
] as const;

export interface MaintainLimits {
  dirtyPage: number;
  sourcePage: number;
  turnPage: number;
}

export interface MaintainOptions {
  /** One cached inventory page. The caller spaces these out. */
  refreshInventory?: boolean;
  inventoryCursor?: string | null;
  /** After an await, skip every database write when this returns true. */
  stop?: () => boolean;
}

export interface MaintainResult {
  inventoryCursor: string | null;
  /** True when this tick called `listWorkingTrees` outside backfill. */
  inventoryRefreshed: boolean;
}

const DEFAULT_LIMITS: MaintainLimits = {
  dirtyPage: SEARCH_DIRTY_PAGE,
  sourcePage: SEARCH_SOURCE_PAGE,
  turnPage: SEARCH_TURN_PAGE,
};

export async function drainSearchOnce(
  db: Db,
  dataDir: string,
  listWorkingTrees: (options?: { includeArchived?: boolean }) => Promise<readonly SearchWorkingTreeSource[]>,
  limits: MaintainLimits = DEFAULT_LIMITS,
  options: MaintainOptions = {},
): Promise<MaintainResult> {
  const history = new SessionHistoryStore(db);
  const result: MaintainResult = {
    inventoryCursor: options.inventoryCursor ?? null,
    inventoryRefreshed: false,
  };
  const stopped = () => options.stop?.() === true;
  let failed = false;
  try {
    if (stopped()) return result;
    // Creating the virtual table cannot run inside a SQLite transaction.
    const fts = probeFts(db) === 'trigram';
    if (stopped()) return result;
    commitSearchUnit(db, () => planFtsMode(db, fts));
    if (stopped()) return result;
    drainDirty(db, history, limits, fts);
    if (stopped()) return result;
    const state = readState(db);
    if (state.backfill_stage !== 'done') {
      failed = await runStage(db, dataDir, history, listWorkingTrees, limits, fts, state, stopped);
    } else {
      failed = await applyAgentStage(db, dataDir, fts, true, stopped);
      if (!failed && !stopped() && options.refreshInventory) {
        const trees = await listWorkingTrees({ includeArchived: true });
        if (stopped()) return result;
        let cursor = options.inventoryCursor ?? null;
        commitSearchUnit(db, () => {
          const page = applyInventoryPage(db, trees, cursor, limits.sourcePage, fts);
          cursor = page.cursor;
          return page.wrote;
        });
        result.inventoryCursor = cursor;
        result.inventoryRefreshed = true;
      }
    }
    if (stopped()) return result;
    if (!failed) recordError(db, null);
    if (stopped()) return result;
    commitSearchUnit(db, () => rebuildFtsPage(db, limits.sourcePage));
  } catch (error) {
    if (!stopped()) recordError(db, error instanceof Error ? error.message : 'search index failed');
  }
  return result;
}

function recordError(db: Db, message: string | null): void {
  try {
    setLastError(db, message);
  } catch {
    // A closed database must not escape the drain as an unhandled rejection.
  }
}

function drainDirty(
  db: Db,
  history: SessionHistoryStore,
  limits: MaintainLimits,
  fts: boolean,
): void {
  for (const kind of ['workspace', 'task', 'session', 'turn', 'schedule', 'inbox'] as const) {
    const rows = db.prepare(
      'SELECT source_key FROM search_dirty WHERE kind = ? ORDER BY source_key LIMIT ?',
    ).all(kind, limits.dirtyPage) as Array<{ source_key: string }>;
    for (const row of rows) {
      // Each source commits its document, FTS rows, dirty mark, and revision
      // together. A later row can throw without dropping earlier revisions.
      commitSearchUnit(db, () => reindexDirty(db, history, kind, row.source_key, fts, limits));
    }
  }
}

function reindexDirty(
  db: Db,
  history: SessionHistoryStore,
  kind: string,
  sourceKey: string,
  fts: boolean,
  limits: MaintainLimits,
): boolean {
  if (kind === 'turn') {
    const wrote = reindexTurn(db, history, sourceKey, fts);
    clearDirty(db, kind, sourceKey);
    return wrote;
  }
  if (kind === 'session') return reindexSessionDirty(db, sourceKey, fts, limits.turnPage);
  if (kind === 'workspace') return reindexWorkspaceDirty(db, sourceKey, fts, limits.sourcePage);
  if (kind === 'task') return reindexTaskDirty(db, sourceKey, fts, limits.sourcePage);
  if (kind === 'schedule') {
    const wrote = reindexSchedule(db, sourceKey, fts);
    clearDirty(db, kind, sourceKey);
    return wrote;
  }
  if (kind === 'inbox') {
    const wrote = reindexInbox(db, sourceKey, fts);
    clearDirty(db, kind, sourceKey);
    return wrote;
  }
  clearDirty(db, kind, sourceKey);
  return false;
}

function dirtyCursor(db: Db, kind: string, sourceKey: string): string | null {
  const row = db.prepare(
    'SELECT cursor FROM search_dirty WHERE kind = ? AND source_key = ?',
  ).get(kind, sourceKey) as { cursor: string | null } | undefined;
  return row?.cursor ?? null;
}

function keepFanout(db: Db, kind: string, sourceKey: string, cursor: string): void {
  db.prepare(
    'UPDATE search_dirty SET cursor = ? WHERE kind = ? AND source_key = ?',
  ).run(cursor, kind, sourceKey);
}

function enqueueChild(db: Db, kind: string, sourceKey: string): void {
  db.prepare(
    `INSERT INTO search_dirty (kind, source_key, cursor) VALUES (?, ?, NULL)
     ON CONFLICT(kind, source_key) DO UPDATE SET cursor = NULL`,
  ).run(kind, sourceKey);
}

function reindexSessionDirty(db: Db, sessionId: string, fts: boolean, pageSize: number): boolean {
  const session = sessionById(db, sessionId);
  if (!session || session.hidden) {
    const removed = deleteWhere(db, 'owner_id = ? OR (kind = ? AND source_id = ?) OR (kind = ? AND source_id = ?)', [
      sessionId, 'session', sessionId, 'worktree', `wt:${sessionId}`,
    ], fts);
    clearDirty(db, 'session', sessionId);
    return removed > 0;
  }
  const cursor = dirtyCursor(db, 'session', sessionId);
  let wrote = false;
  if (cursor === null) {
    wrote = writeSession(db, session, fts);
    wrote = writeSessionWorktree(db, session, fts) || wrote;
  }
  const rows = db.prepare(
    `SELECT id FROM search_documents
     WHERE kind = 'message' AND owner_id = ? AND (? IS NULL OR id > ?)
     ORDER BY id ASC
     LIMIT ?`,
  ).all(session.id, cursor, cursor, pageSize) as Array<{ id: string }>;
  wrote = patchMessageMetadata(db, session, rows.map(row => row.id)) || wrote;
  if (rows.length >= pageSize && pageSize > 0) {
    keepFanout(db, 'session', sessionId, rows[rows.length - 1]!.id);
    return wrote;
  }
  clearDirty(db, 'session', sessionId);
  return wrote;
}

function patchMessageMetadata(db: Db, session: SessionRow, ids: readonly string[]): boolean {
  if (ids.length === 0) return false;
  const title = session.name?.trim() || 'Untitled';
  const normalized = normalizeSearchText(title);
  const archived = session.archived === 1 ? 1 : 0;
  const rows = db.prepare(
    `SELECT id, title, normalized_title, workspace_id, archived, anchor_json
     FROM search_documents WHERE id IN (${ids.map(() => '?').join(', ')})`,
  ).all(...ids) as Array<{
    id: string; title: string; normalized_title: string; workspace_id: string | null;
    archived: number; anchor_json: string;
  }>;
  const update = db.prepare(
    `UPDATE search_documents
     SET title = ?, normalized_title = ?, workspace_id = ?, archived = ?, anchor_json = ?
     WHERE id = ?`,
  );
  let wrote = false;
  for (const row of rows) {
    const anchor = JSON.parse(row.anchor_json) as Record<string, unknown>;
    anchor.archived = archived === 1;
    const anchorJson = JSON.stringify(anchor);
    const same = row.title === title
      && row.normalized_title === normalized
      && row.workspace_id === session.workspace_id
      && row.archived === archived
      && row.anchor_json === anchorJson;
    if (same) continue;
    update.run(title, normalized, session.workspace_id, archived, anchorJson, row.id);
    wrote = true;
  }
  return wrote;
}

function reindexWorkspaceDirty(db: Db, workspaceId: string, fts: boolean, pageSize: number): boolean {
  const workspace = workspaceById(db, workspaceId);
  const cursor = dirtyCursor(db, 'workspace', workspaceId);
  let wrote = false;
  if (!workspace || workspace.hidden) {
    if (cursor === null) {
      const removedDocs = deleteWhere(db, 'kind = ? AND source_id = ?', ['workspace', workspaceId], fts);
      const removedTrees = deleteWhere(
        db,
        "kind = 'worktree' AND workspace_id = ? AND (source_id LIKE 'ws:%' OR source_id LIKE 'ext:%')",
        [workspaceId],
        fts,
      );
      wrote = removedDocs + removedTrees > 0;
    }
  } else if (cursor === null) {
    wrote = writeWorkspace(db, workspace, fts);
  }
  const rows = db.prepare(
    `SELECT id FROM sessions
     WHERE workspace_id = ? AND (? IS NULL OR id > ?)
     ORDER BY id ASC
     LIMIT ?`,
  ).all(workspaceId, cursor, cursor, pageSize) as Array<{ id: string }>;
  for (const row of rows) enqueueChild(db, 'session', row.id);
  if (rows.length >= pageSize && pageSize > 0) {
    keepFanout(db, 'workspace', workspaceId, rows[rows.length - 1]!.id);
    return wrote;
  }
  clearDirty(db, 'workspace', workspaceId);
  return wrote;
}

function reindexTaskDirty(db: Db, taskId: string, fts: boolean, pageSize: number): boolean {
  const task = taskById(db, taskId);
  const cursor = dirtyCursor(db, 'task', taskId);
  let wrote = false;
  if (!task) {
    if (cursor === null) wrote = deleteWhere(db, 'kind = ? AND source_id = ?', ['task', taskId], fts) > 0;
  } else if (cursor === null) {
    wrote = writeTask(db, task, fts);
  }
  const rows = db.prepare(
    `SELECT id FROM sessions
     WHERE task_id = ? AND (? IS NULL OR id > ?)
     ORDER BY id ASC
     LIMIT ?`,
  ).all(taskId, cursor, cursor, pageSize) as Array<{ id: string }>;
  for (const row of rows) enqueueChild(db, 'session', row.id);
  if (rows.length >= pageSize && pageSize > 0) {
    keepFanout(db, 'task', taskId, rows[rows.length - 1]!.id);
    return wrote;
  }
  clearDirty(db, 'task', taskId);
  return wrote;
}

async function runStage(
  db: Db,
  dataDir: string,
  history: SessionHistoryStore,
  listWorkingTrees: (options?: { includeArchived?: boolean }) => Promise<readonly SearchWorkingTreeSource[]>,
  limits: MaintainLimits,
  fts: boolean,
  state: SearchStateRow,
  stopped: () => boolean,
): Promise<boolean> {
  const stage = state.backfill_stage;
  if (stage === 'turn') {
    const rows = pageIds(db, 'turns', state.backfill_cursor, limits.turnPage);
    for (const row of rows) {
      commitSearchUnit(db, () => reindexTurn(db, history, row.id, fts));
    }
    commitSearchUnit(db, () => {
      finishPage(db, rows, limits.turnPage);
      return false;
    });
    return false;
  }
  if (stage === 'worktree') {
    const cursor = state.backfill_cursor;
    const trees = await listWorkingTrees({ includeArchived: true });
    if (stopped()) return false;
    commitSearchUnit(db, () => {
      const page = applyInventoryPage(db, trees, cursor, limits.sourcePage, fts);
      finishPage(db, page.ids.map(id => ({ id })), limits.sourcePage);
      return page.wrote;
    });
    return false;
  }
  if (stage === 'agent') return applyAgentStage(db, dataDir, fts, false, stopped);
  const table = stage === 'workspace' ? 'workspaces'
    : stage === 'session' ? 'sessions'
      : stage === 'task' ? 'tasks'
        : stage === 'schedule' ? 'schedules'
          : stage === 'inbox' ? 'inbox_items'
            : null;
  if (!table) {
    commitSearchUnit(db, () => {
      finishPage(db, [], 0);
      return false;
    });
    return false;
  }
  const rows = pageIds(db, table, state.backfill_cursor, limits.sourcePage);
  for (const row of rows) {
    commitSearchUnit(db, () => indexSourceRow(db, stage, row.id, fts));
  }
  commitSearchUnit(db, () => {
    finishPage(db, rows, limits.sourcePage);
    return false;
  });
  return false;
}

function indexSourceRow(db: Db, stage: string, id: string, fts: boolean): boolean {
  if (stage === 'workspace') {
    const workspace = workspaceById(db, id);
    if (!workspace || workspace.hidden) return false;
    return writeWorkspace(db, workspace, fts);
  }
  if (stage === 'session') {
    const session = sessionById(db, id);
    if (!session || session.hidden) return false;
    const sessionWrote = writeSession(db, session, fts);
    const treeWrote = writeSessionWorktree(db, session, fts);
    return sessionWrote || treeWrote;
  }
  if (stage === 'task') {
    const task = taskById(db, id);
    if (!task) return false;
    return writeTask(db, task, fts);
  }
  if (stage === 'schedule') return reindexSchedule(db, id, fts);
  return reindexInbox(db, id, fts);
}

function finishPage(db: Db, rows: Array<{ id: string }>, pageSize: number): void {
  if (rows.length >= pageSize && pageSize > 0) {
    db.prepare('UPDATE search_state SET backfill_cursor = ? WHERE id = 1')
      .run(rows[rows.length - 1]!.id);
    return;
  }
  const state = readState(db);
  const index = STAGES.indexOf(state.backfill_stage as typeof STAGES[number]);
  const next = STAGES[index + 1] ?? 'done';
  db.prepare(
    'UPDATE search_state SET backfill_stage = ?, backfill_cursor = NULL, backfill_complete = ? WHERE id = 1',
  ).run(next, next === 'done' ? 1 : 0);
}

function pageIds(db: Db, table: string, cursor: string | null, limit: number): Array<{ id: string }> {
  return db.prepare(
    `SELECT id FROM ${table} WHERE (? IS NULL OR id > ?) ORDER BY id ASC LIMIT ?`,
  ).all(cursor, cursor, limit) as Array<{ id: string }>;
}

function reindexTurn(db: Db, history: SessionHistoryStore, turnId: string, fts: boolean): boolean {
  const turn = db.prepare(
    'SELECT id, session_id, turn_number, created_at FROM turns WHERE id = ?',
  ).get(turnId) as { id: string; session_id: string; turn_number: number; created_at: string } | undefined;
  if (!turn) return deleteWhere(db, 'kind = ? AND group_key = ?', ['message', turnId], fts) > 0;
  const session = sessionById(db, turn.session_id);
  if (!session || session.hidden) {
    return deleteWhere(db, 'kind = ? AND group_key = ?', ['message', turnId], fts) > 0;
  }
  const folded = foldTurnMessages(history.canonicalTurnEvents(turnId));
  const live = new Set<string>();
  let wrote = false;
  folded.forEach((message, position) => {
    const searchText = foldedSearchText(message);
    if (!searchText) return;
    const sourceId = `${session.id}\u0000${message.messageId}`;
    live.add(documentId('message', sourceId));
    const revision = textRevision(searchText);
    wrote = writeDocument(db, {
      kind: 'message',
      sourceId,
      ownerId: session.id,
      workspaceId: session.workspace_id,
      groupKey: turn.id,
      sourceRevision: revision,
      title: session.name?.trim() || 'Untitled',
      searchText,
      anchor: {
        session_id: session.id,
        turn_id: turn.id,
        turn: turn.turn_number,
        message_id: message.messageId,
        message_kind: message.messageKind,
        text_revision: revision,
        archived: session.archived === 1,
      },
      archived: session.archived === 1,
      sortTurn: turn.turn_number,
      sortPos: position,
      updatedAt: message.updatedAt,
    }, fts) || wrote;
  });
  const existing = db.prepare(
    `SELECT id FROM search_documents WHERE kind = 'message' AND group_key = ?`,
  ).all(turn.id) as Array<{ id: string }>;
  const drop = existing.filter(row => !live.has(row.id)).map(row => row.id);
  if (drop.length > 0) {
    deleteDocuments(db, drop, fts);
    wrote = true;
  }
  return wrote;
}

function writeSession(db: Db, session: SessionRow, fts: boolean): boolean {
  const workspace = session.workspace_id ? workspaceById(db, session.workspace_id) : undefined;
  const task = session.task_id ? taskById(db, session.task_id) : undefined;
  const title = session.name?.trim() || 'Untitled';
  const searchText = projectSearchText([
    title,
    workspace?.name,
    workspace?.path,
    task?.name,
    session.branch,
    session.base_branch,
  ].filter(Boolean).join('\n'));
  return writeDocument(db, {
    kind: 'session',
    sourceId: session.id,
    ownerId: session.id,
    workspaceId: session.workspace_id,
    groupKey: null,
    sourceRevision: textRevision(searchText),
    title,
    searchText,
    anchor: { session_id: session.id, archived: session.archived === 1 },
    archived: session.archived === 1,
    updatedAt: session.updated_at,
  }, fts);
}

function writeSessionWorktree(db: Db, session: SessionRow, fts: boolean): boolean {
  if (!session.branch && !session.worktree_path && !session.detected_worktree_path) {
    return deleteWhere(db, 'kind = ? AND source_id = ?', ['worktree', `wt:${session.id}`], fts) > 0;
  }
  const title = session.branch || session.name?.trim() || session.id;
  const searchText = projectSearchText([
    title,
    session.worktree_path,
    session.detected_worktree_path,
    session.base_branch,
  ].filter(Boolean).join('\n'));
  return writeDocument(db, {
    kind: 'worktree',
    sourceId: `wt:${session.id}`,
    ownerId: session.id,
    workspaceId: session.workspace_id,
    groupKey: null,
    sourceRevision: textRevision(searchText),
    title,
    searchText,
    anchor: {
      working_tree_id: `wt:${session.id}`,
      workspace_id: session.workspace_id,
      session_id: session.id,
      archived: session.archived === 1,
    },
    archived: session.archived === 1,
    updatedAt: session.updated_at,
  }, fts);
}

function writeWorkspace(db: Db, workspace: WorkspaceRow, fts: boolean): boolean {
  const searchText = projectSearchText(`${workspace.name}\n${workspace.path}`);
  return writeDocument(db, {
    kind: 'workspace',
    sourceId: workspace.id,
    ownerId: null,
    workspaceId: workspace.id,
    groupKey: null,
    sourceRevision: textRevision(searchText),
    title: workspace.name,
    searchText,
    anchor: { workspace_id: workspace.id },
    archived: false,
    updatedAt: workspace.updated_at,
  }, fts);
}

function writeTask(db: Db, task: TaskRow, fts: boolean): boolean {
  const searchText = projectSearchText([task.name, task.description].filter(Boolean).join('\n'));
  return writeDocument(db, {
    kind: 'task',
    sourceId: task.id,
    ownerId: null,
    workspaceId: null,
    groupKey: null,
    sourceRevision: textRevision(searchText),
    title: task.name,
    searchText,
    anchor: { task_id: task.id },
    archived: task.status === 'archived',
    updatedAt: task.updated_at,
  }, fts);
}

function reindexSchedule(db: Db, scheduleId: string, fts: boolean): boolean {
  const row = db.prepare(
    'SELECT id, name, prompt, status, updated_at FROM schedules WHERE id = ?',
  ).get(scheduleId) as { id: string; name: string; prompt: string; status: string; updated_at: string } | undefined;
  if (!row) return deleteWhere(db, 'kind = ? AND source_id = ?', ['schedule', scheduleId], fts) > 0;
  const searchText = projectSearchText(`${row.name}\n${row.prompt}`);
  return writeDocument(db, {
    kind: 'schedule',
    sourceId: row.id,
    ownerId: null,
    workspaceId: null,
    groupKey: null,
    sourceRevision: textRevision(searchText),
    title: row.name,
    searchText,
    anchor: { schedule_id: row.id, archived: row.status === 'archived' },
    archived: row.status === 'archived',
    updatedAt: row.updated_at,
  }, fts);
}

function reindexInbox(db: Db, inboxId: string, fts: boolean): boolean {
  const row = db.prepare(
    'SELECT id, title, summary, generation, tombstone, updated_at FROM inbox_items WHERE id = ?',
  ).get(inboxId) as {
    id: string; title: string; summary: string; generation: number; tombstone: number; updated_at: string;
  } | undefined;
  if (!row || row.tombstone === 1) {
    return deleteWhere(db, 'kind = ? AND source_id = ?', ['inbox', inboxId], fts) > 0;
  }
  const searchText = projectSearchText(`${row.title}\n${row.summary}`);
  return writeDocument(db, {
    kind: 'inbox',
    sourceId: row.id,
    ownerId: null,
    workspaceId: null,
    groupKey: null,
    sourceRevision: textRevision(searchText),
    title: row.title,
    searchText,
    anchor: { inbox_id: row.id, generation: row.generation },
    archived: false,
    updatedAt: row.updated_at,
  }, fts);
}

function applyInventoryPage(
  db: Db,
  trees: readonly SearchWorkingTreeSource[],
  cursor: string | null,
  pageSize: number,
  fts: boolean,
): { ids: string[]; cursor: string | null; wrote: boolean } {
  const page = trees
    .filter(tree => !cursor || tree.id > cursor)
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
    .slice(0, pageSize);
  let wrote = false;
  for (const tree of page) wrote = writeInventoryTree(db, tree, fts) || wrote;
  if (page.length >= pageSize && pageSize > 0) {
    return { ids: page.map(tree => tree.id), cursor: page[page.length - 1]!.id, wrote };
  }
  const live = new Set(trees.map(tree => tree.id));
  const stale = db.prepare(
    "SELECT id, source_id FROM search_documents WHERE kind = 'worktree'",
  ).all() as Array<{ id: string; source_id: string }>;
  const drop = stale
    .filter(row => (row.source_id.startsWith('ws:') || row.source_id.startsWith('ext:')) && !live.has(row.source_id))
    .map(row => row.id);
  for (let offset = 0; offset < drop.length; offset += 200) {
    const slice = drop.slice(offset, offset + 200);
    wrote = deleteWhere(db, `id IN (${slice.map(() => '?').join(', ')})`, slice, fts) > 0 || wrote;
  }
  return { ids: page.map(tree => tree.id), cursor: null, wrote };
}

function writeInventoryTree(db: Db, tree: SearchWorkingTreeSource, fts: boolean): boolean {
  let parsed: ReturnType<typeof parseWorkingTreeId>;
  try {
    parsed = parseWorkingTreeId(tree.id);
  } catch {
    return false;
  }
  const session = parsed.kind === 'session' ? sessionById(db, parsed.sessionId) : undefined;
  if (parsed.kind === 'session' && (!session || session.hidden)) {
    return deleteWhere(db, 'kind = ? AND source_id = ?', ['worktree', tree.id], fts) > 0;
  }
  const workspace = workspaceById(db, tree.workspace_id);
  if (workspace?.hidden) {
    return deleteWhere(db, 'kind = ? AND source_id = ?', ['worktree', tree.id], fts) > 0;
  }
  const archived = session?.archived === 1;
  const searchText = projectSearchText([tree.label, tree.branch, tree.path].filter(Boolean).join('\n'));
  const updatedAt = session?.updated_at
    ?? workspace?.updated_at
    ?? new Date(0).toISOString();
  return writeDocument(db, {
    kind: 'worktree',
    sourceId: tree.id,
    ownerId: tree.session_id,
    workspaceId: tree.workspace_id,
    groupKey: null,
    sourceRevision: textRevision(searchText),
    title: tree.label || tree.branch || tree.id,
    searchText,
    anchor: {
      working_tree_id: tree.id,
      workspace_id: tree.workspace_id,
      session_id: tree.session_id,
      archived,
    },
    archived,
    updatedAt,
  }, fts);
}

interface AgentLoad {
  status: 'unchanged' | 'missing' | 'invalid' | 'ready';
  marker: string;
  error?: string;
  agents?: unknown[];
}

async function loadAgentFile(db: Db, dataDir: string, onlyIfChanged: boolean): Promise<AgentLoad> {
  const path = join(dataDir, 'agents.json');
  let marker = 'missing';
  try {
    const info = statSync(path);
    marker = `${info.mtimeMs}:${info.size}`;
  } catch {
    return { status: 'missing', marker };
  }
  if (onlyIfChanged && readState(db).agent_marker === marker) return { status: 'unchanged', marker };
  try {
    const parsed = JSON.parse(await readFileText(path)) as { agents?: unknown };
    return {
      status: 'ready',
      marker,
      agents: Array.isArray(parsed.agents) ? parsed.agents : [],
    };
  } catch (error) {
    return {
      status: 'invalid',
      marker,
      error: error instanceof Error ? error.message : 'agents.json is invalid',
    };
  }
}

/** Returns true when the agent file is invalid and the stage must not advance. */
async function applyAgentStage(
  db: Db,
  dataDir: string,
  fts: boolean,
  onlyIfChanged: boolean,
  stopped: () => boolean,
): Promise<boolean> {
  const loaded = await loadAgentFile(db, dataDir, onlyIfChanged);
  if (stopped() || loaded.status === 'unchanged') return false;
  let failed = false;
  commitSearchUnit(db, () => {
    if (loaded.status === 'invalid') {
      setLastError(db, loaded.error ?? 'agents.json is invalid');
      failed = true;
      return false;
    }
    const wrote = loaded.status === 'missing'
      ? deleteWhere(db, 'kind = ?', ['agent'], fts) > 0
      : writeAgents(db, loaded.agents ?? [], loaded.marker, fts);
    db.prepare('UPDATE search_state SET agent_marker = ? WHERE id = 1').run(loaded.marker);
    if (!onlyIfChanged) finishPage(db, [], 0);
    return wrote;
  });
  return failed;
}

function writeAgents(db: Db, agents: readonly unknown[], marker: string, fts: boolean): boolean {
  const removed = deleteWhere(db, 'kind = ?', ['agent'], fts);
  let wrote = removed > 0;
  for (const candidate of agents) {
    if (!candidate || typeof candidate !== 'object') continue;
    const agent = candidate as { id?: unknown; name?: unknown; pluginId?: unknown; proxy?: unknown };
    if (typeof agent.id !== 'string' || typeof agent.name !== 'string') continue;
    const pluginId = typeof agent.pluginId === 'string' ? agent.pluginId : '';
    const proxy = typeof agent.proxy === 'string' ? agent.proxy : '';
    const searchText = projectSearchText([agent.name, pluginId, proxy].filter(Boolean).join('\n'));
    wrote = writeDocument(db, {
      kind: 'agent',
      sourceId: agent.id,
      ownerId: null,
      workspaceId: null,
      groupKey: null,
      sourceRevision: marker,
      title: agent.name,
      searchText,
      anchor: { agent_id: agent.id },
      archived: false,
      updatedAt: new Date(0).toISOString(),
    }, fts) || wrote;
  }
  return wrote;
}

async function readFileText(path: string): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  return readFile(path, 'utf8');
}

function writeDocument(db: Db, input: SearchDocumentInput, fts: boolean): boolean {
  const id = documentId(input.kind, input.sourceId);
  const anchor = JSON.stringify(input.anchor);
  const existing = db.prepare(
    `SELECT source_revision, title, subtitle, workspace_id, owner_id, group_key,
            anchor_json, archived, sort_turn, sort_pos, updated_at
     FROM search_documents WHERE id = ?`,
  ).get(id) as {
    source_revision: string; title: string; subtitle: string | null; workspace_id: string | null;
    owner_id: string | null; group_key: string | null; anchor_json: string; archived: number;
    sort_turn: number | null; sort_pos: number; updated_at: string;
  } | undefined;
  const same = !!existing
    && existing.source_revision === input.sourceRevision
    && existing.title === input.title
    && (existing.subtitle ?? null) === (input.subtitle ?? null)
    && existing.workspace_id === input.workspaceId
    && existing.owner_id === input.ownerId
    && existing.group_key === input.groupKey
    && existing.anchor_json === anchor
    && existing.archived === (input.archived ? 1 : 0)
    && (existing.sort_turn ?? null) === (input.sortTurn ?? null)
    && existing.sort_pos === (input.sortPos ?? 0)
    && existing.updated_at === input.updatedAt;
  if (same) {
    if (!fts) return false;
    const indexed = db.prepare('SELECT 1 AS hit FROM search_fts WHERE document_id = ?').get(id);
    if (indexed) return false;
  }
  upsertDocument(db, input, fts);
  return true;
}

interface SessionRow {
  id: string;
  name: string | null;
  workspace_id: string | null;
  task_id: string | null;
  archived: number;
  hidden: number;
  branch: string | null;
  base_branch: string | null;
  worktree_path: string | null;
  detected_worktree_path: string | null;
  updated_at: string;
}

interface WorkspaceRow {
  id: string;
  name: string;
  path: string;
  hidden: number;
  updated_at: string;
}

interface TaskRow {
  id: string;
  name: string;
  description: string | null;
  status: string;
  updated_at: string;
}

function sessionById(db: Db, id: string): SessionRow | undefined {
  return db.prepare(
    `SELECT id, name, workspace_id, task_id, archived, hidden, branch, base_branch,
            worktree_path, detected_worktree_path, updated_at
     FROM sessions WHERE id = ?`,
  ).get(id) as SessionRow | undefined;
}

function workspaceById(db: Db, id: string): WorkspaceRow | undefined {
  return db.prepare(
    'SELECT id, name, path, hidden, updated_at FROM workspaces WHERE id = ?',
  ).get(id) as WorkspaceRow | undefined;
}

function taskById(db: Db, id: string): TaskRow | undefined {
  return db.prepare(
    'SELECT id, name, description, status, updated_at FROM tasks WHERE id = ?',
  ).get(id) as TaskRow | undefined;
}
