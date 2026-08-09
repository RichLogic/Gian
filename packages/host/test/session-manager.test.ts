import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  ExecutorConfigState,
  AgentProxyDefaults,
  Executor,
  NativeConfigOption,
  NativeConfigValue,
  ProxyNotification,
  ServerToClientMessage,
} from '@gian/shared';
import { openDatabase } from '../src/storage/db.js';
import { SessionManager } from '../src/session/manager.js';
import type { ProxyManager } from '../src/proxy/manager.js';
import type { ProxyClient, NotificationHandler, StartTurnParams } from '../src/proxy/types.js';
import type { WsBroadcaster } from '../src/web/ws-broadcast.js';
import { ApprovalManager } from '../src/approval/index.js';
import { QueueManager } from '../src/queue/index.js';
import { writeAttachment } from '../src/storage/attachments.js';
import { listGitWorktreesAsync } from '../src/workspace/git.js';
import { createGitRepo } from './fixtures/git-repo.js';
import { installEventStorageV3 } from '../src/storage/event-storage-v3-schema.js';

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

class StubProxyClient implements ProxyClient {
  readonly executor: Executor;
  notificationHandlers: NotificationHandler[] = [];
  startTurnCalls: StartTurnParams[] = [];
  exitHandlers: Array<(code: number | null) => void> = [];
  handlerCountsAtCreate: Array<{ notifications: number; exits: number }> = [];
  notificationDuringCreate: ProxyNotification | null = null;
  notificationDuringInterrupt: ProxyNotification | null = null;
  interruptError: Error | null = null;
  startTurnIds: string[] = [];
  createSessionGate: Promise<void> | null = null;
  onCreateSessionStarted: (() => void) | null = null;

  constructor(executor: Executor = 'claude') {
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
  /** When set, next createSession call rejects (used to test rollback). */
  failNextCreate: Error | null = null;

  /** Captures the last createSession params so tests can assert on adoption. */
  lastCreateParams: {
    cwd: string;
    claudeSessionId?: string;
    threadId?: string;
  } | null = null;

  async createSession(params: {
    cwd: string;
    claudeSessionId?: string;
    threadId?: string;
  }) {
    this.onCreateSessionStarted?.();
    if (this.createSessionGate) await this.createSessionGate;
    this.handlerCountsAtCreate.push({
      notifications: this.notificationHandlers.length,
      exits: this.exitHandlers.length,
    });
    this.lastCreateParams = params;
    if (this.failNextCreate) {
      const err = this.failNextCreate;
      this.failNextCreate = null;
      throw err;
    }
    // Mirror cc-proxy: re-use the supplied claudeSessionId on adoption,
    // otherwise mint a fresh native id. The proxy's own `id` mirrors the
    // native id so a single value flows through both sides.
    const nativeSessionId = params.threadId ?? params.claudeSessionId ?? `cc_${randomUUID()}`;
    if (this.notificationDuringCreate) {
      const notification = this.notificationDuringCreate;
      this.notificationDuringCreate = null;
      this.fire(notification);
    }
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
  async interruptTurn() {
    if (this.notificationDuringInterrupt) {
      const notification = this.notificationDuringInterrupt;
      this.notificationDuringInterrupt = null;
      this.fire(notification);
    }
    if (this.interruptError) {
      const error = this.interruptError;
      this.interruptError = null;
      throw error;
    }
  }
  async respondApproval() { /* no-op */ }
  async startTurn(params: StartTurnParams) {
    this.startTurnCalls.push(params);
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
      turn: { id: this.startTurnIds.shift() ?? 'proxy_turn' },
    };
  }
  async closeSession() { /* no-op */ }
  async shutdown() { /* no-op */ }
  forceKillCalls = 0;
  forceKill() { this.forceKillCalls += 1; }

  onNotification(handler: NotificationHandler) {
    this.notificationHandlers.push(handler);
    return () => {
      this.notificationHandlers = this.notificationHandlers.filter(h => h !== handler);
    };
  }
  onExit(handler: (code: number | null) => void) {
    this.exitHandlers.push(handler);
    return () => {
      this.exitHandlers = this.exitHandlers.filter(h => h !== handler);
    };
  }

  fire(notification: ProxyNotification): void {
    for (const h of this.notificationHandlers) h(notification);
  }
}

class FakeProxyManager {
  client = new StubProxyClient();
  private active: StubProxyClient | null = this.client;
  private initialized = false;
  forceDisposeCalls: string[] = [];
  async getOrCreate(_sessionId?: string, executor: Executor = 'claude'): Promise<ProxyClient> {
    if (!this.initialized) {
      this.initialized = true;
      if (this.client.executor !== executor) {
        this.client = new StubProxyClient(executor);
        this.active = this.client;
      }
    } else if (!this.active) {
      this.client = new StubProxyClient(executor);
      this.active = this.client;
    }
    return this.active;
  }
  get(): ProxyClient | undefined {
    return this.active ?? undefined;
  }
  forceDispose(sessionId: string): void {
    this.forceDisposeCalls.push(sessionId);
    const client = this.active;
    this.active = null;
    client?.forceKill();
  }
  async dispose(): Promise<void> {}
  async closeAll(): Promise<void> { /* no-op */ }
}

class StubKimiProxyClient implements ProxyClient {
  readonly executor = 'kimi' as const;
  notificationHandlers: NotificationHandler[] = [];
  nativeListCalls: Array<{ cwd?: string; cursor?: string }> = [];
  failNativeList = false;
  replayUpdates: unknown[] = [];
  createCalls = 0;
  failNextCreate: Error | null = null;
  readonly options: NativeConfigOption[] = [
    {
      id: 'mode',
      name: 'Mode',
      type: 'select',
      currentValue: 'default',
      scope: 'session',
      choices: [
        { value: 'default', label: 'Default' },
        { value: 'yolo', label: 'YOLO' },
      ],
    },
  ];

  async initialize() {
    return { mode: 'spawn' as const, protocolVersion: 'acp/1', methods: [] };
  }
  async capabilities() {
    return {
      protocolVersion: '1',
      models: [],
      slashCommands: [] as [],
      sessionCapabilities: {
        load: true,
        list: true,
        resume: true,
        close: false,
      },
    };
  }
  async listSlashCommands() {
    return { commands: [] };
  }
  async listNativeSessions(params: { cwd?: string; cursor?: string } = {}) {
    this.nativeListCalls.push(params);
    if (this.failNativeList) throw new Error('Kimi login required');
    if (params.cursor === 'page-2') {
      return {
        sessions: [{
          sessionId: 'kimi-native-2',
          cwd: params.cwd,
          title: 'Older Kimi session',
          updatedAt: '2026-07-28T00:00:00.000Z',
        }],
      };
    }
    return {
      sessions: [{
        sessionId: 'kimi-native-1',
        cwd: params.cwd,
        title: 'Recent Kimi session',
        updatedAt: '2026-07-29T00:00:00.000Z',
      }],
      nextCursor: 'page-2',
    };
  }
  async createSession(params: { cwd: string; nativeSessionId?: string; resumeMode?: string }) {
    this.createCalls += 1;
    if (this.failNextCreate) {
      const error = this.failNextCreate;
      this.failNextCreate = null;
      throw error;
    }
    const nativeSessionId = params.nativeSessionId ?? 'kimi_native_1';
    return {
      session: {
        id: `kimi_proxy_${randomUUID()}`,
        cwd: params.cwd,
        model: null,
        status: 'idle' as const,
        createdAt: '2026-07-29T00:00:00.000Z',
        updatedAt: '2026-07-29T00:00:00.000Z',
        lastError: null,
        nativeSessionId,
        configOptions: this.options,
      },
      nativeSessionId,
      configOptions: this.options,
      replayUpdates: this.replayUpdates,
    };
  }
  async getNativeConfig() {
    return this.snapshot();
  }
  async setNativeConfig(configId: string, value: NativeConfigValue) {
    const option = this.options.find(item => item.id === configId);
    if (!option) throw new Error(`unknown config: ${configId}`);
    option.currentValue = value;
    return this.snapshot();
  }
  async interruptTurn() {}
  async respondApproval() {}
  async startTurn() {
    return {
      session: {
        id: 'kimi_proxy_1',
        cwd: '/tmp',
        model: null,
        status: 'running' as const,
        createdAt: '2026-07-29T00:00:00.000Z',
        updatedAt: '2026-07-29T00:00:00.000Z',
        lastError: null,
      },
      turn: { id: 'kimi_turn_1' },
    };
  }
  async closeSession() {}
  async shutdown() {}
  forceKill() {}
  onNotification(handler: NotificationHandler) {
    this.notificationHandlers.push(handler);
    return () => {
      this.notificationHandlers = this.notificationHandlers.filter(item => item !== handler);
    };
  }
  onExit() {
    return () => {};
  }

