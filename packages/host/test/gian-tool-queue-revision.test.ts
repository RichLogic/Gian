import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'os';
import { join } from 'node:path';
import type {
  ProxyNotification,
  ServerToClientMessage,
  UserAgent,
  UserAgentStatus,
} from '@gian/shared';
import { ApprovalManager } from '../src/approval/index.js';
import type { AgentManager } from '../src/agents/manager.js';
import type { ProxyManager } from '../src/proxy/manager.js';
import type {
  CreateSessionParams,
  NotificationHandler,
  ProxyClient,
  StartTurnParams,
} from '../src/proxy/types.js';
import { QueueManager } from '../src/queue/index.js';
import { SessionManager, type SessionAgentResolver } from '../src/session/manager.js';
import { openDatabase } from '../src/storage/db.js';
import { TaskManager } from '../src/task/manager.js';
import { GianToolService } from '../src/tool/service.js';
import type { WsBroadcaster } from '../src/web/ws-broadcast.js';

const CLAUDE: UserAgent = {
  id: 'agent-claude-review',
  name: 'Claude Review',
  proxy: 'claude',
  cliPath: null,
  defaults: { model: 'sonnet', thinking: 'high', mode: 'ask' },
};

const CODEX: UserAgent = {
  id: 'agent-codex-review',
  name: 'Codex Review',
  proxy: 'codex',
  cliPath: null,
  defaults: { model: 'gpt-5', thinking: 'high', mode: 'ask' },
};

class FakeProxyClient implements ProxyClient {
  readonly executor: 'claude' | 'codex';
  notificationHandlers: NotificationHandler[] = [];
  startTurnCalls: StartTurnParams[] = [];
  steerCalls: Array<{ sessionId: string; input: unknown[] }> = [];
  failNextSteer: Error | null = null;

  constructor(executor: 'claude' | 'codex' = 'claude') {
    this.executor = executor;
  }

  isExited() { return false; }
  async initialize() {
    return {
      protocol: { name: 'gian.proxy' as const, version: '2.0' as const },
      plugin: { id: this.executor, name: this.executor, version: 'test' },
      process: { scope: this.executor === 'codex' ? 'shared' as const : 'session' as const },
      capabilities: this.executor === 'codex' ? { 'turn.steer': {} } : {},
    };
  }
  async catalog() {
    return {
      catalogRevision: 'tool-test',
      input: [{ type: 'text' as const }],
      configOptions: [
        {
          id: 'model', displayName: 'Model', binding: 'turn' as const, role: 'model',
          control: 'select' as const, required: true, defaultValue: this.executor === 'codex' ? 'gpt-5' : 'sonnet',
          choices: [{ value: this.executor === 'codex' ? 'gpt-5' : 'sonnet', displayName: 'Default' }],
        },
      ],
      slashCommands: [],
    };
  }
  async createSession(params: CreateSessionParams) {
    return {
      session: {
        id: `proxy-${randomUUID()}`,
        cwd: params.cwd,
        state: 'idle' as const,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastError: null,
      },
      nativeSessionId: `native-${randomUUID()}`,
    };
  }
  async startTurn(params: StartTurnParams) {
    this.startTurnCalls.push(params);
    return {
      session: {
        id: params.sessionId,
        cwd: '/tmp/tool-test',
        state: 'running' as const,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastError: null,
      },
      turn: { id: `provider-turn-${this.startTurnCalls.length}` },
    };
  }
  async steerTurn(params: { sessionId: string; input: unknown[] }) {
    this.steerCalls.push(params);
    if (this.failNextSteer) {
      const error = this.failNextSteer;
      this.failNextSteer = null;
      throw error;
    }
    return { ok: true as const, turnId: 'proxy_turn' };
  }
  async interruptTurn() {}
  async respondInteraction() {}
  async closeSession() {}
  async shutdown() {}
  forceKill() {}
  onNotification(handler: NotificationHandler) {
    this.notificationHandlers.push(handler);
    return () => {
      this.notificationHandlers = this.notificationHandlers.filter(candidate => candidate !== handler);
    };
  }
  onExit() { return () => {}; }
  fire(notification: ProxyNotification): void {
    for (const handler of this.notificationHandlers) handler(notification);
  }
}

class FakeProxyManager {
  constructor(readonly client: FakeProxyClient) {}
  async getOrCreate(): Promise<ProxyClient> { return this.client; }
  get(): ProxyClient { return this.client; }
  async dispose() {}
  async forceDispose() {}
  async closeAll() {}
}

class CapturingBroadcaster {
  messages: ServerToClientMessage[] = [];
  add() {}
  remove() {}
  send() {}
  broadcast(message: ServerToClientMessage): void { this.messages.push(message); }
  get size() { return 0; }
}

