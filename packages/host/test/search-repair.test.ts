// Search recovery regressions. NOT_RUN until the owner allows install,
// the shared build, and module-scoped checks.

import { createHash } from 'node:crypto';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseContextQuery, parseFindQuery, parseGlobalSearchQuery, SearchContractError } from '../../shared/src/search.js';
import { projectComposerSearchText, projectSearchText } from '../../shared/src/search-text.js';
import { EventStore } from '../src/session/event-store.js';
import { drainSearchOnce, type MaintainLimits } from '../src/search/maintain.js';
import { createSearchModule } from '../src/search/module.js';
import { findInSession, readContext, searchGlobal, searchStatus } from '../src/search/query.js';
import { documentId, readState } from '../src/search/store.js';
import type { SearchWorkingTreeSource } from '../src/search/types.js';
import { openDatabase, type Db } from '../src/storage/db.js';

const LIMITS: MaintainLimits = { dirtyPage: 10, sourcePage: 40, turnPage: 5 };

function openDb(): { dir: string; db: Db; close: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'gian-search-repair-'));
  const db = openDatabase(dir);
  return {
    dir,
    db,
    close() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function insertWorkspace(db: Db, id: string, name: string): void {
  db.prepare(
    `INSERT INTO workspaces(id, name, path, sort_order, hidden, created_at, updated_at)
     VALUES (?, ?, ?, 0, 0, datetime('now'), datetime('now'))`,
  ).run(id, name, `/tmp/${id}`);
}

async function settle(db: Db, dir: string, limits = LIMITS): Promise<void> {
  const trees: readonly SearchWorkingTreeSource[] = [];
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await drainSearchOnce(db, dir, async () => trees, limits);
    const state = readState(db);
    if (state.last_error) throw new Error(state.last_error);
    if (state.backfill_complete === 1) {
      const dirty = db.prepare('SELECT COUNT(*) AS n FROM search_dirty').get() as { n: number };
      if (dirty.n === 0 && state.fts_rebuild !== 1 && state.fts_mode === 'trigram') return;
    }
  }
  throw new Error(`search backfill stalled at ${readState(db).backfill_stage}`);
}

function poisonFtsInserts(db: Db, allow: number): () => void {
  const original = db.prepare.bind(db);
  let seen = 0;
  db.prepare = ((sql: string) => {
    const stmt = original(sql);
    if (sql.includes('INSERT INTO search_fts')) {
      const run = stmt.run.bind(stmt);
      stmt.run = ((...args: unknown[]) => {
        seen += 1;
        if (seen > allow) throw new Error('simulated fts failure');
        return run(...args);
      }) as typeof stmt.run;
    }
    return stmt;
  }) as typeof db.prepare;
  return () => {
    db.prepare = original as typeof db.prepare;
  };
}

function workspaceIds(db: Db): string[] {
  return (db.prepare(
    "SELECT source_id FROM search_documents WHERE kind = 'workspace' ORDER BY source_id",
  ).all() as Array<{ source_id: string }>).map(row => row.source_id);
}

test('a failed FTS insert does not keep a document that later drains would skip', async () => {
  const handle = openDb();
  const restore = poisonFtsInserts(handle.db, 0);
  try {
    insertWorkspace(handle.db, 'ws-a', 'Alpha Place');
    handle.db.prepare('DELETE FROM search_documents').run();
    handle.db.prepare(
      `UPDATE search_state
       SET fts_mode = 'trigram', fts_rebuild = 0, fts_cursor = NULL,
           index_revision = 5, backfill_stage = 'done', backfill_complete = 1,
           last_error = NULL
       WHERE id = 1`,
    ).run();
    await drainSearchOnce(handle.db, handle.dir, async () => []);
    assert.deepEqual(workspaceIds(handle.db), []);
    assert.equal(readState(handle.db).index_revision, 5);
    const dirty = handle.db.prepare(
      "SELECT source_key FROM search_dirty WHERE kind = 'workspace'",
    ).get() as { source_key: string };
    assert.equal(dirty.source_key, 'ws-a');
    restore();
    await drainSearchOnce(handle.db, handle.dir, async () => []);
    assert.deepEqual(workspaceIds(handle.db), ['ws-a']);
    const indexed = handle.db.prepare(
      'SELECT 1 AS hit FROM search_fts WHERE document_id = ?',
    ).get(documentId('workspace', 'ws-a')) as { hit: number } | undefined;
    assert.equal(indexed?.hit, 1);
    const found = searchGlobal(handle.db, parseGlobalSearchQuery({ q: 'Alpha Place' }));
    assert.equal(found.results.some(result => result.kind === 'workspace'), true);
  } finally {
    restore();
    handle.close();
  }
});

