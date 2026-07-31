import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  ExecutorConfigState,
  NativeConfigOption,
  NativeConfigValue,
  ProxyNotification,
  ServerToClientMessage,
} from '@gian/shared';
import { openDatabase } from '../src/storage/db.js';
import { SessionManager } from '../src/session/manager.js';
import type { ProxyManager } from '../src/proxy/manager.js';
import type { ProxyClient, NotificationHandler } from '../src/proxy/types.js';
import type { WsBroadcaster } from '../src/web/ws-broadcast.js';
import { ApprovalManager } from '../src/approval/index.js';
import { QueueManager } from '../src/queue/index.js';
import { writeAttachment } from '../src/storage/attachments.js';

class StubProxyClient implements ProxyClient {
  readonly executor = 'claude' as const;
  notificationHandlers: NotificationHandler[] = [];

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
    forkFromClaudeSessionId?: string;
    threadId?: string;
  } | null = null;

  async createSession(params: {
    cwd: string;
    claudeSessionId?: string;
    forkFromClaudeSessionId?: string;
    threadId?: string;
  }) {
    this.lastCreateParams = params;
    if (this.failNextCreate) {
      const err = this.failNextCreate;
      this.failNextCreate = null;
      throw err;
    }
    // Mirror cc-proxy: re-use the supplied claudeSessionId on adoption,
    // otherwise mint a fresh native id. The proxy's own `id` mirrors the
    // native id so a single value flows through both sides.
    const nativeSessionId = params.claudeSessionId ?? `cc_${randomUUID()}`;
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
  async interruptTurn() { /* no-op */ }
  async respondApproval() { /* no-op */ }
  async startTurn() {
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
      turn: { id: 'proxy_turn' },
    };
  }
  async closeSession() { /* no-op */ }
  async shutdown() { /* no-op */ }
  forceKill() { /* no-op */ }

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
  client = new StubProxyClient();
  async getOrCreate(): Promise<ProxyClient> {
    return this.client;
  }
  get(): ProxyClient {
    return this.client;
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
      models: [] as [],
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
  async getOrCreate(): Promise<ProxyClient> {
    return this.client;
  }
  get(): ProxyClient {
    return this.client;
  }
  async dispose(sessionId: string): Promise<void> {
    this.disposeCalls.push(sessionId);
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

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'gian-sm-test-'));
  const db = openDatabase(dir);

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
  );
  approvals.setRespondFn((sid, aid, dec) => sessions.respondApproval(sid, aid, dec));
  approvals.setGetModeFn(sid => sessions.getSession(sid).approval_mode);

  return { dir, db, wsId, proxyMgr, broadcaster, sessions };
}

function setupKimi() {
  const dir = mkdtempSync(join(tmpdir(), 'gian-sm-kimi-test-'));
  const db = openDatabase(dir);
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
  );
  approvals.setRespondFn((sid, aid, dec) => sessions.respondApproval(sid, aid, dec));
  approvals.setGetModeFn(sid => sessions.getSession(sid).approval_mode);
  return { dir, db, wsId, proxyMgr, broadcaster, sessions };
}

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
  const { dir, db, wsId, proxyMgr, sessions } = setupKimi();
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
    assert.deepEqual(adopted.replay, { turns: 2, events: 4 });

    const events = sessions.listEvents(adopted.session.id);
    assert.deepEqual(
      events.filter(event => event.event === 'user_message').map(event => event.data.text),
      ['hello', 'second'],
    );
    const assistantIds = events
      .filter(event => event.event === 'assistant_text')
      .map(event => event.data.itemId);
    assert.equal(new Set(assistantIds).size, 2);
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

