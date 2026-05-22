// Coverage for traceability rows:
//   CODEX-TTY-001 — switchRuntime dispatches by executor (claude / codex)
//                   and enforces idle / terminal / native-id preconditions.
//   CODEX-TTY-001 — CLI-mode `message:send` / queue draining guards:
//                   sessions in runtime_mode='tty' reject structured turns
//                   so we don't create ghost turns or race the PTY for the
//                   same on-disk codex thread.
//
// Stubs both executors' proxy clients + both TTY managers so the test
// exercises SessionManager's dispatch + guard logic without a real
// cc-proxy or codex-proxy subprocess.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ProxyNotification, ServerToClientMessage, Session } from '@gian/shared';
import { openDatabase } from '../src/storage/db.js';
import { SessionManager } from '../src/session/manager.js';
import type { ProxyManager } from '../src/proxy/manager.js';
import type { ProxyClient, NotificationHandler } from '../src/proxy/types.js';
import type { WsBroadcaster } from '../src/web/ws-broadcast.js';
import { ApprovalManager } from '../src/approval/index.js';
import { QueueManager } from '../src/queue/index.js';
import type { TtyManager } from '../src/tty/manager.js';
import type { CodexTtyManager } from '../src/tty/codex-manager.js';

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

class StubProxyClient implements ProxyClient {
  constructor(public readonly executor: 'claude' | 'codex' = 'claude') {}
  notificationHandlers: NotificationHandler[] = [];

  async initialize() { return { mode: 'spawn' as const, protocolVersion: '0.1.0', methods: [] }; }
  async capabilities() { return { protocolVersion: '0.1.0', models: [], slashCommands: [] }; }
  async listSlashCommands() { return { commands: [] }; }

  async createSession(params: { cwd: string; claudeSessionId?: string; threadId?: string }) {
    const nativeSessionId =
      params.claudeSessionId ?? params.threadId ?? `${this.executor}_${randomUUID()}`;
    return {
      session: {
        id: nativeSessionId,
        cwd: params.cwd,
        ...(this.executor === 'claude'
          ? { claudeSessionId: nativeSessionId }
          : { threadId: nativeSessionId }),
        model: null,
        status: 'idle' as const,
        createdAt: '2026-05-20T00:00:00.000Z',
        updatedAt: '2026-05-20T00:00:00.000Z',
        lastError: null,
      },
      nativeSessionId,
    };
  }
  async interruptTurn() {}
  async respondApproval() {}
  async startTurn() {
    return {
      session: {
        id: 'proxy_x', cwd: '/tmp', model: null, status: 'running' as const,
        createdAt: '2026-05-20T00:00:00.000Z', updatedAt: '2026-05-20T00:00:00.000Z', lastError: null,
      },
      turn: { id: 'proxy_turn' },
    };
  }
  async closeSession() {}
  async shutdown() {}
  forceKill() {}
  onNotification(h: NotificationHandler) { this.notificationHandlers.push(h); return () => { this.notificationHandlers = this.notificationHandlers.filter(x => x !== h); }; }
  onExit() { return () => {}; }
  fire(notification: ProxyNotification): void { for (const h of this.notificationHandlers) h(notification); }
}

class FakeProxyManager {
  clients = new Map<string, StubProxyClient>();
  async getOrCreate(_sessionId: string, executor: 'claude' | 'codex'): Promise<ProxyClient> {
    const key = `${executor}:any`;
    let c = this.clients.get(key);
    if (!c) { c = new StubProxyClient(executor); this.clients.set(key, c); }
    return c;
  }
  get(_sessionId: string): ProxyClient | undefined {
    // Return the first registered client. Tests don't rely on per-session
    // lookup beyond "any client of the right executor exists".
    return this.clients.values().next().value;
  }
  async closeAll(): Promise<void> {}
}

class CapturingBroadcaster {
  messages: ServerToClientMessage[] = [];
  add() {} remove() {} send() {}
  broadcast(msg: ServerToClientMessage) { this.messages.push(msg); }
  get size() { return 0; }
}

interface ManagerSpy {
  start: Array<{ sessionId: string; cwd: string; cols: number; rows: number }>;
  stop: Array<{ sessionId: string }>;
}