  private snapshot(): {
    state: ExecutorConfigState;
    options: NativeConfigOption[];
  } {
    return {
      state: {
        schemaVersion: 1,
        values: Object.fromEntries(
          this.options.map(option => [option.id, option.currentValue]),
        ),
      },
      options: this.options,
    };
  }
}

class FakeKimiProxyManager {
  client = new StubKimiProxyClient();
  disposeCalls: string[] = [];
  private available = true;
  async getOrCreate(): Promise<ProxyClient> {
    this.available = true;
    return this.client;
  }
  get(): ProxyClient | undefined {
    return this.available ? this.client : undefined;
  }
  dropClient(): void {
    this.available = false;
  }
  async dispose(sessionId: string): Promise<void> {
    this.disposeCalls.push(sessionId);
    this.available = false;
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

function setup(
  proxyDefaults?: (executor: Executor) => AgentProxyDefaults,
  eventStorageV3 = false,
) {
  const dir = mkdtempSync(join(tmpdir(), 'gian-sm-test-'));
  const db = openDatabase(dir);
  if (eventStorageV3) installEventStorageV3(db);

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
    null,
    proxyDefaults,
  );
  approvals.setRespondFn((sid, aid, dec) => sessions.respondApproval(sid, aid, dec));
  approvals.setGetModeFn(sid => sessions.getSession(sid).approval_mode);

  return { dir, db, wsId, proxyMgr, broadcaster, sessions };
}

function setupKimi(
  proxyDefaults?: (executor: Executor) => AgentProxyDefaults,
  eventStorageV3 = false,
) {
  const dir = mkdtempSync(join(tmpdir(), 'gian-sm-kimi-test-'));
  const db = openDatabase(dir);
  if (eventStorageV3) installEventStorageV3(db);
  const wsId = randomUUID();
  db.prepare(
    'INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)',
  ).run(wsId, 'test', '/tmp/test-ws');
  const proxyMgr = new FakeKimiProxyManager();
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
    proxyDefaults,
  );
  approvals.setRespondFn((sid, aid, dec) => sessions.respondApproval(sid, aid, dec));
  approvals.setGetModeFn(sid => sessions.getSession(sid).approval_mode);
  return { dir, db, wsId, proxyMgr, broadcaster, sessions };
}

test('new sessions use defaults owned by their Proxy configuration', async () => {
  const { dir, db, wsId, sessions } = setup(() => ({
    model: 'claude-opus-4-1',
    thinking: 'xhigh',
    mode: 'ask',
  }));
  try {
    const session = await sessions.createSession({
      workspace_id: wsId,
      executor: 'claude',
    });
    assert.equal(session.model, 'claude-opus-4-1');
    assert.equal(session.thinking_effort, 'xhigh');
    assert.equal(session.approval_mode, 'ask');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Kimi applies a Proxy-owned default mode through native config', async () => {
  const { dir, db, wsId, sessions } = setupKimi(() => ({
    model: '',
    thinking: '',
    mode: 'yolo',
  }));
  try {
    const session = await sessions.createSession({ workspace_id: wsId, executor: 'kimi' });
    assert.equal(session.approval_mode, null);
    assert.deepEqual(session.executor_config.values, { mode: 'yolo' });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Kimi applies Proxy-owned model and thinking defaults through native config', async () => {
  const { dir, db, wsId, proxyMgr, sessions } = setupKimi(() => ({
    model: 'kimi-k2',
    thinking: 'high',
    mode: 'yolo',
  }));
  try {
    proxyMgr.client.options.push(
      {
        id: 'model',
        name: 'Model',
        type: 'select',
        currentValue: 'kimi-k1',
        scope: 'session',
        choices: [
          { value: 'kimi-k1', label: 'Kimi K1' },
          { value: 'kimi-k2', label: 'Kimi K2' },
        ],
      },
      {
        id: 'thought_level',
        name: 'Thinking',
        type: 'select',
        currentValue: 'medium',
        scope: 'session',
        choices: [
          { value: 'low', label: 'Low' },
          { value: 'medium', label: 'Medium' },
          { value: 'high', label: 'High' },
        ],
      },
    );
    const session = await sessions.createSession({ workspace_id: wsId, executor: 'kimi' });
    assert.equal(session.approval_mode, null);
    assert.equal(session.model, 'kimi-k2');
    assert.deepEqual(session.executor_config.values, {
      mode: 'yolo',
      model: 'kimi-k2',
      thought_level: 'high',
    });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Kimi session persists native config and never invents a Gian approval mode', async () => {
  const { dir, db, wsId, broadcaster, sessions } = setupKimi();
  try {
    const session = await sessions.createSession({
      workspace_id: wsId,
      executor: 'kimi',
      name: 'native-kimi',
    });
    assert.equal(session.approval_mode, null);
    assert.deepEqual(session.executor_config, {
      schemaVersion: 1,
      values: { mode: 'default' },
    });
    assert.equal(session.native_config_options[0]?.id, 'mode');

    const updated = await sessions.setNativeConfig(session.id, 'mode', 'yolo');
    assert.equal(updated.state.values.mode, 'yolo');
    const row = db.prepare(
      'SELECT approval_mode, executor_config_json FROM sessions WHERE id = ?',
    ).get(session.id) as {
      approval_mode: string | null;
      executor_config_json: string;
    };
    assert.equal(row.approval_mode, null);
    assert.equal(JSON.parse(row.executor_config_json).values.mode, 'yolo');
    assert.ok(
      broadcaster.messages.some(message => (
        message.type === 'session:native-config'
        && message.session_id === session.id
        && message.state.values.mode === 'yolo'
      )),
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Kimi session creation rejects legacy Gian approval_mode', async () => {
  const { dir, db, wsId, sessions } = setupKimi();
  try {
    await assert.rejects(
      sessions.createSession({
        workspace_id: wsId,
        executor: 'kimi',
        approval_mode: 'full-access',
      }),
      /approval_mode must be omitted/,
    );
    const count = db.prepare('SELECT COUNT(*) AS count FROM sessions').get() as {
      count: number;
    };
    assert.equal(count.count, 0);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Kimi native session discovery follows ACP cursors', async () => {
  const { dir, db, proxyMgr, sessions } = setupKimi();
  try {
    const native = await sessions.listKimiNativeSessions('/tmp/test-ws');
    assert.deepEqual(native.map(item => item.id), [
      'kimi-native-1',
      'kimi-native-2',
    ]);
    assert.deepEqual(proxyMgr.client.nativeListCalls, [
      { cwd: '/tmp/test-ws' },
      { cwd: '/tmp/test-ws', cursor: 'page-2' },
    ]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('failed Kimi native discovery disposes its unattached facade for retry', async () => {
  const { dir, db, proxyMgr, sessions } = setupKimi();
  proxyMgr.client.failNativeList = true;
  try {
    await assert.rejects(
      sessions.listKimiNativeSessions('/tmp/test-ws'),
      /login required/,
    );
    assert.deepEqual(proxyMgr.disposeCalls, ['__native_sessions_kimi__']);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Kimi adoption coalesces replay chunks and keeps assistant IDs turn-local', async () => {
  const { dir, db, wsId, proxyMgr, broadcaster, sessions } = setupKimi();
  proxyMgr.client.replayUpdates = [
    {
      sessionId: 'kimi-history',
      update: {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'hel' },
      },
    },
    {
      sessionId: 'kimi-history',
      update: {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'lo' },
      },
    },
    {
      sessionId: 'kimi-history',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'first answer' },
      },
    },
    {
      sessionId: 'kimi-history',
      update: {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'second' },
      },
    },
    {
      sessionId: 'kimi-history',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'second answer' },
      },
    },
  ];

  try {
    const adopted = await sessions.adoptKimiNativeSession({
      workspaceId: wsId,
      cwd: '/tmp/test-ws',
      nativeSessionId: 'kimi-history',
    });
    assert.deepEqual(adopted.replay, { turns: 2, events: 8 });
    assert.ok(broadcaster.messages.some(message => (
      message.type === 'session:created'
      && message.session.id === adopted.session.id
      && message.origin === 'native-adopt'
    )));

    const events = sessions.listEvents(adopted.session.id);
    assert.deepEqual(
      events.filter(event => event.event === 'user_message').map(event => event.data.text),
      ['hello', 'second'],
    );
    const assistantIds = events
      .filter(event => event.display?.type === 'message')
      .map(event => event.display?.data.itemId);
    assert.equal(new Set(assistantIds).size, 2);
    assert.deepEqual(
      events.filter(event => event.display?.type === 'state.turn-started').map(event => event.turn),
      [1, 2],
    );
    assert.deepEqual(
      events.filter(event => event.display?.type === 'state.turn-completed').map(event => event.turn),
      [1, 2],
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Kimi adoption replaces replayed tool snapshots instead of amplifying history', async () => {
  const { dir, db, wsId, proxyMgr, sessions } = setupKimi(undefined, true);
  proxyMgr.client.replayUpdates = [
    {
      sessionId: 'kimi-tool-history',
      update: {
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'run it' },
      },
    },
    {
      sessionId: 'kimi-tool-history',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-1',
        kind: 'execute',
        title: 'Run command',
        status: 'pending',
        rawInput: { command: 'printf done' },
      },
    },
    {
      sessionId: 'kimi-tool-history',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-1',
        kind: 'execute',
        title: 'Run command',
        status: 'in_progress',
        rawInput: { command: 'printf done' },
        rawOutput: 'do',
      },
    },
    {
      sessionId: 'kimi-tool-history',
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tool-1',
        kind: 'execute',
        title: 'Run command',
        status: 'completed',
        rawInput: { command: 'printf done' },
        rawOutput: 'done',
      },
    },
  ];

  try {
    const adopted = await sessions.adoptKimiNativeSession({
      workspaceId: wsId,
      cwd: '/tmp/test-ws',
      nativeSessionId: 'kimi-tool-history',
    });
    assert.deepEqual(adopted.replay, { turns: 1, events: 4 });

    const toolEvents = sessions.listEvents(adopted.session.id)
      .filter(event => event.event === 'acp.sessionUpdate');
    assert.equal(toolEvents.length, 1, 'one persisted row per replayed tool identity');
    assert.equal(toolEvents[0]!.display?.type, 'activity.command');
    assert.equal(toolEvents[0]!.display?.data.status, 'success');
    assert.equal(toolEvents[0]!.display?.data.stdout, 'done');
    assert.equal(
      (toolEvents[0]!.data.update as { status?: string }).status,
      'completed',
      'the retained native payload is the final provider snapshot',
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Kimi lazy reattach is single-flight and recycles after auth failure', async () => {
  const first = setupKimi();
  let sessionId: string;
  try {
    const session = await first.sessions.createSession({
      workspace_id: first.wsId,
      executor: 'kimi',
    });
    sessionId = session.id;
  } finally {
    first.db.close();
  }

  const db = openDatabase(first.dir);
  const proxyMgr = new FakeKimiProxyManager();
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
  proxyMgr.client.failNextCreate = new Error(
    "Kimi Code is not logged in. Run '/managed/kimi' login in a terminal, then retry.",
  );

  try {
    const failed = await Promise.allSettled([
      sessions.getNativeConfig(sessionId),
      sessions.listSessionSlashCommands(sessionId),
    ]);
    assert.deepEqual(failed.map(result => result.status), ['rejected', 'rejected']);
    assert.equal(proxyMgr.client.createCalls, 1);
    assert.deepEqual(proxyMgr.disposeCalls, [sessionId]);

    const retried = await sessions.getNativeConfig(sessionId);
    assert.equal(retried.state.values.mode, 'default');
    assert.equal(proxyMgr.client.createCalls, 2);
  } finally {
    db.close();
    rmSync(first.dir, { recursive: true, force: true });
  }
});

test('Kimi send reattaches after an installed Proxy update drops the live facade', async () => {
  const { dir, db, wsId, proxyMgr, sessions } = setupKimi();
  try {
    const session = await sessions.createSession({ workspace_id: wsId, executor: 'kimi' });
    assert.equal(proxyMgr.client.createCalls, 1);

    // ProxyManager.closeByExecutor() intentionally removes live facades when
    // activating an installed Proxy. The coordinator may still hold the old
    // proxy session id until the next request notices that the facade is gone.
    proxyMgr.dropClient();

    await sessions.sendMessage(session.id, 'after proxy update');

    assert.equal(proxyMgr.client.createCalls, 2, 'send reattaches the persisted native session');
    const row = db.prepare('SELECT status FROM sessions WHERE id = ?').get(session.id) as {
      status: string;
    };
    assert.equal(row.status, 'running');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

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

test('setModel with empty string clears stored model override', async () => {
  const { dir, db, wsId, sessions, broadcaster } = setup();
  try {
    const session = await sessions.createSession({
      workspace_id: wsId,
      executor: 'claude',
      name: 'model-clear',
    });
    sessions.setModel(session.id, 'claude-opus-4-8');
    sessions.setModel(session.id, '');

    const row = db.prepare('SELECT model FROM sessions WHERE id = ?').get(session.id) as
      | { model: string | null }
      | undefined;
    assert.ok(row, 'session row persisted');
    assert.equal(row!.model, null);
    const update = broadcaster.messages.findLast?.(
      m => m.type === 'session:updated',
    ) as { session?: { model?: string | null } } | undefined;
    assert.equal(update?.session?.model, null);
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

test('sendMessage with localImage items echoes attachments in user_message payload', async () => {
  const { dir, db, wsId, sessions, broadcaster } = setup();
  try {
    const session = await sessions.createSession({ workspace_id: wsId, executor: 'claude' });
    broadcaster.messages.length = 0;

    await sessions.sendMessage(session.id, 'see this', [
      { type: 'text', text: 'see this' },
      { type: 'localImage', path: '/abs/whatever/abc123.png', name: 'screenshot.png', mime: 'image/png' },
    ]);

    const userRow = db.prepare(
      "SELECT data FROM events WHERE session_id = ? AND type = 'user_message'",
    ).get(session.id) as { data: string };
    const payload = JSON.parse(userRow.data) as {
      text: string;
      attachments?: Array<{ name: string; mime: string; url: string }>;
    };
    assert.equal(payload.text, 'see this');
    assert.ok(payload.attachments, 'attachments persisted');
    assert.equal(payload.attachments!.length, 1);
    assert.equal(payload.attachments![0]!.name, 'screenshot.png');
    assert.equal(payload.attachments![0]!.mime, 'image/png');
    assert.equal(payload.attachments![0]!.url, `/api/sessions/${session.id}/attachments/abc123.png`);

    const broadcastUser = broadcaster.messages.find(
      m => m.type === 'event' && (m as { event: string }).event === 'user_message',
    ) as { data: { attachments?: unknown[] } } | undefined;
    assert.ok(broadcastUser, 'broadcast user_message present');
    assert.equal((broadcastUser!.data.attachments ?? []).length, 1);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sendMessage forwards Codex skill items unchanged to the Proxy turn', async () => {
  const { dir, db, wsId, proxyMgr, sessions } = setup();
  try {
    const session = await sessions.createSession({ workspace_id: wsId, executor: 'codex' });

    await sessions.sendMessage(session.id, '/project-check', [{
      type: 'skill',
      name: 'project-check',
      path: '/tmp/test-ws/.codex/skills/project-check/SKILL.md',
    }]);

    assert.deepEqual(proxyMgr.client.startTurnCalls.at(-1)?.input, [{
      type: 'skill',
      name: 'project-check',
      path: '/tmp/test-ws/.codex/skills/project-check/SKILL.md',
    }]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sendMessage accepts only session-owned localFile snapshots and echoes their metadata', async () => {
  const { dir, db, wsId, sessions } = setup();
  const previousDataDir = process.env.GIAN_DATA_DIR;
  process.env.GIAN_DATA_DIR = dir;
  try {
    const session = await sessions.createSession({ workspace_id: wsId, executor: 'claude' });
    const path = await writeAttachment(
      session.id,
      Buffer.from('hello'),
      'text/plain',
      'notes.txt',
    );

    await sessions.sendMessage(session.id, 'read this', [
      { type: 'text', text: 'read this' },
      { type: 'localFile', path, name: 'notes.txt', mime: 'text/plain', size: 5 },
    ]);

    const userRow = db.prepare(
      "SELECT data FROM events WHERE session_id = ? AND type = 'user_message'",
    ).get(session.id) as { data: string };
    const payload = JSON.parse(userRow.data) as {
      attachments?: Array<{ name: string; mime: string; size?: number; url: string }>;
    };
    assert.deepEqual(payload.attachments, [{
      name: 'notes.txt',
      mime: 'text/plain',
      size: 5,
      url: `/api/sessions/${session.id}/attachments/${path.split('/').pop()}`,
    }]);

    const forged = await sessions.createSession({ workspace_id: wsId, executor: 'claude' });
    await assert.rejects(
      sessions.sendMessage(forged.id, 'read host file', [
        { type: 'localFile', path: '/etc/hosts', name: 'hosts', mime: 'text/plain' },
      ]),
      /invalid local file attachment/,
    );
  } finally {
    if (previousDataDir === undefined) delete process.env.GIAN_DATA_DIR;
    else process.env.GIAN_DATA_DIR = previousDataDir;
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

    const events = db.prepare('SELECT type, call_id, data, created_at FROM events WHERE session_id = ?').all(session.id) as Array<{
      type: string;
      call_id: string;
      data: string;
      created_at: string;
    }>;
    const userMsg = events.find(e => e.type === 'user_message');
    assert.ok(userMsg, 'user_message event persisted');
    assert.equal(JSON.parse(userMsg!.data).text, 'hello world');

    const sessionRow = db.prepare('SELECT status FROM sessions WHERE id = ?').get(session.id) as { status: string };
    assert.equal(sessionRow.status, 'running');

    const userEvents = broadcaster.messages.filter(
      m => m.type === 'event' && (m as { event: string }).event === 'user_message',
    ) as Array<{ call_id: string; ts: number }>;
    assert.equal(userEvents.length, 1);
    assert.equal(
      userEvents[0]!.call_id,
      userMsg!.call_id,
      'persisted and broadcast user_message must share one stable call_id',
    );
    assert.match(userMsg!.created_at, /Z$/, 'new user_message timestamps must carry UTC');
    assert.equal(
      userEvents[0]!.ts,
      Date.parse(userMsg!.created_at),
      'persisted and broadcast user_message must share one timestamp',
    );
    const replayed = sessions.listEvents(session.id).find(event => event.event === 'user_message');
    assert.equal(replayed?.call_id, userEvents[0]!.call_id);
    assert.equal(replayed?.ts, userEvents[0]!.ts);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sendMessage rejects a DB-only external running turn without registering a runtime', async () => {
  const { dir, db, wsId, sessions, proxyMgr } = setup();
  try {
    const session = await sessions.createSession({ workspace_id: wsId, executor: 'claude' });
    db.prepare(
      `INSERT INTO turns(id, session_id, turn_number, status, created_at)
       VALUES('external-running', ?, 1, 'running', '2026-08-09T06:00:00.000Z')`,
    ).run(session.id);
    db.prepare(`UPDATE sessions SET status = 'running' WHERE id = ?`).run(session.id);

    await assert.rejects(
      sessions.sendMessage(session.id, 'must queue'),
      /turn already in flight.*enqueue instead/,
    );
    assert.equal(proxyMgr.client.startTurnCalls.length, 0);
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS n FROM turns WHERE session_id = ?')
        .get(session.id) as { n: number }).n,
      1,
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('two concurrent sends reserve one turn and reject the other before optimistic writes', async () => {
  const { dir, db, wsId, sessions, proxyMgr } = setup();
  try {
    const session = await sessions.createSession({ workspace_id: wsId, executor: 'claude' });
    const results = await Promise.allSettled([
      sessions.sendMessage(session.id, 'first contender'),
      sessions.sendMessage(session.id, 'second contender'),
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    assert.match(String(rejected.reason), /turn already in flight.*enqueue instead/);
    assert.equal(proxyMgr.client.startTurnCalls.length, 1);
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS n FROM turns WHERE session_id = ?')
        .get(session.id) as { n: number }).n,
      1,
    );
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM events WHERE session_id = ? AND type = 'user_message'")
        .get(session.id) as { n: number }).n,
      1,
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sendMessage rechecks DB ownership after delayed proxy adoption', async () => {
  const first = setup();
  const session = await first.sessions.createSession({
    workspace_id: first.wsId,
    executor: 'claude',
  });
  first.db.close();

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
  let releaseCreate!: () => void;
  let markCreateStarted!: () => void;
  proxyMgr.client.createSessionGate = new Promise(resolve => { releaseCreate = resolve; });
  const createStarted = new Promise<void>(resolve => { markCreateStarted = resolve; });
  proxyMgr.client.onCreateSessionStarted = markCreateStarted;

  try {
    const pending = sessions.sendMessage(session.id, 'racing send');
    await createStarted;
    db.prepare(
      `INSERT INTO turns(id, session_id, turn_number, status, created_at)
       VALUES('external-during-ensure', ?, 1, 'running', '2026-08-09T06:10:00.000Z')`,
    ).run(session.id);
    db.prepare(`UPDATE sessions SET status = 'running' WHERE id = ?`).run(session.id);
    releaseCreate();

    await assert.rejects(pending, /turn already in flight.*enqueue instead/);
    assert.equal(proxyMgr.client.startTurnCalls.length, 0);
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS n FROM turns WHERE session_id = ?')
        .get(session.id) as { n: number }).n,
      1,
    );
  } finally {
    releaseCreate();
    db.close();
    rmSync(first.dir, { recursive: true, force: true });
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
    // Provider-native names remain the persisted source of truth.
    assert.ok(types.includes('output.text'));
    assert.ok(types.includes('turn.completed'));

    const sessionRow = db.prepare('SELECT status, unread FROM sessions WHERE id = ?').get(session.id) as { status: string; unread: number };
    assert.equal(sessionRow.status, 'done');
    // A naturally-completed turn marks the session unread (the sidebar dot).
    assert.equal(sessionRow.unread, 1, 'turn.completed marks the session unread');

    const turnRow = db.prepare('SELECT status, completed_at FROM turns WHERE session_id = ?').get(session.id) as { status: string; completed_at: string | null };
    assert.equal(turnRow.status, 'completed');
    assert.ok(turnRow.completed_at);

    const broadcastEvents = broadcaster.messages.filter(m => m.type === 'event') as Array<{ event: string }>;
    assert.ok(broadcastEvents.some(e => e.event === 'output.text'));
    assert.ok(broadcastEvents.some(e => e.event === 'turn.completed'));
    assert.equal(
      sessions.listEvents(session.id)
        .filter(event => event.display?.type === 'state.turn-completed').length,
      1,
      'provider completion is already the canonical boundary',
    );
    assert.equal(
      broadcastEvents.filter(event => event.event === 'gian.turn.completed').length,
      0,
      'Gian must not broadcast a duplicate when the provider supplied completion',
    );
    const doneUpdate = broadcaster.messages.find(
      (m): m is { type: 'session:updated'; session: { status?: string; unread?: number } } =>
        m.type === 'session:updated' && (m as { session: { status?: string } }).session.status === 'done',
    );
    assert.ok(doneUpdate && doneUpdate.session.unread === 1, 'turn.completed broadcasts unread:1');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('turn.failed persists and broadcasts one Gian-owned terminal boundary', async () => {
  const { dir, db, wsId, sessions, proxyMgr, broadcaster } = setup();
  try {
    const session = await sessions.createSession({ workspace_id: wsId, executor: 'claude' });
    await sessions.sendMessage(session.id, 'fail this turn');
    broadcaster.messages.length = 0;

    proxyMgr.client.fire({
      method: 'turn.failed',
      params: {
        sessionId: 'proxy_x',
        data: { message: 'provider failed' },
      },
    });

    const events = sessions.listEvents(session.id);
    assert.equal(events.filter(event => event.display?.type === 'state.error').length, 1);
    const completions = events.filter(event => event.display?.type === 'state.turn-completed');
    assert.equal(completions.length, 1);
    assert.equal(completions[0]?.event, 'gian.turn.completed');
    assert.equal(
      broadcaster.messages.filter(message => (
        message.type === 'event' && message.event === 'gian.turn.completed'
      )).length,
      1,
    );
    assert.equal(sessions.getSession(session.id).status, 'error');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('turn-scoped runtime.error settles an active Codex turn without waiting for proxy exit', async () => {
  const { dir, db, wsId, sessions, proxyMgr } = setup();
  try {
    const session = await sessions.createSession({ workspace_id: wsId, executor: 'codex' });
    proxyMgr.client.startTurnIds.push('codex-runtime-turn');
    await sessions.sendMessage(session.id, 'trigger runtime failure');

    proxyMgr.client.fire({
      method: 'runtime.error',
      params: {
        sessionId: 'proxy_x',
        turnId: 'codex-runtime-turn',
        data: { code: 'RUNTIME_STOPPED', message: 'app-server stopped' },
      },
    });

    const turn = db.prepare(
      'SELECT status, completed_at FROM turns WHERE session_id = ?',
    ).get(session.id) as { status: string; completed_at: string | null };
    assert.equal(turn.status, 'error');
    assert.ok(turn.completed_at);
    assert.equal(sessions.getSession(session.id).status, 'error');
    const events = sessions.listEvents(session.id);
    assert.equal(events.filter(event => event.display?.type === 'state.error').length, 1);
    assert.equal(events.filter(event => event.display?.type === 'state.turn-completed').length, 1);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('host-level runtime.error while idle does not invent a transcript turn', async () => {
  const { dir, db, wsId, sessions, proxyMgr } = setup();
  try {
    const session = await sessions.createSession({ workspace_id: wsId, executor: 'codex' });
    assert.doesNotThrow(() => proxyMgr.client.fire({
      method: 'runtime.error',
      params: {
        data: { code: 'PROTOCOL_ERROR', message: 'host-level diagnostic' },
      },
    }));
    assert.equal(sessions.listEvents(session.id).length, 0);
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS n FROM turns WHERE session_id = ?')
        .get(session.id) as { n: number }).n,
      0,
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('P0 coalesces a burst of Codex diff snapshots into one final event', async () => {
  const { dir, db, wsId, sessions, proxyMgr, broadcaster } = setup(undefined, true);
  try {
    const session = await sessions.createSession({ workspace_id: wsId, executor: 'codex' });
    await sessions.sendMessage(session.id, 'change it');
    broadcaster.messages.length = 0;

    for (let update = 0; update < 300; update++) {
      proxyMgr.client.fire({
        method: 'diff.updated',
        params: {
          sessionId: 'proxy_x',
          turnId: 'proxy_turn',
          data: {
            diff: `diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new-${update}`,
          },
        },
      });
    }
    proxyMgr.client.fire({
      method: 'turn.completed',
      params: { sessionId: 'proxy_x', data: { status: 'completed' } },
    });

    const rows = db.prepare(
      `SELECT COUNT(*) AS n FROM events
       WHERE session_id = ? AND type = 'diff.updated'`,
    ).get(session.id) as { n: number };
    assert.equal(rows.n, 1);
    const diff = sessions.listEvents(session.id)
      .find(event => event.event === 'diff.updated');
    assert.equal(diff?.call_id, 'proxy_turn');
    assert.match(String(diff?.display?.data.diff), /new-299$/);
    assert.equal(
      broadcaster.messages.filter(message => (
        message.type === 'event' && message.event === 'diff.updated'
      )).length,
      1,
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('session usage survives compact invalidation, deduplicates deltas, and resets on rotation', async () => {
  const { dir, db, wsId, sessions, proxyMgr, broadcaster } = setup();
  try {
    const session = await sessions.createSession({ workspace_id: wsId, executor: 'claude' });
    await sessions.sendMessage(session.id, 'measure usage');
    const initialUpdatedAt = sessions.getSession(session.id).updated_at;

    const sample: ProxyNotification = {
      method: 'token_usage.updated',
      params: {
        sessionId: 'proxy_x',
        turnId: 'native-turn-1',
        data: {
          context: { used: 63_000, window: 258_000 },
          conversation: {
            mode: 'delta',
            inputTokens: 70_000,
            outputTokens: 2_000,
            cachedInputTokens: 55_000,
            totalTokens: 72_000,
          },
        },
      },
    };
    proxyMgr.client.fire(sample);
    proxyMgr.client.fire(sample);

    let current = sessions.getSession(session.id);
    assert.equal(current.context_tokens_used, 63_000);
    assert.equal(current.context_window_tokens, 258_000);
    assert.equal(current.conversation_total_tokens, 72_000, 'duplicate turn delta applied once');
    assert.equal(current.conversation_usage_complete, 1, 'fresh Gian session has complete totals');
    assert.equal(current.updated_at, initialUpdatedAt, 'usage must not reorder the session');

    proxyMgr.client.fire({
      method: 'token_usage.updated',
      params: {
        sessionId: 'proxy_x',
        turnId: 'native-compact-1',
        data: { context: null, reason: 'compact_started' },
      },
    });
    current = sessions.getSession(session.id);
    assert.equal(current.context_tokens_used, null);
    assert.equal(current.context_window_tokens, 258_000, 'known window survives compact');
    assert.equal(current.conversation_total_tokens, 72_000, 'compact preserves conversation total');
    assert.ok(current.context_usage_updated_at, 'invalidation is distinguishable from never sampled');

    proxyMgr.client.fire({
      method: 'token_usage.updated',
      params: {
        sessionId: 'proxy_x',
        turnId: 'native-compact-1',
        data: { context: { used: 8_500, window: 258_000 } },
      },
    });
    assert.equal(sessions.getSession(session.id).context_tokens_used, 8_500);

    broadcaster.messages.length = 0;
    proxyMgr.client.fire({
      method: 'session.rotated',
      params: {
        sessionId: 'proxy_x',
        data: {
          oldNativeSessionId: session.native_session_id,
          newNativeSessionId: 'cc_usage_reset',
        },
      },
    });
    current = sessions.getSession(session.id);
    assert.equal(current.context_tokens_used, null);
    assert.equal(current.context_window_tokens, null);
    assert.equal(current.context_usage_updated_at, null);
    assert.equal(current.conversation_total_tokens, null);
    assert.equal(current.conversation_usage_complete, 1);
    assert.ok(
      broadcaster.messages.some(message => (
        message.type === 'session:updated'
        && message.session.id === session.id
        && message.session.conversation_total_tokens === null
      )),
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('user-initiated stop settles status=done WITHOUT marking unread', async () => {
  const { dir, db, wsId, sessions, proxyMgr, broadcaster } = setup();
  try {
    const session = await sessions.createSession({ workspace_id: wsId, executor: 'claude' });
    await sessions.sendMessage(session.id, 'ping'); // opens an active turn
    const client = proxyMgr.client;
    sessions.enqueueMessage(session.id, 'must remain queued');
    await sessions.stopTurn(session.id);            // → completeTurn('stopped')

    const row = db.prepare('SELECT status, unread FROM sessions WHERE id = ?').get(session.id) as { status: string; unread: number };
    assert.equal(row.status, 'done');
    assert.equal(row.unread, 0, 'a turn the user stopped themselves is not unread');
    const completions = sessions.listEvents(session.id)
      .filter(event => event.display?.type === 'state.turn-completed');
    assert.equal(completions.length, 1);
    assert.equal(completions[0]?.event, 'gian.turn.completed');
    assert.ok(broadcaster.messages.some(message => (
      message.type === 'event' && message.event === 'gian.turn.completed'
    )), 'local stop broadcasts the same persisted fold boundary');
    assert.equal(proxyMgr.client.startTurnCalls.length, 1, 'local stop must not auto-send queued work');
    assert.equal(sessions.getQueueLength(session.id), 1);
    assert.equal(client.notificationHandlers.length, 1, 'stop keeps exactly one live notification binding');
    assert.equal(client.exitHandlers.length, 1, 'stop keeps exactly one live exit binding');

    await sessions.sendMessage(session.id, 'after stop');
    broadcaster.messages.length = 0;
    client.fire({
      method: 'output.text',
      params: {
        sessionId: 'proxy_x',
        turnId: 'proxy_turn',
        data: { text: 'continued', itemId: 'message_after_stop' },
      },
    });
    assert.equal(
      broadcaster.messages.filter(message => message.type === 'event' && message.event === 'output.text').length,
      1,
      'one post-stop notification produces one WebSocket event',
    );
    assert.equal(
      (db.prepare(
        "SELECT COUNT(*) AS count FROM events WHERE session_id = ? AND type = 'output.text'",
      ).get(session.id) as { count: number }).count,
      1,
      'one post-stop notification produces one persisted event',
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('provider terminal emitted inside interrupt settles stopped and does not drain queue', async () => {
  const { dir, db, wsId, sessions, proxyMgr } = setup();
  try {
    const session = await sessions.createSession({ workspace_id: wsId, executor: 'claude' });
    proxyMgr.client.startTurnIds.push('stop-race-turn');
    await sessions.sendMessage(session.id, 'ping');
    sessions.enqueueMessage(session.id, 'stay queued');
    proxyMgr.client.notificationDuringInterrupt = {
      method: 'turn.completed',
      params: {
        sessionId: 'proxy_x',
        turnId: 'stop-race-turn',
        data: { status: 'completed' },
      },
    };

    await sessions.stopTurn(session.id);

    const turn = db.prepare(
      'SELECT status FROM turns WHERE session_id = ?',
    ).get(session.id) as { status: string };
    assert.equal(turn.status, 'stopped');
    assert.equal(sessions.getSession(session.id).status, 'done');
    assert.equal(sessions.getSession(session.id).unread, 0);
    assert.equal(proxyMgr.client.startTurnCalls.length, 1);
    assert.equal(sessions.getQueueLength(session.id), 1);
    assert.equal(
      sessions.listEvents(session.id)
        .filter(event => event.display?.type === 'state.turn-completed').length,
      1,
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rejected interrupt clears stop intent and keeps the generation running', async () => {
  const { dir, db, wsId, sessions, proxyMgr } = setup();
  try {
    const session = await sessions.createSession({ workspace_id: wsId, executor: 'claude' });
    proxyMgr.client.startTurnIds.push('interrupt-retry-turn');
    await sessions.sendMessage(session.id, 'keep working');
    proxyMgr.client.interruptError = new Error('interrupt transport failed');

    await assert.rejects(sessions.stopTurn(session.id), /interrupt transport failed/);
    assert.equal(
      (db.prepare('SELECT status FROM turns WHERE session_id = ?').get(session.id) as { status: string }).status,
      'running',
    );
    assert.equal(sessions.getSession(session.id).status, 'running');

    proxyMgr.client.fire({
      method: 'output.text',
      params: {
        sessionId: 'proxy_x',
        turnId: 'interrupt-retry-turn',
        data: { text: 'still alive' },
      },
    });
    assert.ok(sessions.listEvents(session.id).some(event => event.event === 'output.text'));

    proxyMgr.client.fire({
      method: 'turn.completed',
      params: {
        sessionId: 'proxy_x',
        turnId: 'interrupt-retry-turn',
        data: { status: 'completed' },
      },
    });
    assert.equal(
      (db.prepare('SELECT status FROM turns WHERE session_id = ?').get(session.id) as { status: string }).status,
      'completed',
      'cleared intent lets the eventual natural terminal retain its provider status',
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('late output and terminal from a stopped provider generation cannot pollute the next turn', async () => {
  const { dir, db, wsId, sessions, proxyMgr } = setup();
  try {
    const session = await sessions.createSession({ workspace_id: wsId, executor: 'claude' });
    proxyMgr.client.startTurnIds.push('old-provider-turn');
    await sessions.sendMessage(session.id, 'old turn');
    await sessions.stopTurn(session.id);

    proxyMgr.client.startTurnIds.push('new-provider-turn');
    await sessions.sendMessage(session.id, 'new turn');
    const before = sessions.listEvents(session.id).length;
    assert.doesNotThrow(() => proxyMgr.client.fire({
      method: 'output.text',
      params: {
        sessionId: 'proxy_x',
        turnId: 'old-provider-turn',
        data: { text: 'late old output' },
      },
    }));
    assert.doesNotThrow(() => proxyMgr.client.fire({
      method: 'turn.completed',
      params: {
        sessionId: 'proxy_x',
        turnId: 'old-provider-turn',
        data: { status: 'completed' },
      },
    }));

    assert.equal(sessions.listEvents(session.id).length, before);
    const turns = db.prepare(
      'SELECT status FROM turns WHERE session_id = ? ORDER BY turn_number',
    ).all(session.id) as Array<{ status: string }>;
    assert.deepEqual(turns.map(turn => turn.status), ['stopped', 'running']);
    assert.equal(sessions.getSession(session.id).status, 'running');

    proxyMgr.client.fire({
      method: 'turn.completed',
      params: {
        sessionId: 'proxy_x',
        turnId: 'new-provider-turn',
        data: { status: 'completed' },
      },
    });
    assert.deepEqual(
      (db.prepare('SELECT status FROM turns WHERE session_id = ? ORDER BY turn_number')
        .all(session.id) as Array<{ status: string }>).map(turn => turn.status),
      ['stopped', 'completed'],
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('local completion flushes the final pending snapshot before the fold boundary', async () => {
  const { dir, db, wsId, sessions, proxyMgr } = setup(undefined, true);
  try {
    const session = await sessions.createSession({ workspace_id: wsId, executor: 'codex' });
    await sessions.sendMessage(session.id, 'change it');
    for (const revision of ['old', 'final']) {
      proxyMgr.client.fire({
        method: 'diff.updated',
        params: {
          sessionId: 'proxy_x',
          turnId: 'proxy_turn',
          data: { diff: revision },
        },
      });
    }
    await sessions.stopTurn(session.id);

    const events = sessions.listEvents(session.id);
    const diff = events.filter(event => event.event === 'diff.updated');
    assert.equal(diff.length, 1);
    assert.equal(diff[0]?.display?.data.diff, 'final');
    const terminalIndex = events.findIndex(event => event.display?.type === 'state.turn-completed');
    assert.ok(events.findIndex(event => event.event === 'diff.updated') < terminalIndex);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('forceRecover persists a terminal boundary for a DB-only orphaned turn', async () => {
  const { dir, db, wsId, sessions, broadcaster } = setup();
  try {
    const session = await sessions.createSession({ workspace_id: wsId, executor: 'claude' });
    db.prepare(
      `INSERT INTO turns(id, session_id, turn_number, status, created_at)
       VALUES('orphan-turn', ?, 1, 'running', '2026-08-09T03:00:00.000Z')`,
    ).run(session.id);
    db.prepare(`UPDATE sessions SET status = 'running' WHERE id = ?`).run(session.id);
    broadcaster.messages.length = 0;

    await sessions.forceRecover(session.id);

    const turn = db.prepare(
      'SELECT status, completed_at FROM turns WHERE id = ?',
    ).get('orphan-turn') as { status: string; completed_at: string | null };
    assert.equal(turn.status, 'stopped');
    assert.ok(turn.completed_at);
    const completions = sessions.listEvents(session.id)
      .filter(event => event.display?.type === 'state.turn-completed');
    assert.equal(completions.length, 1);
    assert.equal(completions[0]?.call_id, 'gian:turn-completed:orphan-turn');
    assert.equal(
      broadcaster.messages.filter(message => (
        message.type === 'event' && message.event === 'gian.turn.completed'
      )).length,
      1,
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Codex force recover replaces the facade and never accumulates notification handlers', async () => {
  const { dir, db, wsId, sessions, proxyMgr, broadcaster } = setup();
  try {
    const session = await sessions.createSession({ workspace_id: wsId, executor: 'codex' });
    const first = proxyMgr.client;
    assert.equal(first.executor, 'codex');
    assert.equal(first.notificationHandlers.length, 1);
    assert.equal(first.exitHandlers.length, 1);
    assert.deepEqual(first.handlerCountsAtCreate, [{ notifications: 1, exits: 1 }]);

    await sessions.forceRecover(session.id);
    assert.equal(first.notificationHandlers.length, 0, 'first facade is detached during recover');
    assert.equal(first.exitHandlers.length, 0, 'first exit callback is detached during recover');
    assert.equal(first.forceKillCalls, 1);

    await sessions.sendMessage(session.id, 'after first recovery');
    const second = proxyMgr.client;
    assert.notEqual(second, first, 'first post-recovery turn uses a fresh facade');
    assert.equal(second.notificationHandlers.length, 1);
    assert.equal(second.exitHandlers.length, 1);
    assert.deepEqual(
      second.handlerCountsAtCreate,
      [{ notifications: 1, exits: 1 }],
      'replacement callbacks are attached before native create/adopt starts',
    );

    await sessions.forceRecover(session.id);
    assert.equal(second.notificationHandlers.length, 0, 'second facade is also detached');
    assert.equal(second.exitHandlers.length, 0, 'second exit callback is also detached');
    assert.equal(second.forceKillCalls, 1);

    await sessions.sendMessage(session.id, 'after second recovery');
    const third = proxyMgr.client;
    assert.notEqual(third, second, 'second post-recovery turn uses another fresh facade');
    assert.equal(third.notificationHandlers.length, 1, 'only one Host callback is attached');
    assert.equal(third.exitHandlers.length, 1, 'only one Host exit callback is attached');
    assert.deepEqual(third.handlerCountsAtCreate, [{ notifications: 1, exits: 1 }]);
    assert.deepEqual(proxyMgr.forceDisposeCalls, [session.id, session.id]);

    broadcaster.messages.length = 0;
    third.fire({
      method: 'output.text.delta',
      params: {
        sessionId: 'proxy_after_second_recovery',
        turnId: 'proxy_turn',
        data: { delta: 'pong', itemId: 'msg_after_second_recovery' },
      },
    });

    const liveDeltas = broadcaster.messages.filter(message => (
      message.type === 'event'
      && message.session_id === session.id
      && message.event === 'output.text.delta'
    ));
    assert.equal(liveDeltas.length, 1, 'one Proxy delta produces one WebSocket event');

    const stored = db.prepare(
      `SELECT COUNT(*) AS count
       FROM events
       WHERE session_id = ? AND type = 'output.text.delta'`,
    ).get(session.id) as { count: number };
    assert.equal(stored.count, 1, 'one Proxy delta produces one persisted event');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const executor of ['claude', 'kimi'] as const) {
  test(`${executor} force recover replaces only its facade and preserves single delivery`, async () => {
    const { dir, db, wsId, sessions, proxyMgr, broadcaster } = setup();
    try {
      const session = await sessions.createSession({ workspace_id: wsId, executor });
      const first = proxyMgr.client;
      assert.equal(first.executor, executor);
      assert.equal(first.notificationHandlers.length, 1);
      assert.equal(first.exitHandlers.length, 1);

      await sessions.sendMessage(session.id, 'before recovery');
      await sessions.forceRecover(session.id);
      assert.equal(first.notificationHandlers.length, 0);
      assert.equal(first.exitHandlers.length, 0);

      await sessions.sendMessage(session.id, 'after recovery');
      const replacement = proxyMgr.client;
      assert.notEqual(replacement, first);
      assert.equal(replacement.executor, executor);
      assert.equal(replacement.notificationHandlers.length, 1);
      assert.equal(replacement.exitHandlers.length, 1);

      const notification: ProxyNotification = executor === 'claude'
        ? {
            method: 'output.text',
            params: {
              sessionId: 'native_claude_recovered',
              turnId: 'proxy_turn',
              data: { text: 'claude recovered', itemId: 'claude_message_recovered' },
            },
          }
        : {
            method: 'acp.sessionUpdate',
            params: {
              sessionId: 'native_kimi_recovered',
              turnId: 'proxy_turn',
              data: {
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: 'kimi recovered' },
                  _meta: { itemId: 'kimi_message_recovered' },
                },
              },
            },
          };
      broadcaster.messages.length = 0;
      replacement.fire(notification);

      const eventType = executor === 'claude' ? 'output.text' : 'acp.sessionUpdate';
      assert.equal(
        broadcaster.messages.filter(message => message.type === 'event' && message.event === eventType).length,
        1,
        `${executor}: one recovered notification produces one WebSocket event`,
      );
      assert.equal(
        (db.prepare(
          'SELECT COUNT(*) AS count FROM events WHERE session_id = ? AND type = ?',
        ).get(session.id, eventType) as { count: number }).count,
        1,
        `${executor}: one recovered notification produces one persisted event`,
      );
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('setUnread toggles the flag, broadcasts, and does NOT bump updated_at', async () => {
  const { dir, db, wsId, sessions, broadcaster } = setup();
  try {
    const session = await sessions.createSession({ workspace_id: wsId, executor: 'claude' });
    const before = db.prepare('SELECT updated_at, unread FROM sessions WHERE id = ?').get(session.id) as { updated_at: string; unread: number };
    assert.equal(before.unread, 0, 'fresh session starts read');
    broadcaster.messages.length = 0;

    sessions.setUnread(session.id, true);
    const marked = db.prepare('SELECT updated_at, unread FROM sessions WHERE id = ?').get(session.id) as { updated_at: string; unread: number };
    assert.equal(marked.unread, 1);
    assert.equal(marked.updated_at, before.updated_at, 'read/unread must not reorder the sidebar');

    const upd = broadcaster.messages.find(
      (m): m is { type: 'session:updated'; session: { unread?: number; updated_at?: string } } =>
        m.type === 'session:updated',
    );
    assert.ok(upd && upd.session.unread === 1, 'broadcasts unread:1');
    assert.equal(upd!.session.updated_at, undefined, 'broadcast carries no updated_at');

    sessions.setUnread(session.id, false); // mark read (the open-session path)
    const cleared = db.prepare('SELECT unread FROM sessions WHERE id = ?').get(session.id) as { unread: number };
    assert.equal(cleared.unread, 0);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('setPinned toggles pinned_at, broadcasts, and does NOT bump updated_at', async () => {
  const { dir, db, wsId, sessions, broadcaster } = setup();
  try {
    const session = await sessions.createSession({ workspace_id: wsId, executor: 'claude' });
    const before = db.prepare('SELECT updated_at, pinned_at FROM sessions WHERE id = ?').get(session.id) as { updated_at: string; pinned_at: string | null };
    assert.equal(before.pinned_at, null, 'fresh session starts unpinned');
    broadcaster.messages.length = 0;

    sessions.setPinned(session.id, true);
    const marked = db.prepare('SELECT updated_at, pinned_at FROM sessions WHERE id = ?').get(session.id) as { updated_at: string; pinned_at: string | null };
    assert.ok(marked.pinned_at, 'pin stamps pinned_at');
    assert.equal(marked.updated_at, before.updated_at, 'pin must not reorder by updated_at');

    const upd = broadcaster.messages.find(
      (m): m is { type: 'session:updated'; session: { pinned_at?: string | null } } =>
        m.type === 'session:updated',
    );
    assert.ok(upd && upd.session.pinned_at, 'broadcasts the pinned_at stamp');

    sessions.setPinned(session.id, false);
    const cleared = db.prepare('SELECT pinned_at FROM sessions WHERE id = ?').get(session.id) as { pinned_at: string | null };
    assert.equal(cleared.pinned_at, null, 'unpin clears pinned_at');
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
    assert.deepEqual(types, ['user_message', 'output.text', 'turn.completed']);
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
    first.proxyMgr.client.fire({
      method: 'turn.completed',
      params: { sessionId: 'proxy_x', data: { status: 'completed' } },
    });
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
    const rotatedDuringAdopt = 'cc_rotated_during_adopt';
    proxyMgr.client.notificationDuringCreate = {
      method: 'session.rotated',
      params: {
        sessionId: originalNativeId,
        data: {
          oldNativeSessionId: originalNativeId,
          newNativeSessionId: rotatedDuringAdopt,
        },
      },
    };
    await sessions.sendMessage(sessionId, 'after restart');

    // Adoption: createSession was called with the persisted claudeSessionId.
    assert.ok(proxyMgr.client.lastCreateParams, 'createSession invoked on second host');
    assert.equal(
      proxyMgr.client.lastCreateParams!.claudeSessionId,
      originalNativeId,
      'createSession passed persisted native_session_id as claudeSessionId for adoption',
    );
    assert.equal(
      (db.prepare('SELECT native_session_id FROM sessions WHERE id = ?').get(sessionId) as {
        native_session_id: string;
      }).native_session_id,
      rotatedDuringAdopt,
      'a notification emitted during native adoption is handled instead of dropped',
    );
    assert.equal(proxyMgr.client.notificationHandlers.length, 1, 'ordinary resume binds one notification callback');
    assert.equal(proxyMgr.client.exitHandlers.length, 1, 'ordinary resume binds one exit callback');

    broadcaster.messages.length = 0;
    proxyMgr.client.fire({
      method: 'output.text',
      params: {
        sessionId: rotatedDuringAdopt,
        turnId: 'proxy_turn',
        data: { text: 'resumed once', itemId: 'message_after_resume' },
      },
    });
    assert.equal(
      broadcaster.messages.filter(message => message.type === 'event' && message.event === 'output.text').length,
      1,
      'one notification after ordinary resume produces one WebSocket event',
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

test('command_execution with `git worktree add` records detected_worktree_path and broadcasts', async () => {
  const { dir, db, sessions, proxyMgr, broadcaster } = setup();
  const repo = createGitRepo({ initialBranch: 'main' });
  try {
    // Workspace backed by a REAL git repo so membership validation passes.
    const wsPath = realpathSync(repo.path);
    const repoWsId = randomUUID();
    db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)')
      .run(repoWsId, 'repo-ws', wsPath);

    // The agent "already ran" the command: the worktree exists on disk.
    repo.git(['worktree', 'add', '-b', 'feature/agent', `${repo.path}-agent`, 'main']);
    const wtPath = (await listGitWorktreesAsync(wsPath)).find(w => w.branch === 'feature/agent')!.path;

    const session = await sessions.createSession({ workspace_id: repoWsId, executor: 'claude' });
    await sessions.sendMessage(session.id, 'make a worktree');
    broadcaster.messages.length = 0;

    const fireBash = (command: string): void => proxyMgr.client.fire({
      method: 'tool.use',
      params: {
        sessionId: 'proxy_x',
        data: { toolName: 'Bash', input: { command }, callId: randomUUID() },
      },
    });

    fireBash(`git worktree add -b feature/agent ${wtPath} main`);

    await waitFor(() => {
      const current = db
        .prepare('SELECT detected_worktree_path FROM sessions WHERE id = ?')
        .get(session.id) as { detected_worktree_path: string | null };
      return current.detected_worktree_path === wtPath;
    });

    const row = db
      .prepare('SELECT detected_worktree_path FROM sessions WHERE id = ?')
      .get(session.id) as { detected_worktree_path: string | null };
    assert.equal(row.detected_worktree_path, wtPath, 'detected path persisted on the session row');

    const updates = broadcaster.messages.filter(
      m => m.type === 'session:updated'
        && (m as { session: { detected_worktree_path?: string | null } }).session.detected_worktree_path,
    );
    assert.equal(updates.length, 1, 'one session:updated broadcast carries the detected path');
    const gitUpdates = broadcaster.messages.filter(
      m => m.type === 'workspace:git-updated',
    );
    assert.deepEqual(gitUpdates, [{
      type: 'workspace:git-updated',
      workspace_id: repoWsId,
      reason: 'worktree-detected',
    }], 'detection invalidates cached worktree listings for the workspace');

    // Idempotent: the completion event re-carries the same command — no
    // second write, no second broadcast.
    fireBash(`git worktree add -b feature/agent ${wtPath} main`);
    const updatesAfter = broadcaster.messages.filter(
      m => m.type === 'session:updated'
        && (m as { session: { detected_worktree_path?: string | null } }).session.detected_worktree_path,
    );
    assert.equal(updatesAfter.length, 1, 'same path again does not rebroadcast');
    assert.equal(
      broadcaster.messages.filter(m => m.type === 'workspace:git-updated').length,
      1,
      'same detected path does not trigger another worktree refresh',
    );

    // Guards: a path that is NOT a worktree of the workspace repo is ignored…
    fireBash('git worktree add /not/a/real/worktree');
    // …and so is a non-worktree-add command.
    fireBash('git worktree list');
    const rowAfter = db
      .prepare('SELECT detected_worktree_path FROM sessions WHERE id = ?')
      .get(session.id) as { detected_worktree_path: string | null };
    assert.equal(rowAfter.detected_worktree_path, wtPath, 'guards reject bogus detections');
    assert.equal(
      broadcaster.messages.filter(m => m.type === 'workspace:git-updated').length,
      1,
      'rejected detections do not trigger worktree refreshes',
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
    repo.cleanup();
  }
});

test('worktree detection never disturbs Gian-owned worktree sessions', async () => {
  const { dir, db, sessions, proxyMgr } = setup();
  const repo = createGitRepo({ initialBranch: 'main' });
  try {
    const wsPath = realpathSync(repo.path);
    const repoWsId = randomUUID();
    db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)')
      .run(repoWsId, 'repo-ws', wsPath);

    repo.git(['worktree', 'add', '-b', 'feature/agent', `${repo.path}-agent`, 'main']);
    const wtPath = (await listGitWorktreesAsync(wsPath)).find(w => w.branch === 'feature/agent')!.path;

    const session = await sessions.createSession({ workspace_id: repoWsId, executor: 'claude' });
    // Simulate a Gian-owned worktree session (managed by merge/discard).
    db.prepare('UPDATE sessions SET worktree_path = ? WHERE id = ?')
      .run('/data/worktrees/owned', session.id);
    await sessions.sendMessage(session.id, 'ping');

    proxyMgr.client.fire({
      method: 'tool.use',
      params: {
        sessionId: 'proxy_x',
        data: {
          toolName: 'Bash',
          input: { command: `git worktree add ${wtPath}` },
          callId: randomUUID(),
        },
      },
    });

    const row = db
      .prepare('SELECT detected_worktree_path, worktree_path FROM sessions WHERE id = ?')
      .get(session.id) as { detected_worktree_path: string | null; worktree_path: string | null };
    assert.equal(row.detected_worktree_path, null,
      'Gian-owned worktree sessions never get a detected path');
    assert.equal(row.worktree_path, '/data/worktrees/owned', 'owned worktree untouched');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
    repo.cleanup();
  }
});