function agentStatus(agent: UserAgent): UserAgentStatus {
  return {
    ...agent,
    proxyName: agent.name,
    ready: true,
    cli: { state: 'ready', path: '/test/cli', version: 'test', source: 'path' },
    plugin: {
      state: 'ready',
      path: '/test/proxy',
      version: 'test',
      source: 'development',
      defaults: agent.defaults,
    },
    officialInstallUrl: 'https://example.invalid',
  };
}

function setup(executor: 'claude' | 'codex' = 'claude') {
  const dir = mkdtempSync(join(tmpdir(), 'gian-queue-rev-'));
  const db = openDatabase(dir);
  const workspaceId = randomUUID();
  db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)')
    .run(workspaceId, 'Tool test', '/tmp/tool-test');
  const agent = executor === 'codex' ? CODEX : CLAUDE;
  const proxy = new FakeProxyManager(new FakeProxyClient(executor));
  const broadcaster = new CapturingBroadcaster();
  const approvals = new ApprovalManager(broadcaster as unknown as WsBroadcaster);
  const queue = new QueueManager(db);
  const resolver: SessionAgentResolver = {
    cliPathForKind: () => null,
    cliPathForSession: () => null,
    requireCliPathForSession: () => null,
    agentRuntime: id => {
      if (id !== agent.id) throw new Error(`agent not found: ${id}`);
      return { agent, cliPath: null };
    },
    agentRuntimeProfile: async () => null,
    agentsForKind: kind => kind === agent.proxy ? [agent] : [],
  };
  const sessions = new SessionManager(
    db,
    proxy as unknown as ProxyManager,
    broadcaster as unknown as WsBroadcaster,
    approvals,
    queue,
    dir,
    null,
    undefined,
    undefined,
    resolver,
  );
  approvals.setRespondFn((sessionId, approvalId, decision) => (
    sessions.respondApproval(sessionId, approvalId, decision)
  ));
  approvals.setGetModeFn(sessionId => sessions.getApprovalModeForActiveTurn(sessionId));
  const agents = {
    listAgents: () => [agent],
    getAgent: (id: string) => {
      if (id !== agent.id) throw new Error(`agent not found: ${id}`);
      return agent;
    },
    agentStatus: async (id: string) => {
      if (id !== agent.id) throw new Error(`agent not found: ${id}`);
      return agentStatus(agent);
    },
    agentRuntimePath: () => ({ proxy: agent.proxy, cliPath: null }),
  } as unknown as AgentManager;
  const tool = new GianToolService({
    db,
    tasks: new TaskManager(db),
    sessions,
    approvals,
    broadcaster: broadcaster as unknown as WsBroadcaster,
    agents,
  });
  return { dir, db, workspaceId, proxy, broadcaster, sessions, tool, agent, approvals, agents, queue };
}

function teardown(context: ReturnType<typeof setup>): void {
  context.tool.close();
  context.db.close();
  rmSync(context.dir, { recursive: true, force: true });
}

function call(
  context: ReturnType<typeof setup>,
  method: string,
  params: Record<string, unknown>,
  idempotencyKey?: string,
  callerId = 'test-caller',
  requestId = randomUUID(),
) {
  return context.tool.call({
    request_id: requestId,
    caller_id: callerId,
    method,
    params,
    ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
  });
}

async function createSession(context: ReturnType<typeof setup>, key = 'create-session') {
  const result = await call(context, 'session.create', {
    workspace_id: context.workspaceId,
    agent_id: context.agent.id,
  }, key);
  assert.equal(result.ok, true, result.error?.message);
  return (result.data as { session: { id: string } }).session.id;
}