test('an earlier document keeps its revision when a later FTS insert fails', async () => {
  const handle = openDb();
  const restore = poisonFtsInserts(handle.db, 1);
  try {
    insertWorkspace(handle.db, 'ws-a', 'Alpha Place');
    insertWorkspace(handle.db, 'ws-b', 'Beta Place');
    handle.db.prepare('DELETE FROM search_documents').run();
    handle.db.prepare(
      `UPDATE search_state
       SET fts_mode = 'trigram', fts_rebuild = 0, fts_cursor = NULL,
           index_revision = 5, backfill_stage = 'done', backfill_complete = 1,
           last_error = NULL
       WHERE id = 1`,
    ).run();
    await drainSearchOnce(handle.db, handle.dir, async () => []);
    assert.equal(readState(handle.db).index_revision, 6);
    assert.deepEqual(workspaceIds(handle.db), ['ws-a']);
    const dirty = handle.db.prepare(
      "SELECT source_key FROM search_dirty WHERE kind = 'workspace' ORDER BY source_key",
    ).all() as Array<{ source_key: string }>;
    assert.deepEqual(dirty.map(row => row.source_key), ['ws-b']);
    const fts = handle.db.prepare('SELECT COUNT(*) AS n FROM search_fts').get() as { n: number };
    assert.equal(fts.n, 1);
  } finally {
    restore();
    handle.close();
  }
});

test('existing documents stay searchable until a trigram rebuild finishes', async () => {
  const handle = openDb();
  try {
    insertWorkspace(handle.db, 'ws-a', 'longtoken Alpha');
    insertWorkspace(handle.db, 'ws-b', 'longtoken Beta');
    await settle(handle.db, handle.dir);
    handle.db.prepare('DELETE FROM search_fts').run();
    handle.db.prepare(
      `UPDATE search_state
       SET fts_mode = 'unavailable', fts_rebuild = 0, fts_cursor = NULL, last_error = NULL
       WHERE id = 1`,
    ).run();
    await drainSearchOnce(handle.db, handle.dir, async () => [], { ...LIMITS, sourcePage: 1 });
    const rebuilding = readState(handle.db);
    assert.equal(rebuilding.fts_mode, 'unavailable');
    assert.equal(rebuilding.fts_rebuild, 1);
    const during = searchGlobal(handle.db, parseGlobalSearchQuery({ q: 'longtoken', types: 'workspace' }));
    assert.equal(during.coverage.state, 'building');
    assert.equal(during.results.length, 2);
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await drainSearchOnce(handle.db, handle.dir, async () => [], { ...LIMITS, sourcePage: 1 });
      if (readState(handle.db).fts_mode === 'trigram' && readState(handle.db).fts_rebuild === 0) break;
    }
    const ready = readState(handle.db);
    assert.equal(ready.fts_mode, 'trigram');
    assert.equal(ready.fts_rebuild, 0);
    const docs = handle.db.prepare('SELECT COUNT(*) AS n FROM search_documents').get() as { n: number };
    const fts = handle.db.prepare('SELECT COUNT(*) AS n FROM search_fts').get() as { n: number };
    assert.equal(fts.n, docs.n);
    const after = searchGlobal(handle.db, parseGlobalSearchQuery({ q: 'longtoken', types: 'workspace' }));
    assert.equal(after.coverage.state, 'ready');
    assert.equal(after.results.length, 2);
  } finally {
    handle.close();
  }
});

function insertSession(db: Db, id: string, name: string, workspaceId: string): void {
  db.prepare(
    `INSERT INTO sessions(
       id, name, type, workspace_id, executor, approval_mode, status, archived, unread,
       native_session_id, created_at, updated_at
     ) VALUES (?, ?, 'primary', ?, 'codex', 'plan', 'running', 0, 0, ?, datetime('now'), datetime('now'))`,
  ).run(id, name, workspaceId, `native-${id}`);
}

