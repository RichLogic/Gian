// Coverage for traceability row:
//   SEC-012 — Composer one-shot bypass must only affect the next turn,
//             must show a warning UI, and must not persist into
//             session.approval_mode.
//
// This file covers the authoritative host policy boundary. Browser
// wire-through lives in e2e/specs/06-one-shot-bypass.spec.ts.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Executor, ProxyNotification, ServerToClientMessage } from '@gian/shared';
import { openDatabase } from '../src/storage/db.js';
import { SessionManager } from '../src/session/manager.js';
import type { ProxyManager } from '../src/proxy/manager.js';
import type { ProxyClient, NotificationHandler } from '../src/proxy/types.js';
import type { WsBroadcaster } from '../src/web/ws-broadcast.js';
import { ApprovalManager } from '../src/approval/index.js';
import { QueueManager } from '../src/queue/index.js';

// ---------------------------------------------------------------------------
// Fake proxy that records every startTurn call so we can compare per-turn
// policy params against the stored session.approval_mode.
// ---------------------------------------------------------------------------

class RecordingProxyClient implements ProxyClient {
  readonly executor: Executor;
  notificationHandlers: NotificationHandler[] = [];
  startTurnCalls: Array<import('../src/proxy/types.js').StartTurnParams> = [];

  constructor(executor: Executor) {
    this.executor = executor;
  }

  isExited() { return false; }
  async initialize() {
    return {
      protocol: { name: 'gian.proxy' as const, version: '2.0' as const },
      plugin: { id: this.executor, name: this.executor, version: '0.2.0' },
      process: { scope: this.executor === 'codex' ? 'shared' as const : 'session' as const },
      capabilities: {},
    };
  }
  async catalog() {
    return {
      catalogRevision: 'sec-012',
      input: [{ type: 'text' as const }],
      configOptions: [{
        id: 'permission_mode',
        displayName: 'Mode',
        binding: 'turn' as const,
        role: 'approval_mode',
        control: 'select' as const,
        required: false,
        defaultValue: 'ask',
        choices: [
          { value: 'ask', displayName: 'Ask' },
          { value: 'plan', displayName: 'Plan' },
          { value: 'auto', displayName: 'Auto' },
          { value: 'bypassPermissions', displayName: 'Bypass' },
        ],
      }],
      slashCommands: [],
    };
  }
  async createSession(params: { cwd: string; nativeSessionId?: string }) {
    const nativeSessionId = params.nativeSessionId ?? `${this.executor}_${randomUUID()}`;
    return {
      session: {
        id: nativeSessionId,
        cwd: params.cwd,
        state: 'idle' as const,
        createdAt: '2026-05-17T00:00:00.000Z',
        updatedAt: '2026-05-17T00:00:00.000Z',
        lastError: null,
      },
      nativeSessionId,
    };
  }
  async interruptTurn() {}
  async respondInteraction() {}
  async startTurn(params: import('../src/proxy/types.js').StartTurnParams) {
    this.startTurnCalls.push(params);
    return {
      session: {
        id: 'proxy_x',
        cwd: '/tmp',
        state: 'running' as const,
        createdAt: '2026-05-17T00:00:00.000Z',
        updatedAt: '2026-05-17T00:00:00.000Z',
        lastError: null,
      },
      turn: { id: 'proxy_turn' },
    };
  }
  async closeSession() {}
  async shutdown() {}
  forceKill() {}
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
  client: RecordingProxyClient;
  constructor(executor: Executor) {
    this.client = new RecordingProxyClient(executor);
  }
  async getOrCreate(): Promise<ProxyClient> {
    return this.client;
  }
  get(): ProxyClient {
    return this.client;
  }
  async closeAll(): Promise<void> {}
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

function setup(executor: Executor) {
  const dir = mkdtempSync(join(tmpdir(), 'gian-sec012-test-'));
  const db = openDatabase(dir);
  const wsId = randomUUID();
  db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)')
    .run(wsId, 'test', '/tmp/test-ws');

