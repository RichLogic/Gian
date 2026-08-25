import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
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
import type {
  ProxyClient,
  NotificationHandler,
  ProxyReplayResult,
  RespondInteractionParams,
  StartTurnParams,
} from '../src/proxy/types.js';
import type { WsBroadcaster } from '../src/web/ws-broadcast.js';
import { ApprovalManager } from '../src/approval/index.js';
import { QueueManager } from '../src/queue/index.js';
import { writeAttachment } from '../src/storage/attachments.js';
import { listGitWorktreesAsync } from '../src/workspace/git.js';
import { createGitRepo } from './fixtures/git-repo.js';
import { installEventStorageV3 } from '../src/storage/event-storage-v3-schema.js';
import {
  canonicalFingerprint,
  proxyNotificationSchema,
  replayEventSchemaUnion,
  type ReplayEvent,
} from '@gian/proxy-protocol';
import { EMPTY_CATALOG, stubInitialize, stubSession } from './helpers/protocol-v2-stub.js';

function liveNotification(value: {
  method: string;
  params: Record<string, unknown> & { turnId?: string };
}): ProxyNotification {
  return proxyNotificationSchema.parse({
    jsonrpc: '2.0',
    method: value.method,
    params: {
      streamId: 'stream-1',
      sequence: 1,
      ...(value.params.turnId ? { sourceTurnId: value.params.turnId } : {}),
      ...value.params,
    },
  });
}

function replayEvent(value: {
  method: string;
  eventId: string;
  sessionId: string;
  replayStreamId: string;
  sequence: number;
  sourceTurnId: string;
  emittedAt: string;
  data: unknown;
}): ReplayEvent {
  return replayEventSchemaUnion.parse(value);
}

