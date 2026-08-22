import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { ProxyProtocolError } from '@gian/proxy-protocol';
import type { Executor, ServerToClientMessage } from '@gian/shared';
import { openDatabase } from '../src/storage/db.js';
import { SessionManager } from '../src/session/manager.js';
import { ApprovalManager } from '../src/approval/index.js';
import { QueueManager } from '../src/queue/index.js';
import type { ProxyManager } from '../src/proxy/manager.js';
import type { ProxyClient, NotificationHandler } from '../src/proxy/types.js';
import type { WsBroadcaster } from '../src/web/ws-broadcast.js';
import { EMPTY_CATALOG, stubInitialize, stubSession } from './helpers/protocol-v2-stub.js';

class CapturingBroadcaster {
  messages: ServerToClientMessage[] = [];
  add() {}
  remove() {}
  send() {}
  broadcast(msg: ServerToClientMessage): void {
    this.messages.push(msg);
  }
  get size() { return 0; }
}

class SidechatForkStubClient implements ProxyClient {
  readonly executor: Executor = 'claude';
  readonly protocolV2 = true as const;
  stream = 'stream-parent';
  notificationHandlers: NotificationHandler[] = [];
  faultHandlers: Array<(error: Error) => void> = [];
  children = new Map<string, SidechatForkStubClient>();
  resumeRefs = new Map<string, string>();
  closeCalls: Array<{ sidechatId: string; resumeRef: { id: string } }> = [];
  providerDataDeleted = true;
  resumeUnavailable = false;
  sessionConfig = { execution_mode: 'agent' as const };
  currentParentId = 'parent';
  pgid = 100;
  forkCalls = 0;