function uuidv7At(ms: number): string {
  const hex = ms.toString(16).padStart(12, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7000-8000-0123456789ab`;
}

test('structured session.send is identical on idle, queue, and steer', async () => {
  const context = setup('codex');
  try {
    const sessionId = await createSession(context);
    const payload = {
      session_id: sessionId,
      text: 'compile me',
      items: [{ type: 'text' as const, text: 'compile me' }],
      composer_document: { version: 1 as const, segments: [{ type: 'text' as const, text: 'compile me' }] },
    };
    const idle = await call(context, 'session.send', payload, 'send-idle');
    assert.equal(idle.ok, true, idle.error?.message);
    assert.equal((idle.data as { state: string }).state, 'started');
    const startedInput = context.proxy.client.startTurnCalls[0]?.input;
    assert.ok(Array.isArray(startedInput));

    const queued = await call(context, 'session.send', { ...payload, text: 'queued' }, 'send-queued');
    assert.equal(queued.ok, true);
    assert.equal((queued.data as { state: string }).state, 'queued');
    const snapshot = await call(context, 'session.get', { session_id: sessionId });
    const queue = (snapshot.data as { queue: Array<{ text: string; composer_document?: { version: number } }> }).queue;
    assert.equal(queue.length, 1);
    assert.equal(queue[0]?.composer_document?.version, 1);

    const steered = await call(context, 'session.send', {
      ...payload,
      text: 'steer me',
      busy: 'steer',
    }, 'send-steer');
    assert.equal(steered.ok, true, steered.error?.message);
    assert.equal((steered.data as { state: string }).state, 'steered');
    assert.equal(context.proxy.client.steerCalls.length, 1);
  } finally {
    teardown(context);
  }
});

test('queue methods advance revision and reject stale compare-and-write', async () => {
  const context = setup();
  try {
    const sessionId = await createSession(context);
    await call(context, 'session.send', { session_id: sessionId, text: 'first' }, 'send-1');
    const queued = await call(context, 'session.send', { session_id: sessionId, text: 'second' }, 'send-2');
    assert.equal((queued.data as { state: string }).state, 'queued');
    const before = await call(context, 'session.get', { session_id: sessionId });
    const revision = (before.data as { queue_revision: string }).queue_revision;
    const queueId = (before.data as { queue: Array<{ id: string }> }).queue[0]!.id;

    const stale = await call(context, 'queue.update', {
      session_id: sessionId,
      queue_id: queueId,
      text: 'stale',
      expected_queue_revision: '0',
    }, 'stale-update');
    assert.equal(stale.ok, false);
    assert.equal(stale.error?.code, 'PRECONDITION_FAILED');
    assert.equal((stale.error?.details as { queue_revision: string }).queue_revision, revision);

    const updated = await call(context, 'queue.update', {
      session_id: sessionId,
      queue_id: queueId,
      text: 'edited',
      expected_queue_revision: revision,
    }, 'ok-update');
    assert.equal(updated.ok, true, updated.error?.message);
    const nextRevision = (updated.data as { queue_revision: string }).queue_revision;
    assert.notEqual(nextRevision, revision);
    assert.equal((updated.data as { entry: { text: string } }).entry.text, 'edited');

    const missing = await call(context, 'queue.remove', {
      session_id: sessionId,
      queue_id: randomUUID(),
      expected_queue_revision: nextRevision,
    }, 'missing-remove');
    assert.equal(missing.ok, false);
    assert.equal(missing.error?.code, 'NOT_FOUND');
  } finally {
    teardown(context);
  }
});

test('Local Web remove/clear cancels Tool-created queued deliveries', async () => {
  const context = setup();
  try {
    const sessionId = await createSession(context);
    await call(context, 'session.send', { session_id: sessionId, text: 'active' }, 'send-active');
    const queued = await call(context, 'session.send', { session_id: sessionId, text: 'later' }, 'send-later');
    const deliveryId = (queued.data as { delivery_id: string; queue_id: string }).delivery_id;
    const queueId = (queued.data as { queue_id: string }).queue_id;
    context.sessions.removeFromQueue(sessionId, queueId);
    const snapshot = await call(context, 'session.get', { session_id: sessionId });
    assert.equal((snapshot.data as { queue: unknown[] }).queue.length, 0);
    const delivery = context.db.prepare('SELECT state FROM tool_deliveries WHERE id = ?')
      .get(deliveryId) as { state: string };
    assert.equal(delivery.state, 'cancelled');

    const queued2 = await call(context, 'session.send', { session_id: sessionId, text: 'again' }, 'send-again');
    context.sessions.clearQueue(sessionId);
    const cleared = context.db.prepare('SELECT state FROM tool_deliveries WHERE id = ?')
      .get((queued2.data as { delivery_id: string }).delivery_id) as { state: string };
    assert.equal(cleared.state, 'cancelled');
  } finally {
    teardown(context);
  }
});

test('queue.send_now idle starts head only and bind delivery to the Turn', async () => {
  const context = setup();
  try {
    const sessionId = await createSession(context);
    context.queue.add(sessionId, 'one');
    context.queue.add(sessionId, 'two');
    const sent = await call(context, 'queue.send_now', { session_id: sessionId }, 'send-now');
    assert.equal(sent.ok, true, sent.error?.message);
    assert.equal((sent.data as { mode: string }).mode, 'started');
    assert.equal((sent.data as { affected: unknown[] }).affected.length, 1);
    const after = await call(context, 'session.get', { session_id: sessionId });
    assert.equal((after.data as { queue: unknown[] }).queue.length, 1);
  } finally {
    teardown(context);
  }
});

test('queue.send_now steer restores remaining entries after a partial failure', async () => {
  const context = setup('codex');
  try {
    const sessionId = await createSession(context);
    await call(context, 'session.send', { session_id: sessionId, text: 'active' }, 'send-active');
    await call(context, 'session.send', { session_id: sessionId, text: 'one' }, 'q1');
    await call(context, 'session.send', { session_id: sessionId, text: 'two' }, 'q2');
    context.proxy.client.failNextSteer = new Error('steer rejected');
    const failed = await call(context, 'queue.send_now', { session_id: sessionId }, 'send-now-fail');
    assert.equal(failed.ok, false);
    const snapshot = await call(context, 'session.get', { session_id: sessionId });
    const texts = (snapshot.data as { queue: Array<{ text: string }> }).queue.map(entry => entry.text);
    assert.deepEqual(texts, ['one', 'two']);
  } finally {
    teardown(context);
  }
});

test('remote caller expired UUIDv7 never executes and 90-day rows survive prune', async () => {
  const context = setup();
  try {
    const sessionId = await createSession(context, 'create-remote-window');
    const oldId = uuidv7At(Date.now() - 91 * 24 * 60 * 60 * 1000);
    const expired = await call(
      context,
      'session.send',
      { session_id: sessionId, text: 'too old' },
      'expired-send',
      'remote:device-1',
      oldId,
    );
    assert.equal(expired.ok, false);
    assert.equal(expired.error?.code, 'COMMAND_EXPIRED');
    assert.equal(context.proxy.client.startTurnCalls.length, 0);

    const freshId = uuidv7At(Date.now());
    const fresh = await call(
      context,
      'session.send',
      { session_id: sessionId, text: 'fresh remote' },
      'fresh-send',
      'remote:device-1',
      freshId,
    );
    assert.equal(fresh.ok, true, fresh.error?.message);
    context.db.prepare(
      `UPDATE tool_requests SET status = 'succeeded', updated_at = ? WHERE id = ?`,
    ).run(new Date().toISOString(), freshId);
    for (let index = 0; index < 3; index += 1) {
      await call(context, 'session.stop', { session_id: sessionId }, `stop-${index}`);
    }
    const kept = context.db.prepare('SELECT id FROM tool_requests WHERE id = ?').get(freshId);
    assert.ok(kept);
  } finally {
    teardown(context);
  }
});

test('two Remote callers racing the same Queue revision produce one winner', async () => {
  const context = setup();
  try {
    const sessionId = await createSession(context);
    await call(context, 'session.send', { session_id: sessionId, text: 'busy' }, 'busy');
    await call(context, 'session.send', { session_id: sessionId, text: 'queued' }, 'queued');
    const snapshot = await call(context, 'session.get', { session_id: sessionId });
    const revision = (snapshot.data as { queue_revision: string }).queue_revision;
    const queueId = (snapshot.data as { queue: Array<{ id: string }> }).queue[0]!.id;
    const first = await call(
      context,
      'queue.update',
      { session_id: sessionId, queue_id: queueId, text: 'device-a', expected_queue_revision: revision },
      'remote-a',
      'remote:device-a',
    );
    const second = await call(
      context,
      'queue.update',
      { session_id: sessionId, queue_id: queueId, text: 'device-b', expected_queue_revision: revision },
      'remote-b',
      'remote:device-b',
    );
    assert.equal(first.ok, true, first.error?.message);
    assert.equal(second.ok, false);
    assert.equal(second.error?.code, 'PRECONDITION_FAILED');
    const after = await call(context, 'session.get', { session_id: sessionId });
    assert.equal((after.data as { queue: Array<{ text: string }> }).queue[0]?.text, 'device-a');
  } finally {
    teardown(context);
  }
});

test('boot reconciliation marks orphan queued deliveries unknown', async () => {
  const context = setup();
  try {
    const sessionId = await createSession(context);
    await call(context, 'session.send', { session_id: sessionId, text: 'busy' }, 'busy');
    const queued = await call(context, 'session.send', { session_id: sessionId, text: 'orphan' }, 'orphan');
    const deliveryId = (queued.data as { delivery_id: string }).delivery_id;
    const queueId = (queued.data as { queue_id: string }).queue_id;
    context.db.prepare('DELETE FROM queue_entries WHERE id = ?').run(queueId);
    context.db.prepare(`UPDATE tool_deliveries SET state = 'queued' WHERE id = ?`).run(deliveryId);
    const next = new GianToolService({
      db: context.db,
      tasks: new TaskManager(context.db),
      sessions: context.sessions,
      approvals: context.approvals,
      broadcaster: context.broadcaster as unknown as WsBroadcaster,
      agents: context.agents,
    });
    next.close();
    const row = context.db.prepare('SELECT state FROM tool_deliveries WHERE id = ?')
      .get(deliveryId) as { state: string };
    assert.equal(row.state, 'unknown');
  } finally {
    teardown(context);
  }
});
