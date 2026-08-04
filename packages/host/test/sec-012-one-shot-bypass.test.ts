// Coverage for traceability row:
//   SEC-012 — Composer one-shot bypass must only affect the next turn,
//             must show a warning UI, and must not persist into
//             session.approval_mode.
//
// This file covers the host policy dimension only. The Composer UI warning
// and the message:send WS payload assertion still need separate evidence
// before the SEC-012 row can leave GAP — see traceability matrix.

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

// ---------------------------------------------------------------------------
// Fake proxy that records every startTurn call so we can compare per-turn
// policy params against the stored session.approval_mode.
// ---------------------------------------------------------------------------

class RecordingProxyClient implements ProxyClient {
  readonly executor: 'claude' | 'codex';
  notificationHandlers: NotificationHandler[] = [];
  startTurnCalls: Array<Record<string, unknown>> = [];

  constructor(executor: 'claude' | 'codex') {
    this.executor = executor;
  }

  async initialize() {
    return { mode: 'spawn' as const, protocolVersion: '0.1.0', methods: [] };
  }
  async capabilities() {
    return { protocolVersion: '0.1.0', models: [], slashCommands: [] };
  }
  async listSlashCommands() {
    return { commands: [] };
  }
  async createSession(params: { cwd: string; claudeSessionId?: string; threadId?: string }) {
    const nativeSessionId = params.claudeSessionId ?? params.threadId ?? `${this.executor}_${randomUUID()}`;
    return {
      session: {
        id: nativeSessionId,
        cwd: params.cwd,
        claudeSessionId: nativeSessionId,
        model: null,
        status: 'idle' as const,
        createdAt: '2026-05-17T00:00:00.000Z',
        updatedAt: '2026-05-17T00:00:00.000Z',
        lastError: null,
      },
      nativeSessionId,
    };
  }
  async interruptTurn() {}
  async respondApproval() {}
  async startTurn(params: unknown) {
    this.startTurnCalls.push(params as Record<string, unknown>);
    return {
      session: {
        id: 'proxy_x',
        cwd: '/tmp',
        model: null,
        status: 'running' as const,
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
  constructor(executor: 'claude' | 'codex') {
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

function setup(executor: 'claude' | 'codex') {
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

test('SEC-012: bypass turn (claude) carries permissionMode=bypassPermissions exactly once', async () => {
  const ctx = setup('claude');
  try {
    const session = await ctx.sessions.createSession({
      workspace_id: ctx.wsId,
      executor: 'claude',
      approval_mode: 'ask',
    });

    // Bypass turn: caller passes oneShotBypass=true.
    await ctx.sessions.sendMessage(session.id, 'risky shell', undefined, true);
    fireCompleted(ctx.proxyMgr);

    // Next turn: caller does NOT pass oneShotBypass.
    await ctx.sessions.sendMessage(session.id, 'normal follow up');

    const calls = ctx.proxyMgr.client.startTurnCalls;
    assert.equal(calls.length, 2, 'two turns started');

    // Bypass turn must carry bypassPermissions only on the first call.
    assert.equal(calls[0]!.permissionMode, 'bypassPermissions',
      'bypass turn must override permission to bypassPermissions');
    assert.notEqual(calls[1]!.permissionMode, 'bypassPermissions',
      'follow-up turn must NOT carry bypassPermissions');

    // Per `proxyTurnParamsFor`, approval_mode='ask' for claude maps to
    // permissionMode='default'. The follow-up turn must use that.
    assert.equal(calls[1]!.permissionMode, 'default',
      'follow-up turn must use the session.approval_mode mapping (ask → default)');
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
    assert.equal(calls[0]!.permissionMode, 'bypassPermissions', 'turn 1 bypass');
    assert.equal(calls[1]!.permissionMode, 'default', 'turn 2 back to ask→default');
    assert.equal(calls[2]!.permissionMode, 'bypassPermissions', 'turn 3 bypass again');
    assert.equal(calls[3]!.permissionMode, 'default', 'turn 4 back to ask→default');
  } finally {
    teardown(ctx);
  }
});

// ---------------------------------------------------------------------------
// Codex executor — different policy field set
// ---------------------------------------------------------------------------

test('SEC-012: bypass turn (codex) carries danger-full-access + approvalPolicy=never exactly once', async () => {
  const ctx = setup('codex');
  try {
    const session = await ctx.sessions.createSession({
      workspace_id: ctx.wsId,
      executor: 'codex',
      approval_mode: 'ask',
    });

    await ctx.sessions.sendMessage(session.id, 'risky', undefined, true);
    fireCompleted(ctx.proxyMgr);

    await ctx.sessions.sendMessage(session.id, 'normal follow up');

    const calls = ctx.proxyMgr.client.startTurnCalls;
    assert.equal(calls.length, 2);

    assert.equal(calls[0]!.sandbox, 'danger-full-access',
      'codex bypass turn must request danger-full-access sandbox');
    assert.equal(calls[0]!.approvalPolicy, 'never',
      'codex bypass turn must set approvalPolicy=never');
    assert.equal(calls[0]!.approvalsReviewer, 'auto_review',
      'codex bypass turn must set approvalsReviewer=auto_review');

    // Follow-up turn must NOT carry bypass params — ask → workspace-write + on-request.
    assert.notEqual(calls[1]!.sandbox, 'danger-full-access',
      'follow-up turn must NOT carry danger-full-access sandbox');
    assert.equal(calls[1]!.sandbox, 'workspace-write',
      'follow-up turn uses the stored approval_mode mapping (ask → workspace-write)');
    assert.equal(calls[1]!.approvalPolicy, 'on-request');
    assert.equal(calls[1]!.approvalsReviewer, 'user');
  } finally {
    teardown(ctx);
  }
});

test('SEC-012: codex bypass does NOT mutate session.approval_mode in DB', async () => {
  const ctx = setup('codex');
  try {
    const session = await ctx.sessions.createSession({
      workspace_id: ctx.wsId,
      executor: 'codex',
      approval_mode: 'plan',
    });

    await ctx.sessions.sendMessage(session.id, 'risky', undefined, true);

    const row = ctx.db
      .prepare('SELECT approval_mode FROM sessions WHERE id = ?')
      .get(session.id) as { approval_mode: string };
    assert.equal(row.approval_mode, 'plan',
      'codex bypass must not persist into session.approval_mode');
  } finally {
    teardown(ctx);
  }
});
