// Session ↔ Agent binding (agents.json schema v2, migration 055):
// session:create resolves kind/defaults/CLI path from the Agent and persists
// agent_id + name/color snapshots; fork copies them; a deleted Agent leaves
// the session readable but unable to run turns.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  Executor,
  ProxyNotification,
  ServerToClientMessage,
  UserAgent,
} from '@gian/shared';
import type { WSContext } from 'hono/ws';
import { openDatabase } from '../src/storage/db.js';
import { SessionManager, type SessionAgentResolver } from '../src/session/manager.js';
import type { ProxyManager } from '../src/proxy/manager.js';
import type { NotificationHandler } from '../src/proxy/types.js';
import type { WsBroadcaster } from '../src/web/ws-broadcast.js';
import { ApprovalManager } from '../src/approval/index.js';
import { QueueManager } from '../src/queue/index.js';
import { EMPTY_CATALOG, stubInitialize, stubSession } from './helpers/protocol-v2-stub.js';

delete process.env.GIAN_AUTH_REQUIRED;
delete process.env.GIAN_DESKTOP_TOKEN;

const { makeWsHandlers } = await import('../src/web/ws-handler.js');
const { WsBroadcaster: RealWsBroadcaster } = await import('../src/web/ws-broadcast.js');

function makeAgent(overrides: Partial<UserAgent> = {}): UserAgent {
  return {
    id: overrides.id ?? randomUUID(),
    name: overrides.name ?? 'Codex Prime',
    color: overrides.color ?? 'ink',
    proxy: overrides.proxy ?? 'codex',
    cliPath: overrides.cliPath ?? null,
    defaults: overrides.defaults ?? { model: '', thinking: '', mode: '' },
  };
}

class FakeClient {
  readonly protocolV2 = true as const;
  stream: string | null = 'stream-1';
  lastCreateParams: Record<string, unknown> | null = null;
  notificationHandlers: NotificationHandler[] = [];
  ownSessionId: string | null = null;

  constructor(
    readonly executor: Executor,
    readonly cliPath: string | null,
  ) {}

  isExited() { return false; }
  hasAttachedSession() { return this.stream !== null; }
  async initialize() {
    return { ...stubInitialize(this.executor), capabilities: { 'session.fork': true } };
  }
  async catalog() { return EMPTY_CATALOG; }
  streamId() { return this.stream; }
  runtimeHost() {
    return {
      createSessionClient: (sessionId: string) => {
        const child = new FakeClient(this.executor, this.cliPath);
        child.stream = `stream-${sessionId}`;
        child.ownSessionId = sessionId;
        return child;
      },
    };
  }
  async createSession(params: Record<string, unknown>) {
    this.lastCreateParams = params;
    const nativeSessionId = `native-${randomUUID()}`;
    return {
      session: {
        ...stubSession(nativeSessionId, String(params.cwd ?? '/tmp')),
        nativeSession: { id: nativeSessionId },
      },
      nativeSessionId,
    };
  }
  async forkSession(params: { sessionId: string }) {
    return {
      session: {
        id: params.sessionId,
        streamId: `stream-${params.sessionId}`,
        state: 'idle' as const,
        nativeSession: { id: `native-${params.sessionId}` },
        createdAt: '2026-08-24T00:00:00.000Z',
        updatedAt: '2026-08-24T00:00:00.000Z',
      },
      origin: {
        kind: 'fork' as const,
        sessionId: this.ownSessionId ?? 'parent',
        turnId: 't1',
        sourceTurnId: 'src-1',
      },
      replayEvents: [],
    };
  }
  async startTurn() {
    return {
      session: stubSession('native-x', '/tmp', 'running'),
      turn: { id: `turn-${randomUUID()}` },
    };
  }
  async setName() {}
  async shutdown() {}
  forceKill() {}
  onNotification(handler: NotificationHandler) {
    this.notificationHandlers.push(handler);
    return () => {
      this.notificationHandlers = this.notificationHandlers.filter(item => item !== handler);
    };
  }
  onSessionFault() { return () => {}; }
  onExit() { return () => {}; }
}

class FakeProxyManager {
  clients = new Map<string, FakeClient>();
  acquires: Array<{ sessionId: string; executor: Executor; cliPath: string | null }> = [];

  async getOrCreate(sessionId: string, executor: Executor, options?: { cliPath?: string | null }) {
    const cliPath = options?.cliPath ?? null;
    this.acquires.push({ sessionId, executor, cliPath });
    const existing = this.clients.get(sessionId);
    if (existing) return existing;
    const client = new FakeClient(executor, cliPath);
    client.ownSessionId = sessionId;
    this.clients.set(sessionId, client);
    return client;
  }
  get(sessionId: string) {
    return this.clients.get(sessionId);
  }
  adoptExisting(sessionId: string, client: FakeClient): void {
    this.clients.set(sessionId, client);
  }
  forgetAdopted(sessionId: string): void {
    this.clients.delete(sessionId);
  }
  async dispose(sessionId: string) {
    this.clients.delete(sessionId);
  }
  async closeAll() {}
}