function insertTurn(db: Db, id: string, sessionId: string, turnNumber: number): void {
  db.prepare(
    'INSERT INTO turns(id, session_id, turn_number, status) VALUES (?, ?, ?, ?)',
  ).run(id, sessionId, turnNumber, 'completed');
}

interface MessageSnap {
  sort_turn: number | null;
  search_text: string;
  updated_at: string;
  title: string;
  archived: number;
  workspace_id: string | null;
}

function messageSnaps(db: Db, sessionId: string): MessageSnap[] {
  return db.prepare(
    `SELECT sort_turn, search_text, updated_at, title, archived, workspace_id
     FROM search_documents
     WHERE kind = 'message' AND owner_id = ?
     ORDER BY sort_turn ASC, sort_pos ASC`,
  ).all(sessionId) as MessageSnap[];
}

test('unread and status updates do not rebuild old message bodies', async () => {
  const handle = openDb();
  try {
    const { db, dir } = handle;
    insertWorkspace(db, 'ws-1', 'Place');
    insertSession(db, 'sess-old', 'Old Session', 'ws-1');
    const events = new EventStore(db);
    for (let turn = 1; turn <= 6; turn += 1) {
      const turnId = `turn-${turn}`;
      insertTurn(db, turnId, 'sess-old', turn);
      events.persist({
        sessionId: 'sess-old',
        turnId,
        callId: `user-${turn}`,
        type: 'user_message',
        data: { text: `body-stable-${turn}` },
      });
      db.prepare('UPDATE events SET created_at = ? WHERE turn_id = ?').run(
        `2020-01-0${turn} 03:04:05`,
        turnId,
      );
    }
    await settle(db, dir);
    const before = messageSnaps(db, 'sess-old');
    assert.equal(before.length, 6);
    const revision = readState(db).index_revision;
    for (const row of before) {
      assert.equal(row.updated_at, `2020-01-0${row.sort_turn}T03:04:05.000Z`);
      assert.equal(row.search_text.includes(`body-stable-${row.sort_turn}`), true);
    }
    db.prepare(
      `UPDATE sessions
       SET unread = 4, status = 'idle', last_accessed_at = '2024-08-09 10:11:12',
           updated_at = '2024-08-09 10:11:12', conversation_total_tokens = 90
       WHERE id = 'sess-old'`,
    ).run();
    await drainSearchOnce(db, dir, async () => []);
    assert.equal(readState(db).index_revision, revision);
    assert.deepEqual(messageSnaps(db, 'sess-old'), before);
    const dirty = db.prepare(
      "SELECT COUNT(*) AS n FROM search_dirty WHERE kind IN ('session', 'turn')",
    ).get() as { n: number };
    assert.equal(dirty.n, 0);
  } finally {
    handle.close();
  }
});

