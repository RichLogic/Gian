// Account sign-in faults mirror into Inbox. NOT_RUN.
// Generation is inbox_repair_episodes, not a count of surviving events.
// A turn snapshot without runtime_profile cannot close the fault.
// Tests are added with this change and were not executed.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accountRepairInboxObserver } from '../src/inbox/account-repair-producer.js';
import { InboxService } from '../src/inbox/service.js';
import { installEventStorageV3 } from '../src/storage/event-storage-v3-schema.js';
import { openDatabase, type Db } from '../src/storage/db.js';
import type { InboxItemPublic } from '../../shared/src/inbox.js';

const LOGIN_SUMMARY = 'Sign in to this Agent from its login terminal. Gian does not run login by itself.';
const SETTINGS_SUMMARY = 'This Agent has no login command. Open its settings. Gian cannot repair the account automatically.';
const AGENT_A = '11111111-1111-4111-8111-111111111111';
const AGENT_B = '22222222-2222-4222-8222-222222222222';
const AGENT_KIMI = '33333333-3333-4333-8333-333333333333';
const AGENT_DSH = '44444444-4444-4444-8444-444444444444';
const AGENT_BOUND = '55555555-5555-4555-8555-555555555555';
const AGENT_ONCE = '66666666-6666-4666-8666-666666666666';
const SECRET_NAME = 'SESSION_NAME_SHOULD_NOT_APPEAR';
const SECRET_PATH = '/Users/secret/home';

function at(minute: number, second = 0): string {
  return `2026-09-01T12:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}.000Z`;
}

function realConfig(agentId: string, proxy: string, agentName: string | null) {
  return {
    agent_id: agentId,
    agent_name: agentName,
    proxy,
    model: null,
    thinking_effort: null,
    approval_mode: 'ask',
    service_tier: null,
    session: {},
    turn: {},
  };
}

function boundConfig(
  agentId: string,
  proxy: string,
  agentName: string | null,
  runtimeId: string,
  configHome: string | null,
) {
  return {
    ...realConfig(agentId, proxy, agentName),
    runtime_profile: { id: runtimeId, configHome },
  };
}

interface Fixture {
  dir: string;
  db: Db;
  inbox: InboxService;
  repair: ReturnType<typeof accountRepairInboxObserver>;
  messages: Array<{ type: string }>;
  close(): void;
}

function setup(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'account-repair-inbox-'));
  const db = openDatabase(dir);
  installEventStorageV3(db);
  const messages: Array<{ type: string }> = [];
  const inbox = new InboxService(db, {
    broadcast(message) { messages.push(message); },
  });
  const workspaceId = randomUUID();
  db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)').run(workspaceId, 'ws', '/tmp/ws');
  const repair = accountRepairInboxObserver(db, inbox);
  return {
    dir,
    db,
    inbox,
    repair,
    messages,
    close() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function addSession(
  db: Db,
  workspaceId: string,
  agentId: string | null,
  executor: string,
): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO sessions (
       id, name, type, workspace_id, executor, status, archived, hidden,
       native_session_id, conversation_usage_complete, created_at, updated_at
     ) VALUES (?, 'Conversation', 'coding', ?, ?, 'idle', 0, 0, ?, 1, ?, ?)`,
  ).run(id, workspaceId, executor, `native-${id}`, at(0), at(0));
  db.prepare(
    `UPDATE sessions SET agent_id = ?, agent_name = ?, proxy_plugin_id = ? WHERE id = ?`,
  ).run(agentId, SECRET_NAME, executor === 'dsh' ? 'claude' : 'ai.deepseek.harness', id);
  return id;
}

function workspaceId(db: Db): string {
  const row = db.prepare('SELECT id FROM workspaces LIMIT 1').get() as { id: string };
  return row.id;
}

function addTurn(
  db: Db,
  sessionId: string,
  turnNumber: number,
  createdAt: string,
  config: Record<string, unknown>,
): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO turns (id, session_id, turn_number, status, config_json, created_at)
     VALUES (?, ?, ?, 'running', ?, ?)`,
  ).run(id, sessionId, turnNumber, JSON.stringify(config), createdAt);
  return id;
}