  const proxyMgr = new FakeProxyManager(executor);
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

function teardown(ctx: { dir: string; db: ReturnType<typeof openDatabase> }) {
  ctx.db.close();
  rmSync(ctx.dir, { recursive: true, force: true });
}

function fireCompleted(proxyMgr: FakeProxyManager) {
  proxyMgr.client.fire({
    method: 'turn.completed',
    params: { sessionId: 'proxy_x', data: { status: 'completed' } },
  });
}

// ---------------------------------------------------------------------------
// Claude executor
// ---------------------------------------------------------------------------

test('SEC-012: bypass turn (claude) carries permission_mode=bypassPermissions exactly once', async () => {
  const ctx = setup('claude');
  try {
    const session = await ctx.sessions.createSession({
      workspace_id: ctx.wsId,
      executor: 'claude',
      approval_mode: 'ask',
    });

    await ctx.sessions.sendMessage(session.id, 'risky shell', undefined, true);
    fireCompleted(ctx.proxyMgr);

    await ctx.sessions.sendMessage(session.id, 'normal follow up');

    const calls = ctx.proxyMgr.client.startTurnCalls;
    assert.equal(calls.length, 2, 'two turns started');
    assert.equal(calls[0]!.config.permission_mode, 'bypassPermissions',
      'bypass turn must override permission to bypassPermissions');
    assert.equal(calls[1]!.config.permission_mode, 'ask',
      'follow-up turn must use the stored session approval_mode');
  } finally {
    teardown(ctx);
  }
});

test('SEC-012: bypass turn does NOT mutate session.approval_mode in DB', async () => {
  const ctx = setup('claude');
  try {
    const session = await ctx.sessions.createSession({
      workspace_id: ctx.wsId,
      executor: 'claude',
      approval_mode: 'plan',
    });

    const before = ctx.db
      .prepare('SELECT approval_mode FROM sessions WHERE id = ?')
      .get(session.id) as { approval_mode: string };
    assert.equal(before.approval_mode, 'plan');

    await ctx.sessions.sendMessage(session.id, 'risky', undefined, true);
    fireCompleted(ctx.proxyMgr);

    const after = ctx.db
      .prepare('SELECT approval_mode FROM sessions WHERE id = ?')
      .get(session.id) as { approval_mode: string };
    assert.equal(after.approval_mode, 'plan',
      'bypass must NOT persist into session.approval_mode — that would defeat the per-turn contract');
  } finally {
    teardown(ctx);
  }
});

test('SEC-012: second bypass turn re-applies bypassPermissions without coupling to the first', async () => {
  // Per the SEC-012 contract, every bypass turn is independent: caller has
  // to opt in each time. Don't let an internal sticky flag turn one bypass
  // into a permanent one — verify by alternating explicit opt-ins.
  const ctx = setup('claude');
  try {
    const session = await ctx.sessions.createSession({
      workspace_id: ctx.wsId,
      executor: 'claude',
      approval_mode: 'ask',
    });

    await ctx.sessions.sendMessage(session.id, 'turn 1 bypass', undefined, true);
    fireCompleted(ctx.proxyMgr);

    await ctx.sessions.sendMessage(session.id, 'turn 2 normal');
    fireCompleted(ctx.proxyMgr);

    await ctx.sessions.sendMessage(session.id, 'turn 3 bypass again', undefined, true);
    fireCompleted(ctx.proxyMgr);

    await ctx.sessions.sendMessage(session.id, 'turn 4 normal');

    const calls = ctx.proxyMgr.client.startTurnCalls;
    assert.equal(calls.length, 4);
    assert.equal(calls[0]!.config.permission_mode, 'bypassPermissions', 'turn 1 bypass');
    assert.equal(calls[1]!.config.permission_mode, 'ask', 'turn 2 back to ask');
    assert.equal(calls[2]!.config.permission_mode, 'bypassPermissions', 'turn 3 bypass again');
    assert.equal(calls[3]!.config.permission_mode, 'ask', 'turn 4 back to ask');
  } finally {
    teardown(ctx);
  }
});

// ---------------------------------------------------------------------------
// Unsupported executors — fail closed before any turn side effect
// ---------------------------------------------------------------------------

for (const executor of ['codex', 'kimi'] as const) {
  test(`SEC-012: ${executor} one-shot bypass fails closed without side effects`, async () => {
    const ctx = setup(executor);
    try {
      const session = await ctx.sessions.createSession({
        workspace_id: ctx.wsId,
        executor,
        ...(executor === 'codex' ? { approval_mode: 'plan' as const } : {}),
      });
      const before = ctx.db
        .prepare('SELECT approval_mode, status, updated_at FROM sessions WHERE id = ?')
        .get(session.id) as { approval_mode: string | null; status: string; updated_at: string };
      const eventsBefore = (ctx.db
        .prepare('SELECT COUNT(*) AS count FROM events WHERE session_id = ?')
        .get(session.id) as { count: number }).count;
      ctx.broadcaster.messages.length = 0;

      await assert.rejects(
        ctx.sessions.sendMessage(session.id, 'must stay blocked', undefined, true),
        /only supported for Claude sessions/,
      );

      const after = ctx.db
        .prepare('SELECT approval_mode, status, updated_at FROM sessions WHERE id = ?')
        .get(session.id) as { approval_mode: string | null; status: string; updated_at: string };
      const eventsAfter = (ctx.db
        .prepare('SELECT COUNT(*) AS count FROM events WHERE session_id = ?')
        .get(session.id) as { count: number }).count;
      assert.deepEqual(after, before, 'rejected bypass must not mutate the session row');
      assert.equal(eventsAfter, eventsBefore, 'rejected bypass must not append transcript events');
      assert.equal(ctx.proxyMgr.client.startTurnCalls.length, 0, 'rejected bypass must not start a turn');
      assert.equal(ctx.broadcaster.messages.length, 0, 'rejected bypass must not broadcast optimistic state');
    } finally {
      teardown(ctx);
    }
  });
}