test('name, archive, and workspace changes propagate without rewriting bodies', async () => {
  const handle = openDb();
  try {
    const { db, dir } = handle;
    insertWorkspace(db, 'ws-1', 'Place One');
    insertWorkspace(db, 'ws-2', 'Place Two');
    insertSession(db, 'sess-meta', 'Original Name', 'ws-1');
    const events = new EventStore(db);
    for (let turn = 1; turn <= 4; turn += 1) {
      const turnId = `meta-${turn}`;
      insertTurn(db, turnId, 'sess-meta', turn);
      events.persist({
        sessionId: 'sess-meta',
        turnId,
        callId: `user-${turn}`,
        type: 'user_message',
        data: { text: `kept-body-${turn}` },
      });
    }
    await settle(db, dir);
    const bodies = messageSnaps(db, 'sess-meta').map(row => row.search_text);
    const times = messageSnaps(db, 'sess-meta').map(row => row.updated_at);
    db.prepare("UPDATE sessions SET name = 'Renamed Session' WHERE id = 'sess-meta'").run();
    const revision = readState(db).index_revision;
    await drainSearchOnce(db, dir, async () => [], { ...LIMITS, turnPage: 1, sourcePage: 1 });
    assert.ok(readState(db).index_revision > revision);
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM search_dirty WHERE kind = 'turn'").get() as { n: number }).n,
      0,
    );
    const sessionTitle = db.prepare(
      "SELECT title FROM search_documents WHERE kind = 'session' AND source_id = 'sess-meta'",
    ).get() as { title: string };
    assert.equal(sessionTitle.title, 'Renamed Session');
    const once = messageSnaps(db, 'sess-meta');
    assert.deepEqual(once.map(row => row.search_text), bodies);
    assert.deepEqual(once.map(row => row.updated_at), times);
    assert.equal(once.filter(row => row.title === 'Renamed Session').length, 1);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await drainSearchOnce(db, dir, async () => [], { ...LIMITS, turnPage: 1, sourcePage: 1 });
      const pending = db.prepare(
        "SELECT 1 AS hit FROM search_dirty WHERE kind = 'session' AND source_key = 'sess-meta'",
      ).get();
      if (!pending) break;
    }
    db.prepare('UPDATE sessions SET archived = 1 WHERE id = ?').run('sess-meta');
    db.prepare('UPDATE sessions SET workspace_id = ? WHERE id = ?').run('ws-2', 'sess-meta');
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await drainSearchOnce(db, dir, async () => [], { ...LIMITS, turnPage: 1, sourcePage: 1 });
      const pending = db.prepare(
        "SELECT 1 AS hit FROM search_dirty WHERE kind = 'session' AND source_key = 'sess-meta'",
      ).get();
      if (!pending) break;
    }
    const after = messageSnaps(db, 'sess-meta');
    assert.deepEqual(after.map(row => row.search_text), bodies);
    assert.deepEqual(after.map(row => row.updated_at), times);
    assert.equal(after.every(row => row.title === 'Renamed Session' && row.archived === 1 && row.workspace_id === 'ws-2'), true);
    const found = searchGlobal(db, parseGlobalSearchQuery({
      q: 'kept-body-4',
      types: 'message',
      include_archived: '1',
      workspace_id: 'ws-2',
    }));
    assert.equal(found.results.some(result => result.kind === 'message'), true);
  } finally {
    handle.close();
  }
});

test('workspace and task fanout keeps a persistent page cursor', async () => {
  const handle = openDb();
  try {
    const { db, dir } = handle;
    insertWorkspace(db, 'ws-fan', 'Old Workspace');
    db.prepare(
      `INSERT INTO tasks(id, name, description, status, created_at, updated_at)
       VALUES ('task-fan', 'Old Task', 'task-note', 'open', datetime('now'), datetime('now'))`,
    ).run();
    for (const id of ['sess-a', 'sess-b', 'sess-c']) insertSession(db, id, id, 'ws-fan');
    db.prepare("UPDATE sessions SET task_id = 'task-fan' WHERE workspace_id = 'ws-fan'").run();
    await settle(db, dir);
    db.prepare("UPDATE workspaces SET name = 'New Workspace' WHERE id = 'ws-fan'").run();
    await drainSearchOnce(db, dir, async () => [], { ...LIMITS, sourcePage: 1, turnPage: 1 });
    const workspaceDirty = db.prepare(
      "SELECT cursor FROM search_dirty WHERE kind = 'workspace' AND source_key = 'ws-fan'",
    ).get() as { cursor: string | null };
    assert.equal(workspaceDirty.cursor, 'sess-a');
    const renamed = db.prepare(
      `SELECT source_id FROM search_documents
       WHERE kind = 'session' AND search_text LIKE '%New Workspace%'
       ORDER BY source_id`,
    ).all() as Array<{ source_id: string }>;
    assert.deepEqual(renamed.map(row => row.source_id), ['sess-a']);
    db.prepare("DELETE FROM search_dirty WHERE kind = 'workspace'").run();
    db.prepare("UPDATE tasks SET name = 'New Task' WHERE id = 'task-fan'").run();
    await drainSearchOnce(db, dir, async () => [], { ...LIMITS, sourcePage: 1, turnPage: 1 });
    const taskDirty = db.prepare(
      "SELECT cursor FROM search_dirty WHERE kind = 'task' AND source_key = 'task-fan'",
    ).get() as { cursor: string | null };
    assert.equal(taskDirty.cursor, 'sess-a');
    const taskHits = db.prepare(
      `SELECT source_id FROM search_documents
       WHERE kind = 'session' AND search_text LIKE '%New Task%'
       ORDER BY source_id`,
    ).all() as Array<{ source_id: string }>;
    assert.deepEqual(taskHits.map(row => row.source_id), ['sess-a']);
    const turns = db.prepare("SELECT COUNT(*) AS n FROM search_dirty WHERE kind = 'turn'").get() as { n: number };
    assert.equal(turns.n, 0);
  } finally {
    handle.close();
  }
});

