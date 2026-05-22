import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ProxyNotification, ServerToClientMessage } from '@gian/shared';
import { openDatabase } from '../src/storage/db.js';
import { SessionManager } from '../src/session/manager.js';
import type { ProxyManager } from '../src/proxy/manager.js';
import type { ProxyClient, NotificationHandler } from '../src/proxy/types.js';
import type { WsBroadcaster } from '../src/web/ws-broadcast.js';
import { ApprovalManager } from '../src/approval/index.js';
import { QueueManager } from '../src/queue/index.js';

class StubProxyClient implements ProxyClient {
  readonly executor = 'claude' as const;
  notificationHandlers: NotificationHandler[] = [];

  async initialize() {
    return { mode: 'spawn' as const, protocolVersion: '0.1.0', methods: [] };
  }
  async capabilities() {
    return { protocolVersion: '0.1.0', models: [], slashCommands: [] };
  }
  async listSlashCommands() {
    return { commands: [] };
  }
  /** When set, next createSession call rejects (used to test rollback). */
  failNextCreate: Error | null = null;

  /** Captures the last createSession params so tests can assert on adoption. */
  lastCreateParams: { cwd: string; claudeSessionId?: string; threadId?: string } | null = null;

  async createSession(params: { cwd: string; claudeSessionId?: string; threadId?: string }) {
    this.lastCreateParams = params;
    if (this.failNextCreate) {
      const err = this.failNextCreate;
      this.failNextCreate = null;
      throw err;
    }
    // Mirror cc-proxy: re-use the supplied claudeSessionId on adoption,
    // otherwise mint a fresh native id. The proxy's own `id` mirrors the
    // native id so a single value flows through both sides.
    const nativeSessionId = params.claudeSessionId ?? `cc_${randomUUID()}`;
    return {
      session: {
        id: nativeSessionId,
        cwd: params.cwd,
        claudeSessionId: nativeSessionId,
        model: null,
        status: 'idle' as const,
        createdAt: '2026-04-26T00:00:00.000Z',
        updatedAt: '2026-04-26T00:00:00.000Z',
        lastError: null,
      },
      nativeSessionId,
    };
  }
  async interruptTurn() { /* no-op */ }
  async respondApproval() { /* no-op */ }
  async startTurn() {
    return {
      session: {
        id: 'proxy_x',
        cwd: '/tmp',
        model: null,
        status: 'running' as const,
        createdAt: '2026-04-26T00:00:00.000Z',
        updatedAt: '2026-04-26T00:00:00.000Z',
        lastError: null,
      },
      turn: { id: 'proxy_turn' },
    };
  }
  async closeSession() { /* no-op */ }
  async shutdown() { /* no-op */ }
  forceKill() { /* no-op */ }

  onNotification(handler: NotificationHandler) {
    this.notificationHandlers.push(handler);
    return () => {
      this.notificationHandlers = this.notificationHandlers.filter(h => h !== handler);
    };
  }
  onExit() {
    return () => {};
  }

  fire(notification: ProxyNotification): void {
    for (const h of this.notificationHandlers) h(notification);
  }
}

class FakeProxyManager {
  client = new StubProxyClient();
  async getOrCreate(): Promise<ProxyClient> {
    return this.client;
  }
  get(): ProxyClient {
    return this.client;
  }
  async closeAll(): Promise<void> { /* no-op */ }
}