class CapturingBroadcaster {
  messages: ServerToClientMessage[] = [];
  send(): void {}
  broadcast(msg: ServerToClientMessage): void {
    this.messages.push(msg);
  }
}

function setup(options?: {
  agents?: UserAgent[];
  cliPaths?: Record<string, string | null>;
  deletedAgentIds?: Set<string>;
  dir?: string;
}) {
  const dir = options?.dir ?? mkdtempSync(join(tmpdir(), 'gian-agent-binding-'));
  const db = openDatabase(dir);
  const wsId = randomUUID();
  db.prepare('INSERT OR IGNORE INTO workspaces (id, name, path) VALUES (?, ?, ?)')
    .run(wsId, 'test', '/tmp/test-ws');

  const agents = options?.agents ?? [];
  const cliPaths = options?.cliPaths ?? {};
  const deleted = options?.deletedAgentIds ?? new Set<string>();
  const kindPath = (executor: Executor): string | null => {
    const first = agents.find(agent => agent.proxy === executor);
    return first ? cliPaths[first.id] ?? first.cliPath : null;
  };
  const resolver: SessionAgentResolver = {
    cliPathForKind: kindPath,
    cliPathForSession: session => {
      if (session.agent_id) {
        if (deleted.has(session.agent_id)) return null;
        return cliPaths[session.agent_id] ?? null;
      }
      return kindPath(session.executor);
    },
    requireCliPathForSession: session => {
      if (session.agent_id) {
        if (deleted.has(session.agent_id)) {
          throw Object.assign(
            new Error(`Agent was deleted: ${session.agent_name ?? session.agent_id}`),
            { code: 'AGENT_DELETED' },
          );
        }
        return cliPaths[session.agent_id] ?? null;
      }
      return kindPath(session.executor);
    },
    agentRuntime: agentId => {
      const agent = agents.find(candidate => candidate.id === agentId);
      if (!agent || deleted.has(agentId)) throw new Error(`agent not found: ${agentId}`);
      return { agent, cliPath: cliPaths[agentId] ?? agent.cliPath };
    },
    agentsForKind: executor => agents.filter(agent => agent.proxy === executor),
  };

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
    null,
    undefined,
    undefined,
    resolver,
  );
  return { dir, db, wsId, proxyMgr, broadcaster, sessions };
}