test('find budget advances past a fully scanned message', async () => {
  const handle = openDb();
  try {
    const { db, dir } = handle;
    insertWorkspace(db, 'ws-find', 'Find Place');
    insertSession(db, 'sess-find', 'Find Session', 'ws-find');
    const events = new EventStore(db);
    insertTurn(db, 'find-1', 'sess-find', 1);
    insertTurn(db, 'find-2', 'sess-find', 2);
    events.persist({
      sessionId: 'sess-find', turnId: 'find-1', callId: 'u1', type: 'user_message',
      data: { text: 'nothing-here' },
    });
    events.persist({
      sessionId: 'sess-find', turnId: 'find-2', callId: 'u2', type: 'user_message',
      data: { text: 'needle-token sits here' },
    });
    await settle(db, dir);
    let cursor: string | undefined;
    let previous: string | undefined;
    let seen = 0;
    let complete = false;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const page = findInSession(db, parseFindQuery('sess-find', {
        q: 'needle-token',
        ...(cursor ? { cursor } : {}),
      }), 1);
      if (page.next_cursor) assert.notEqual(page.next_cursor, previous);
      previous = page.next_cursor ?? previous;
      seen += page.matches.length;
      cursor = page.next_cursor ?? undefined;
      if (page.total_complete) {
        assert.equal(page.next_cursor, null);
        assert.equal(page.total, 1);
        complete = true;
        break;
      }
    }
    assert.equal(complete, true);
    assert.equal(seen, 1);

    let hitCursor: string | undefined;
    let hits = 0;
    let hitComplete = false;
    insertTurn(db, 'find-3', 'sess-find', 3);
    events.persist({
      sessionId: 'sess-find',
      turnId: 'find-3',
      callId: 'u3',
      type: 'user_message',
      data: { text: 'pairword '.repeat(4).trim() },
    });
    await settle(db, dir);
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const page = findInSession(db, parseFindQuery('sess-find', {
        q: 'pairword',
        limit: '2',
        ...(hitCursor ? { cursor: hitCursor } : {}),
      }));
      assert.ok(page.matches.length <= 2);
      hits += page.matches.length;
      hitCursor = page.next_cursor ?? undefined;
      if (!page.next_cursor) {
        assert.equal(page.total, 4);
        assert.equal(page.total_complete, true);
        hitComplete = true;
        break;
      }
    }
    assert.equal(hitComplete, true);
    assert.equal(hits, 4);

    let emptyCursor: string | undefined;
    let emptyComplete = false;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const page = findInSession(db, parseFindQuery('sess-find', {
        q: 'absent-token',
        ...(emptyCursor ? { cursor: emptyCursor } : {}),
      }), 1);
      if (page.next_cursor) assert.notEqual(page.next_cursor, emptyCursor);
      emptyCursor = page.next_cursor ?? undefined;
      if (page.total_complete) {
        assert.equal(page.total, 0);
        assert.equal(page.next_cursor, null);
        emptyComplete = true;
        break;
      }
    }
    assert.equal(emptyComplete, true);
  } finally {
    handle.close();
  }
});

function textRevisionOf(text: string): string {
  return createHash('sha256').update(projectSearchText(text)).digest('hex');
}