test('sidechat creation forwards the Claude parent and persists a pending fork', async () => {
  const { dir, db, wsId, proxyMgr, sessions } = setup();
  try {
    const parent = {
      id: randomUUID(),
      native_session_id: 'claude-parent-1',
    };
    db.prepare(
      `INSERT INTO sessions
        (id, workspace_id, executor, native_session_id, worktree_path)
       VALUES (?, ?, 'claude', ?, ?)`,
    ).run(parent.id, wsId, parent.native_session_id, '/tmp/parent-worktree');

    const child = await sessions.createSession({
      workspace_id: wsId,
      executor: 'claude',
      name: 'side question',
      fork_from: parent.id,
    });

    assert.equal(proxyMgr.client.lastCreateParams?.cwd, '/tmp/parent-worktree');
    assert.equal(
      proxyMgr.client.lastCreateParams?.forkFromClaudeSessionId,
      parent.native_session_id,
    );
    const pending = db
      .prepare('SELECT fork_from_session_id FROM sessions WHERE id = ?')
      .get(child.id) as { fork_from_session_id: string | null };
    assert.equal(pending.fork_from_session_id, parent.id);

    proxyMgr.client.fire({
      method: 'session.rotated',
      params: {
        sessionId: child.id,
        data: {
          oldNativeSessionId: child.native_session_id,
          newNativeSessionId: 'claude-sidechat-1',
        },
      },
    });
    const adopted = db
      .prepare(
        'SELECT native_session_id, fork_from_session_id FROM sessions WHERE id = ?',
      )
      .get(child.id) as {
        native_session_id: string;
        fork_from_session_id: string | null;
      };
    assert.equal(adopted.native_session_id, 'claude-sidechat-1');
    assert.equal(adopted.fork_from_session_id, null);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unstarted sidechat restores its pending fork after host restart', async () => {
  const first = setup();
  let parentNativeId: string;
  let childId: string;
  try {
    const parent = await first.sessions.createSession({
      workspace_id: first.wsId,
      executor: 'claude',
    });
    parentNativeId = parent.native_session_id!;
    first.db.prepare('UPDATE sessions SET worktree_path = ? WHERE id = ?')
      .run('/tmp/restart-parent-worktree', parent.id);
    const child = await first.sessions.createSession({
      workspace_id: first.wsId,
      executor: 'claude',
      fork_from: parent.id,
    });
    childId = child.id;
  } finally {
    first.db.close();
  }

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
    await sessions.listSessionSlashCommands(childId);
    assert.equal(proxyMgr.client.lastCreateParams?.cwd, '/tmp/restart-parent-worktree');
    assert.equal(
      proxyMgr.client.lastCreateParams?.forkFromClaudeSessionId,
      parentNativeId,
    );
    assert.equal(proxyMgr.client.lastCreateParams?.claudeSessionId, undefined);
  } finally {
    db.close();
    rmSync(first.dir, { recursive: true, force: true });
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

    const events = db.prepare('SELECT type, data FROM events WHERE session_id = ?').all(session.id) as Array<{
      type: string;
      data: string;
    }>;
    const userMsg = events.find(e => e.type === 'user_message');
    assert.ok(userMsg, 'user_message event persisted');
    assert.equal(JSON.parse(userMsg!.data).text, 'hello world');

    const sessionRow = db.prepare('SELECT status FROM sessions WHERE id = ?').get(session.id) as { status: string };
    assert.equal(sessionRow.status, 'running');

    const userEvents = broadcaster.messages.filter(
      m => m.type === 'event' && (m as { event: string }).event === 'user_message',
    );
    assert.equal(userEvents.length, 1);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
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
    // Both output.text and turn.completed are covered by the cc normalizer
    // and persisted under unified type names: assistant_text + turn_completed.
    assert.ok(types.includes('assistant_text'));
    assert.ok(types.includes('turn_completed'));

    const sessionRow = db.prepare('SELECT status, unread FROM sessions WHERE id = ?').get(session.id) as { status: string; unread: number };
    assert.equal(sessionRow.status, 'done');
    // A naturally-completed turn marks the session unread (the sidebar dot).
    assert.equal(sessionRow.unread, 1, 'turn.completed marks the session unread');

    const turnRow = db.prepare('SELECT status, completed_at FROM turns WHERE session_id = ?').get(session.id) as { status: string; completed_at: string | null };
    assert.equal(turnRow.status, 'completed');
    assert.ok(turnRow.completed_at);

    const broadcastEvents = broadcaster.messages.filter(m => m.type === 'event') as Array<{ event: string }>;
    assert.ok(broadcastEvents.some(e => e.event === 'assistant_text'));
    assert.ok(broadcastEvents.some(e => e.event === 'turn_completed'));
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
  const { dir, db, wsId, sessions } = setup();
  try {
    const session = await sessions.createSession({ workspace_id: wsId, executor: 'claude' });
    await sessions.sendMessage(session.id, 'ping'); // opens an active turn
    await sessions.stopTurn(session.id);            // → completeTurn('stopped')

    const row = db.prepare('SELECT status, unread FROM sessions WHERE id = ?').get(session.id) as { status: string; unread: number };
    assert.equal(row.status, 'done');
    assert.equal(row.unread, 0, 'a turn the user stopped themselves is not unread');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

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
    assert.deepEqual(types, ['user_message', 'assistant_text', 'turn_completed']);
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
    await sessions.sendMessage(sessionId, 'after restart');

    // Adoption: createSession was called with the persisted claudeSessionId.
    assert.ok(proxyMgr.client.lastCreateParams, 'createSession invoked on second host');
    assert.equal(
      proxyMgr.client.lastCreateParams!.claudeSessionId,
      originalNativeId,
      'createSession passed persisted native_session_id as claudeSessionId for adoption',
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
