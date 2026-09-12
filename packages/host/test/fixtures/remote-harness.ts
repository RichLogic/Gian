import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProxyNotification, ServerToClientMessage, UserAgent, UserAgentStatus } from '@gian/shared';
import { generateUuidV7, type CommandRequest, type RemoteMethod } from '@gian/remote-protocol';
import { ApprovalManager } from '../../src/approval/index.js';
import type { AgentManager } from '../../src/agents/manager.js';
import type { ProxyManager } from '../../src/proxy/manager.js';
import type { CreateSessionParams, NotificationHandler, ProxyClient, StartTurnParams } from '../../src/proxy/types.js';
import { QueueManager } from '../../src/queue/index.js';
import { SessionManager, type SessionAgentResolver } from '../../src/session/manager.js';
import { openDatabase } from '../../src/storage/db.js';
import { TaskManager } from '../../src/task/manager.js';
import { GianToolAccessController } from '../../src/tool/access.js';
import { GianToolService } from '../../src/tool/service.js';
import type { WsBroadcaster } from '../../src/web/ws-broadcast.js';
import { MemoryRemoteIdentity } from '../../src/remote/identity.js';
import { RemoteRuntime } from '../../src/remote/runtime.js';
import { defaultRemoteDeviceGrants } from '../../src/remote/grants.js';

export const HARNESS_AGENT: UserAgent = {
  id: 'agent-claude-review',
  name: 'Claude Review',
  proxy: 'claude',
  cliPath: null,
  defaults: { model: 'sonnet', thinking: 'high', mode: 'ask' },
};

class FakeProxyClient implements ProxyClient {
  readonly executor = 'claude' as const;
  notificationHandlers: NotificationHandler[] = [];
  startTurnCalls: StartTurnParams[] = [];

  isExited() { return false; }
  async initialize() {
    return {
      protocol: { name: 'gian.proxy' as const, version: '2.0' as const },
      plugin: { id: 'claude', name: 'Claude', version: 'test' },
      process: { scope: 'session' as const },
      capabilities: {},
    };
  }
  async catalog() {
    return {
      catalogRevision: 'remote-test',
      input: [{ type: 'text' as const }],
      configOptions: [],
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
        cwd: '/tmp/remote-test',
        state: 'running' as const,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastError: null,
      },
      turn: { id: `provider-turn-${this.startTurnCalls.length}` },
    };
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
  readonly client = new FakeProxyClient();
  async getOrCreate(): Promise<ProxyClient> { return this.client; }
  get(): ProxyClient { return this.client; }
  async dispose() {}
  async forceDispose() {}
  async closeAll() {}
}

class CapturingBroadcaster {
  messages: ServerToClientMessage[] = [];
  private readonly listeners = new Set<(message: ServerToClientMessage) => void>();
  add() {}
  remove() {}
  send() {}
  onBroadcast(listener: (message: ServerToClientMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  broadcast(message: ServerToClientMessage): void {
    this.messages.push(message);
    for (const listener of this.listeners) listener(message);
  }
  get size() { return 0; }
}

function agentStatus(): UserAgentStatus {
  return {
    ...HARNESS_AGENT,
    proxyName: HARNESS_AGENT.name,
    ready: true,
    cli: { state: 'ready', path: '/test/cli', version: 'test', source: 'path' },
    plugin: {
      state: 'ready',
      path: '/test/proxy',
      version: 'test',
      source: 'development',
      defaults: HARNESS_AGENT.defaults,
    },
    officialInstallUrl: 'https://example.invalid',
  };
}

export function setupRemoteHarness() {
  const dir = mkdtempSync(join(tmpdir(), 'gian-remote-'));
  const previousDataDir = process.env['GIAN_DATA_DIR'];
  process.env['GIAN_DATA_DIR'] = dir;
  const db = openDatabase(dir);
  const workspaceId = randomUUID();
  db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)')
    .run(workspaceId, 'Remote test', dir);
  const tasks = new TaskManager(db);
  const taskId = tasks.createTask({ name: 'Remote active task' }).id;
  const proxy = new FakeProxyManager();
  const broadcaster = new CapturingBroadcaster();
  const approvals = new ApprovalManager(broadcaster as unknown as WsBroadcaster);
  const queue = new QueueManager(db);
  const resolver: SessionAgentResolver = {
    cliPathForKind: () => null,
    cliPathForSession: () => null,
    requireCliPathForSession: () => null,
    agentRuntime: id => {
      if (id !== HARNESS_AGENT.id) throw new Error(`agent not found: ${id}`);
      return { agent: HARNESS_AGENT, cliPath: null };
    },
    agentRuntimeProfile: async () => null,
    agentsForKind: executor => executor === HARNESS_AGENT.proxy ? [HARNESS_AGENT] : [],
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
    listAgents: () => [HARNESS_AGENT],
    getAgent: (id: string) => {
      if (id !== HARNESS_AGENT.id) throw new Error(`agent not found: ${id}`);
      return HARNESS_AGENT;
    },
    agentStatus: async (id: string) => {
      if (id !== HARNESS_AGENT.id) throw new Error(`agent not found: ${id}`);
      return agentStatus();
    },
    agentRuntimePath: () => ({ proxy: HARNESS_AGENT.proxy, cliPath: null }),
  } as unknown as AgentManager;
  const tool = new GianToolService({
    db,
    tasks,
    sessions,
    approvals,
    broadcaster: broadcaster as unknown as WsBroadcaster,
    agents,
  });
  const access = new GianToolAccessController(tool, db);
  const identity = new MemoryRemoteIdentity();
  const clock = { nowMs: Date.now() };
  const runtime = new RemoteRuntime({
    db,
    sessions,
    tasks,
    access,
    tool,
    identity,
    dataDir: dir,
    hostVersion: '0.0.0-test',
    now: () => new Date(clock.nowMs),
    listAgents: () => [HARNESS_AGENT],
    hostEvents: broadcaster,
  });
  return { dir, db, workspaceId, taskId, proxy, sessions, tasks, tool, access, runtime, identity, approvals, previousDataDir, clock };
}

export function teardownRemoteHarness(context: ReturnType<typeof setupRemoteHarness>): void {
  context.runtime.close();
  context.tool.close();
  context.db.close();
  rmSync(context.dir, { recursive: true, force: true });
  if (context.previousDataDir === undefined) delete process.env['GIAN_DATA_DIR'];
  else process.env['GIAN_DATA_DIR'] = context.previousDataDir;
}

export function seedDevice(context: ReturnType<typeof setupRemoteHarness>, name = 'Phone') {
  return context.runtime.devices.create({
    publicKey: JSON.stringify({ kty: 'EC', crv: 'P-256', x: randomUUID().replaceAll('-', ''), y: randomUUID().replaceAll('-', '') }),
    name,
    platform: 'ios',
    grants: defaultRemoteDeviceGrants(),
  });
}

export function command(
  method: RemoteMethod,
  params: unknown,
  commandId = generateUuidV7(),
): CommandRequest {
  return {
    type: 'command.request',
    command_id: commandId,
    created_at: Date.now(),
    attempt_id: randomUUID(),
    method,
    params,
  };
}