test('context rejects a stale message revision and does not treat search backfill as cold history', async () => {
  const handle = openDb();
  try {
    const { db, dir } = handle;
    insertWorkspace(db, 'ws-rev', 'Revision Place');
    insertSession(db, 'sess-rev', 'Revision Session', 'ws-rev');
    insertTurn(db, 'rev-turn', 'sess-rev', 1);
    const events = new EventStore(db);
    events.persist({
      sessionId: 'sess-rev',
      turnId: 'rev-turn',
      callId: 'rev-user',
      type: 'user_message',
      data: { text: 'original-token' },
    });
    await settle(db, dir);
    const indexed = db.prepare(
      "SELECT id, anchor_json FROM search_documents WHERE kind = 'message' AND owner_id = 'sess-rev'",
    ).get() as { id: string; anchor_json: string };
    const oldRevision = (JSON.parse(indexed.anchor_json) as { text_revision: string }).text_revision;
    assert.equal(oldRevision, textRevisionOf('original-token'));
    events.persist({
      sessionId: 'sess-rev',
      turnId: 'rev-turn',
      callId: 'rev-user',
      type: 'user_message',
      data: { text: 'changed-token' },
    });
    const stale = {
      turn_id: 'rev-turn',
      document_id: indexed.id,
      text_revision: oldRevision,
    };
    assert.throws(
      () => readContext(db, parseContextQuery('sess-rev', stale)),
      (error: unknown) => error instanceof SearchContractError && error.code === 'text_revision_mismatch',
    );
    assert.throws(
      () => readContext(db, parseContextQuery('sess-rev', { turn_id: 'rev-turn', document_id: indexed.id })),
      (error: unknown) => error instanceof SearchContractError && error.code === 'text_revision_mismatch',
    );
    const fresh = readContext(db, parseContextQuery('sess-rev', {
      turn_id: 'rev-turn',
      document_id: indexed.id,
      text_revision: textRevisionOf('changed-token'),
    }));
    assert.equal(JSON.stringify(fresh.events).includes('changed-token'), true);
    assert.equal(fresh.session.projection, 'search-context');
    assert.equal('executor' in fresh.session, false);
    assert.equal(fresh.history_complete, true);
    await settle(db, dir);
    db.exec(`
      CREATE TABLE event_rebuild_state (
        session_id TEXT PRIMARY KEY,
        complete INTEGER NOT NULL
      );
      INSERT INTO event_rebuild_state (session_id, complete) VALUES ('sess-rev', 0);
    `);
    const status = searchStatus(db);
    assert.equal(status.coverage.state, 'building');
    assert.equal(status.coverage.complete, false);
    const globalCold = searchGlobal(db, parseGlobalSearchQuery({ q: 'changed-token' }));
    assert.equal(globalCold.coverage.state, 'building');
    assert.equal(globalCold.coverage.complete, false);
    const found = findInSession(db, parseFindQuery('sess-rev', { q: 'changed-token' }));
    assert.equal(found.total_complete, false);
    assert.equal(found.coverage.state, 'building');
    assert.equal(found.coverage.complete, false);
    const cold = readContext(db, parseContextQuery('sess-rev', { turn_id: 'rev-turn' }));
    assert.equal(cold.history_complete, false);
    assert.equal(cold.session.projection, 'search-context');
    assert.equal(JSON.stringify(cold.events).includes('changed-token'), true);
  } finally {
    handle.close();
  }
});

test('hidden and deleted cold history does not mark visible search complete', async () => {
  const handle = openDb();
  try {
    const { db, dir } = handle;
    insertWorkspace(db, 'ws-cold', 'Cold Place');
    insertSession(db, 'sess-open', 'Open Session', 'ws-cold');
    insertSession(db, 'sess-cold', 'Cold Session', 'ws-cold');
    insertSession(db, 'sess-hidden', 'Hidden Cold', 'ws-cold');
    insertTurn(db, 'open-turn', 'sess-open', 1);
    insertTurn(db, 'cold-turn', 'sess-cold', 1);
    const events = new EventStore(db);
    events.persist({
      sessionId: 'sess-open', turnId: 'open-turn', callId: 'open-user', type: 'user_message',
      data: { text: 'open-visible-token' },
    });
    events.persist({
      sessionId: 'sess-cold', turnId: 'cold-turn', callId: 'cold-user', type: 'user_message',
      data: { text: 'cold-visible-token' },
    });
    await settle(db, dir);
    db.prepare("UPDATE sessions SET hidden = 1 WHERE id = 'sess-hidden'").run();
    db.prepare('DELETE FROM search_dirty').run();
    db.exec(`
      CREATE TABLE event_rebuild_state (
        session_id TEXT PRIMARY KEY,
        complete INTEGER NOT NULL
      );
      INSERT INTO event_rebuild_state (session_id, complete) VALUES
        ('sess-hidden', 0),
        ('deleted-session', 0);
    `);
    const readyStatus = searchStatus(db);
    assert.equal(readyStatus.coverage.state, 'ready');
    assert.equal(readyStatus.coverage.complete, true);
    const readyGlobal = searchGlobal(db, parseGlobalSearchQuery({ q: 'open-visible-token' }));
    assert.equal(readyGlobal.coverage.state, 'ready');
    assert.equal(readyGlobal.coverage.complete, true);
    assert.equal(readyGlobal.results.length > 0, true);
    const openFind = findInSession(db, parseFindQuery('sess-open', { q: 'open-visible-token' }));
    assert.equal(openFind.total_complete, true);
    assert.equal(openFind.coverage.state, 'ready');
    assert.equal(openFind.coverage.complete, true);
    db.prepare(
      "INSERT INTO event_rebuild_state (session_id, complete) VALUES ('sess-cold', 0)",
    ).run();
    const blockedStatus = searchStatus(db);
    assert.equal(blockedStatus.coverage.state, 'building');
    assert.equal(blockedStatus.coverage.complete, false);
    const blockedGlobal = searchGlobal(db, parseGlobalSearchQuery({ q: 'open-visible-token' }));
    assert.equal(blockedGlobal.coverage.state, 'building');
    assert.equal(blockedGlobal.coverage.complete, false);
    const stillOpen = findInSession(db, parseFindQuery('sess-open', { q: 'open-visible-token' }));
    assert.equal(stillOpen.total_complete, true);
    assert.equal(stillOpen.coverage.state, 'ready');
    assert.equal(stillOpen.coverage.complete, true);
    const coldFind = findInSession(db, parseFindQuery('sess-cold', { q: 'cold-visible-token' }));
    assert.equal(coldFind.total_complete, false);
    assert.equal(coldFind.coverage.state, 'building');
    assert.equal(coldFind.coverage.complete, false);
    assert.equal(coldFind.coverage.complete, coldFind.total_complete);
  } finally {
    handle.close();
  }
});