function addEvent(
  db: Db,
  sessionId: string,
  turnId: string,
  type: string,
  data: Record<string, unknown>,
  createdAt: string,
  sequence?: number,
): string {
  const id = randomUUID();
  const callId = randomUUID();
  if (sequence == null) {
    db.prepare(
      `INSERT INTO events (id, session_id, turn_id, call_id, type, data, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, sessionId, turnId, callId, type, JSON.stringify(data), createdAt);
  } else {
    db.prepare(
      `INSERT INTO events (id, session_id, turn_id, call_id, type, data, created_at, sequence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, sessionId, turnId, callId, type, JSON.stringify(data), createdAt, sequence);
  }
  return callId;
}

function authData(retryable = true): Record<string, unknown> {
  return {
    __gian_event: 2,
    provider: 'claude',
    raw: {},
    display: {
      type: 'state.error',
      data: { message: 'please login now', code: 'RUNTIME_AUTH_REQUIRED', retryable },
    },
  };
}

function completedData(turnId: string, status?: string): Record<string, unknown> {
  return {
    __gian_event: 2,
    provider: 'claude',
    raw: {},
    display: {
      type: 'state.turn-completed',
      data: {
        turnId,
        ...(status === undefined ? {} : { status }),
      },
    },
  };
}

function items(inbox: InboxService): InboxItemPublic[] {
  return inbox.list({ status: 'all', limit: 100 }).items;
}

function accountItem(inbox: InboxService, agentId: string): InboxItemPublic {
  const found = items(inbox).find(item => (
    item.target.type === 'system_repair' && item.target.subject_id === agentId
  ));
  assert.ok(found);
  assert.equal(found.display.kind, 'system.repair');
  return found;
}

function episode(db: Db, agentId: string): {
  generation: number;
  phase: string;
  config_identity: string | null;
  recovery_block: string | null;
  entry_kind: string;
  title: string;
} | undefined {
  return db.prepare(
    `SELECT generation, phase, config_identity, recovery_block, entry_kind, title
       FROM inbox_repair_episodes WHERE source_key = ?`,
  ).get(`system.repair:account:${agentId}`) as {
    generation: number;
    phase: string;
    config_identity: string | null;
    recovery_block: string | null;
    entry_kind: string;
    title: string;
  } | undefined;
}

test('one agent is one sign-in item and a restart keeps its read state', () => {
  const fx = setup();
  try {
    const applied = fx.db.prepare(
      `SELECT 1 AS ok FROM migrations WHERE filename = '091_inbox_repair_source.sql'`,
    ).get() as { ok: number } | undefined;
    assert.equal(applied?.ok, 1);
    const ws = workspaceId(fx.db);
    const first = addSession(fx.db, ws, AGENT_A, 'claude');
    const second = addSession(fx.db, ws, AGENT_A, 'claude');
    const other = addSession(fx.db, ws, AGENT_B, 'claude');
    const kimi = addSession(fx.db, ws, AGENT_KIMI, 'kimi');
    const dsh = addSession(fx.db, ws, AGENT_DSH, 'dsh');
    const bare = addSession(fx.db, ws, null, 'claude');
    const idle = addSession(fx.db, ws, '77777777-7777-4777-8777-777777777777', 'claude');
    fx.db.prepare(`UPDATE sessions SET status = 'error' WHERE id = ?`).run(idle);

    const auth = (sessionId: string, minute: number, config: Record<string, unknown>, retryable = true) => {
      const turnId = addTurn(fx.db, sessionId, 1, at(minute), config);
      addEvent(fx.db, sessionId, turnId, 'turn.failed', authData(retryable), at(minute, 1));
    };
    auth(first, 1, realConfig(AGENT_A, 'claude', 'Claude One'), true);
    auth(second, 2, realConfig(AGENT_A, 'claude', 'Claude One'), false);
    auth(other, 3, realConfig(AGENT_B, 'claude', 'Claude Two'));
    auth(kimi, 4, realConfig(AGENT_KIMI, 'kimi', 'Kimi One'), true);
    auth(dsh, 5, realConfig(AGENT_DSH, 'dsh', SECRET_PATH));
    const bareTurn = addTurn(fx.db, bare, 1, at(6), realConfig(AGENT_A, 'claude', 'Ignored'));
    addEvent(fx.db, bare, bareTurn, 'turn.failed', authData(), at(6, 1));
    const failedTurn = addTurn(fx.db, other, 2, at(7), realConfig(AGENT_B, 'claude', 'Claude Two'));
    addEvent(fx.db, other, failedTurn, 'turn.failed', {
      __gian_event: 2,
      provider: 'claude',
      raw: {},
      display: {
        type: 'state.error',
        data: { message: 'please login now', code: 'TURN_FAILED', retryable: true },
      },
    }, at(7, 1));

    fx.repair.reconcile();
    const rows = items(fx.inbox);
    assert.equal(rows.length, 4);
    assert.equal(rows.every(row => row.source_kind === 'system.repair'), true);
    assert.equal(fx.messages.some(message => message.type === 'attention'), false);

    const claude = accountItem(fx.inbox, AGENT_A);
    assert.equal(claude.status, 'pending');
    assert.equal(claude.generation, 1);
    assert.equal(claude.unread, true);
    assert.equal(claude.title, 'Claude One');
    assert.equal(claude.summary, LOGIN_SUMMARY);
    assert.deepEqual(claude.actions, ['open']);
    assert.equal(claude.target.type, 'system_repair');
    if (claude.display.kind === 'system.repair') {
      assert.deepEqual(claude.display.entry, { kind: 'agent_login', agent_id: AGENT_A });
    }
    assert.equal(JSON.stringify(claude).includes(SECRET_NAME), false);
    assert.equal(JSON.stringify(claude).includes('please login now'), false);

    const secondAgent = accountItem(fx.inbox, AGENT_B);
    assert.equal(secondAgent.generation, 1);
    assert.equal(secondAgent.title, 'Claude Two');

    const kimiItem = accountItem(fx.inbox, AGENT_KIMI);
    assert.equal(kimiItem.title, 'Kimi One');
    assert.equal(kimiItem.summary, LOGIN_SUMMARY);
    if (kimiItem.display.kind === 'system.repair') {
      assert.deepEqual(kimiItem.display.entry, { kind: 'agent_login', agent_id: AGENT_KIMI });
    }

    const dshItem = accountItem(fx.inbox, AGENT_DSH);
    assert.equal(dshItem.title, 'Account sign-in');
    assert.equal(dshItem.summary, SETTINGS_SUMMARY);
    if (dshItem.display.kind === 'system.repair') {
      assert.deepEqual(dshItem.display.entry, { kind: 'agent_settings', agent_id: AGENT_DSH });
    }
    assert.equal(JSON.stringify(dshItem).includes(SECRET_PATH), false);
    assert.equal(JSON.stringify(items(fx.inbox)).includes('77777777-7777-4777-8777-777777777777'), false);

    const stored = episode(fx.db, AGENT_A);
    assert.equal(stored?.generation, 1);
    assert.equal(stored?.phase, 'open');
    assert.equal(stored?.config_identity, null);
    assert.equal(stored?.recovery_block, 'CONFIG_IDENTITY_ABSENT');

    fx.inbox.markRead(claude.id, claude.generation);
    const revision = accountItem(fx.inbox, AGENT_A).revision;
    const inboxRevision = fx.inbox.count().inbox_revision;
    const seen = fx.messages.length;
    fx.repair.reconcile();
    fx.repair.reconcile();
    const reread = accountItem(fx.inbox, AGENT_A);
    assert.equal(reread.status, 'pending');
    assert.equal(reread.generation, 1);
    assert.equal(reread.unread, false);
    assert.equal(reread.revision, revision);
    assert.equal(fx.inbox.count().inbox_revision, inboxRevision);
    assert.equal(fx.messages.length, seen);

    const source = readFileSync(
      fileURLToPath(new URL('../src/inbox/account-repair-producer.ts', import.meta.url)),
      'utf8',
    );
    assert.equal(source.includes('prepareAgentCliTerminal'), false);
  } finally {
    fx.close();
  }
});

test('a snapshot without a runtime binding does not close on a completed turn', () => {
  const fx = setup();
  try {
    const ws = workspaceId(fx.db);
    const sessionId = addSession(fx.db, ws, AGENT_A, 'claude');
    const fault = addTurn(fx.db, sessionId, 1, at(1), realConfig(AGENT_A, 'claude', 'Claude One'));
    addEvent(fx.db, sessionId, fault, 'turn.failed', authData(), at(1, 1));
    for (const status of ['completed', 'unknown', 'stopped', 'error', undefined] as const) {
      const minute = status === 'completed' ? 2 : status === 'unknown' ? 3 : status === 'stopped' ? 4 : status === 'error' ? 5 : 6;
      const turnId = addTurn(fx.db, sessionId, minute, at(minute), realConfig(AGENT_A, 'claude', 'Claude One'));
      addEvent(
        fx.db,
        sessionId,
        turnId,
        'gian.turn.completed',
        completedData(turnId, status),
        at(minute, 1),
      );
    }
    fx.repair.reconcile();
    const item = accountItem(fx.inbox, AGENT_A);
    assert.equal(item.status, 'pending');
    assert.equal(item.generation, 1);
    assert.equal(item.read_at, null);
    const stored = episode(fx.db, AGENT_A);
    assert.equal(stored?.phase, 'open');
    assert.equal(stored?.recovery_block, 'CONFIG_IDENTITY_ABSENT');
    assert.equal(stored?.config_identity, null);
  } finally {
    fx.close();
  }
});

test('only a later turn with the same runtime binding closes, and deletion does not rewind it', () => {
  const fx = setup();
  try {
    const ws = workspaceId(fx.db);
    const sessionId = addSession(fx.db, ws, AGENT_BOUND, 'claude');
    const home = '/Users/someone/.claude-a';
    const profileA = (name = 'Bound Agent') => boundConfig(AGENT_BOUND, 'claude', name, 'runtime-a', home);
    const early = addTurn(fx.db, sessionId, 1, at(1), profileA());
    const fault = addTurn(fx.db, sessionId, 2, at(2), profileA());
    addEvent(fx.db, sessionId, fault, 'turn.failed', authData(), at(2, 1));
    addEvent(fx.db, sessionId, early, 'gian.turn.completed', completedData(early, 'completed'), at(2, 30));
    const otherRuntime = addTurn(fx.db, sessionId, 3, at(3), boundConfig(AGENT_BOUND, 'claude', 'Bound Agent', 'runtime-b', home));
    addEvent(fx.db, sessionId, otherRuntime, 'gian.turn.completed', completedData(otherRuntime, 'completed'), at(3, 1));
    const otherHome = addTurn(fx.db, sessionId, 4, at(4), boundConfig(AGENT_BOUND, 'claude', 'Bound Agent', 'runtime-a', '/Users/someone/.claude-b'));
    addEvent(fx.db, sessionId, otherHome, 'gian.turn.completed', completedData(otherHome, 'completed'), at(4, 1));
    const unknown = addTurn(fx.db, sessionId, 5, at(5), profileA());
    addEvent(fx.db, sessionId, unknown, 'gian.turn.completed', completedData(unknown, 'unknown'), at(5, 1));
    fx.repair.reconcile();
    assert.equal(accountItem(fx.inbox, AGENT_BOUND).status, 'pending');
    assert.equal(accountItem(fx.inbox, AGENT_BOUND).generation, 1);
    assert.equal(episode(fx.db, AGENT_BOUND)?.phase, 'open');
    assert.equal(episode(fx.db, AGENT_BOUND)?.recovery_block, null);
    assert.notEqual(episode(fx.db, AGENT_BOUND)?.config_identity, null);

    const matched = addTurn(fx.db, sessionId, 6, at(6), profileA());
    addEvent(fx.db, sessionId, matched, 'gian.turn.completed', completedData(matched, 'completed'), at(6, 1));
    fx.repair.reconcile();
    const closed = accountItem(fx.inbox, AGENT_BOUND);
    assert.equal(closed.status, 'resolved');
    assert.equal(closed.generation, 1);
    assert.equal(closed.read_at, null);
    assert.equal(episode(fx.db, AGENT_BOUND)?.phase, 'closed');

    const again = addTurn(fx.db, sessionId, 7, at(7), profileA());
    addEvent(fx.db, sessionId, again, 'turn.failed', authData(), at(7, 1));
    const againDone = addTurn(fx.db, sessionId, 8, at(8), profileA());
    addEvent(fx.db, sessionId, againDone, 'gian.turn.completed', completedData(againDone, 'completed'), at(8, 1));
    fx.repair.reconcile();
    assert.equal(accountItem(fx.inbox, AGENT_BOUND).status, 'resolved');
    assert.equal(accountItem(fx.inbox, AGENT_BOUND).generation, 2);

    fx.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
    assert.equal(episode(fx.db, AGENT_BOUND)?.generation, 2);
    assert.equal(episode(fx.db, AGENT_BOUND)?.phase, 'closed');
    const fresh = addSession(fx.db, ws, AGENT_BOUND, 'claude');
    const freshTurn = addTurn(fx.db, fresh, 1, at(9), profileA());
    addEvent(fx.db, fresh, freshTurn, 'turn.failed', authData(), at(9, 1));
    fx.repair.reconcile();
    const reopened = accountItem(fx.inbox, AGENT_BOUND);
    assert.equal(reopened.status, 'pending');
    assert.equal(reopened.generation, 3);
    assert.equal(reopened.unread, true);
    assert.equal(items(fx.inbox).filter(item => item.target.type === 'system_repair' && item.target.subject_id === AGENT_BOUND).length, 1);
  } finally {
    fx.close();
  }
});

test('one event does not apply another event or a sequence already consumed', () => {
  const fx = setup();
  try {
    const ws = workspaceId(fx.db);
    const authSession = addSession(fx.db, ws, AGENT_ONCE, 'claude');
    const fault = addTurn(fx.db, authSession, 1, at(1), realConfig(AGENT_ONCE, 'claude', 'Once'));
    const authCall = addEvent(fx.db, authSession, fault, 'turn.failed', authData(), at(1, 1));
    const otherSession = addSession(fx.db, ws, AGENT_ONCE, 'claude');
    const other = addTurn(fx.db, otherSession, 1, at(2), realConfig(AGENT_ONCE, 'claude', 'Once'));
    const otherCall = addEvent(fx.db, otherSession, other, 'gian.turn.completed', completedData(other, 'unknown'), at(2, 1));
    fx.repair.observe({
      session_id: otherSession,
      call_id: otherCall,
      display: { type: 'state.turn-completed', data: { status: 'unknown', turnId: other } },
    });
    assert.equal(items(fx.inbox).length, 0);

    fx.repair.observe({
      session_id: authSession,
      call_id: authCall,
      display: { type: 'state.error', data: { code: 'RUNTIME_AUTH_REQUIRED', retryable: true } },
    });
    assert.equal(accountItem(fx.inbox, AGENT_ONCE).generation, 1);

    const boundSession = addSession(fx.db, ws, AGENT_BOUND, 'claude');
    const opened = addTurn(fx.db, boundSession, 1, at(3), boundConfig(AGENT_BOUND, 'claude', 'Bound', 'runtime-a', '/Users/someone/.claude-a'));
    addEvent(fx.db, boundSession, opened, 'turn.failed', authData(), at(3, 1));
    const done = addTurn(fx.db, boundSession, 2, at(4), boundConfig(AGENT_BOUND, 'claude', 'Bound', 'runtime-a', '/Users/someone/.claude-a'));
    addEvent(fx.db, boundSession, done, 'gian.turn.completed', completedData(done, 'completed'), at(4, 1));
    fx.repair.reconcile();
    assert.equal(accountItem(fx.inbox, AGENT_BOUND).status, 'resolved');
    assert.equal(accountItem(fx.inbox, AGENT_BOUND).generation, 1);

    const parked = addSession(fx.db, ws, AGENT_BOUND, 'claude');
    const parkedTurn = addTurn(fx.db, parked, 1, at(5), boundConfig(AGENT_BOUND, 'claude', 'Bound', 'runtime-a', '/Users/someone/.claude-a'));
    addEvent(fx.db, parked, parkedTurn, 'turn.failed', authData(), at(5, 1), 1);
    fx.db.prepare(
      `INSERT INTO inbox_repair_watermarks (source_key, session_id, sequence)
       VALUES (?, ?, 10)`,
    ).run(`system.repair:account:${AGENT_BOUND}`, parked);
    fx.repair.reconcile();
    const stayed = accountItem(fx.inbox, AGENT_BOUND);
    assert.equal(stayed.status, 'resolved');
    assert.equal(stayed.generation, 1);
    assert.equal(episode(fx.db, AGENT_BOUND)?.phase, 'closed');
  } finally {
    fx.close();
  }
});

test('a failed inbox write does not escape the event', () => {
  const dir = mkdtempSync(join(tmpdir(), 'account-repair-inbox-'));
  const db = openDatabase(dir);
  installEventStorageV3(db);
  try {
    const workspace = randomUUID();
    db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)').run(workspace, 'ws', '/tmp/ws');
    const sessionId = addSession(db, workspace, AGENT_A, 'claude');
    const turnId = addTurn(db, sessionId, 1, at(1), realConfig(AGENT_A, 'claude', 'Claude One'));
    const callId = addEvent(db, sessionId, turnId, 'turn.failed', authData(), at(1, 1));
    const broken = accountRepairInboxObserver(db, {
      applySignal() { throw new Error('inbox down'); },
    });
    assert.doesNotThrow(() => {
      broken.observe({
        session_id: sessionId,
        call_id: callId,
        display: { type: 'state.error', data: { code: 'RUNTIME_AUTH_REQUIRED' } },
      });
    });
    assert.equal(episode(db, AGENT_A), undefined);
    const inbox = new InboxService(db, { broadcast() {} });
    accountRepairInboxObserver(db, inbox).observe({
      session_id: sessionId,
      call_id: callId,
      display: { type: 'state.error', data: { code: 'RUNTIME_AUTH_REQUIRED' } },
    });
    assert.equal(inbox.list({ status: 'all', limit: 10 }).items.length, 1);
    assert.equal(episode(db, AGENT_A)?.generation, 1);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