function makeFakeTtyManager(spy: ManagerSpy, db: ReturnType<typeof openDatabase>) {
  // Mirror the real managers' side effect on runtime_mode so subsequent
  // SessionManager guards (sendMessage CLI check, target===current no-op)
  // see the post-switch state. The real claude/codex managers update this
  // column in `persistMode`; the test fakes do the same one-liner.
  const persist = (sessionId: string, mode: 'tty' | 'structured') => {
    db.prepare('UPDATE sessions SET runtime_mode = ? WHERE id = ?').run(mode, sessionId);
  };
  return {
    async start(session: Session, cwd: string, opts: { cols: number; rows: number }) {
      spy.start.push({ sessionId: session.id, cwd, cols: opts.cols, rows: opts.rows });
      persist(session.id, 'tty');
      return { replay: [], alive: true };
    },
    async stop(session: Session) {
      spy.stop.push({ sessionId: session.id });
      persist(session.id, 'structured');
    },
    async input() {}, async resize() {}, async replay() { return { chunks: [], alive: false }; },
    handleProxyNotification() {},
  };
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'gian-switch-test-'));
  const db = openDatabase(dir);
  const wsId = randomUUID();
  db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)')
    .run(wsId, 'test', '/tmp/test-ws');

  const proxyMgr = new FakeProxyManager();
  const broadcaster = new CapturingBroadcaster();
  const approvals = new ApprovalManager(broadcaster as unknown as WsBroadcaster);
  const queue = new QueueManager(db);
  const sessions = new SessionManager(
    db,
    proxyMgr as unknown as ProxyManager,
    broadcaster as unknown as WsBroadcaster,
    approvals, queue, dir,
  );
  approvals.setRespondFn((sid, aid, dec) => sessions.respondApproval(sid, aid, dec));
  approvals.setGetModeFn(sid => sessions.getSession(sid).approval_mode);

  const claudeSpy: ManagerSpy = { start: [], stop: [] };
  const codexSpy: ManagerSpy = { start: [], stop: [] };
  sessions.setTtyManager(makeFakeTtyManager(claudeSpy, db) as unknown as TtyManager);
  sessions.setCodexTtyManager(makeFakeTtyManager(codexSpy, db) as unknown as CodexTtyManager);

  return { dir, db, wsId, proxyMgr, broadcaster, sessions, claudeSpy, codexSpy };
}