test('a query does not delete a missing source or move the index revision', async () => {
  const handle = openDb();
  try {
    const { db, dir } = handle;
    insertWorkspace(db, 'ws-ghost', 'ghost-workspace-token');
    insertSession(db, 'sess-ghost', 'ghost-session-token', 'ws-ghost');
    insertTurn(db, 'ghost-turn', 'sess-ghost', 1);
    new EventStore(db).persist({
      sessionId: 'sess-ghost',
      turnId: 'ghost-turn',
      callId: 'ghost-user',
      type: 'user_message',
      data: { text: 'ghost-message-token' },
    });
    await settle(db, dir);
    const revision = readState(db).index_revision;
    const ids = (db.prepare(
      `SELECT id FROM search_documents
       WHERE (kind = 'workspace' AND source_id = 'ws-ghost')
          OR (kind = 'session' AND source_id = 'sess-ghost')
          OR (kind = 'message' AND owner_id = 'sess-ghost')
       ORDER BY id`,
    ).all() as Array<{ id: string }>).map(row => row.id);
    assert.equal(ids.length, 3);
    const ftsBefore = ftsCount(db, ids);
    db.prepare('DELETE FROM workspaces WHERE id = ?').run('ws-ghost');
    db.prepare("UPDATE sessions SET hidden = 1 WHERE id = 'sess-ghost'").run();
    db.prepare('DELETE FROM search_dirty').run();
    assert.equal(searchGlobal(db, parseGlobalSearchQuery({ q: 'ghost-workspace-token', types: 'workspace' })).results.length, 0);
    assert.equal(searchGlobal(db, parseGlobalSearchQuery({ q: 'ghost-session-token', types: 'session' })).results.length, 0);
    assert.equal(searchGlobal(db, parseGlobalSearchQuery({
      q: 'ghost-message-token',
      types: 'message',
      include_archived: '1',
    })).results.length, 0);
    assert.equal(readState(db).index_revision, revision);
    assert.equal(ftsCount(db, ids), ftsBefore);
    assert.equal(ftsBefore, ids.length);
    const left = db.prepare(
      `SELECT COUNT(*) AS n FROM search_documents WHERE id IN (${ids.map(() => '?').join(', ')})`,
    ).get(...ids) as { n: number };
    assert.equal(left.n, ids.length);
  } finally {
    handle.close();
  }
});

function ftsCount(db: Db, ids: readonly string[]): number {
  return (db.prepare(
    `SELECT COUNT(*) AS n FROM search_fts WHERE document_id IN (${ids.map(() => '?').join(', ')})`,
  ).get(...ids) as { n: number }).n;
}

