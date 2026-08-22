import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type {
  Executor,
  ProxyNotification,
  ServerToClientMessage,
} from '@gian/shared';
import { ApprovalManager } from '../src/approval/index.js';
import type { ProxyManager } from '../src/proxy/manager.js';
import type {
  CreateSessionParams,
  NotificationHandler,
  ProxyClient,
  StartTurnParams,
} from '../src/proxy/types.js';
import { QueueManager } from '../src/queue/index.js';
import { SessionManager } from '../src/session/manager.js';
import { openDatabase, type Db } from '../src/storage/db.js';
import type { WsBroadcaster } from '../src/web/ws-broadcast.js';

class RecordingProxyClient implements ProxyClient {
  readonly createCalls: CreateSessionParams[] = [];
  readonly startTurnCalls: StartTurnParams[] = [];
  readonly setNameCalls: string[] = [];
  private readonly notificationHandlers: NotificationHandler[] = [];
  private bound = false;

  constructor(
    readonly executor: Executor,
    private readonly key: string,
    private readonly createGate?: Promise<void>,
  ) {}

  isExited() { return false; }

  async initialize() {
    return {
      protocol: { name: 'gian.proxy' as const, version: '2.0' as const },
      plugin: { id: this.executor, name: this.executor, version: '0.2.0' },
      process: { scope: this.executor === 'codex' ? 'shared' as const : 'session' as const },
      capabilities: { 'session.rename': 1 },
    };
  }

  async catalog() {
    return { catalogRevision: 'test', input: [{ type: 'text' as const }], configOptions: [], slashCommands: [] };
  }

  async createSession(params: CreateSessionParams) {
    this.createCalls.push(params);
    await this.createGate;
    this.bound = true;
    const nativeSessionId = params.nativeSessionId
      ?? (this.executor === 'claude' ? `claude-native-${this.key}` : `codex-native-${this.key}`);
    return {
      session: {
        id: `proxy-${this.key}`,
        cwd: params.cwd,
        state: 'idle' as const,
        createdAt: '2026-08-08T00:00:00.000Z',
        updatedAt: '2026-08-08T00:00:00.000Z',
        lastError: null,
      },
      nativeSessionId,
    };
  }

  async startTurn(params: StartTurnParams) {
    this.startTurnCalls.push(params);
    return {
      session: {
        id: `proxy-${this.key}`,
        cwd: '/workspace',
        state: 'running' as const,
        createdAt: '2026-08-08T00:00:00.000Z',
        updatedAt: '2026-08-08T00:00:00.000Z',
        lastError: null,
      },
      turn: { id: 'turn-provider' },
    };
  }

  async setName(name: string) {
    if (!this.bound) return;
    this.setNameCalls.push(name);
  }

  async interruptTurn() {}
  async respondInteraction() {}
  async closeSession() {}
  async shutdown() {}
  forceKill() {}

  onNotification(handler: NotificationHandler) {
    this.notificationHandlers.push(handler);
    return () => {};
  }

  onExit() {
    return () => {};
  }

  fire(notification: ProxyNotification) {
    for (const handler of this.notificationHandlers) handler(notification);
  }
}

class RecordingProxyManager {
  readonly clients = new Map<string, RecordingProxyClient>();

  constructor(
    private readonly createGate?: Promise<void>,
  ) {}

  async getOrCreate(key: string, executor: Executor): Promise<ProxyClient> {
    let client = this.clients.get(key);
    if (!client) {
      client = new RecordingProxyClient(executor, key, this.createGate);
      this.clients.set(key, client);
    }
    return client;
  }

  get(key: string): ProxyClient | undefined {
    return this.clients.get(key);
  }

  async dispose(key: string) {
    this.clients.delete(key);
  }

  client(key: string): RecordingProxyClient {
    const client = this.clients.get(key);
    assert.ok(client, `missing fake proxy client for ${key}`);
    return client;
  }
}

class NoopBroadcaster {
  add() {}
  remove() {}
  send() {}
  broadcast(_message: ServerToClientMessage) {}
  get size() { return 0; }
}

function makeManager(db: Db, dir: string, proxies: RecordingProxyManager) {
  const broadcaster = new NoopBroadcaster();
  const approvals = new ApprovalManager(broadcaster as unknown as WsBroadcaster);
  const sessions = new SessionManager(
    db,
    proxies as unknown as ProxyManager,
    broadcaster as unknown as WsBroadcaster,
    approvals,
    new QueueManager(db),
    dir,
  );
  approvals.setRespondFn((sessionId, approvalId, decision) =>
    sessions.respondApproval(sessionId, approvalId, decision));
  approvals.setGetModeFn(sessionId => sessions.getSession(sessionId).approval_mode);
  return sessions;
}

