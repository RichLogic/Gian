// Search index, query, and route handlers on a bare Hono.
// NOT_RUN until the owner allows install, shared build, and module-scoped checks.
// createApp mounts the same routes; this file does not boot the host app.

import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Hono } from 'hono';
import { GIAN_ACTION_CLOSE, GIAN_ACTION_OPEN, GIAN_ROLE_CLOSE, GIAN_ROLE_OPEN } from '../../shared/src/action.js';
import { MANAGER_SYS_CLOSE, MANAGER_SYS_OPEN } from '../../shared/src/manager.js';
import {
  SearchContractError,
  parseContextQuery,
  parseFindQuery,
  parseGlobalSearchQuery,
  type SearchPage,
  type SearchResult,
} from '../../shared/src/search.js';
import { EventStore } from '../src/session/event-store.js';
import { createSearchModule } from '../src/search/module.js';
import { drainSearchOnce, type MaintainLimits } from '../src/search/maintain.js';
import { findInSession, readContext, searchGlobal } from '../src/search/query.js';
import { SEARCH_SCAN_BUDGET, dirtyCount, readState } from '../src/search/store.js';
import type { SearchWorkingTreeSource } from '../src/search/types.js';
import { openDatabase, type Db } from '../src/storage/db.js';

const LIMITS: MaintainLimits = { dirtyPage: 10, sourcePage: 40, turnPage: 5 };

function openDb(): { dir: string; db: Db; close: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'gian-search-'));
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

function insertWorkspace(db: Db, id: string, name: string, path: string): void {
  db.prepare(
    `INSERT INTO workspaces(id, name, path, sort_order, hidden, created_at, updated_at)
     VALUES (?, ?, ?, 0, 0, datetime('now'), datetime('now'))`,
  ).run(id, name, path);
}

function insertSession(db: Db, id: string, name: string, workspaceId: string, archived = 0): void {
  db.prepare(
    `INSERT INTO sessions(
       id, name, type, workspace_id, executor, approval_mode, status, archived, unread,
       native_session_id, created_at, updated_at
     ) VALUES (?, ?, 'primary', ?, 'codex', 'plan', 'running', ?, 0, ?, datetime('now'), datetime('now'))`,
  ).run(id, name, workspaceId, archived, `native-${id}`);
}

function insertTurn(db: Db, id: string, sessionId: string, turnNumber: number): void {
  db.prepare(
    'INSERT INTO turns(id, session_id, turn_number, status) VALUES (?, ?, ?, ?)',
  ).run(id, sessionId, turnNumber, 'completed');
}

function collect(
  db: Db,
  q: string,
  extra: Record<string, string> = {},
  budget = SEARCH_SCAN_BUDGET,
): { results: SearchResult[]; coverage: SearchPage['coverage'] } {
  const results: SearchResult[] = [];
  let cursor: string | undefined;
  let coverage: SearchPage['coverage'] | null = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const page = searchGlobal(db, parseGlobalSearchQuery({
      q,
      ...extra,
      ...(cursor ? { cursor } : {}),
    }), budget);
    results.push(...page.results);
    coverage = page.coverage;
    if (!page.next_cursor) return { results, coverage };
    cursor = page.next_cursor;
  }
  throw new Error(`search cursor did not finish for ${q}`);
}

async function settle(
  db: Db,
  dir: string,
  trees: readonly SearchWorkingTreeSource[] = [],
  limits = LIMITS,
): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await drainSearchOnce(db, dir, async options => {
      assert.equal(options?.includeArchived, true);
      return trees;
    }, limits);
    const state = readState(db);
    if (state.last_error) throw new Error(state.last_error);
    if (state.backfill_complete === 1 && dirtyCount(db) === 0) return;
  }
  throw new Error(`search backfill stalled at ${readState(db).backfill_stage}`);
}