function teardown(ctx: { dir: string; db: ReturnType<typeof openDatabase> }) {
  ctx.db.close();
  rmSync(ctx.dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// CODEX-TTY-001 — switchRuntime dispatches by executor
// ---------------------------------------------------------------------------

test('CODEX-TTY-001: switchRuntime(target=tty) on a CLAUDE session calls claude TtyManager.start', async () => {
  const ctx = setup();
  try {
    const session = await ctx.sessions.createSession({ workspace_id: ctx.wsId, executor: 'claude' });
    await ctx.sessions.switchRuntime(session.id, 'tty');
    assert.equal(ctx.claudeSpy.start.length, 1);
    assert.equal(ctx.codexSpy.start.length, 0,
      'codex manager must NOT see a claude session switch');
    assert.equal(ctx.claudeSpy.start[0]!.sessionId, session.id);
  } finally { teardown(ctx); }
});

test('CODEX-TTY-001: switchRuntime(target=tty) on a CODEX session calls codex CodexTtyManager.start', async () => {
  const ctx = setup();
  try {
    const session = await ctx.sessions.createSession({ workspace_id: ctx.wsId, executor: 'codex' });
    await ctx.sessions.switchRuntime(session.id, 'tty');
    assert.equal(ctx.codexSpy.start.length, 1);
    assert.equal(ctx.claudeSpy.start.length, 0,
      'claude manager must NOT see a codex session switch');
    assert.equal(ctx.codexSpy.start[0]!.sessionId, session.id);
  } finally { teardown(ctx); }
});

test('CODEX-TTY-001: switchRuntime(target=structured) on a CODEX session calls codex CodexTtyManager.stop', async () => {
  const ctx = setup();
  try {
    const session = await ctx.sessions.createSession({ workspace_id: ctx.wsId, executor: 'codex' });
    await ctx.sessions.switchRuntime(session.id, 'tty');
    await ctx.sessions.switchRuntime(session.id, 'structured');
    assert.equal(ctx.codexSpy.stop.length, 1);
    assert.equal(ctx.claudeSpy.stop.length, 0);
  } finally { teardown(ctx); }
});

test('CODEX-TTY-001: switchRuntime is a no-op when target === current mode (toggle double-fire safety)', async () => {
  const ctx = setup();
  try {
    const session = await ctx.sessions.createSession({ workspace_id: ctx.wsId, executor: 'codex' });
    // session starts in structured by default — switch to structured is a no-op
    await ctx.sessions.switchRuntime(session.id, 'structured');
    assert.equal(ctx.codexSpy.start.length, 0);
    assert.equal(ctx.codexSpy.stop.length, 0);
  } finally { teardown(ctx); }
});

test('CODEX-TTY-001: switchRuntime throws SWITCH_BLOCKED on a finalized worktree session', async () => {
  const ctx = setup();
  try {
    const session = await ctx.sessions.createSession({ workspace_id: ctx.wsId, executor: 'codex' });
    // Simulate a merged worktree.
    ctx.db.prepare(`UPDATE sessions SET worktree_outcome='merged' WHERE id=?`).run(session.id);
    await assert.rejects(
      ctx.sessions.switchRuntime(session.id, 'tty'),
      (err: Error & { code?: string }) =>
        err.code === 'SWITCH_BLOCKED' && /finalized/.test(err.message),
    );
    assert.equal(ctx.codexSpy.start.length, 0);
  } finally { teardown(ctx); }
});

test('CODEX-TTY-001: switchRuntime rejects unsupported executors', async () => {
  const ctx = setup();
  try {
    const session = await ctx.sessions.createSession({ workspace_id: ctx.wsId, executor: 'claude' });
    // Forge a fictional executor on the row to hit the guard.
    ctx.db.prepare(`UPDATE sessions SET executor='mystery' WHERE id=?`).run(session.id);
    await assert.rejects(
      ctx.sessions.switchRuntime(session.id, 'tty'),
      (err: Error & { code?: string }) =>
        err.code === 'SWITCH_BLOCKED' && /not available for executor/.test(err.message),
    );
  } finally { teardown(ctx); }
});

// ---------------------------------------------------------------------------
// CODEX-TTY-001 — CLI-mode message:send guard
// ---------------------------------------------------------------------------

test('CODEX-TTY-001: sendMessage rejects when session is in runtime_mode=tty (codex)', async () => {
  const ctx = setup();
  try {
    const session = await ctx.sessions.createSession({ workspace_id: ctx.wsId, executor: 'codex' });
    await ctx.sessions.switchRuntime(session.id, 'tty');
    await assert.rejects(
      ctx.sessions.sendMessage(session.id, 'hello'),
      /CLI mode/,
    );
    // No turn row created.
    const count = (ctx.db.prepare('SELECT COUNT(*) AS c FROM turns WHERE session_id=?').get(session.id) as { c: number }).c;
    assert.equal(count, 0);
  } finally { teardown(ctx); }
});

test('CODEX-TTY-001: sendMessage rejects when session is in runtime_mode=tty (claude)', async () => {
  const ctx = setup();
  try {
    const session = await ctx.sessions.createSession({ workspace_id: ctx.wsId, executor: 'claude' });
    await ctx.sessions.switchRuntime(session.id, 'tty');
    await assert.rejects(
      ctx.sessions.sendMessage(session.id, 'hello'),
      /CLI mode/,
    );
  } finally { teardown(ctx); }
});

test('CODEX-TTY-001: sendQueuedNow rejects in tty mode AND preserves the queue head', async () => {
  const ctx = setup();
  try {
    const session = await ctx.sessions.createSession({ workspace_id: ctx.wsId, executor: 'codex' });
    ctx.sessions.enqueueMessage(session.id, 'first');
    ctx.sessions.enqueueMessage(session.id, 'second');
    await ctx.sessions.switchRuntime(session.id, 'tty');
    await assert.rejects(
      ctx.sessions.sendQueuedNow(session.id),
      /CLI mode/,
    );
    assert.equal(ctx.sessions.getQueueLength(session.id), 2,
      'queue head must NOT be popped when sendQueuedNow refuses in CLI mode');
  } finally { teardown(ctx); }
});

// ---------------------------------------------------------------------------
// CODEX-TTY-001 — PTY cleanup on session teardown / forceRecover
// (covers HIGH from codex review: structured closeSession alone leaks the
//  CLI-mode PTY in shared codex-proxy)
// ---------------------------------------------------------------------------

test('CODEX-TTY-001: deleteSession on a CODEX session in tty mode calls CodexTtyManager.stop (no PTY leak)', async () => {
  const ctx = setup();
  try {
    const session = await ctx.sessions.createSession({ workspace_id: ctx.wsId, executor: 'codex' });
    await ctx.sessions.switchRuntime(session.id, 'tty');
    ctx.codexSpy.stop.length = 0;  // discard the no-op switch-back stop, if any
    await ctx.sessions.deleteSession(session.id);
    assert.equal(ctx.codexSpy.stop.length, 1,
      'teardownProxy must call CodexTtyManager.stop so `codex resume` is killed inside the shared codex-proxy');
    assert.equal(ctx.codexSpy.stop[0]!.sessionId, session.id);
  } finally { teardown(ctx); }
});

test('CODEX-TTY-001: deleteSession on a CLAUDE session in tty mode calls TtyManager.stop', async () => {
  const ctx = setup();
  try {
    const session = await ctx.sessions.createSession({ workspace_id: ctx.wsId, executor: 'claude' });
    await ctx.sessions.switchRuntime(session.id, 'tty');
    ctx.claudeSpy.stop.length = 0;
    await ctx.sessions.deleteSession(session.id);
    assert.equal(ctx.claudeSpy.stop.length, 1,
      'teardownProxy must call TtyManager.stop so the claude PTY is killed before cc-proxy.closeSession');
  } finally { teardown(ctx); }
});

test('CODEX-TTY-001: deleteSession on a structured session does NOT call either tty manager stop', async () => {
  const ctx = setup();
  try {
    const session = await ctx.sessions.createSession({ workspace_id: ctx.wsId, executor: 'codex' });
    // never switch to tty
    await ctx.sessions.deleteSession(session.id);
    assert.equal(ctx.codexSpy.stop.length, 0);
    assert.equal(ctx.claudeSpy.stop.length, 0);
  } finally { teardown(ctx); }
});

test('CODEX-TTY-001: forceRecover on a CODEX session in tty mode calls CodexTtyManager.stop', async () => {
  const ctx = setup();
  try {
    const session = await ctx.sessions.createSession({ workspace_id: ctx.wsId, executor: 'codex' });
    await ctx.sessions.switchRuntime(session.id, 'tty');
    ctx.codexSpy.stop.length = 0;
    await ctx.sessions.forceRecover(session.id);
    assert.equal(ctx.codexSpy.stop.length, 1,
      'forceRecover must kill the PTY too, otherwise CLI-mode session is wedged but PTY keeps running');
    // After forceRecover the runtime_mode should be back to structured so a
    // re-open lands the user in Chat instead of a dead xterm.
    const row = ctx.db.prepare('SELECT runtime_mode FROM sessions WHERE id=?').get(session.id) as { runtime_mode: string };
    assert.equal(row.runtime_mode, 'structured');
  } finally { teardown(ctx); }
});

// ---------------------------------------------------------------------------
// CODEX-TTY-001 — WS error envelope preserves `SWITCH_BLOCKED`
// (covers MEDIUM/LOW from codex review: dispatchErrorCode used to flatten
//  every switch failure to DISPATCH_FAILED)
// ---------------------------------------------------------------------------

test('CODEX-TTY-001: WS dispatch surfaces SWITCH_BLOCKED (not DISPATCH_FAILED) when switchRuntime refuses', async () => {
  // Avoid the full SessionManager — we want to assert ws-handler behavior,
  // not re-test the manager logic. A minimal stub is enough here.
  const { makeWsHandlers } = await import('../src/web/ws-handler.js');
  const captured: Array<Record<string, unknown>> = [];
  const broadcaster = {
    add() {}, remove() {},
    send(_ws: unknown, msg: Record<string, unknown>) { captured.push(msg); },
    broadcast() {},
    get size() { return 0; },
  };
  const sessions = {
    listSessions: () => [],
    async switchRuntime() {
      throw Object.assign(new Error('finish the current turn before switching runtime'), { code: 'SWITCH_BLOCKED' });
    },
  };
  const handlers = makeWsHandlers({
    sessions: sessions as unknown as import('../src/session/manager.js').SessionManager,
    broadcaster: broadcaster as unknown as import('../src/web/ws-broadcast.js').WsBroadcaster,
  });
  const ws = {} as unknown as import('hono/ws').WSContext;
  handlers.onOpen({} as Event, ws);
  // Authenticate (AUTH_REQUIRED defaults to false in test env).
  await handlers.onMessage({ data: JSON.stringify({ type: 'auth', token: 't' }) } as never, ws);
  captured.length = 0;
  // Now trigger the failing switch.
  await handlers.onMessage({
    data: JSON.stringify({ type: 'session:switch-runtime', session_id: 'sess-1', target: 'tty' }),
  } as never, ws);
  const err = captured.find(m => m.type === 'error');
  assert.ok(err, 'dispatch failure must broadcast an `error` envelope');
  assert.equal(err!.code, 'SWITCH_BLOCKED',
    'SwitchRuntime errors tag .code=SWITCH_BLOCKED; ws-handler must forward that instead of falling back to DISPATCH_FAILED');
  assert.equal(err!.session_id, 'sess-1');
});

test('CODEX-TTY-001: switching BACK to structured re-enables sendMessage on the same session', async () => {
  const ctx = setup();
  try {
    const session = await ctx.sessions.createSession({ workspace_id: ctx.wsId, executor: 'codex' });
    await ctx.sessions.switchRuntime(session.id, 'tty');
    await ctx.sessions.switchRuntime(session.id, 'structured');
    // sendMessage path needs to complete its turn for the assertion to be
    // meaningful end-to-end; instead, just check it doesn't throw the CLI-
    // mode guard. The fake startTurn returns immediately.
    await ctx.sessions.sendMessage(session.id, 'back to chat');
    const count = (ctx.db.prepare('SELECT COUNT(*) AS c FROM turns WHERE session_id=?').get(session.id) as { c: number }).c;
    assert.equal(count, 1, 'sendMessage should have inserted a turn after switching back to structured');
  } finally { teardown(ctx); }
});