class CapturingBroadcaster {
  messages: ServerToClientMessage[] = [];
  add() {}
  remove() {}
  send() {}
  broadcast(msg: ServerToClientMessage): void {
    this.messages.push(msg);
  }
  get size() {
    return 0;
  }
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'gian-sm-test-'));
  const db = openDatabase(dir);

  const wsId = randomUUID();
  // Migration 006 dropped `executor` from workspaces — it's a session
  // attribute now, not a workspace one.
  db.prepare(
    'INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)',
  ).run(wsId, 'test', '/tmp/test-ws');

  const proxyMgr = new FakeProxyManager();
  const broadcaster = new CapturingBroadcaster();
  const approvals = new ApprovalManager(broadcaster as unknown as WsBroadcaster);
  const queue = new QueueManager(db);
  const sessions = new SessionManager(
    db,
    proxyMgr as unknown as ProxyManager,
    broadcaster as unknown as WsBroadcaster,
    approvals,
    queue,
    dir,
  );
  approvals.setRespondFn((sid, aid, dec) => sessions.respondApproval(sid, aid, dec));
  approvals.setGetModeFn(sid => sessions.getSession(sid).approval_mode);

  return { dir, db, wsId, proxyMgr, broadcaster, sessions };
}

test('createSession persists row with native_session_id from proxy response', async () => {
  const { dir, db, wsId, sessions } = setup();
  try {
    const session = await sessions.createSession({
      workspace_id: wsId,
      executor: 'claude',
      name: 'first',
    });

    assert.equal(session.workspace_id, wsId);
    assert.equal(session.executor, 'claude');
    assert.equal(session.status, 'new');
    assert.equal(session.name, 'first');

    const row = db.prepare('SELECT native_session_id FROM sessions WHERE id = ?').get(session.id) as
      | { native_session_id: string | null } | undefined;
    assert.ok(row, 'session row persisted');
    assert.ok(row!.native_session_id, 'native_session_id populated');
    assert.match(row!.native_session_id!, /^cc_/, 'native_session_id came from stub createSession');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createSession leaves no row if proxy createSession fails', async () => {
  const { dir, db, wsId, proxyMgr, sessions } = setup();
  try {
    proxyMgr.client.failNextCreate = new Error('proxy boom');

    await assert.rejects(
      sessions.createSession({ workspace_id: wsId, executor: 'claude' }),
      /proxy boom/,
    );

    const count = (db.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number }).c;
    assert.equal(count, 0, 'no half-row left behind');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('createSession rejects unknown workspace', async () => {
  const { dir, db, sessions } = setup();
  try {
    await assert.rejects(
      sessions.createSession({ workspace_id: 'does-not-exist', executor: 'claude' }),
      /workspace not found/,
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sendMessage creates turn, persists user_message, broadcasts envelope', async () => {
  const { dir, db, wsId, sessions, broadcaster } = setup();
  try {
    const session = await sessions.createSession({ workspace_id: wsId, executor: 'claude' });
    broadcaster.messages.length = 0; // ignore creation-time messages

    await sessions.sendMessage(session.id, 'hello world');

    const turns = db.prepare('SELECT * FROM turns WHERE session_id = ?').all(session.id) as Array<{
      turn_number: number;
      status: string;
    }>;
    assert.equal(turns.length, 1);
    assert.equal(turns[0]!.turn_number, 1);
    assert.equal(turns[0]!.status, 'running');

    const events = db.prepare('SELECT type, data FROM events WHERE session_id = ?').all(session.id) as Array<{
      type: string;
      data: string;
    }>;
    const userMsg = events.find(e => e.type === 'user_message');
    assert.ok(userMsg, 'user_message event persisted');
    assert.equal(JSON.parse(userMsg!.data).text, 'hello world');

    const sessionRow = db.prepare('SELECT status FROM sessions WHERE id = ?').get(session.id) as { status: string };
    assert.equal(sessionRow.status, 'running');

    const userEvents = broadcaster.messages.filter(
      m => m.type === 'event' && (m as { event: string }).event === 'user_message',
    );
    assert.equal(userEvents.length, 1);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('proxy notification persists event and broadcasts; turn.completed updates statuses', async () => {
  const { dir, db, wsId, sessions, proxyMgr, broadcaster } = setup();
  try {
    const session = await sessions.createSession({ workspace_id: wsId, executor: 'claude' });
    await sessions.sendMessage(session.id, 'ping');
    broadcaster.messages.length = 0;

    proxyMgr.client.fire({
      method: 'output.text',
      params: {
        sessionId: 'proxy_x',
        data: { text: 'pong' },
      },
    });
    proxyMgr.client.fire({
      method: 'turn.completed',
      params: {
        sessionId: 'proxy_x',
        data: { status: 'completed' },
      },
    });

    const events = db.prepare('SELECT type FROM events WHERE session_id = ?').all(session.id) as Array<{ type: string }>;
    const types = events.map(e => e.type);
    // Both output.text and turn.completed are covered by the cc normalizer
    // and persisted under unified type names: assistant_text + turn_completed.
    assert.ok(types.includes('assistant_text'));
    assert.ok(types.includes('turn_completed'));

    const sessionRow = db.prepare('SELECT status FROM sessions WHERE id = ?').get(session.id) as { status: string };
    assert.equal(sessionRow.status, 'done');

    const turnRow = db.prepare('SELECT status, completed_at FROM turns WHERE session_id = ?').get(session.id) as { status: string; completed_at: string | null };
    assert.equal(turnRow.status, 'completed');
    assert.ok(turnRow.completed_at);

    const broadcastEvents = broadcaster.messages.filter(m => m.type === 'event') as Array<{ event: string }>;
    assert.ok(broadcastEvents.some(e => e.event === 'assistant_text'));
    assert.ok(broadcastEvents.some(e => e.event === 'turn_completed'));
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('listEvents returns persisted events ordered chronologically with turn numbers', async () => {
  const { dir, db, wsId, sessions, proxyMgr } = setup();
  try {
    const session = await sessions.createSession({ workspace_id: wsId, executor: 'claude' });
    await sessions.sendMessage(session.id, 'first');

    proxyMgr.client.fire({
      method: 'output.text',
      params: { sessionId: 'proxy_x', data: { text: 'reply' } },
    });
    proxyMgr.client.fire({
      method: 'turn.completed',
      params: { sessionId: 'proxy_x', data: { status: 'completed' } },
    });

    const events = sessions.listEvents(session.id);
    const types = events.map(e => e.event);
    assert.deepEqual(types, ['user_message', 'assistant_text', 'turn_completed']);
    assert.equal(events[0]!.session_id, session.id);
    assert.equal(events[0]!.turn, 1);
    assert.equal((events[0]!.data as { text: string }).text, 'first');
    assert.equal((events[1]!.data as { text: string }).text, 'reply');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('debug notifications are dropped — neither persisted nor broadcast', async () => {
  // Previously these flowed through `legacyRawDispatch` so the UI could see
  // them in the wire log. That escape hatch was removed when the normalizer
  // pipeline became the sole event boundary; anything without a unified
  // mapping is now dropped at the host edge.
  const { dir, db, wsId, sessions, proxyMgr, broadcaster } = setup();
  try {
    const session = await sessions.createSession({ workspace_id: wsId, executor: 'claude' });
    await sessions.sendMessage(session.id, 'msg');
    const eventsBefore = (db.prepare('SELECT COUNT(*) AS c FROM events WHERE session_id = ?').get(session.id) as { c: number }).c;
    broadcaster.messages.length = 0;

    proxyMgr.client.fire({
      method: 'debug',
      params: { sessionId: 'proxy_x', data: { message: 'hi' } },
    });

    const eventsAfter = (db.prepare('SELECT COUNT(*) AS c FROM events WHERE session_id = ?').get(session.id) as { c: number }).c;
    assert.equal(eventsAfter, eventsBefore, 'debug event must not be persisted');

    const broadcasted = broadcaster.messages.filter(m => m.type === 'event') as Array<{ event: string }>;
    assert.ok(!broadcasted.some(e => e.event === 'debug'), 'debug must not be broadcast');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sendMessage rehydrates proxy session after host restart via native_session_id adoption', async () => {
  // First "host" creates the session.
  const first = setup();
  let sessionId: string;
  let originalNativeId: string;
  try {
    const session = await first.sessions.createSession({ workspace_id: first.wsId, executor: 'claude' });
    await first.sessions.sendMessage(session.id, 'before restart');
    sessionId = session.id;
    originalNativeId = (first.db
      .prepare('SELECT native_session_id FROM sessions WHERE id = ?')
      .get(sessionId) as { native_session_id: string }).native_session_id;
  } finally {
    first.db.close();
  }

  // Second "host" reuses the same DB dir but starts with empty in-memory state
  // (proxySessionIds is a fresh Map). The session row + workspace row persist
  // in DB. sendMessage must lazily re-init the proxy session by calling
  // createSession with the persisted native_session_id as the adoption param —
  // PR2 has no SESSION_ALREADY_EXISTS / getSessionByKey recovery path because
  // proxies are stateless across restarts.
  const db = openDatabase(first.dir);
  const proxyMgr = new FakeProxyManager();
  const broadcaster = new CapturingBroadcaster();
  const approvals = new ApprovalManager(broadcaster as unknown as WsBroadcaster);
  const queue = new QueueManager(db);
  const sessions = new SessionManager(
    db,
    proxyMgr as unknown as ProxyManager,
    broadcaster as unknown as WsBroadcaster,
    approvals,
    queue,
    first.dir,
  );

  try {
    await sessions.sendMessage(sessionId, 'after restart');

    // Adoption: createSession was called with the persisted claudeSessionId.
    assert.ok(proxyMgr.client.lastCreateParams, 'createSession invoked on second host');
    assert.equal(
      proxyMgr.client.lastCreateParams!.claudeSessionId,
      originalNativeId,
      'createSession passed persisted native_session_id as claudeSessionId for adoption',
    );

    const turnCount = (db.prepare('SELECT COUNT(*) AS c FROM turns WHERE session_id = ?').get(sessionId) as { c: number }).c;
    assert.equal(turnCount, 2, 'second turn persisted after rehydration');

    const userMsgs = db
      .prepare("SELECT data FROM events WHERE session_id = ? AND type = 'user_message' ORDER BY rowid")
      .all(sessionId) as Array<{ data: string }>;
    assert.equal(userMsgs.length, 2);
    assert.equal(JSON.parse(userMsgs[1]!.data).text, 'after restart');
  } finally {
    db.close();
    rmSync(first.dir, { recursive: true, force: true });
  }
});

test('session.rotated notification updates native_session_id and broadcasts session:updated', async () => {
  const { dir, db, wsId, sessions, proxyMgr, broadcaster } = setup();
  try {
    const session = await sessions.createSession({ workspace_id: wsId, executor: 'claude' });
    const oldNativeId = (db
      .prepare('SELECT native_session_id FROM sessions WHERE id = ?')
      .get(session.id) as { native_session_id: string }).native_session_id;
    broadcaster.messages.length = 0;

    const newNativeId = 'cc_rotated_abcdef';
    proxyMgr.client.fire({
      method: 'session.rotated',
      params: {
        sessionId: 'proxy_x',
        data: {
          oldNativeSessionId: oldNativeId,
          newNativeSessionId: newNativeId,
        },
      },
    });

    const row = db
      .prepare('SELECT native_session_id FROM sessions WHERE id = ?')
      .get(session.id) as { native_session_id: string };
    assert.equal(row.native_session_id, newNativeId, 'native_session_id rotated in DB');

    const updates = broadcaster.messages.filter(
      m => m.type === 'session:updated',
    ) as Array<{ session: { id: string; native_session_id?: string } }>;
    assert.ok(updates.length >= 1, 'session:updated broadcast emitted');
    const last = updates[updates.length - 1]!;
    assert.equal(last.session.id, session.id);
    assert.equal(last.session.native_session_id, newNativeId);

    // Should NOT have persisted a transcript event for session.rotated.
    const rotatedEvents = db
      .prepare(
        "SELECT COUNT(*) AS c FROM events WHERE session_id = ? AND type = 'session.rotated'",
      )
      .get(session.id) as { c: number };
    assert.equal(rotatedEvents.c, 0, 'session.rotated must not be persisted as a transcript event');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