  isExited() { return false; }
  processGroupId() { return this.pgid; }
  async initialize() {
    return {
      ...stubInitialize('claude'),
      capabilities: {
        sidechat: 1,
        'session.replay': 1,
        'session.fork': 1,
        'session.fork.atTurn': 1,
      },
    };
  }
  lastCreateParams: { nativeSessionId?: string } | null = null;
  async catalog() {
    return {
      ...EMPTY_CATALOG,
      catalogRevision: 'sidechat-fork-stub',
      configOptions: [{
        id: 'execution_mode',
        displayName: 'Mode',
        binding: 'session' as const,
        control: 'select' as const,
        required: true,
        defaultValue: 'agent',
        choices: [
          { value: 'agent', displayName: 'Agent' },
          { value: 'plan', displayName: 'Plan' },
        ],
      }, {
        id: 'effort',
        displayName: 'Effort',
        binding: 'turn' as const,
        control: 'select' as const,
        required: false,
        defaultValue: 'medium',
        choices: [
          { value: 'low', displayName: 'Low' },
          { value: 'medium', displayName: 'Medium' },
        ],
      }],
      actions: [
        { id: 'sidechat.create', supported: true },
        { id: 'session.fork', supported: true },
        { id: 'session.fork.atTurn', supported: true },
      ],
    };
  }
  async createSession(params: { cwd?: string; nativeSessionId?: string } = {}) {
    this.lastCreateParams = params;
    return {
      session: stubSession(params.nativeSessionId ?? 'parent', params.cwd ?? '/tmp'),
      nativeSessionId: params.nativeSessionId ?? 'native-parent',
    };
  }
  streamId() { return this.stream; }
  hasAttachedSession() { return this.stream != null; }
  runtimeHost() {
    return {
      createSessionClient: (id: string) => {
        const existing = this.children.get(id);
        if (existing) return existing;
        const child = new SidechatForkStubClient();
        child.stream = null as unknown as string;
        this.children.set(id, child);
        return child;
      },
    };
  }
  async createSidechat(params: { sidechatId: string }) {
    const resumeRef = { id: `opaque-${params.sidechatId}-1` };
    this.resumeRefs.set(params.sidechatId, resumeRef.id);
    const child = this.runtimeHost().createSessionClient(params.sidechatId);
    child.stream = `stream-${params.sidechatId}`;
    return {
      id: params.sidechatId,
      parentSessionId: this.currentParentId,
      streamId: `stream-${params.sidechatId}`,
      state: 'idle' as const,
      resumeRef,
      anchor: { type: 'empty' as const },
      sessionConfig: this.sessionConfig,
      createdAt: '2026-08-20T00:00:00.000Z',
      updatedAt: '2026-08-20T00:00:00.000Z',
    };
  }
  async resumeSidechat(params: { sidechatId: string; resumeRef: { id: string } }) {
    if (this.resumeUnavailable) {
      throw new ProxyProtocolError('SIDECHAT_UNAVAILABLE', 'gone', 'request');
    }
    const next = { id: `opaque-${params.sidechatId}-2` };
    this.resumeRefs.set(params.sidechatId, next.id);
    const child = this.runtimeHost().createSessionClient(params.sidechatId);
    child.stream = `stream-${params.sidechatId}-2`;
    return {
      id: params.sidechatId,
      parentSessionId: this.currentParentId,
      streamId: `stream-${params.sidechatId}-2`,
      state: 'idle' as const,
      resumeRef: next,
      anchor: { type: 'empty' as const },
      sessionConfig: this.sessionConfig,
      createdAt: '2026-08-20T00:00:00.000Z',
      updatedAt: '2026-08-20T00:00:00.000Z',
    };
  }
  async closeSidechat(params: { sidechatId: string; resumeRef: { id: string } }) {
    this.closeCalls.push(params);
    return { ok: true as const, sidechatId: params.sidechatId, providerDataDeleted: this.providerDataDeleted };
  }
  async forkSession(params: { sessionId: string; anchor: { type: string } }) {
    this.forkCalls += 1;
    return stubForkResult(this.currentParentId, params.sessionId, this);
  }
  async startTurn() {
    return { session: stubSession('sc', '/tmp', 'running'), turn: { id: 't-side' } };
  }
  async interruptTurn() {}
  async respondInteraction() {}
  async closeSession() {}
  async deleteNativeSession(_nativeSessionId: string) {}
  async shutdown() {}
  forceKill() {}
  onNotification(handler: NotificationHandler) {
    this.notificationHandlers.push(handler);
    return () => {
      this.notificationHandlers = this.notificationHandlers.filter((item) => item !== handler);
    };
  }
  onSessionFault(handler: (error: Error) => void) {
    this.faultHandlers.push(handler);
    return () => {
      this.faultHandlers = this.faultHandlers.filter((item) => item !== handler);
    };
  }
  onExit() { return () => {}; }
}

function stubForkResult(
  parentId: string,
  sessionId: string,
  client: SidechatForkStubClient,
  extras: { nativeSession?: { id: string } | null; attach?: boolean } = {},
) {
  const child = client.runtimeHost().createSessionClient(sessionId);
  if (extras.attach !== false) child.stream = `stream-${sessionId}`;
  return {
    session: {
      id: sessionId,
      streamId: `stream-${sessionId}`,
      state: 'idle' as const,
      ...(extras.nativeSession === null
        ? {}
        : { nativeSession: extras.nativeSession ?? { id: `native-${sessionId}` } }),
      createdAt: '2026-08-20T00:00:00.000Z',
      updatedAt: '2026-08-20T00:00:00.000Z',
    },
    origin: {
      kind: 'fork' as const,
      sessionId: parentId,
      turnId: 't1',
      sourceTurnId: 'src-1',
    },
    replayEvents: [{
      method: 'turn.started',
      eventId: 'r1',
      replayStreamId: 'replay-fork',
      sequence: 1,
      sessionId,
      sourceTurnId: 'src-1',
      emittedAt: '2026-08-20T00:00:00.000Z',
      data: {},
    }, {
      method: 'turn.completed',
      eventId: 'r2',
      replayStreamId: 'replay-fork',
      sequence: 2,
      sessionId,
      sourceTurnId: 'src-1',
      emittedAt: '2026-08-20T00:00:00.000Z',
      data: { stopReason: 'completed' },
    }],
    replayStreamId: 'replay-fork',
  };
}