test('session:create binds the Agent: kind, defaults, CLI path, snapshots', async () => {
  const agent = makeAgent({
    name: 'Codex Prime',
    color: 'azure',
    proxy: 'codex',
    defaults: { model: 'gpt-5-codex', thinking: 'high', mode: '' },
  });
  const { dir, db, wsId, proxyMgr, sessions } = setup({
    agents: [agent],
    cliPaths: { [agent.id]: '/agents/codex-a' },
  });
  try {
    const session = await sessions.createSession({
      workspace_id: wsId,
      agent_id: agent.id,
    });
    assert.equal(session.executor, 'codex');
    assert.equal(session.agent_id, agent.id);
    assert.equal(session.agent_name, 'Codex Prime');
    assert.equal(session.agent_color, 'azure');
    assert.equal(session.model, 'gpt-5-codex');
    assert.equal(session.thinking_effort, 'high');
    // The owning Agent's path reached runtime acquisition.
    assert.deepEqual(proxyMgr.acquires[0], {
      sessionId: session.id,
      executor: 'codex',
      cliPath: '/agents/codex-a',
    });
    const row = db.prepare('SELECT agent_id, agent_name, agent_color FROM sessions WHERE id = ?')
      .get(session.id) as { agent_id: string; agent_name: string; agent_color: string };
    assert.deepEqual(row, {
      agent_id: agent.id,
      agent_name: 'Codex Prime',
      agent_color: 'azure',
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('session:create rejects an executor that contradicts the Agent kind', async () => {
  const agent = makeAgent({ proxy: 'codex' });
  const { dir, sessions, wsId } = setup({ agents: [agent] });
  try {
    await assert.rejects(
      sessions.createSession({ workspace_id: wsId, agent_id: agent.id, executor: 'claude' }),
      /is a codex Agent, not claude/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('session:create rejects an unknown Agent id', async () => {
  const { dir, sessions, wsId } = setup({ agents: [] });
  try {
    await assert.rejects(
      sessions.createSession({ workspace_id: wsId, agent_id: 'deleted-agent' }),
      /agent not found: deleted-agent/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('legacy executor-only create leaves Agent columns NULL', async () => {
  const { dir, sessions, wsId } = setup({ agents: [] });
  try {
    const session = await sessions.createSession({ workspace_id: wsId, executor: 'claude' });
    assert.equal(session.agent_id ?? null, null);
    assert.equal(session.agent_name ?? null, null);
    assert.equal(session.agent_color ?? null, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('fork copies the source session Agent binding', async () => {
  const agent = makeAgent({ proxy: 'claude', name: 'Claude Work', color: 'ember' });
  const { dir, db, wsId, sessions } = setup({ agents: [agent] });
  try {
    const parent = await sessions.createSession({ workspace_id: wsId, agent_id: agent.id });
    db.prepare(
      `INSERT INTO turns (id, session_id, turn_number, status, created_at, completed_at)
       VALUES ('t1', ?, 1, 'completed', '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z')`,
    ).run(parent.id);
    db.prepare(
      `INSERT INTO proxy_replay_turns (session_id, provider_turn_id, turn_id)
       VALUES (?, 'src-1', 't1')`,
    ).run(parent.id);
    const result = await sessions.forkSession({
      sourceSessionId: parent.id,
      anchor: { type: 'head' },
    });
    const child = sessions.getSession(result.sessionId);
    assert.equal(child.agent_id, agent.id);
    assert.equal(child.agent_name, 'Claude Work');
    assert.equal(child.agent_color, 'ember');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a deleted Agent leaves the session readable but blocks new turns', async () => {
  const agent = makeAgent({ proxy: 'claude', name: 'Gone Claude' });
  const deleted = new Set<string>();
  const first = setup({ agents: [agent], deletedAgentIds: deleted });
  const dir = first.dir;
  try {
    const parent = await first.sessions.createSession({
      workspace_id: first.wsId,
      agent_id: agent.id,
    });
    // Simulate a Host restart after the Agent was deleted: a fresh
    // SessionManager over the same DB with no cached bring-up.
    deleted.add(agent.id);
    const second = setup({ agents: [], deletedAgentIds: deleted, dir });
    try {
      const readable = second.sessions.getSession(parent.id);
      assert.equal(readable.agent_name, 'Gone Claude');
      await assert.rejects(
        second.sessions.sendMessage(parent.id, 'hello'),
        (error: unknown) => (
          error instanceof Error
          && (error as { code?: unknown }).code === 'AGENT_DELETED'
        ),
      );
      // A legacy unbound session still resolves through the kind default.
      const legacy = await second.sessions.createSession({
        workspace_id: first.wsId,
        executor: 'claude',
      });
      await second.sessions.sendMessage(legacy.id, 'still works');
    } finally {
      // Same dir as `first` — cleaned up by the outer finally.
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('native adopt binds one Agent explicitly and never silently picks the first', async () => {
  const kindAgents = [
    makeAgent({ proxy: 'kimi', name: 'Kimi A' }),
    makeAgent({ proxy: 'kimi', name: 'Kimi B' }),
  ];
  const { dir, sessions } = setup({ agents: kindAgents });
  try {
    assert.throws(
      () => sessions.resolveAdoptAgent('kimi'),
      (error: unknown) => {
        const value = error as { code?: unknown; agents?: unknown };
        assert.equal(value.code, 'AGENT_REQUIRED');
        assert.deepEqual(value.agents, [
          { id: kindAgents[0]!.id, name: 'Kimi A' },
          { id: kindAgents[1]!.id, name: 'Kimi B' },
        ]);
        return true;
      },
    );
    const binding = sessions.resolveAdoptAgent('kimi', kindAgents[1]!.id);
    assert.deepEqual(binding, {
      agentId: kindAgents[1]!.id,
      agentName: 'Kimi B',
      agentColor: 'ink',
      cliPath: null,
    });
    assert.throws(
      () => sessions.resolveAdoptAgent('claude', kindAgents[0]!.id),
      /is a kimi Agent, not claude/,
    );

    const solo = makeAgent({ proxy: 'codex', name: 'Only Codex' });
    const second = setup({ agents: [solo] });
    try {
      const single = second.sessions.resolveAdoptAgent('codex');
      assert.equal(single.agentId, solo.id);
      assert.deepEqual(second.sessions.resolveAdoptAgent('dsh'), {
        agentId: null,
        agentName: null,
        agentColor: null,
        cliPath: null,
      });
    } finally {
      rmSync(second.dir, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ws session:create without agent_id and executor fails AGENT_REQUIRED', async () => {
  const broadcaster = new RealWsBroadcaster();
  const sent: Array<Record<string, unknown>> = [];
  const ws = {
    send: (value: string) => { sent.push(JSON.parse(value) as Record<string, unknown>); },
    close: () => {},
  } as unknown as WSContext;
  const sessions = {
    createSession: async () => {
      throw new Error('must not be reached');
    },
  };
  const handlers = makeWsHandlers({
    sessions: sessions as never,
    broadcaster,
  });
  await handlers.onOpen(new Event('open'), ws);
  await handlers.onMessage({ data: JSON.stringify({ type: 'auth', token: 'dev' }) }, ws);
  sent.length = 0;
  await handlers.onMessage({
    data: JSON.stringify({
      type: 'session:create',
      workspace_id: 'ws-1',
      request_id: 'req-1',
    }),
  }, ws);
  const error = sent.find(frame => frame['type'] === 'error') as
    | { code?: string; request_type?: string }
    | undefined;
  assert.equal(error?.code, 'AGENT_REQUIRED');
  assert.equal(error?.request_type, 'session:create');
});