function seedWorkspace(db: Db, path: string): string {
  const workspaceId = randomUUID();
  db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)')
    .run(workspaceId, 'Provider fixture', path);
  return workspaceId;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test('SESSION-NAME-001: Claude first turn carries the latest Gian name and rename appends JSONL title', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gian-session-name-claude-'));
  const workspacePath = join(dir, 'workspace');
  const previousHome = process.env.HOME;
  process.env.HOME = join(dir, 'home');
  mkdirSync(workspacePath, { recursive: true });
  const db = openDatabase(dir);
  const proxies = new RecordingProxyManager();
  const sessions = makeManager(db, dir, proxies);
  try {
    const workspaceId = seedWorkspace(db, workspacePath);
    const session = await sessions.createSession({
      workspace_id: workspaceId,
      executor: 'claude',
      name: 'Initial Claude',
    });
    const client = proxies.client(session.id);
    assert.equal(client.startTurnCalls.length, 0, 'session creation must not spend a Claude turn');

    sessions.renameSession(session.id, '  Latest\nClaude  ');
    await waitFor(() => client.setNameCalls.includes('Latest\nClaude'));
    await sessions.sendMessage(session.id, 'first turn');
    assert.equal(client.startTurnCalls.length, 1);
    assert.deepEqual(client.setNameCalls, ['Initial Claude', 'Latest\nClaude']);

    sessions.renameSession(session.id, 'Renamed\tClaude');
    await waitFor(() => client.setNameCalls.includes('Renamed\tClaude'));

    const beforeBlank = client.setNameCalls.slice();
    sessions.renameSession(session.id, '   ');
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(client.setNameCalls, beforeBlank, 'blank names never clear native titles');
  } finally {
    db.close();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SESSION-NAME-001: Claude gian.proxy/2 delegates native naming to the plugin', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gian-session-name-claude-v2-'));
  const workspacePath = join(dir, 'workspace');
  mkdirSync(workspacePath, { recursive: true });
  const db = openDatabase(dir);
  const proxies = new RecordingProxyManager();
  const sessions = makeManager(db, dir, proxies);
  try {
    const workspaceId = seedWorkspace(db, workspacePath);
    const session = await sessions.createSession({
      workspace_id: workspaceId,
      executor: 'claude',
      name: 'Claude Initial',
    });
    const client = proxies.client(session.id);
    assert.deepEqual(client.setNameCalls, ['Claude Initial']);

    sessions.renameSession(session.id, 'Claude Renamed');
    await waitFor(() => client.setNameCalls.length === 2);
    assert.deepEqual(client.setNameCalls, ['Claude Initial', 'Claude Renamed']);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SESSION-NAME-001: Codex create, active rename, and rehydrate all route through setName', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gian-session-name-codex-'));
  const workspacePath = join(dir, 'workspace');
  mkdirSync(workspacePath, { recursive: true });
  let db = openDatabase(dir);
  let sessionId = '';
  try {
    const workspaceId = seedWorkspace(db, workspacePath);
    const firstProxies = new RecordingProxyManager();
    const firstManager = makeManager(db, dir, firstProxies);
    const session = await firstManager.createSession({
      workspace_id: workspaceId,
      executor: 'codex',
      name: '  Codex Initial  ',
    });
    sessionId = session.id;
    const liveClient = firstProxies.client(session.id);
    assert.deepEqual(liveClient.setNameCalls, ['Codex Initial']);

    firstManager.renameSession(session.id, '   ');
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(liveClient.setNameCalls, ['Codex Initial']);

    firstManager.renameSession(session.id, 'Codex Active');
    await waitFor(() => liveClient.setNameCalls.length === 2);
    assert.deepEqual(liveClient.setNameCalls, ['Codex Initial', 'Codex Active']);

    db.close();
    db = openDatabase(dir);
    const resumedProxies = new RecordingProxyManager();
    const resumedManager = makeManager(db, dir, resumedProxies);
    await resumedManager.listSessionSlashCommands(session.id);
    const resumedClient = resumedProxies.client(session.id);
    assert.equal(resumedClient.createCalls[0]!.nativeSessionId, session.native_session_id);
    assert.deepEqual(resumedClient.setNameCalls, ['Codex Active']);
  } finally {
    try { db.close(); } catch { /* already closed between host generations */ }
    rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(sessionId);
});

test('SESSION-NAME-001: Codex rehydrate applies a rename that lands during native adoption', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gian-session-name-codex-race-'));
  const workspacePath = join(dir, 'workspace');
  mkdirSync(workspacePath, { recursive: true });
  const db = openDatabase(dir);
  let releaseCreate: (() => void) | undefined;
  let releaseClear: (() => void) | undefined;
  const createGate = new Promise<void>((resolve) => { releaseCreate = resolve; });
  try {
    const workspaceId = seedWorkspace(db, workspacePath);
    const initialManager = makeManager(db, dir, new RecordingProxyManager());
    const session = await initialManager.createSession({
      workspace_id: workspaceId,
      executor: 'codex',
      name: 'Codex Before Rehydrate',
    });

    const resumedProxies = new RecordingProxyManager(createGate);
    const resumedManager = makeManager(db, dir, resumedProxies);
    const rehydrate = resumedManager.listSessionSlashCommands(session.id);
    await waitFor(() => resumedProxies.clients.get(session.id)?.createCalls.length === 1);

    resumedManager.renameSession(session.id, 'Codex Renamed In Flight');
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(
      resumedProxies.client(session.id).setNameCalls,
      [],
      'the unbound facade cannot apply the concurrent rename yet',
    );

    releaseCreate();
    await rehydrate;
    assert.deepEqual(resumedProxies.client(session.id).setNameCalls, ['Codex Renamed In Flight']);

    const clearGate = new Promise<void>((resolve) => { releaseClear = resolve; });
    const clearedProxies = new RecordingProxyManager(clearGate);
    const clearedManager = makeManager(db, dir, clearedProxies);
    const clearRehydrate = clearedManager.listSessionSlashCommands(session.id);
    await waitFor(() => clearedProxies.clients.get(session.id)?.createCalls.length === 1);

    clearedManager.renameSession(session.id, '   ');
    await new Promise(resolve => setTimeout(resolve, 0));
    releaseClear();
    await clearRehydrate;
    assert.deepEqual(
      clearedProxies.client(session.id).setNameCalls,
      [],
      'an authoritative cleared DB name must not resurrect the stale captured name',
    );
  } finally {
    releaseCreate?.();
    releaseClear?.();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