class StubProxyManager {
  client = new SidechatForkStubClient();
  adopted = new Map<string, ProxyClient>();
  parentSessionId: string | null = null;
  async getOrCreate(sessionId?: string): Promise<ProxyClient> {
    if (sessionId) {
      this.parentSessionId = sessionId;
      this.client.currentParentId = sessionId;
    }
    return this.client;
  }
  get(sessionId?: string): ProxyClient | undefined {
    if (!sessionId) return this.client;
    if (this.adopted.has(sessionId)) return this.adopted.get(sessionId);
    if (this.client.children.has(sessionId)) return undefined;
    if (sessionId === this.parentSessionId) return this.client;
    return undefined;
  }
  adoptExisting(sessionId: string, client: ProxyClient): void {
    this.adopted.set(sessionId, client);
  }
  forgetAdopted(sessionId: string): void {
    this.adopted.delete(sessionId);
  }
  async dispose() {}
  async closeAll() {}
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'gian-sidechat-int-'));
  const db = openDatabase(dir);
  const wsId = randomUUID();
  db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)').run(wsId, 'test', '/tmp/test-ws');
  const proxyMgr = new StubProxyManager();
  const broadcaster = new CapturingBroadcaster();
  const approvals = new ApprovalManager(broadcaster as unknown as WsBroadcaster);
  const sessions = new SessionManager(
    db,
    proxyMgr as unknown as ProxyManager,
    broadcaster as unknown as WsBroadcaster,
    approvals,
    new QueueManager(db),
    dir,
  );
  return { dir, db, wsId, proxyMgr, broadcaster, sessions };
}