test('composer documents and legacy text share one search projection', async () => {
  const handle = openDb();
  try {
    const { db, dir } = handle;
    const composer = {
      version: 1 as const,
      segments: [
        { type: 'text' as const, text: 'before ' },
        { type: 'reference' as const, id: 'note', referenceType: 'context' as const, label: 'Notes' },
        { type: 'text' as const, text: ' after' },
      ],
    };
    insertWorkspace(db, 'ws-doc', 'Document Place');
    insertSession(db, 'sess-doc', 'Document Session', 'ws-doc');
    insertTurn(db, 'legacy-turn', 'sess-doc', 1);
    insertTurn(db, 'doc-turn', 'sess-doc', 2);
    const events = new EventStore(db);
    events.persist({
      sessionId: 'sess-doc', turnId: 'legacy-turn', callId: 'legacy-user', type: 'user_message',
      data: { text: 'plain-legacy-token' },
    });
    events.persist({
      sessionId: 'sess-doc', turnId: 'doc-turn', callId: 'doc-user', type: 'user_message',
      data: {
        text: 'compiled-body-should-not-index',
        composer_document: composer,
      },
    });
    await settle(db, dir);
    const legacy = db.prepare(
      "SELECT search_text FROM search_documents WHERE kind = 'message' AND group_key = 'legacy-turn'",
    ).get() as { search_text: string };
    assert.equal(legacy.search_text, 'plain-legacy-token');
    const indexed = db.prepare(
      "SELECT id, search_text, anchor_json FROM search_documents WHERE kind = 'message' AND group_key = 'doc-turn'",
    ).get() as { id: string; search_text: string; anchor_json: string };
    const projected = projectComposerSearchText(composer);
    assert.equal(projected, 'before Notes after');
    assert.equal(indexed.search_text, projected);
    assert.equal(indexed.search_text.includes('compiled-body-should-not-index'), false);
    assert.equal(indexed.search_text.includes('"Notes"'), false);
    const revision = (JSON.parse(indexed.anchor_json) as { text_revision: string }).text_revision;
    assert.equal(revision, createHash('sha256').update(projected).digest('hex'));
    const page = readContext(db, parseContextQuery('sess-doc', {
      turn_id: 'doc-turn',
      document_id: indexed.id,
      text_revision: revision,
    }));
    assert.equal(JSON.stringify(page.events).includes('before '), true);
    assert.throws(
      () => readContext(db, parseContextQuery('sess-doc', {
        turn_id: 'doc-turn',
        document_id: indexed.id,
        text_revision: createHash('sha256').update('compiled-body-should-not-index').digest('hex'),
      })),
      (error: unknown) => error instanceof SearchContractError && error.code === 'text_revision_mismatch',
    );
  } finally {
    handle.close();
  }
});

test('dispose waits for a delayed inventory and does not write a closed database', async () => {
  const handle = openDb();
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => {
    const stack = reason instanceof Error ? `${reason.stack ?? ''}\n${reason.message}` : String(reason);
    if (stack.includes('packages/host/src/search/')) rejections.push(reason);
  };
  process.on('unhandledRejection', onRejection);
  try {
    const { db, dir } = handle;
    db.prepare("UPDATE search_state SET backfill_stage = 'worktree', backfill_cursor = NULL WHERE id = 1").run();
    let release: (trees: readonly SearchWorkingTreeSource[]) => void = () => {};
    let markEntered: () => void = () => {};
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const gate = new Promise<readonly SearchWorkingTreeSource[]>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    let mutations = 0;
    let armed = false;
    const originalPrepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => {
      if (armed && /^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql)) mutations += 1;
      return originalPrepare(sql);
    }) as typeof db.prepare;
    const mod = createSearchModule({
      db,
      dataDir: dir,
      listWorkingTrees: () => {
        calls += 1;
        markEntered();
        return gate;
      },
    });
    mod.start();
    await entered;
    armed = true;
    const pending = mod.dispose();
    assert.equal(pending instanceof Promise, true);
    db.close();
    release([]);
    await pending;
    await new Promise((resolve) => {
      setTimeout(resolve, 40);
    });
    assert.equal(calls, 1);
    assert.equal(mutations, 0);
    assert.equal(rejections.length, 0);
  } finally {
    process.off('unhandledRejection', onRejection);
    try {
      handle.db.close();
    } catch {
      // The test closes the database before the delayed inventory returns.
    }
    rmSync(handle.dir, { recursive: true, force: true });
  }
});