test('source dirty rows survive reopen without an in-memory event hook', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gian-search-reopen-'));
  const db = openDatabase(dir);
  insertWorkspace(db, 'ws-1', 'Persistent Place', '/tmp/persistent');
  assert.ok(dirtyCount(db) > 0);
  db.close();
  const reopened = openDatabase(dir);
  try {
    assert.ok(dirtyCount(reopened) > 0);
    await settle(reopened, dir);
    const found = collect(reopened, 'Persistent Place');
    assert.equal(found.results.some(result => result.kind === 'workspace'), true);
    assert.equal(found.coverage.state, 'ready');
  } finally {
    reopened.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('backfill resumes after the stored cursor', async () => {
  const handle = openDb();
  try {
    insertWorkspace(handle.db, 'ws-a', 'Alpha', '/tmp/a');
    insertWorkspace(handle.db, 'ws-b', 'Beta', '/tmp/b');
    handle.db.prepare('DELETE FROM search_dirty').run();
    handle.db.prepare('DELETE FROM search_documents').run();
    handle.db.prepare(
      `UPDATE search_state
       SET backfill_stage = 'workspace', backfill_cursor = NULL, backfill_complete = 0,
           index_revision = 0, last_error = NULL`,
    ).run();
    const limits = { dirtyPage: 1, sourcePage: 1, turnPage: 1 };
    await drainSearchOnce(handle.db, handle.dir, async () => [], limits);
    const first = handle.db.prepare(
      "SELECT source_id FROM search_documents WHERE kind = 'workspace' ORDER BY source_id",
    ).all() as Array<{ source_id: string }>;
    assert.deepEqual(first.map(row => row.source_id), ['ws-a']);
    assert.equal(readState(handle.db).backfill_cursor, 'ws-a');
    assert.equal(readState(handle.db).backfill_complete, 0);
    await drainSearchOnce(handle.db, handle.dir, async () => [], limits);
    const second = handle.db.prepare(
      "SELECT source_id FROM search_documents WHERE kind = 'workspace' ORDER BY source_id",
    ).all() as Array<{ source_id: string }>;
    assert.deepEqual(second.map(row => row.source_id), ['ws-a', 'ws-b']);
    assert.equal(readState(handle.db).backfill_cursor, 'ws-b');
  } finally {
    handle.close();
  }
});

test('search module mounts routes and dispose cancels the pending tick', async () => {
  const handle = openDb();
  try {
    let calls = 0;
    const mod = createSearchModule({
      db: handle.db,
      dataDir: handle.dir,
      listWorkingTrees: async () => {
        calls += 1;
        return [];
      },
    });
    const app = new Hono();
    mod.register(app);
    mod.start();
    mod.start();
    mod.dispose();
    mod.dispose();
    assert.equal(calls, 0);
    const status = await app.request('http://127.0.0.1/api/search/status');
    assert.equal(status.status, 200);
    const body = await status.json() as { coverage: { state: string } };
    assert.equal(body.coverage.state, 'building');
  } finally {
    handle.close();
  }
});

test('index and query canonical history without leaking hidden or archived rows', async () => {
  const handle = openDb();
  try {
    const { db, dir } = handle;
    insertWorkspace(db, 'ws-1', 'Workspace One', '/tmp/ws-1');
    insertWorkspace(db, 'ws-2', 'Workspace Two', '/tmp/ws-2');
    db.prepare(
      `INSERT INTO tasks(id, name, description, status, created_at, updated_at)
       VALUES ('task-1', 'task-name', 'task-body-token', 'open', datetime('now'), datetime('now'))`,
    ).run();
    insertSession(db, 'sess-main', 'Session Alpha', 'ws-1');
    insertSession(db, 'sess-archive', 'Archive Keep', 'ws-1', 1);
    insertSession(db, 'sess-hidden', 'Hidden Secret', 'ws-1');
    db.prepare(
      `UPDATE sessions
       SET task_id = 'task-1', agent_id = 'agent-1', branch = 'feature/search', worktree_path = '/tmp/ws-1/tree'
       WHERE id = 'sess-main'`,
    ).run();
    db.prepare("UPDATE sessions SET branch = 'archive-branch' WHERE id = 'sess-archive'").run();
    for (const [id, sessionId, turn] of [
      ['t1', 'sess-main', 1],
      ['t2', 'sess-main', 2],
      ['t3', 'sess-main', 3],
      ['t4', 'sess-main', 4],
      ['ta', 'sess-archive', 1],
      ['th', 'sess-hidden', 1],
    ] as const) insertTurn(db, id, sessionId, turn);

    const events = new EventStore(db);
    const user = (turnId: string, callId: string, text: string, sessionId = 'sess-main') => {
      events.persist({ sessionId, turnId, callId, type: 'user_message', data: { text } });
    };
    const assistant = (turnId: string, callId: string, itemId: string, text: string, delta: boolean) => {
      events.persist({
        sessionId: 'sess-main',
        turnId,
        callId,
        type: 'assistant_text',
        data: {
          __gian_event: 2,
          provider: 'codex',
          raw: {},
          display: { type: 'message', data: { text, delta, itemId } },
        },
      });
    };
    user('t1', 'user-one', 'turn-one-token');
    user('t1', 'user-main', [
      GIAN_ROLE_OPEN,
      'engineer',
      GIAN_ROLE_CLOSE,
      MANAGER_SYS_OPEN,
      'secret-system',
      MANAGER_SYS_CLOSE,
      '你好世界 xe\u0301y look [Attached image: /api/sessions/sess-main/attachments/pic.png] here',
    ].join('\n'));
    user('t1', 'user-pair', 'pair-token and pair-token');
    assistant('t1', 'link-1', 'item-link', 'See [docs](https://secret.example/hidden) and `/tmp/secret-file`', false);
    assistant(
      't1',
      'action-1',
      'item-action',
      `before ${GIAN_ACTION_OPEN}\n{"method":"create_subtask"}\n${GIAN_ACTION_CLOSE} after-token`,
      false,
    );
    assistant('t1', 'open-1', 'item-open', `before ${GIAN_ACTION_OPEN} still-visible`, false);
    assistant('t1', 'snap-1', 'item-snap', 'hello-delta', true);
    assistant('t1', 'snap-2', 'item-snap', 'replaced-snapshot', false);
    user('t2', 'user-two', 'turn-two-token');
    events.persist({
      sessionId: 'sess-main',
      turnId: 't2',
      callId: 'reason-1',
      type: 'reasoning',
      data: {
        __gian_event: 2,
        provider: 'codex',
        raw: {},
        display: { type: 'activity.reasoning', data: { text: 'secret-reasoning-token', itemId: 'reason-1' } },
      },
    });
    events.persist({
      sessionId: 'sess-main',
      turnId: 't2',
      callId: 'tool-1',
      type: 'tool_execution',
      data: {
        __gian_event: 2,
        provider: 'codex',
        raw: {},
        display: { type: 'activity.tool', data: { text: 'secret-tool-token', itemId: 'tool-1' } },
      },
    });
    user('t3', 'user-three', 'turn-three-token');
    user('t4', 'user-delete', 'delete-me-token');
    user('ta', 'user-archive', 'archive-only-token', 'sess-archive');
    user('th', 'user-hidden', 'hidden-only-token', 'sess-hidden');

    db.prepare(
      `INSERT INTO schedules(
         id, name, prompt, status, trigger_kind, trigger_json, timezone,
         control_session_id, creator_kind, creator_actor_id, created_at, updated_at
       ) VALUES (
         'sched-1', 'Nightly', 'visible-prompt', 'active', 'once', '{}', 'UTC',
         'sess-main', 'internal_session', 'actor-1', datetime('now'), datetime('now')
       )`,
    ).run();
    db.prepare(
      `INSERT INTO inbox_items(
         id, source_key, source_kind, status, generation, revision, title, summary,
         target_json, display_json, tombstone, created_at, updated_at
       ) VALUES
         ('in-1', 'src-1', 'session.question', 'pending', 3, 1, 'inbox-title', 'inbox-summary',
          '{"secret":"target-secret-token"}', '{}', 0, datetime('now'), datetime('now')),
         ('in-tomb', 'src-tomb', 'session.question', 'pending', 1, 1, 'tombstone-title', 'gone',
          '{}', '{}', 1, datetime('now'), datetime('now'))`,
    ).run();
    writeFileSync(join(dir, 'agents.json'), JSON.stringify({
      version: 6,
      agents: [{ id: 'agent-1', name: 'Searcher', pluginId: 'io.gian.codex', proxy: 'codex' }],
    }));
    const trees: SearchWorkingTreeSource[] = [
      {
        id: 'ws:ws-1',
        kind: 'workspace',
        label: 'Workspace One',
        path: '/tmp/ws-1',
        branch: null,
        workspace_id: 'ws-1',
        workspace_name: 'Workspace One',
        session_id: null,
        session_name: null,
      },
      {
        id: 'wt:sess-main',
        kind: 'worktree',
        label: 'feature/search',
        path: '/tmp/ws-1/tree',
        branch: 'feature/search',
        workspace_id: 'ws-1',
        workspace_name: 'Workspace One',
        session_id: 'sess-main',
        session_name: 'Session Alpha',
      },
      {
        id: 'ext:ws-1:Y29kZQ',
        kind: 'worktree',
        label: 'external-tree-label',
        path: '/tmp/external',
        branch: 'external',
        workspace_id: 'ws-1',
        workspace_name: 'Workspace One',
        session_id: null,
        session_name: null,
      },
    ];

    const triggers = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'search_%'",
    ).all() as Array<{ sql: string }>;
    assert.ok(triggers.length >= 12);
    for (const trigger of triggers) assert.equal(trigger.sql.includes('search_fts'), false);
    assert.ok(dirtyCount(db) > 0);

    await settle(db, dir, trees);
    const indexed = db.prepare(
      "SELECT search_text FROM search_documents WHERE kind = 'message'",
    ).all() as Array<{ search_text: string }>;
    const joined = indexed.map(row => row.search_text).join('\n');
    assert.equal(joined.includes('secret.example'), false);
    assert.equal(joined.includes('/tmp/secret-file'), true);
    assert.equal(joined.includes('docs'), true);
    assert.equal(joined.includes('secret-system'), true);
    assert.equal(joined.includes('engineer'), false);
    assert.equal(joined.includes('create_subtask'), false);
    assert.equal(joined.includes('still-visible'), true);
    assert.equal(joined.includes('after-token'), true);
    assert.equal(joined.includes('replaced-snapshot'), true);
    assert.equal(joined.includes('hello-delta'), false);
    assert.equal(joined.includes('pic.png'), false);
    assert.equal(joined.includes('secret-reasoning-token'), false);
    assert.equal(joined.includes('secret-tool-token'), false);
    assert.equal(joined.includes('你好世界'), true);

    const mode = readState(db).fts_mode;
    assert.ok(mode === 'trigram' || mode === 'unavailable');
    for (const term of ['你', '你好', '你好世']) {
      assert.equal(collect(db, term).results.some(result => result.kind === 'message'), true, term);
    }
    const accent = collect(db, '\u00e9').results.find(result => result.kind === 'message' && result.snippet?.includes('e\u0301'));
    if (!accent?.snippet) throw new Error('missing accent hit');
    const accentRange = accent.ranges[0];
    if (!accentRange) throw new Error('missing accent range');
    assert.equal(accent.snippet.slice(accentRange.start, accentRange.end).normalize('NFKC'), '\u00e9');

    const exact = searchGlobal(db, parseGlobalSearchQuery({ q: 'Session Alpha' }));
    assert.equal(exact.results[0]?.kind, 'session');
    assert.equal(exact.results[0]?.title, 'Session Alpha');
    const prefix = collect(db, 'Session');
    const sessionAt = prefix.results.findIndex(result => result.kind === 'session');
    const messageAt = prefix.results.findIndex(result => result.kind === 'message');
    assert.ok(sessionAt >= 0);
    if (messageAt >= 0) assert.ok(sessionAt < messageAt);

    db.prepare("UPDATE search_documents SET title = 'stale-title' WHERE kind = 'message'").run();
    const live = collect(db, '你好世界').results.find(result => result.kind === 'message');
    assert.equal(live?.title, 'Session Alpha');

    assert.equal(collect(db, 'secret.example').results.length, 0);
    assert.equal(collect(db, '/tmp/secret-file').results.some(result => result.kind === 'message'), true);
    assert.equal(collect(db, 'secret-reasoning-token').results.length, 0);
    assert.equal(collect(db, `zzz' OR '1'='1`).results.some(result => result.title === 'Session Alpha'), false);
    assert.equal(collect(db, '%').results.some(result => result.title === 'Session Alpha'), false);

    const archivedDefault = collect(db, 'archive-only-token');
    assert.equal(archivedDefault.results.length, 0);
    const archivedIncluded = collect(db, 'archive-only-token', { include_archived: '1' });
    assert.equal(archivedIncluded.results.some(result => result.archived), true);
    const archivedContext = readContext(db, parseContextQuery('sess-archive', { turn: '1' }));
    assert.equal(archivedContext.session.read_only, true);
    assert.equal(archivedContext.session.archived, 1);
    assert.equal(
      (db.prepare('SELECT archived FROM sessions WHERE id = ?').get('sess-archive') as { archived: number }).archived,
      1,
    );

    const taskHere = collect(db, 'task-body-token', { types: 'task', workspace_id: 'ws-1' });
    assert.equal(taskHere.results.some(result => result.kind === 'task'), true);
    const taskElsewhere = collect(db, 'task-body-token', { types: 'task', workspace_id: 'ws-2' });
    assert.equal(taskElsewhere.results.length, 0);
    const agent = collect(db, 'Searcher', { types: 'agent', workspace_id: 'ws-1' });
    assert.equal(agent.results[0]?.target.type, 'agent');
    const schedule = collect(db, 'visible-prompt');
    assert.equal(schedule.results.some(result => result.kind === 'schedule'), true);
    const inbox = collect(db, 'inbox-title').results.find(result => result.kind === 'inbox');
    assert.equal(inbox?.target.type, 'inbox');
    assert.equal(inbox?.target.type === 'inbox' ? inbox.target.generation : 0, 3);
    assert.equal(collect(db, 'target-secret-token').results.length, 0);
    assert.equal(collect(db, 'tombstone-title').results.length, 0);
    const external = collect(db, 'external-tree-label').results.find(result => result.kind === 'worktree');
    assert.equal(external?.target.type, 'worktree');
    assert.equal(external?.target.type === 'worktree' ? external.target.working_tree_id : '', 'ext:ws-1:Y29kZQ');
    assert.equal(external?.target.type === 'worktree' ? external.target.session_id : 'missing', null);

    let findCursor: string | undefined;
    let findSeen = 0;
    let findComplete = false;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const page = findInSession(db, parseFindQuery('sess-main', {
        q: 'pair-token',
        limit: '1',
        ...(findCursor ? { cursor: findCursor } : {}),
      }));
      findSeen += page.matches.length;
      if (!page.total_complete) {
        assert.ok(page.next_cursor);
        findCursor = page.next_cursor ?? undefined;
        continue;
      }
      assert.equal(page.total, 2);
      findComplete = true;
      break;
    }
    assert.equal(findComplete, true);
    assert.equal(findSeen, 2);

    const narrow = readContext(db, parseContextQuery('sess-main', { turn: '2', before: '0', after: '0' }));
    const narrowText = JSON.stringify(narrow.events);
    assert.equal(narrowText.includes('turn-two-token'), true);
    assert.equal(narrowText.includes('secret-reasoning-token'), true);
    assert.equal(narrowText.includes('turn-one-token'), false);
    assert.equal(narrowText.includes('turn-three-token'), false);
    const wide = readContext(db, parseContextQuery('sess-main', { turn_id: 't2', turn: '2', before: '1', after: '1' }));
    const wideText = JSON.stringify(wide.events);
    assert.equal(wideText.includes('turn-one-token'), true);
    assert.equal(wideText.includes('turn-three-token'), true);
    assert.throws(
      () => readContext(db, parseContextQuery('sess-main', { turn_id: 't2', turn: '1' })),
      (error: unknown) => error instanceof SearchContractError && error.code === 'invalid_argument',
    );
    assert.throws(
      () => readContext(db, parseContextQuery('sess-main', {
        turn: '2',
        document_id: `m:${'ab'.repeat(32)}`,
      })),
      (error: unknown) => error instanceof SearchContractError && error.code === 'not_found',
    );
    const located = collect(db, 'replaced-snapshot').results.find(result => result.kind === 'message');
    if (!located || located.target.type !== 'session' || !located.target.turn_id || !located.target.text_revision) {
      throw new Error('missing snapshot target');
    }
    const turnId = located.target.turn_id;
    const revision = located.target.text_revision;
    const matched = readContext(db, parseContextQuery('sess-main', {
      turn_id: turnId,
      document_id: located.id,
      text_revision: revision,
    }));
    assert.equal(matched.session.id, 'sess-main');
    const flipped = revision.replace(/.$/, char => char === 'a' ? 'b' : 'a');
    assert.throws(
      () => readContext(db, parseContextQuery('sess-main', {
        turn_id: turnId,
        document_id: located.id,
        text_revision: flipped,
      })),
      (error: unknown) => error instanceof SearchContractError && error.code === 'text_revision_mismatch',
    );

    const partial = searchGlobal(db, parseGlobalSearchQuery({ q: 'zzzz-absent' }), 1);
    assert.equal(partial.results.length, 0);
    assert.equal(partial.coverage.state, 'partial');
    assert.equal(partial.coverage.complete, false);
    assert.ok(partial.next_cursor);
    const finishedAbsent = collect(db, 'zzzz-absent', {}, 1);
    assert.equal(finishedAbsent.results.length, 0);
    assert.equal(finishedAbsent.coverage.state, 'ready');
    db.prepare('UPDATE search_state SET index_revision = index_revision + 1 WHERE id = 1').run();
    assert.throws(
      () => searchGlobal(db, parseGlobalSearchQuery({ q: 'zzzz-absent', cursor: partial.next_cursor ?? '' })),
      (error: unknown) => error instanceof SearchContractError && error.code === 'stale_cursor',
    );

    const mod = createSearchModule({
      db,
      dataDir: dir,
      listWorkingTrees: async () => trees,
    });
    const app = new Hono();
    mod.register(app);
    const blank = await app.request('http://127.0.0.1/api/search?q=%20');
    assert.equal(blank.status, 400);
    const tooLong = await app.request('http://127.0.0.1/api/search?q=alpha&limit=51');
    assert.equal(tooLong.status, 400);
    const setting = await app.request('http://127.0.0.1/api/search?q=theme&types=setting');
    assert.equal(setting.status, 400);
    const malformed = await app.request('http://127.0.0.1/api/search?q=alpha&cursor=%25%25');
    assert.equal(malformed.status, 400);
    const stale = await app.request(`http://127.0.0.1/api/search?q=zzzz-absent&cursor=${encodeURIComponent(partial.next_cursor ?? '')}`);
    assert.equal(stale.status, 409);
    const found = await app.request(`http://127.0.0.1/api/search?q=${encodeURIComponent('你好')}`);
    assert.equal(found.status, 200);
    const conflict = await app.request(
      `http://127.0.0.1/api/sessions/sess-main/context?turn_id=t1&document_id=${located.id}&text_revision=${flipped}`,
    );
    assert.equal(conflict.status, 409);
    const archivedHttp = await app.request('http://127.0.0.1/api/sessions/sess-archive/context?turn=1');
    assert.equal(archivedHttp.status, 200);
    const archivedBody = await archivedHttp.json() as { session: { read_only: boolean; archived: number } };
    assert.equal(archivedBody.session.read_only, true);
    assert.equal(archivedBody.session.archived, 1);

    db.prepare('DELETE FROM events WHERE turn_id = ?').run('t4');
    await settle(db, dir, trees);
    assert.equal(collect(db, 'delete-me-token').results.length, 0);

    db.prepare("UPDATE sessions SET hidden = 1 WHERE id = 'sess-hidden'").run();
    await settle(db, dir, trees);
    assert.equal(collect(db, 'hidden-only-token', { include_archived: '1' }).results.length, 0);
    assert.throws(
      () => readContext(db, parseContextQuery('sess-hidden', { turn: '1' })),
      (error: unknown) => error instanceof SearchContractError && error.code === 'not_found',
    );
    const hiddenHttp = await app.request('http://127.0.0.1/api/sessions/sess-hidden/find?q=hidden-only-token');
    assert.equal(hiddenHttp.status, 404);

    db.prepare("UPDATE sessions SET archived = 1 WHERE id = 'sess-main'").run();
    await settle(db, dir, trees);
    assert.equal(collect(db, 'Session Alpha').results.some(result => result.kind === 'session'), false);
    assert.equal(
      collect(db, 'Session Alpha', { include_archived: '1' }).results.some(result => result.kind === 'session' && result.archived),
      true,
    );
    const readonly = readContext(db, parseContextQuery('sess-main', { turn: '1' }));
    assert.equal(readonly.session.read_only, true);
    assert.equal(
      (db.prepare('SELECT archived FROM sessions WHERE id = ?').get('sess-main') as { archived: number }).archived,
      1,
    );

    writeFileSync(join(dir, 'agents.json'), '{');
    await drainSearchOnce(db, dir, async () => trees);
    assert.ok(readState(db).last_error);
    const kept = db.prepare("SELECT COUNT(*) AS n FROM search_documents WHERE kind = 'agent'").get() as { n: number };
    assert.equal(kept.n, 1);
    writeFileSync(join(dir, 'agents.json'), JSON.stringify({
      version: 6,
      agents: [{ id: 'agent-1', name: 'Searcher', pluginId: 'io.gian.codex', proxy: 'codex' }],
    }));
    await drainSearchOnce(db, dir, async () => trees);
    assert.equal(readState(db).last_error, null);
  } finally {
    handle.close();
  }
});