test('Side Chat persists only on the transient store and is absent from history/trace', async () => {
  const ctx = setup();
  try {
    const parent = await ctx.sessions.createSession({ workspace_id: ctx.wsId, executor: 'claude' });
    const sidechat = await ctx.sessions.createSidechat(parent.id, 'sc_int_1');
    assert.equal(sidechat.parent_session_id, parent.id);
    assert.equal('resumeRef' in sidechat, false);
    assert.equal(ctx.sessions.listSidechats().length, 1);
    assert.equal(ctx.sessions.listSessions().some((session) => session.id === sidechat.id), false);
    assert.equal(
      (ctx.db.prepare('SELECT COUNT(*) AS n FROM sidechat_transients').get() as { n: number }).n,
      1,
    );
    assert.equal(
      (ctx.db.prepare('SELECT COUNT(*) AS n FROM events WHERE session_id = ?').get(sidechat.id) as { n: number }).n,
      0,
    );
    assert.throws(
      () => ctx.sessions.listEvents(sidechat.id),
      (error: unknown) => error instanceof ProxyProtocolError && error.code === 'SESSION_NOT_FOUND',
    );
    assert.throws(
      () => ctx.sessions.getTraceSnapshot(sidechat.id),
      (error: unknown) => error instanceof ProxyProtocolError && error.code === 'SESSION_NOT_FOUND',
    );
    const created = ctx.broadcaster.messages.filter((message) => message.type === 'sidechat:created');
    assert.equal(created.length, 1);
    assert.doesNotMatch(JSON.stringify(created), /opaque-/);
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test('Core restart resumes open Side Chats from transient records', async () => {
  const first = setup();
  const parent = await first.sessions.createSession({ workspace_id: first.wsId, executor: 'claude' });
  await first.sessions.createSidechat(parent.id, 'sc_restart');
  first.db.close();

  const db = openDatabase(first.dir);
  const proxyMgr = new StubProxyManager();
  const broadcaster = new CapturingBroadcaster();
  const sessions = new SessionManager(
    db,
    proxyMgr as unknown as ProxyManager,
    broadcaster as unknown as WsBroadcaster,
    new ApprovalManager(broadcaster as unknown as WsBroadcaster),
    new QueueManager(db),
    first.dir,
  );
  try {
    await sessions.createSidechat(parent.id, 'sc_other');
    const recovered = sessions.listSidechats().find((item) => item.id === 'sc_restart');
    assert.ok(recovered);
    assert.equal(recovered.status, 'open');
    const generation = (db.prepare(
      'SELECT stream_generation FROM sidechat_transients WHERE sidechat_id = ?',
    ).get('sc_restart') as { stream_generation: number }).stream_generation;
    assert.ok(generation >= 2);
  } finally {
    db.close();
    rmSync(first.dir, { recursive: true, force: true });
  }
});

test('session delete requires recorded Side Chat confirmation and close does not leak resumeRef', async () => {
  const ctx = setup();
  try {
    const parent = await ctx.sessions.createSession({ workspace_id: ctx.wsId, executor: 'claude' });
    await ctx.sessions.createSidechat(parent.id, 'sc_del');
    await assert.rejects(
      ctx.sessions.deleteSession(parent.id),
      (error: unknown) => (
        error instanceof Error && error.name === 'SidechatConfirmationRequiredError'
      ),
    );
    await ctx.sessions.deleteSession(parent.id, ['sc_del']);
    assert.equal(ctx.sessions.listSidechats().length, 0);
    assert.equal(ctx.proxyMgr.client.closeCalls[0]?.sidechatId, 'sc_del');
    const closed = ctx.broadcaster.messages.filter((message) => message.type === 'sidechat:closed');
    assert.equal(closed.length, 1);
    assert.doesNotMatch(JSON.stringify(ctx.broadcaster.messages), /opaque-/);
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test('Fork persists origin, workspace, and ordinary history without a worktree snapshot claim', async () => {
  const ctx = setup();
  try {
    const parent = await ctx.sessions.createSession({ workspace_id: ctx.wsId, executor: 'claude' });
    ctx.db.prepare(
      `INSERT INTO turns (id, session_id, turn_number, status, created_at, completed_at)
       VALUES ('t1', ?, 1, 'completed', '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z')`,
    ).run(parent.id);
    ctx.db.prepare(
      `INSERT INTO proxy_replay_turns (session_id, provider_turn_id, turn_id)
       VALUES (?, 'src-1', 't1')`,
    ).run(parent.id);
    ctx.proxyMgr.client.forkSession = async (params) => {
      ctx.proxyMgr.client.forkCalls += 1;
      return stubForkResult(parent.id, params.sessionId, ctx.proxyMgr.client);
    };

    const result = await ctx.sessions.forkSession({
      sourceSessionId: parent.id,
      sessionId: 'fork-1',
      anchor: { type: 'head' },
    });
    assert.equal(result.sessionId, 'fork-1');
    assert.deepEqual(result.origin, {
      kind: 'fork',
      session_id: parent.id,
      turn_id: 't1',
      source_turn_id: 'src-1',
    });
    const forked = ctx.sessions.getSession('fork-1');
    assert.equal(forked.workspace_id, parent.workspace_id);
    assert.equal(forked.native_session_id, 'native-fork-1');
    assert.equal(
      (ctx.db.prepare('SELECT native_session_id FROM sessions WHERE id = ?').get('fork-1') as {
        native_session_id: string;
      }).native_session_id,
      'native-fork-1',
    );
    assert.deepEqual(forked.origin, result.origin);
    assert.ok(ctx.sessions.listEvents('fork-1').length > 0);
    assert.equal(
      ctx.broadcaster.messages.some((message) => (
        message.type === 'session:created' && message.origin === 'session-fork'
      )),
      true,
    );

    const again = await ctx.sessions.forkSession({
      sourceSessionId: parent.id,
      sessionId: 'fork-1',
      anchor: { type: 'head' },
    });
    assert.deepEqual(again, result);
    assert.equal(
      (ctx.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE id = ?').get('fork-1') as { n: number }).n,
      1,
    );
    await assert.rejects(
      ctx.sessions.forkSession({
        sourceSessionId: parent.id,
        sessionId: parent.id,
        anchor: { type: 'head' },
      }),
      (error: unknown) => error instanceof ProxyProtocolError && error.code === 'CONFLICT',
    );
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test('Side Chat user inputs survive Core restart', async () => {
  const first = setup();
  const parent = await first.sessions.createSession({ workspace_id: first.wsId, executor: 'claude' });
  await first.sessions.createSidechat(parent.id, 'sc_inputs');
  await first.sessions.sendMessage('sc_inputs', 'first');
  await first.sessions.sendMessage('sc_inputs', 'second');
  const before = first.sessions.listSidechats().find((item) => item.id === 'sc_inputs');
  assert.equal(before?.user_inputs.length, 2);
  assert.deepEqual(before?.user_inputs.map((entry) => entry.turn_id).length, 2);
  first.db.close();

  const db = openDatabase(first.dir);
  const proxyMgr = new StubProxyManager();
  const broadcaster = new CapturingBroadcaster();
  const sessions = new SessionManager(
    db,
    proxyMgr as unknown as ProxyManager,
    broadcaster as unknown as WsBroadcaster,
    new ApprovalManager(broadcaster as unknown as WsBroadcaster),
    new QueueManager(db),
    first.dir,
  );
  try {
    await sessions.createSidechat(parent.id, 'sc_other_inputs');
    const recovered = sessions.listSidechats().find((item) => item.id === 'sc_inputs');
    assert.ok(recovered);
    assert.equal(recovered.user_inputs.length, 2);
    assert.deepEqual(recovered.user_inputs[0]?.input, [{ type: 'text', text: 'first' }]);
    assert.deepEqual(recovered.user_inputs[1]?.input, [{ type: 'text', text: 'second' }]);
  } finally {
    db.close();
    rmSync(first.dir, { recursive: true, force: true });
  }
});

test('parent Proxy generation change re-runs Side Chat recovery', async () => {
  const ctx = setup();
  try {
    const parent = await ctx.sessions.createSession({ workspace_id: ctx.wsId, executor: 'claude' });
    await ctx.sessions.createSidechat(parent.id, 'sc_gen');
    const firstGeneration = (ctx.db.prepare(
      'SELECT stream_generation FROM sidechat_transients WHERE sidechat_id = ?',
    ).get('sc_gen') as { stream_generation: number }).stream_generation;
    await ctx.sessions.createSidechat(parent.id, 'sc_gen_other');
    const skipped = (ctx.db.prepare(
      'SELECT stream_generation FROM sidechat_transients WHERE sidechat_id = ?',
    ).get('sc_gen') as { stream_generation: number }).stream_generation;
    assert.equal(skipped, firstGeneration);
    ctx.proxyMgr.client.pgid = 200;
    ctx.proxyMgr.client.children.clear();
    await ctx.sessions.createSidechat(parent.id, 'sc_gen_after');
    const recovered = (ctx.db.prepare(
      'SELECT stream_generation FROM sidechat_transients WHERE sidechat_id = ?',
    ).get('sc_gen') as { stream_generation: number }).stream_generation;
    assert.ok(recovered > firstGeneration);
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test('same-process parent stream rotate re-runs Side Chat recovery', async () => {
  const ctx = setup();
  try {
    const parent = await ctx.sessions.createSession({ workspace_id: ctx.wsId, executor: 'claude' });
    await ctx.sessions.createSidechat(parent.id, 'sc_stream');
    const firstGeneration = (ctx.db.prepare(
      'SELECT stream_generation FROM sidechat_transients WHERE sidechat_id = ?',
    ).get('sc_stream') as { stream_generation: number }).stream_generation;
    ctx.proxyMgr.client.stream = 'stream-parent-rotated';
    ctx.proxyMgr.client.children.clear();
    await ctx.sessions.createSidechat(parent.id, 'sc_stream_after');
    const recovered = (ctx.db.prepare(
      'SELECT stream_generation FROM sidechat_transients WHERE sidechat_id = ?',
    ).get('sc_stream') as { stream_generation: number }).stream_generation;
    assert.ok(recovered > firstGeneration);
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test('failed Fork publish does not leave a retryable incomplete Session', async () => {
  const ctx = setup();
  try {
    const parent = await ctx.sessions.createSession({ workspace_id: ctx.wsId, executor: 'claude' });
    ctx.db.prepare(
      `INSERT INTO turns (id, session_id, turn_number, status, created_at, completed_at)
       VALUES ('t1', ?, 1, 'completed', '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z')`,
    ).run(parent.id);
    ctx.db.prepare(
      `INSERT INTO proxy_replay_turns (session_id, provider_turn_id, turn_id)
       VALUES (?, 'src-1', 't1')`,
    ).run(parent.id);
    ctx.proxyMgr.client.forkSession = async (params) => {
      ctx.proxyMgr.client.forkCalls += 1;
      return stubForkResult(parent.id, params.sessionId, ctx.proxyMgr.client);
    };
    const originalAdopt = ctx.proxyMgr.adoptExisting.bind(ctx.proxyMgr);
    ctx.proxyMgr.adoptExisting = () => {
      throw new Error('adopt failed');
    };
    await assert.rejects(
      ctx.sessions.forkSession({
        sourceSessionId: parent.id,
        sessionId: 'fork-incomplete',
        anchor: { type: 'head' },
      }),
      /adopt failed/,
    );
    assert.equal(
      (ctx.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE id = ?').get('fork-incomplete') as {
        n: number;
      }).n,
      0,
    );
    ctx.proxyMgr.adoptExisting = originalAdopt;
    const published = await ctx.sessions.forkSession({
      sourceSessionId: parent.id,
      sessionId: 'fork-incomplete',
      anchor: { type: 'head' },
    });
    assert.equal(published.sessionId, 'fork-incomplete');
    assert.equal(ctx.sessions.getSession('fork-incomplete').native_session_id, 'native-fork-incomplete');
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test('Fork Session row and inherited replay publish in one transaction', async () => {
  const ctx = setup();
  try {
    const parent = await ctx.sessions.createSession({ workspace_id: ctx.wsId, executor: 'claude' });
    seedTerminalTurn(ctx.db, parent.id, 't1', 'src-1', 1);
    ctx.proxyMgr.client.forkSession = async (params) => ({
      ...stubForkResult(parent.id, params.sessionId, ctx.proxyMgr.client),
      replayEvents: [{ method: 'turn.started' }],
    });
    const coordinator = ctx.sessions as unknown as {
      events: { persistKimiReplay(sessionId: string): never };
    };
    coordinator.events.persistKimiReplay = (sessionId: string): never => {
      ctx.db.prepare(
        `INSERT INTO turns (id, session_id, turn_number, status, created_at)
         VALUES ('partial-replay-turn', ?, 1, 'completed', '2026-08-20T00:00:00.000Z')`,
      ).run(sessionId);
      throw new Error('replay persistence failed');
    };
    await assert.rejects(
      ctx.sessions.forkSession({
        sourceSessionId: parent.id,
        sessionId: 'fork-atomic',
        anchor: { type: 'head' },
      }),
      /replay persistence failed/,
    );
    assert.equal(
      (ctx.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE id = ?').get('fork-atomic') as { n: number }).n,
      0,
    );
    assert.equal(
      (ctx.db.prepare('SELECT COUNT(*) AS n FROM turns WHERE id = ?').get('partial-replay-turn') as { n: number }).n,
      0,
    );
    assert.equal(ctx.proxyMgr.adopted.has('fork-atomic'), false);
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

function seedTerminalTurn(
  db: ReturnType<typeof openDatabase>,
  sessionId: string,
  turnId: string,
  sourceTurnId: string,
  turnNumber: number,
): void {
  db.prepare(
    `INSERT INTO turns (id, session_id, turn_number, status, created_at, completed_at)
     VALUES (?, ?, ?, 'completed', '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z')`,
  ).run(turnId, sessionId, turnNumber);
  db.prepare(
    `INSERT INTO proxy_replay_turns (session_id, provider_turn_id, turn_id)
     VALUES (?, ?, ?)`,
  ).run(sessionId, sourceTurnId, turnId);
}

test('repeated head Fork returns the first origin after the parent grows', async () => {
  const ctx = setup();
  try {
    const parent = await ctx.sessions.createSession({ workspace_id: ctx.wsId, executor: 'claude' });
    seedTerminalTurn(ctx.db, parent.id, 't1', 'src-1', 1);
    ctx.proxyMgr.client.forkSession = async (params) => {
      ctx.proxyMgr.client.forkCalls += 1;
      return stubForkResult(parent.id, params.sessionId, ctx.proxyMgr.client);
    };
    const first = await ctx.sessions.forkSession({
      sourceSessionId: parent.id,
      sessionId: 'fork-head',
      anchor: { type: 'head' },
    });
    seedTerminalTurn(ctx.db, parent.id, 't2', 'src-2', 2);
    const again = await ctx.sessions.forkSession({
      sourceSessionId: parent.id,
      sessionId: 'fork-head',
      anchor: { type: 'head' },
    });
    assert.deepEqual(again, first);
    assert.deepEqual(again.origin, {
      kind: 'fork',
      session_id: parent.id,
      turn_id: 't1',
      source_turn_id: 'src-1',
    });
    assert.equal(ctx.proxyMgr.client.forkCalls, 1);
    await assert.rejects(
      ctx.sessions.forkSession({
        sourceSessionId: parent.id,
        sessionId: 'fork-head',
        anchor: { type: 'turn', turnId: 't1', sourceTurnId: 'src-1' },
      }),
      (error: unknown) => error instanceof ProxyProtocolError && error.code === 'CONFLICT',
    );
    await assert.rejects(
      ctx.sessions.forkSession({
        sourceSessionId: parent.id,
        sessionId: 'fork-head',
        anchor: { type: 'turn', turnId: 't2', sourceTurnId: 'src-2' },
      }),
      (error: unknown) => error instanceof ProxyProtocolError && error.code === 'CONFLICT',
    );
    ctx.proxyMgr.client.stream = 'stream-parent-next-generation';
    await assert.rejects(
      ctx.sessions.forkSession({
        sourceSessionId: parent.id,
        sessionId: 'fork-head',
        anchor: { type: 'head' },
      }),
      (error: unknown) => error instanceof ProxyProtocolError && error.code === 'CONFLICT',
    );
    const identity = ctx.db.prepare(
      `SELECT origin_source_stream_id AS sourceStreamId, origin_anchor_type AS anchorType
         FROM sessions WHERE id = 'fork-head'`,
    ).get() as { sourceStreamId: string; anchorType: string };
    assert.deepEqual(identity, { sourceStreamId: 'stream-parent', anchorType: 'head' });
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test('restart idempotent Fork does not adopt an unattached child facade', async () => {
  const ctx = setup();
  try {
    const parent = await ctx.sessions.createSession({ workspace_id: ctx.wsId, executor: 'claude' });
    seedTerminalTurn(ctx.db, parent.id, 't1', 'src-1', 1);
    ctx.proxyMgr.client.forkSession = async (params) => {
      ctx.proxyMgr.client.forkCalls += 1;
      return stubForkResult(parent.id, params.sessionId, ctx.proxyMgr.client);
    };
    const first = await ctx.sessions.forkSession({
      sourceSessionId: parent.id,
      sessionId: 'fork-reattach',
      anchor: { type: 'head' },
    });
    ctx.proxyMgr.adopted.clear();
    ctx.proxyMgr.client.children.clear();
    const again = await ctx.sessions.forkSession({
      sourceSessionId: parent.id,
      sessionId: 'fork-reattach',
      anchor: { type: 'head' },
    });
    assert.deepEqual(again, first);
    assert.equal(ctx.proxyMgr.adopted.has('fork-reattach'), false);
    const child = ctx.proxyMgr.client.children.get('fork-reattach');
    assert.equal(child, undefined);
    assert.equal(ctx.proxyMgr.client.forkCalls, 1);
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test('Fork Result without nativeSession is not persisted', async () => {
  const ctx = setup();
  try {
    const parent = await ctx.sessions.createSession({ workspace_id: ctx.wsId, executor: 'claude' });
    seedTerminalTurn(ctx.db, parent.id, 't1', 'src-1', 1);
    ctx.proxyMgr.client.forkSession = async (params) => (
      stubForkResult(parent.id, params.sessionId, ctx.proxyMgr.client, { nativeSession: null })
    );
    await assert.rejects(
      ctx.sessions.forkSession({
        sourceSessionId: parent.id,
        sessionId: 'fork-no-native',
        anchor: { type: 'head' },
      }),
      (error: unknown) => error instanceof ProxyProtocolError && error.code === 'INTERNAL',
    );
    assert.equal(
      (ctx.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE id = ?').get('fork-no-native') as {
        n: number;
      }).n,
      0,
    );
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test('Fork INSERT failure reports leftover Provider cleanup', async () => {
  const ctx = setup();
  try {
    const parent = await ctx.sessions.createSession({ workspace_id: ctx.wsId, executor: 'claude' });
    seedTerminalTurn(ctx.db, parent.id, 't1', 'src-1', 1);
    ctx.db.prepare(
      `INSERT INTO sessions (id, workspace_id, executor, native_session_id, created_at, updated_at)
       VALUES ('other-session', ?, 'claude', 'native-fork-conflict', '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z')`,
    ).run(ctx.wsId);
    ctx.proxyMgr.client.forkSession = async (params) => {
      const result = stubForkResult(parent.id, params.sessionId, ctx.proxyMgr.client);
      const child = ctx.proxyMgr.client.children.get(params.sessionId);
      if (child) {
        child.closeSession = async () => {
          throw new Error('close blocked');
        };
      }
      return result;
    };
    ctx.proxyMgr.client.deleteNativeSession = async () => {
      throw new Error('native still live');
    };
    await assert.rejects(
      ctx.sessions.forkSession({
        sourceSessionId: parent.id,
        sessionId: 'fork-conflict',
        anchor: { type: 'head' },
      }),
      (error: unknown) => (
        error instanceof ProxyProtocolError
        && error.code === 'RUNTIME_ERROR'
        && /session.close failed/.test(error.message)
        && /session.native.delete failed/.test(error.message)
      ),
    );
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test('ordinary Session with turn-bound options can Fork a Session-bound snapshot', async () => {
  const ctx = setup();
  try {
    const parent = await ctx.sessions.createSession({ workspace_id: ctx.wsId, executor: 'claude' });
    seedTerminalTurn(ctx.db, parent.id, 't1', 'src-1', 1);
    ctx.proxyMgr.client.forkSession = async (params) => (
      stubForkResult(parent.id, params.sessionId, ctx.proxyMgr.client)
    );
    const result = await ctx.sessions.forkSession({
      sourceSessionId: parent.id,
      sessionId: 'fork-bound',
      anchor: { type: 'head' },
    });
    assert.equal(result.sessionId, 'fork-bound');
    assert.deepEqual(ctx.sessions.getSession('fork-bound').executor_config.values, {
      execution_mode: 'agent',
    });
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test('Fork rejects a persisted Session option whose Catalog binding changed', async () => {
  const ctx = setup();
  try {
    const parent = await ctx.sessions.createSession({ workspace_id: ctx.wsId, executor: 'claude' });
    seedTerminalTurn(ctx.db, parent.id, 't1', 'src-1', 1);
    const originalCatalog = ctx.proxyMgr.client.catalog.bind(ctx.proxyMgr.client);
    ctx.proxyMgr.client.catalog = async () => {
      const catalog = await originalCatalog();
      return {
        ...catalog,
        configOptions: catalog.configOptions.map((option) => (
          option.id === 'execution_mode' ? { ...option, binding: 'turn' as const } : option
        )),
      };
    };
    await assert.rejects(
      ctx.sessions.forkSession({
        sourceSessionId: parent.id,
        sessionId: 'fork-binding-changed',
        anchor: { type: 'head' },
      }),
      (error: unknown) => (
        error instanceof ProxyProtocolError && error.code === 'CONFIG_BINDING_INVALID'
      ),
    );
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});