function liveFromReplay(event: ReplayEvent): ProxyNotification {
  return liveNotification({
    method: event.method,
    params: {
      eventId: event.eventId,
      streamId: event.replayStreamId,
      sequence: event.sequence,
      sessionId: event.sessionId,
      turnId: event.sourceTurnId,
      emittedAt: event.emittedAt,
      data: event.data,
    },
  });
}

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
  faultHandlers: Array<(error: Error) => void> = [];
  handlerCountsAtCreate: Array<{ notifications: number; exits: number }> = [];
  notificationDuringCreate: ProxyNotification | null = null;
  notificationDuringInterrupt: ProxyNotification | null = null;
  interruptError: Error | null = null;
  startTurnIds: string[] = [];
  echoHostTurnId = false;
  approvalCalls: RespondInteractionParams[] = [];
  nameCalls: string[] = [];
  createSessionGate: Promise<void> | null = null;
  onCreateSessionStarted: (() => void) | null = null;

  constructor(executor: Executor = 'claude') {
    this.executor = executor;
  }

  isExited() { return false; }
  async initialize() {
    return stubInitialize(this.executor);
  }
  async catalog() {
    if (this.catalogOverride) return this.catalogOverride;
    if (this.executor === 'codex') {
      return {
        catalogRevision: 'codex-test',
        input: [{ type: 'text' as const }],
        configOptions: [{
          id: 'fast',
          displayName: 'Fast',
          binding: 'turn' as const,
          role: 'fast',
          control: 'boolean' as const,
          required: false,
          defaultValue: false,
        }],
        slashCommands: [],
      };
    }
    return EMPTY_CATALOG;
  }
  /** When set, next createSession call rejects (used to test rollback). */
  failNextCreate: Error | null = null;

  /** Captures the last createSession params so tests can assert on adoption. */
  lastCreateParams: import('../src/proxy/types.js').CreateSessionParams | null = null;
  catalogOverride: import('@gian/shared').ProxyCatalog | null = null;
  createTurnConfig: {
    options: import('@gian/shared').ConfigOption[];
    revision: string;
  } | null = null;
  resolveCalls: Array<{
    catalogRevision: string;
    sessionConfig: Record<string, string | boolean | number | null>;
    turnConfig: Record<string, string | boolean | number | null>;
  }> = [];

  async createSession(params: import('../src/proxy/types.js').CreateSessionParams) {
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
    const nativeSessionId = params.nativeSessionId ?? `cc_${randomUUID()}`;
    if (this.notificationDuringCreate) {
      const notification = this.notificationDuringCreate;
      this.notificationDuringCreate = null;
      this.fire(notification);
    }
    return {
      session: stubSession(nativeSessionId, params.cwd),
      nativeSessionId,
      ...(this.createTurnConfig
        ? {
            turnConfigOptions: this.createTurnConfig.options,
            turnConfigRevision: this.createTurnConfig.revision,
          }
        : {}),
    };
  }

  async resolveCatalog(params: {
    catalogRevision: string;
    sessionConfig: Record<string, string | boolean | number | null>;
    turnConfig: Record<string, string | boolean | number | null>;
  }) {
    this.resolveCalls.push(params);
    const catalog = await this.catalog();
    return {
      ...catalog,
      resolvedDefaults: { sessionConfig: {}, turnConfig: {} },
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
  async respondInteraction(params: RespondInteractionParams) {
    this.approvalCalls.push(params);
  }
  async setName(name: string) {
    this.nameCalls.push(name);
  }
  async startTurn(params: StartTurnParams) {
    this.startTurnCalls.push(params);
    return {
      session: stubSession('proxy_x', '/tmp', 'running'),
      turn: {
        id: this.startTurnIds.shift() ?? (this.echoHostTurnId ? params.turnId : 'proxy_turn'),
      },
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
  onSessionFault(handler: (error: Error) => void) {
    this.faultHandlers.push(handler);
    return () => {
      this.faultHandlers = this.faultHandlers.filter(h => h !== handler);
    };
  }

  fire(notification: ProxyNotification): void {
    for (const h of this.notificationHandlers) h(notification);
  }
  fireFault(error: Error): void {
    for (const h of this.faultHandlers) h(error);
  }
}

class FakeProxyManager {
  client = new StubProxyClient();
  private active: StubProxyClient | null = this.client;
  private initialized = false;
  forceDisposeCalls: string[] = [];
  forceDisposeGate: Promise<void> | null = null;
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
  async forceDispose(sessionId: string): Promise<void> {
    this.forceDisposeCalls.push(sessionId);
    const client = this.active;
    this.active = null;
    if (client) await client.forceKill();
    if (this.forceDisposeGate) await this.forceDisposeGate;
  }
  async dispose(): Promise<void> {}
  async closeAll(): Promise<void> { /* no-op */ }
}

class StubKimiProxyClient implements ProxyClient {
  readonly executor: 'kimi' | 'dsh';
  readonly protocolV2 = true as const;
  notificationHandlers: NotificationHandler[] = [];
  nativeListCalls: Array<{ cwd?: string; cursor?: string }> = [];
  failNativeList = false;
  replayEvents: unknown[] = [];
  replaySession?: () => Promise<ProxyReplayResult>;
  forceKillCalls = 0;
  createCalls = 0;
  failNextCreate: Error | null = null;
  lastCreateParams: import('../src/proxy/types.js').CreateSessionParams | null = null;
  startTurnCalls: StartTurnParams[] = [];
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

  constructor(executor: 'kimi' | 'dsh' = 'kimi') {
    this.executor = executor;
  }

  isExited() { return false; }
  async initialize() {
    return stubInitialize(this.executor);
  }
  async catalog() {
    return {
      catalogRevision: 'kimi-test',
      input: [{ type: 'text' as const }],
      configOptions: this.options.map((option) => ({
        id: option.id,
        displayName: option.name,
        binding: option.scope,
        role: option.category === 'thought_level'
          ? 'effort'
          : option.category
            ? option.category
          : option.id === 'model'
            ? 'model'
            : option.id === 'mode'
              ? 'approval_mode'
              : undefined,
        control: option.type,
        required: false,
        defaultValue: option.currentValue,
        choices: option.choices?.map((choice) => ({
          value: choice.value,
          displayName: choice.label,
        })),
      })),
      slashCommands: [],
    };
  }
  async listNativeSessions(params: { cwd?: string; cursor?: string } = {}) {
    this.nativeListCalls.push(params);
    if (this.failNativeList) throw new Error('Kimi login required');
    if (params.cursor === 'page-2') {
      return {
        sessions: [{
          id: 'kimi-native-2',
          cwd: params.cwd,
          displayName: 'Older Kimi session',
          updatedAt: '2026-07-28T00:00:00.000Z',
        }],
        nextCursor: null,
      };
    }
    return {
      sessions: [{
        id: 'kimi-native-1',
        cwd: params.cwd,
        displayName: 'Recent Kimi session',
        updatedAt: '2026-07-29T00:00:00.000Z',
      }],
      nextCursor: 'page-2',
    };
  }
  async createSession(params: import('../src/proxy/types.js').CreateSessionParams) {
    this.createCalls += 1;
    this.lastCreateParams = params;
    if (this.failNextCreate) {
      const error = this.failNextCreate;
      this.failNextCreate = null;
      throw error;
    }
    const nativeSessionId = params.nativeSessionId ?? 'kimi_native_1';
    return {
      session: stubSession(`kimi_proxy_${randomUUID()}`, params.cwd),
      nativeSessionId,
      replayEvents: this.replayEvents,
    };
  }
  async interruptTurn() {}
  async respondInteraction() {}
  async startTurn(params: StartTurnParams) {
    this.startTurnCalls.push(params);
    return {
      session: stubSession('kimi_proxy_1', '/tmp', 'running'),
      turn: { id: params.turnId ?? 'kimi_turn_1' },
    };
  }
  async closeSession() {}
  async shutdown() {}
  forceKill() { this.forceKillCalls += 1; }
  onNotification(handler: NotificationHandler) {
    this.notificationHandlers.push(handler);
    return () => {
      this.notificationHandlers = this.notificationHandlers.filter(item => item !== handler);
    };
  }
  onExit() {
    return () => {};
  }

  fire(notification: ProxyNotification): void {
    for (const handler of this.notificationHandlers) handler(notification);
  }
}

class FakeKimiProxyManager {
  client: StubKimiProxyClient;
  disposeCalls: string[] = [];
  private available = true;
  constructor(executor: 'kimi' | 'dsh' = 'kimi') {
    this.client = new StubKimiProxyClient(executor);
  }
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

  return { dir, db, wsId, proxyMgr, broadcaster, approvals, sessions };
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

function setupDsh(
  proxyDefaults?: (executor: Executor) => AgentProxyDefaults,
) {
  const dir = mkdtempSync(join(tmpdir(), 'gian-sm-dsh-test-'));
  const db = openDatabase(dir);
  const wsId = randomUUID();
  db.prepare(
    'INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)',
  ).run(wsId, 'test', '/tmp/test-ws');
  const proxyMgr = new FakeKimiProxyManager('dsh');
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

test('new Codex sessions persist Fast before their first turn starts', async () => {
  const { dir, db, wsId, proxyMgr, sessions } = setup();
  try {
    const session = await sessions.createSession({
      workspace_id: wsId,
      executor: 'codex',
      service_tier: 'fast',
    });
    assert.equal(session.service_tier, 'fast');

    await sessions.sendMessage(session.id, 'first fast turn');
    assert.equal(proxyMgr.client.startTurnCalls.at(-1)?.config.fast, true);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('blank session titles are normalized to null so auto-title remains enabled', async () => {
  const { dir, db, wsId, sessions } = setup();
  try {
    const session = await sessions.createSession({
      workspace_id: wsId,
      executor: 'codex',
      name: '  \n\t  ',
    });
    assert.equal(session.name, null);
    const stored = db.prepare('SELECT name FROM sessions WHERE id = ?')
      .get(session.id) as { name: string | null };
    assert.equal(stored.name, null);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('opaque approval options stay pending until interaction.resolved', async () => {
  const { dir, db, wsId, proxyMgr, approvals, sessions } = setup();
  try {
    const session = await sessions.createSession({
      workspace_id: wsId,
      executor: 'claude',
    });
    proxyMgr.client.echoHostTurnId = true;
    await sessions.sendMessage(session.id, 'start interaction');
    const activeTurnId = proxyMgr.client.startTurnCalls.at(-1)!.turnId;
    proxyMgr.client.fire(liveNotification({
      method: 'interaction.requested',
      params: {
        eventId: 'interaction-requested-1',
        sessionId: session.id,
        turnId: activeTurnId,
        emittedAt: '2026-08-18T00:00:00.000Z',
        data: {
          interactionId: 'approval-opaque',
          title: 'Run tests',
          presentation: { kind: 'permission' },
          inputs: [{ id: 'reason', type: 'text', label: 'Reason', required: true }],
          actions: [{ id: 'opaque-provider-option-42', label: 'Allow once', style: 'primary' }],
        },
      },
    }));
    await waitFor(() => approvals.getPending('approval-opaque') !== undefined);

    await sessions.respondApproval(
      session.id,
      'approval-opaque',
      'allow_once',
      { reason: 'looks safe' },
      'opaque-provider-option-42',
    );

    assert.equal(proxyMgr.client.approvalCalls.length, 1);
    assert.equal(proxyMgr.client.approvalCalls[0]?.sessionId, session.native_session_id);
    assert.equal(proxyMgr.client.approvalCalls[0]?.interactionId, 'approval-opaque');
    assert.equal(proxyMgr.client.approvalCalls[0]?.actionId, 'opaque-provider-option-42');
    assert.deepEqual(proxyMgr.client.approvalCalls[0]?.values, { reason: 'looks safe' });
    const responseId = proxyMgr.client.approvalCalls[0]?.responseId;
    assert.ok(responseId);
    assert.ok(approvals.getPending('approval-opaque'));
    const accepted = db.prepare(
      'SELECT outcome, resolved_at FROM proxy_interactions WHERE session_id = ? AND interaction_id = ?',
    ).get(session.id, 'approval-opaque') as { outcome: string | null; resolved_at: string | null };
    assert.equal(accepted.outcome, null);
    assert.equal(accepted.resolved_at, null);

    await sessions.respondApproval(
      session.id,
      'approval-opaque',
      'allow_once',
      { reason: 'looks safe' },
      'opaque-provider-option-42',
    );
    assert.equal(proxyMgr.client.approvalCalls.length, 2);
    assert.equal(proxyMgr.client.approvalCalls[1]?.responseId, responseId);

    proxyMgr.client.fire(liveNotification({
      method: 'interaction.resolved',
      params: {
        eventId: 'interaction-resolved-1',
        sequence: 2,
        sessionId: session.id,
        turnId: activeTurnId,
        emittedAt: '2026-08-18T00:00:01.000Z',
        data: {
          interactionId: 'approval-opaque',
          outcome: 'submitted',
          actionId: 'opaque-provider-option-42',
        },
      },
    }));
    await waitFor(() => approvals.getPending('approval-opaque') === undefined);
    const resolved = db.prepare(
      'SELECT outcome, resolved_at FROM proxy_interactions WHERE session_id = ? AND interaction_id = ?',
    ).get(session.id, 'approval-opaque') as { outcome: string | null; resolved_at: string | null };
    assert.equal(resolved.outcome, 'submitted');
    assert.ok(resolved.resolved_at);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('startTurn persists the next-turn config draft without one-shot bypass', async () => {
  const { dir, db, wsId, sessions } = setup();
  try {
    const session = await sessions.createSession({
      workspace_id: wsId,
      executor: 'codex',
    });
    await sessions.sendMessage(session.id, 'hello');
    const row = db.prepare('SELECT turn_config_json FROM sessions WHERE id = ?')
      .get(session.id) as { turn_config_json: string | null };
    assert.ok(row.turn_config_json);
    assert.deepEqual(JSON.parse(row.turn_config_json), { fast: false });
    assert.deepEqual(sessions.getSession(session.id).turn_config, { fast: false });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('create persists session_config, turn_config, and create-result turn options', async () => {
  const { dir, db, wsId, proxyMgr, sessions } = setup();
  try {
    proxyMgr.client.catalogOverride = {
      catalogRevision: 'claude-create',
      input: [{ type: 'text' }],
      configOptions: [
        {
          id: 'workspace_mode',
          displayName: 'Workspace',
          binding: 'session',
          control: 'select',
          required: false,
          defaultValue: 'default',
        },
        {
          id: 'model',
          displayName: 'Model',
          binding: 'turn',
          role: 'model',
          control: 'select',
          required: true,
          defaultValue: 'base',
        },
      ],
      slashCommands: [],
    };
    proxyMgr.client.createTurnConfig = {
      revision: 'turn-rev-1',
      options: [{
        id: 'verbosity',
        displayName: 'Verbosity',
        binding: 'turn',
        control: 'select',
        required: false,
        defaultValue: 'quiet',
      }],
    };
    const session = await sessions.createSession({
      workspace_id: wsId,
      executor: 'claude',
      session_config: { workspace_mode: 'strict' },
      turn_config: { model: 'sonnet' },
    });
    assert.equal(proxyMgr.client.lastCreateParams?.sessionConfig?.workspace_mode, 'strict');
    assert.equal(session.turn_config?.model, 'sonnet');
    assert.equal(session.turn_config_revision, 'turn-rev-1');
    assert.deepEqual(session.turn_config_options?.map((option) => option.id), ['verbosity']);
    const row = db.prepare(
      'SELECT turn_config_json, turn_config_options_json, turn_config_revision FROM sessions WHERE id = ?',
    ).get(session.id) as {
      turn_config_json: string;
      turn_config_options_json: string;
      turn_config_revision: string;
    };
    assert.deepEqual(JSON.parse(row.turn_config_json), { model: 'sonnet' });
    assert.equal(row.turn_config_revision, 'turn-rev-1');
    assert.deepEqual(JSON.parse(row.turn_config_options_json).map((option: { id: string }) => option.id), ['verbosity']);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unknown approval catalog values stay off the approval_mode column', async () => {
  const { dir, db, wsId, proxyMgr, sessions } = setup();
  try {
    proxyMgr.client.catalogOverride = {
      catalogRevision: 'claude-approval',
      input: [{ type: 'text' }],
      configOptions: [{
        id: 'permission_mode',
        displayName: 'Mode',
        binding: 'turn',
        role: 'approval_mode',
        control: 'select',
        required: false,
        defaultValue: 'default',
        choices: [
          { value: 'default', displayName: 'Default' },
          { value: 'yolo', displayName: 'YOLO' },
          { value: 'ask', displayName: 'Ask' },
        ],
      }],
      slashCommands: [],
    };
    const session = await sessions.createSession({
      workspace_id: wsId,
      executor: 'claude',
      turn_config: { permission_mode: 'yolo' },
    });
    assert.notEqual(session.approval_mode, 'yolo');
    assert.equal(session.turn_config?.permission_mode, 'yolo');
    sessions.setTurnConfigValue(session.id, 'permission_mode', 'yolo');
    const afterUnknown = sessions.getSession(session.id);
    assert.notEqual(afterUnknown.approval_mode, 'yolo');
    assert.equal(afterUnknown.turn_config?.permission_mode, 'yolo');
    sessions.setTurnConfigValue(session.id, 'permission_mode', 'ask');
    const afterKnown = sessions.getSession(session.id);
    assert.equal(afterKnown.approval_mode, 'ask');
    const row = db.prepare('SELECT approval_mode FROM sessions WHERE id = ?')
      .get(session.id) as { approval_mode: string | null };
    assert.equal(row.approval_mode, 'ask');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('startTurn uses session turn_config_options instead of the process catalog', async () => {
  const { dir, db, wsId, proxyMgr, sessions } = setup();
  try {
    const session = await sessions.createSession({
      workspace_id: wsId,
      executor: 'codex',
    });
    sessions.persistTurnConfigOptions(session.id, [{
      id: 'verbosity',
      displayName: 'Verbosity',
      binding: 'turn',
      control: 'select',
      required: false,
      defaultValue: 'quiet',
    }], 'session-turn-rev');
    await sessions.sendMessage(session.id, 'hello');
    assert.deepEqual(proxyMgr.client.startTurnCalls[0]?.config, { verbosity: 'quiet' });
    assert.equal(sessions.getSession(session.id).turn_config?.verbosity, 'quiet');
    assert.equal(sessions.getSession(session.id).turn_config?.fast, undefined);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('session.updated persists turnConfigOptions as a full replacement', async () => {
  const { dir, db, wsId, proxyMgr, sessions } = setup();
  try {
    const session = await sessions.createSession({
      workspace_id: wsId,
      executor: 'claude',
    });
    proxyMgr.client.fire({
      jsonrpc: '2.0',
      method: 'session.updated',
      params: {
        eventId: 'upd-1',
        streamId: 'stream-1',
        sequence: 1,
        sessionId: session.id,
        emittedAt: '2026-08-18T04:00:00.000Z',
        data: {
          turnConfigOptions: [],
          turnConfigRevision: 'empty-rev',
        },
      },
    } as ProxyNotification);
    const updated = sessions.getSession(session.id);
    assert.deepEqual(updated.turn_config_options, []);
    assert.equal(updated.turn_config_revision, 'empty-rev');
    const row = db.prepare(
      'SELECT turn_config_options_json, turn_config_revision FROM sessions WHERE id = ?',
    ).get(session.id) as {
      turn_config_options_json: string;
      turn_config_revision: string;
    };
    assert.deepEqual(JSON.parse(row.turn_config_options_json), []);
    assert.equal(row.turn_config_revision, 'empty-rev');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('session and process lifecycle events mirror protocol state into the Session row', async () => {
  const { dir, db, wsId, proxyMgr, sessions } = setup();
  try {
    const session = await sessions.createSession({
      workspace_id: wsId,
      executor: 'claude',
    });
    proxyMgr.client.fire(liveNotification({
      method: 'session.updated',
      params: {
        eventId: 'session-running-1',
        sessionId: session.id,
        emittedAt: '2026-08-18T04:00:00.000Z',
        data: { state: 'running' },
      },
    }));
    assert.equal(sessions.getSession(session.id).status, 'running');

    proxyMgr.client.fire(proxyNotificationSchema.parse({
      jsonrpc: '2.0',
      method: 'runtime.error',
      params: {
        eventId: 'process-error-1',
        emittedAt: '2026-08-18T04:00:01.000Z',
        data: {
          domainCode: 'RUNTIME_UNAVAILABLE',
          message: 'mock runtime disconnected',
          retryable: true,
          details: {},
        },
      },
    }));
    assert.equal(sessions.getSession(session.id).status, 'error');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Grok session rename uses the generic protocol client', async () => {
  const { dir, db, wsId, proxyMgr, sessions } = setup();
  try {
    const session = await sessions.createSession({
      workspace_id: wsId,
      executor: 'grok',
    });
    sessions.renameSession(session.id, 'Renamed Grok session');
    await waitFor(() => proxyMgr.client.nameCalls.length === 1);
    assert.deepEqual(proxyMgr.client.nameCalls, ['Renamed Grok session']);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('role setters and setTurnConfigValue keep the next-turn draft in sync', async () => {
  const { dir, db, wsId, sessions } = setup();
  try {
    const session = await sessions.createSession({
      workspace_id: wsId,
      executor: 'codex',
    });
    sessions.setServiceTier(session.id, 'fast');
    sessions.setTurnConfigValue(session.id, 'verbosity', 'quiet');
    const row = db.prepare('SELECT turn_config_json, service_tier FROM sessions WHERE id = ?')
      .get(session.id) as { turn_config_json: string; service_tier: string | null };
    assert.equal(row.service_tier, 'fast');
    assert.deepEqual(JSON.parse(row.turn_config_json), { fast: true, verbosity: 'quiet' });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('turn dispatch omits catalog options disabled for the selected model', async () => {
  const { dir, db, wsId, proxyMgr, sessions } = setup();
  try {
    const session = await sessions.createSession({
      workspace_id: wsId,
      executor: 'codex',
      model: 'gpt-standard',
      service_tier: 'fast',
    });
    sessions.persistTurnConfigOptions(session.id, [{
      id: 'model',
      displayName: 'Model',
      binding: 'turn',
      role: 'model',
      control: 'select',
      required: false,
      defaultValue: 'gpt-fast',
      choices: [
        { value: 'gpt-fast', displayName: 'GPT Fast' },
        { value: 'gpt-standard', displayName: 'GPT Standard' },
      ],
    }, {
      id: 'service_tier',
      displayName: 'Fast',
      binding: 'turn',
      role: 'fast',
      control: 'boolean',
      required: false,
      defaultValue: false,
      enabledWhen: [{ optionId: 'model', oneOf: ['gpt-fast'] }],
    }], 'codex-fast-conditions');

    await sessions.sendMessage(session.id, 'standard turn');

    assert.deepEqual(proxyMgr.client.startTurnCalls[0]?.config, {
      model: 'gpt-standard',
    });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a live terminal event still settles the turn when replay already persisted it', async () => {
  const { dir, db, wsId, proxyMgr, sessions } = setup();
  try {
    const session = await sessions.createSession({
      workspace_id: wsId,
      executor: 'claude',
    });
    await sessions.sendMessage(session.id, 'hello');
    const turnId = proxyMgr.client.startTurnCalls[0]?.turnId;
    assert.ok(turnId);
    const providerTurnId = 'proxy_turn';
    const emittedAt = '2026-08-10T03:00:00.000Z';
    const data = { stopReason: 'completed' } as const;
    const eventId = 'overlap-terminal-event';
    const notification = liveNotification({
      method: 'turn.completed',
      params: {
        eventId,
        streamId: 'stream-1',
        sequence: 1,
        sessionId: session.id,
        turnId: providerTurnId,
        emittedAt,
        data,
      },
    });
    const payloadHash = createHash('sha256').update(JSON.stringify({
      method: notification.method,
      fingerprint: canonicalFingerprint(notification),
      turnId: providerTurnId,
      emittedAt,
      data,
    })).digest('hex');
    db.prepare(
      `INSERT OR IGNORE INTO proxy_replay_turns
        (session_id, provider_turn_id, turn_id, replay_owned)
       VALUES (?, ?, ?, 0)`,
    ).run(session.id, providerTurnId, turnId);
    db.prepare(
      `INSERT INTO proxy_replay_events
        (session_id, event_id, turn_id, payload_sha256)
       VALUES (?, ?, ?, ?)`,
    ).run(session.id, eventId, turnId, payloadHash);
    proxyMgr.client.fire(notification);

    assert.equal(sessions.getSession(session.id).status, 'done');
    assert.deepEqual(
      db.prepare('SELECT status FROM turns WHERE id = ?').get(turnId),
      { status: 'completed' },
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Kimi session_config overrides computed session-bound values and stays off approval_mode', async () => {
  const { dir, db, wsId, proxyMgr, sessions } = setupKimi(() => ({
    model: '',
    thinking: '',
    mode: 'default',
  }));
  try {
    const session = await sessions.createSession({
      workspace_id: wsId,
      executor: 'kimi',
      session_config: { mode: 'yolo' },
    });
    assert.equal(session.approval_mode, null);
    assert.equal(proxyMgr.client.lastCreateParams?.sessionConfig?.mode, 'yolo');
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

test('Kimi applies a turn-bound Proxy-owned default mode on the first turn', async () => {
  const { dir, db, wsId, proxyMgr, sessions } = setupKimi(() => ({
    model: '',
    thinking: '',
    mode: 'yolo',
  }));
  try {
    proxyMgr.client.options[0] = { ...proxyMgr.client.options[0]!, scope: 'turn' };
    const session = await sessions.createSession({ workspace_id: wsId, executor: 'kimi' });
    assert.equal(session.approval_mode, null);
    assert.equal(session.turn_config?.mode, 'yolo');

    await sessions.sendMessage(session.id, 'use the configured native mode');
    assert.equal(proxyMgr.client.startTurnCalls.at(-1)?.config.mode, 'yolo');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('DSH applies Settings model, effort, and mode defaults on its first turn', async () => {
  const { dir, db, wsId, proxyMgr, sessions } = setupDsh(() => ({
    model: 'deepseek-reasoner',
    thinking: 'high',
    mode: 'never',
  }));
  try {
    proxyMgr.client.options.splice(0, proxyMgr.client.options.length,
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'deepseek-chat',
        scope: 'turn',
        choices: [
          { value: 'deepseek-chat', label: 'DeepSeek Chat' },
          { value: 'deepseek-reasoner', label: 'DeepSeek Reasoner' },
        ],
      },
      {
        id: 'effort',
        name: 'Reasoning effort',
        category: 'effort',
        type: 'select',
        currentValue: 'medium',
        scope: 'turn',
        choices: [
          { value: 'medium', label: 'Medium' },
          { value: 'high', label: 'High' },
        ],
      },
      {
        id: 'approval_policy',
        name: 'Approval policy',
        category: 'approval_mode',
        type: 'select',
        currentValue: 'ask',
        scope: 'turn',
        choices: [
          { value: 'ask', label: 'Ask' },
          { value: 'never', label: 'Never' },
        ],
      },
    );

    const session = await sessions.createSession({ workspace_id: wsId, executor: 'dsh' });
    assert.equal(session.approval_mode, null);
    assert.equal(session.model, 'deepseek-reasoner');
    assert.equal(session.thinking_effort, 'high');
    assert.deepEqual(session.turn_config, {
      model: 'deepseek-reasoner',
      effort: 'high',
      approval_policy: 'never',
    });

    await sessions.sendMessage(session.id, 'use every configured DSH default');
    assert.equal(proxyMgr.client.startTurnCalls.at(-1)?.config.model, 'deepseek-reasoner');
    assert.equal(proxyMgr.client.startTurnCalls.at(-1)?.config.effort, 'high');
    assert.equal(proxyMgr.client.startTurnCalls.at(-1)?.config.approval_policy, 'never');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('managed approval presets do not leak into an older Codex native policy catalog', async () => {
  const { dir, db, wsId, proxyMgr, sessions } = setup(() => ({
    model: '',
    thinking: '',
    mode: 'ask',
  }));
  try {
    await proxyMgr.getOrCreate(undefined, 'codex');
    proxyMgr.client.catalogOverride = {
      catalogRevision: 'codex-low-level-policy',
      input: [{ type: 'text' }],
      configOptions: [{
        id: 'approval_policy',
        displayName: 'Approval policy',
        binding: 'turn',
        role: 'approval_mode',
        control: 'select',
        required: false,
        defaultValue: null,
        choices: [
          { value: null, displayName: 'Configured default' },
          { value: 'on-request', displayName: 'On request' },
          { value: 'never', displayName: 'Never' },
        ],
      }],
      slashCommands: [],
    };
    const session = await sessions.createSession({ workspace_id: wsId, executor: 'codex' });
    assert.equal(session.approval_mode, 'ask');
    assert.equal(session.turn_config?.approval_policy, undefined);

    await sessions.sendMessage(session.id, 'use config.toml permissions');
    assert.equal(proxyMgr.client.startTurnCalls.at(-1)?.config.approval_policy, null);
    assert.notEqual(proxyMgr.client.startTurnCalls.at(-1)?.config.approval_policy, 'ask');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Codex semantic approval presets reach the first turn unchanged', async t => {
  for (const mode of ['ask', 'auto', 'full-access', 'custom'] as const) {
    await t.test(mode, async () => {
      const { dir, db, wsId, proxyMgr, sessions } = setup(() => ({
        model: '',
        thinking: '',
        mode,
      }));
      try {
        await proxyMgr.getOrCreate(undefined, 'codex');
        proxyMgr.client.catalogOverride = {
          catalogRevision: 'codex-semantic-approval',
          input: [{ type: 'text' }],
          configOptions: [{
            id: 'approval_mode',
            displayName: 'Approval',
            binding: 'turn',
            role: 'approval_mode',
            control: 'select',
            required: false,
            defaultValue: 'ask',
            choices: [
              { value: 'ask', displayName: 'Ask for approval' },
              { value: 'auto', displayName: 'Approve for me' },
              { value: 'full-access', displayName: 'Full access' },
              { value: 'custom', displayName: 'Custom (config.toml)' },
            ],
          }],
          slashCommands: [],
        };
        const session = await sessions.createSession({ workspace_id: wsId, executor: 'codex' });
        assert.equal(session.approval_mode, mode);
        assert.equal(session.turn_config?.approval_mode, mode);

        await sessions.sendMessage(session.id, `use ${mode}`);
        assert.equal(proxyMgr.client.startTurnCalls.at(-1)?.config.approval_mode, mode);
      } finally {
        db.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
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
        id: 'thinking',
        name: 'Thinking',
        category: 'thought_level',
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
      thinking: 'high',
    });
    assert.deepEqual(proxyMgr.client.lastCreateParams?.sessionConfig, {
      mode: 'yolo',
      model: 'kimi-k2',
      thinking: 'high',
    });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Kimi skips a stale default when ACP no longer advertises that semantic role', async () => {
  const { dir, db, wsId, proxyMgr, sessions } = setupKimi(() => ({
    model: '',
    thinking: 'high',
    mode: '',
  }));
  try {
    const session = await sessions.createSession({ workspace_id: wsId, executor: 'kimi' });
    assert.deepEqual(session.executor_config.values, { mode: 'default' });
    assert.equal(proxyMgr.client.lastCreateParams?.sessionConfig?.thinking, undefined);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Kimi creation failure names the advertised config id and leaves no Gian row', async () => {
  const { dir, db, wsId, proxyMgr, sessions } = setupKimi(() => ({
    model: '',
    thinking: 'high',
    mode: '',
  }));
  try {
    proxyMgr.client.options.push({
      id: 'thinking',
      name: 'Thinking',
      category: 'thought_level',
      type: 'select',
      currentValue: 'medium',
      scope: 'session',
      choices: [
        { value: 'medium', label: 'Medium' },
        { value: 'high', label: 'High' },
      ],
    });
    proxyMgr.client.failNextCreate = new Error(
      'Invalid params: Unknown configId: thinking',
    );

    await assert.rejects(
      sessions.createSession({ workspace_id: wsId, executor: 'kimi' }),
      /Unknown configId: thinking/,
    );
    const count = db.prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number };
    assert.equal(count.count, 0);
    assert.equal(proxyMgr.disposeCalls.length, 1);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Kimi rehydrate remaps a saved thinking alias to the current advertised id', async () => {
  const { dir, db, wsId, proxyMgr, sessions } = setupKimi();
  try {
    proxyMgr.client.options.push({
      id: 'thinking',
      name: 'Thinking',
      category: 'thought_level',
      type: 'select',
      currentValue: 'medium',
      scope: 'session',
      choices: [
        { value: 'medium', label: 'Medium' },
        { value: 'high', label: 'High' },
      ],
    });
    const session = await sessions.createSession({ workspace_id: wsId, executor: 'kimi' });
    db.prepare('UPDATE sessions SET executor_config_json = ? WHERE id = ?').run(
      JSON.stringify({
        schemaVersion: 1,
        values: { mode: 'default', thought_level: 'high' },
      }),
      session.id,
    );
    proxyMgr.dropClient();

    const snapshot = await sessions.getNativeConfig(session.id);

    assert.equal(snapshot.state.values.thinking, 'high');
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
  proxyMgr.client.replayEvents = [
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

test('protocol v1 replay deduplicates events already persisted from the live stream', async () => {
  const { dir, db, wsId, proxyMgr, broadcaster, sessions } = setupKimi();
  try {
    const adopted = await sessions.adoptKimiNativeSession({
      workspaceId: wsId,
      cwd: '/tmp/test-ws',
      nativeSessionId: 'native-live-replay-overlap',
    });
    await sessions.sendMessage(adopted.session.id, 'live question');
    const turn = db.prepare(
      'SELECT id, turn_number FROM turns WHERE session_id = ? ORDER BY turn_number DESC LIMIT 1',
    ).get(adopted.session.id) as { id: string; turn_number: number };
    assert.deepEqual(db.prepare(
      `SELECT turn_id, replay_owned
       FROM proxy_replay_turns
       WHERE session_id = ? AND provider_turn_id = ?`,
    ).get(adopted.session.id, turn.id), { turn_id: turn.id, replay_owned: 0 });
    const streamId = 'replay-live-overlap';
    const replay = [
      replayEvent({
        method: 'turn.started',
        eventId: 'overlap-start',
        replayStreamId: streamId,
        sequence: 1,
        sessionId: adopted.session.id,
        sourceTurnId: turn.id,
        emittedAt: '2026-08-10T01:00:00.000Z',
        data: {},
      }),
      replayEvent({
        method: 'input.recorded',
        eventId: 'overlap-input',
        replayStreamId: streamId,
        sequence: 2,
        sessionId: adopted.session.id,
        sourceTurnId: turn.id,
        emittedAt: '2026-08-10T01:00:00.100Z',
        data: {
          input: [{ type: 'text', text: 'live question' }],
        },
      }),
      replayEvent({
        method: 'content.completed',
        eventId: 'overlap-content',
        replayStreamId: streamId,
        sequence: 3,
        sessionId: adopted.session.id,
        sourceTurnId: turn.id,
        emittedAt: '2026-08-10T01:00:01.000Z',
        data: { contentId: 'overlap-answer', kind: 'text', content: 'live answer' },
      }),
      replayEvent({
        method: 'turn.completed',
        eventId: 'overlap-end',
        replayStreamId: streamId,
        sequence: 4,
        sessionId: adopted.session.id,
        sourceTurnId: turn.id,
        emittedAt: '2026-08-10T01:00:02.000Z',
        data: { stopReason: 'completed' },
      }),
    ];

    proxyMgr.client.replaySession = async () => ({ replayStreamId: streamId, events: replay });
    broadcaster.messages.length = 0;
    proxyMgr.client.fire({
        method: 'history.changed',
      params: {
        eventId: 'overlap-history-changed',
        streamId: 'attached-stream',
        sequence: 1,
        sessionId: adopted.session.id,
        emittedAt: '2026-08-10T01:00:03.000Z',
        data: { reason: 'native-history-changed' },
      },
    });

    await waitFor(() => (
      db.prepare('SELECT COUNT(*) AS count FROM proxy_replay_events WHERE session_id = ?')
        .get(adopted.session.id) as { count: number }
    ).count === 4);
    assert.equal(
      broadcaster.messages.filter(message => message.type === 'attention').length,
      0,
      'history refresh may rebuild transcript events but must not replay notifications',
    );
    const beforeLiveEvents = (db.prepare(
      'SELECT COUNT(*) AS count FROM events WHERE session_id = ?',
    ).get(adopted.session.id) as { count: number }).count;
    for (const event of [replay[0]!, replay[2]!, replay[3]!]) {
      proxyMgr.client.fire(liveFromReplay(event));
    }
    assert.equal((db.prepare(
      'SELECT COUNT(*) AS count FROM events WHERE session_id = ?',
    ).get(adopted.session.id) as { count: number }).count, beforeLiveEvents);
    assert.equal((db.prepare(
      'SELECT COUNT(*) AS count FROM turns WHERE session_id = ?',
    ).get(adopted.session.id) as { count: number }).count, 1);
    assert.equal(sessions.listEvents(adopted.session.id)
      .filter(event => event.event === 'user_message').length, 1);
    assert.equal(sessions.getSession(adopted.session.id).status, 'done');
    assert.equal(proxyMgr.client.forceKillCalls, 0);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('protocol v1 native-history refresh retries a transient replay failure', async () => {
  const { dir, db, wsId, proxyMgr, sessions } = setupKimi();
  try {
    const adopted = await sessions.adoptKimiNativeSession({
      workspaceId: wsId,
      cwd: '/tmp/test-ws',
      nativeSessionId: 'native-transient-replay',
    });
    const streamId = 'replay-transient';
    const events = [
      replayEvent({
        method: 'turn.started',
        eventId: 'transient-start',
        replayStreamId: streamId,
        sequence: 1,
        sessionId: adopted.session.id,
        sourceTurnId: 'transient-turn',
        emittedAt: '2026-08-10T01:00:00.000Z',
        data: {},
      }),
      replayEvent({
        method: 'turn.completed',
        eventId: 'transient-end',
        replayStreamId: streamId,
        sequence: 2,
        sessionId: adopted.session.id,
        sourceTurnId: 'transient-turn',
        emittedAt: '2026-08-10T01:00:01.000Z',
        data: { stopReason: 'completed' },
      }),
    ];
    let replayCalls = 0;
    proxyMgr.client.replaySession = async () => {
      replayCalls += 1;
      if (replayCalls === 1) throw new Error('temporary replay timeout');
      return { replayStreamId: streamId, events };
    };

    proxyMgr.client.fire({
        method: 'history.changed',
      params: {
        eventId: 'transient-history-changed',
        streamId: 'attached-stream',
        sequence: 1,
        sessionId: adopted.session.id,
        emittedAt: '2026-08-10T01:00:02.000Z',
        data: { reason: 'native-history-changed' },
      },
    });

    await waitFor(() => replayCalls === 2);
    await waitFor(() => (
      db.prepare('SELECT COUNT(*) AS count FROM proxy_replay_events WHERE session_id = ?')
        .get(adopted.session.id) as { count: number }
    ).count === 2);
    assert.equal(proxyMgr.client.forceKillCalls, 0);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('protocol v1 native-history refresh persists new replay eventIds exactly once', async () => {
  const { dir, db, wsId, proxyMgr, broadcaster, sessions } = setupKimi();
  try {
    const adopted = await sessions.adoptKimiNativeSession({
      workspaceId: wsId,
      cwd: '/tmp/test-ws',
      nativeSessionId: 'native-protocol-history',
    });
    broadcaster.messages.length = 0;
    let streamId = 'replay-native-protocol-history';
    const replayTurn = (turnId: string, startSequence: number) => [
      replayEvent({
        method: 'turn.started',
        eventId: `start-${turnId}`,
        replayStreamId: streamId,
        sequence: startSequence,
        sessionId: adopted.session.id,
        sourceTurnId: turnId,
        emittedAt: '2026-08-10T01:00:00.000Z',
        data: {},
      }),
      replayEvent({
        method: 'input.recorded',
        eventId: `input-${turnId}`,
        replayStreamId: streamId,
        sequence: startSequence + 1,
        sessionId: adopted.session.id,
        sourceTurnId: turnId,
        emittedAt: '2026-08-10T01:00:00.000Z',
        data: {
          input: [{ type: 'text', text: `question ${turnId}` }],
        },
      }),
      replayEvent({
        method: 'content.completed',
        eventId: `content-${turnId}`,
        replayStreamId: streamId,
        sequence: startSequence + 2,
        sessionId: adopted.session.id,
        sourceTurnId: turnId,
        emittedAt: '2026-08-10T01:00:01.000Z',
        data: { contentId: `content-${turnId}`, kind: 'text', content: 'answer' },
      }),
      replayEvent({
        method: 'turn.completed',
        eventId: `end-${turnId}`,
        replayStreamId: streamId,
        sequence: startSequence + 3,
        sessionId: adopted.session.id,
        sourceTurnId: turnId,
        emittedAt: '2026-08-10T01:00:02.000Z',
        data: { stopReason: 'completed' },
      }),
    ];
    let replay = replayTurn('external-1', 1);
    let releaseFirstReplay!: () => void;
    const firstReplayGate = new Promise<void>(resolve => { releaseFirstReplay = resolve; });
    let replayCalls = 0;
    proxyMgr.client.replaySession = async () => {
      replayCalls += 1;
      if (replayCalls === 1) await firstReplayGate;
      return { replayStreamId: streamId, events: replay };
    };
    const historyChanged = () => proxyMgr.client.fire({
        method: 'history.changed',
      params: {
        eventId: randomUUID(),
        streamId: 'attached-stream',
        sequence: 1,
        sessionId: adopted.session.id,
        emittedAt: new Date().toISOString(),
        data: { reason: 'native-history-changed' },
      },
    });

    historyChanged();
    await waitFor(() => replayCalls === 1);
    historyChanged();
    releaseFirstReplay();
    await waitFor(() => replayCalls === 2);
    await waitFor(() => (
      db.prepare('SELECT COUNT(*) AS count FROM proxy_replay_events')
        .get() as { count: number }
    ).count === 4);
    historyChanged();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal((
      db.prepare('SELECT COUNT(*) AS count FROM proxy_replay_events')
        .get() as { count: number }
    ).count, 4);
    assert.equal((
      db.prepare('SELECT COUNT(*) AS count FROM proxy_replay_turns')
        .get() as { count: number }
    ).count, 1);
    assert.equal(
      broadcaster.messages.filter(message => message.type === 'attention').length,
      1,
      'the first newly observed external replay turn notifies exactly once',
    );

    replay = [...replay, ...replayTurn('external-2', 5)];
    historyChanged();
    await waitFor(() => (
      db.prepare('SELECT COUNT(*) AS count FROM proxy_replay_events')
        .get() as { count: number }
    ).count === 8);
    assert.equal((
      db.prepare('SELECT COUNT(*) AS count FROM proxy_replay_turns')
        .get() as { count: number }
    ).count, 2);
    assert.equal(
      broadcaster.messages.filter(message => message.type === 'attention').length,
      2,
      'a second external replay tail adds one notification without replaying the first',
    );

    streamId = 'replay-native-protocol-history-rewritten';
    replay = replayTurn('external-rewritten', 1);
    historyChanged();
    await waitFor(() => (
      db.prepare('SELECT COUNT(*) AS count FROM proxy_replay_events')
        .get() as { count: number }
    ).count === 4);
    assert.equal((
      db.prepare('SELECT COUNT(*) AS count FROM proxy_replay_turns')
        .get() as { count: number }
    ).count, 1);
    assert.equal((
      db.prepare('SELECT COUNT(*) AS count FROM turns')
        .get() as { count: number }
    ).count, 1);
    assert.equal(
      broadcaster.messages.filter(message => message.type === 'attention').length,
      2,
      'a stream-revision transcript rebuild is historical and stays silent',
    );

    const conflicting = replayEvent({
      ...replay[2]!,
      data: { contentId: 'content-external-rewritten', kind: 'text', content: 'changed' },
    });
    replay = [...replayTurn('external-3', 1), conflicting];
    historyChanged();
    await waitFor(() => proxyMgr.client.forceKillCalls === 1);
    assert.equal((
      db.prepare('SELECT COUNT(*) AS count FROM proxy_replay_events')
        .get() as { count: number }
    ).count, 4, 'a conflicting replay rolls back earlier events in the same refresh');
    assert.equal((
      db.prepare('SELECT COUNT(*) AS count FROM proxy_replay_turns')
        .get() as { count: number }
    ).count, 1, 'a conflicting replay also rolls back its newly allocated turn');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Kimi adoption replaces replayed tool snapshots instead of amplifying history', async () => {
  const { dir, db, wsId, proxyMgr, sessions } = setupKimi(undefined, true);
  proxyMgr.client.replayEvents = [
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
    const attentions = broadcaster.messages.filter(
      (message): message is Extract<ServerToClientMessage, { type: 'attention' }> =>
        message.type === 'attention',
    );
    assert.deepEqual(attentions.map(message => message.kind), ['turn-completed']);
    assert.equal(attentions[0]?.session_id, session.id);
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
    assert.deepEqual(
      broadcaster.messages
        .filter((message): message is Extract<ServerToClientMessage, { type: 'attention' }> => (
          message.type === 'attention'
        ))
        .map(message => message.kind),
      ['error'],
    );
    assert.equal(sessions.getSession(session.id).status, 'error');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('duplicate legacy approval events emit one attention signal', async () => {
  const { dir, db, wsId, sessions, proxyMgr, broadcaster } = setup();
  try {
    const session = await sessions.createSession({
      workspace_id: wsId,
      executor: 'claude',
      approval_mode: 'ask',
    });
    await sessions.sendMessage(session.id, 'request permission');
    broadcaster.messages.length = 0;
    const notification: ProxyNotification = {
      method: 'approval.requested',
      params: {
        sessionId: 'proxy_x',
        data: {
          approvalId: 'same-approval',
          toolName: 'Bash',
          risk: 'high',
          inputPreview: JSON.stringify({
            command: 'pnpm test',
            description: 'Run the project checks.',
          }),
        },
      },
    };

    proxyMgr.client.fire(notification);
    proxyMgr.client.fire(notification);

    assert.equal(
      broadcaster.messages.filter(message => (
        message.type === 'event' && message.display?.type === 'interaction.approval'
      )).length,
      2,
      'legacy providers may repeat the transcript event itself',
    );
    const attentions = broadcaster.messages.filter(
      (message): message is Extract<ServerToClientMessage, { type: 'attention' }> =>
        message.type === 'attention',
    );
    assert.equal(attentions.length, 1, 'bounded identity de-duplication suppresses the repeat');
    assert.match(attentions[0]?.id ?? '', /^gian:attention:[A-Za-z0-9_-]{43}$/u);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('auto-approved requests do not emit attention', async () => {
  const { dir, db, wsId, sessions, proxyMgr, broadcaster } = setup();
  try {
    const session = await sessions.createSession({
      workspace_id: wsId,
      executor: 'claude',
      approval_mode: 'ask',
    });
    await sessions.sendMessage(session.id, 'run a safe command');
    broadcaster.messages.length = 0;

    proxyMgr.client.fire({
      method: 'approval.requested',
      params: {
        sessionId: 'proxy_x',
        data: {
          approvalId: 'auto-approved-request',
          toolName: 'Bash',
          risk: 'low',
          inputPreview: JSON.stringify({
            command: 'pwd',
            description: 'Inspect the current directory.',
          }),
        },
      },
    });

    await waitFor(() => broadcaster.messages.some(message => (
      message.type === 'approval:created'
      && message.approval.id === 'auto-approved-request'
      && message.approval.status === 'auto-approved'
    )));
    assert.equal(
      broadcaster.messages.filter(message => message.type === 'attention').length,
      0,
      'attention is emitted only after ApprovalManager confirms pending state',
    );
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

test('a session-scoped protocol fault persists an error terminal before quarantining the Proxy', async () => {
  const { dir, db, wsId, sessions, proxyMgr, broadcaster } = setup();
  try {
    const session = await sessions.createSession({ workspace_id: wsId, executor: 'codex' });
    await sessions.sendMessage(session.id, 'trigger protocol fault');

    proxyMgr.client.fireFault(new Error('Notification sequence gap'));

    const turn = db.prepare(
      'SELECT status, completed_at FROM turns WHERE session_id = ?',
    ).get(session.id) as { status: string; completed_at: string | null };
    assert.equal(turn.status, 'error');
    assert.ok(turn.completed_at);
    assert.equal(sessions.getSession(session.id).status, 'error');
    assert.ok(broadcaster.messages.some(message => (
      message.type === 'session:updated'
      && message.session.id === session.id
      && message.session.status === 'error'
    )));
    const events = sessions.listEvents(session.id);
    assert.equal(events.filter(event => event.display?.type === 'state.error').length, 1);
    assert.equal(events.filter(event => event.display?.type === 'state.turn-completed').length, 1);
    assert.equal(proxyMgr.client.faultHandlers.length, 0, 'quarantine detaches the faulted session');
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

test('user-initiated stop waits for the authoritative terminal event', async () => {
  const { dir, db, wsId, sessions, proxyMgr, broadcaster } = setup();
  try {
    const session = await sessions.createSession({ workspace_id: wsId, executor: 'claude' });
    proxyMgr.client.echoHostTurnId = true;
    await sessions.sendMessage(session.id, 'ping'); // opens an active turn
    const client = proxyMgr.client;
    const activeTurnId = client.startTurnCalls.at(-1)!.turnId;
    sessions.enqueueMessage(session.id, 'must remain queued');
    broadcaster.messages.length = 0;
    await sessions.stopTurn(session.id);

    let row = db.prepare('SELECT status, unread FROM sessions WHERE id = ?').get(session.id) as { status: string; unread: number };
    assert.equal(row.status, 'running');
    assert.equal(row.unread, 0);
    let completions = sessions.listEvents(session.id)
      .filter(event => event.display?.type === 'state.turn-completed');
    assert.equal(completions.length, 0);
    assert.equal(
      broadcaster.messages.filter(message => message.type === 'attention').length,
      0,
      'a user-initiated stop does not produce completion attention',
    );
    assert.equal(proxyMgr.client.startTurnCalls.length, 1, 'local stop must not auto-send queued work');
    assert.equal(sessions.getQueueLength(session.id), 1);
    assert.equal(client.notificationHandlers.length, 1, 'stop keeps exactly one live notification binding');
    assert.equal(client.exitHandlers.length, 1, 'stop keeps exactly one live exit binding');

    client.fire(liveNotification({
      method: 'turn.completed',
      params: {
        eventId: 'turn-interrupted-1',
        sessionId: session.id,
        turnId: activeTurnId,
        emittedAt: '2026-08-18T00:00:02.000Z',
        data: { stopReason: 'interrupted' },
      },
    }));
    row = db.prepare('SELECT status, unread FROM sessions WHERE id = ?').get(session.id) as { status: string; unread: number };
    assert.equal(row.status, 'done');
    assert.equal(row.unread, 0, 'a turn the user stopped themselves is not unread');
    completions = sessions.listEvents(session.id)
      .filter(event => event.display?.type === 'state.turn-completed');
    assert.equal(completions.length, 1);
    assert.equal(completions[0]?.event, 'turn.completed');

    await sessions.sendMessage(session.id, 'after stop');
    const nextTurnId = client.startTurnCalls.at(-1)!.turnId;
    broadcaster.messages.length = 0;
    client.fire({
      method: 'output.text',
      params: {
        sessionId: 'proxy_x',
        turnId: nextTurnId,
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

test('provider completion emitted inside interrupt settles stopped without attention or queue drain', async () => {
  const { dir, db, wsId, sessions, proxyMgr, broadcaster } = setup();
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
    assert.equal(
      broadcaster.messages.filter(message => message.type === 'attention').length,
      0,
      'a synchronous provider completion cannot outrun the Stop attention boundary',
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('provider failure emitted inside interrupt settles stopped without error attention', async () => {
  const { dir, db, wsId, sessions, proxyMgr, broadcaster } = setup();
  try {
    const session = await sessions.createSession({ workspace_id: wsId, executor: 'claude' });
    proxyMgr.client.startTurnIds.push('stop-failure-race-turn');
    await sessions.sendMessage(session.id, 'ping');
    broadcaster.messages.length = 0;
    proxyMgr.client.notificationDuringInterrupt = {
      method: 'turn.failed',
      params: {
        sessionId: 'proxy_x',
        turnId: 'stop-failure-race-turn',
        data: { message: 'interrupted by user' },
      },
    };

    await sessions.stopTurn(session.id);

    const turn = db.prepare(
      'SELECT status FROM turns WHERE session_id = ?',
    ).get(session.id) as { status: string };
    assert.equal(turn.status, 'stopped');
    assert.equal(sessions.getSession(session.id).status, 'done');
    assert.equal(sessions.getSession(session.id).unread, 0);
    assert.equal(
      broadcaster.messages.filter(message => message.type === 'attention').length,
      0,
      'a synchronous provider failure cannot outrun the Stop attention boundary',
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
    proxyMgr.client.fire({
      method: 'turn.completed',
      params: {
        sessionId: 'proxy_x',
        turnId: 'old-provider-turn',
        data: { status: 'completed' },
      },
    });

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

test('terminal completion flushes the final pending snapshot before the fold boundary', async () => {
  const { dir, db, wsId, sessions, proxyMgr } = setup(undefined, true);
  try {
    const session = await sessions.createSession({ workspace_id: wsId, executor: 'codex' });
    proxyMgr.client.echoHostTurnId = true;
    await sessions.sendMessage(session.id, 'change it');
    const activeTurnId = proxyMgr.client.startTurnCalls.at(-1)!.turnId;
    for (const revision of ['old', 'final']) {
      proxyMgr.client.fire({
        method: 'diff.updated',
        params: {
          sessionId: 'proxy_x',
          turnId: activeTurnId,
          data: { diff: revision },
        },
      });
    }
    await sessions.stopTurn(session.id);
    proxyMgr.client.fire({
      method: 'turn.completed',
      params: {
        sessionId: 'proxy_x',
        turnId: activeTurnId,
        data: { status: 'completed' },
      },
    });

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

test('forceRecover waits for proxy cleanup before reporting recovery complete', async () => {
  const { dir, db, wsId, sessions, proxyMgr } = setup();
  try {
    const session = await sessions.createSession({ workspace_id: wsId, executor: 'codex' });
    let releaseCleanup!: () => void;
    proxyMgr.forceDisposeGate = new Promise<void>(resolve => {
      releaseCleanup = resolve;
    });

    let recovered = false;
    const recovery = sessions.forceRecover(session.id).then(() => {
      recovered = true;
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(recovered, false, 'recovery acknowledgement must wait for native cleanup');

    releaseCleanup();
    await recovery;
    assert.equal(recovered, true);
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
      proxyMgr.client.lastCreateParams!.nativeSessionId,
      originalNativeId,
      'createSession passed persisted native_session_id for adoption',
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
