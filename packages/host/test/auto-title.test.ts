import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type {
  Executor,
  ProxyNotification,
  ServerToClientMessage,
} from '@gian/shared';
import { ApprovalManager } from '../src/approval/index.js';
import { locateCcJsonl } from '../src/native/locate-jsonl.js';
import type { ProxyManager } from '../src/proxy/manager.js';
import type {
  CreateSessionParams,
  NotificationHandler,
  ProxyClient,
  StartTurnParams,
} from '../src/proxy/types.js';
import { QueueManager } from '../src/queue/index.js';
import {
  AutoTitleService,
  parseCcAiTitle,
  truncateFallbackTitle,
} from '../src/session/auto-title.js';
import { SessionHistoryStore } from '../src/session/history-store.js';
import { SessionManager } from '../src/session/manager.js';
import { SessionRepository } from '../src/session/repository.js';
import { openDatabase, type Db } from '../src/storage/db.js';
import type { WsBroadcaster } from '../src/web/ws-broadcast.js';

// Issue #57 — automatic session titles derived after completed turns.

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function seedWorkspace(db: Db, path: string): string {
  const workspaceId = randomUUID();
  db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)')
    .run(workspaceId, 'Auto-title fixture', path);
  return workspaceId;
}

function seedSession(
  db: Db,
  opts: {
    workspaceId: string;
    executor: Executor;
    nativeSessionId: string;
    name?: string | null;
  },
): string {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO sessions (id, name, workspace_id, executor, native_session_id)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, opts.name ?? null, opts.workspaceId, opts.executor, opts.nativeSessionId);
  return id;
}

function seedUserMessage(db: Db, sessionId: string, text: string): void {
  const now = new Date().toISOString();
  const turnId = randomUUID();
  db.prepare(
    `INSERT INTO turns (id, session_id, turn_number, status, created_at, completed_at)
     VALUES (?, ?, 1, 'completed', ?, ?)`,
  ).run(turnId, sessionId, now, now);
  new SessionHistoryStore(db).appendEvent(
    sessionId,
    turnId,
    randomUUID(),
    'user_message',
    { text },
  );
}

interface Fixture {
  dir: string;
  db: Db;
  workspaceId: string;
  cleanup: () => void;
}

function makeFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'gian-auto-title-'));
  const workspacePath = join(dir, 'workspace');
  mkdirSync(workspacePath, { recursive: true });
  const db = openDatabase(dir);
  const workspaceId = seedWorkspace(db, workspacePath);
  return {
    dir,
    db,
    workspaceId,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function makeService(
  db: Db,
  proxy: ProxyManager,
  rename: (sessionId: string, name: string) => void,
): AutoTitleService {
  return new AutoTitleService({
    db,
    sessions: new SessionRepository(db),
    history: new SessionHistoryStore(db),
    proxy,
    rename,
  });
}

class UnusedProxyManager {
  async getOrCreate(): Promise<never> {
    throw new Error('auto-title must not touch the proxy for this executor');
  }
  async dispose(): Promise<void> {}
}

class StubKimiProxyManager {
  listCalls = 0;
  disposeCalls = 0;
  pages: Array<{ sessions: unknown[]; nextCursor?: string }> = [];
  gate: Promise<void> | null = null;

  async getOrCreate(key: string, _executor: Executor): Promise<Partial<ProxyClient>> {
    assert.equal(key, '__native_sessions_kimi__');
    return {
      initialize: async () => ({ mode: 'spawn' as const, protocolVersion: 'test', methods: [] }),
      listNativeSessions: async () => {
        this.listCalls += 1;
        if (this.gate) await this.gate;
        return this.pages.shift() ?? { sessions: [] };
      },
    };
  }

  async dispose(): Promise<void> {
    this.disposeCalls += 1;
  }
}

test('parseCcAiTitle: last non-empty ai-title wins, malformed lines tolerated', () => {
  const jsonl = [
    '{"type":"user","message":{"content":"hi"}}',
    '{"type":"ai-title","aiTitle":"First Title","sessionId":"s"}',
    '{"type":"ai-title","aiTitle":"   ","sessionId":"s"}',
    '{"type":"ai-title","aiTitle":"Regenerated Title","sessionId":"s"}',
    '{"type":"ai-title","aiTitle":"","sessionId":"s"}',
    '{"type":"ai-title","aiTitle":"trailing junk',
    '',
  ].join('\n');
  assert.equal(parseCcAiTitle(jsonl), 'Regenerated Title');

  assert.equal(parseCcAiTitle('{"type":"user","message":{"content":"hi"}}\n'), null);
  assert.equal(parseCcAiTitle(''), null);
});

test('parseCcAiTitle sanitizes control characters like appendCcCustomTitle', () => {
  const jsonl = `${JSON.stringify({
    type: 'ai-title',
    aiTitle: '  a\nb\tc  ',
    sessionId: 's',
  })}\n`;
  assert.equal(parseCcAiTitle(jsonl), 'a b c');
});

test('truncateFallbackTitle collapses whitespace and ellipsizes at ~40 chars', () => {
  assert.equal(truncateFallbackTitle('  hello\n\t world  '), 'hello world');

  const long = truncateFallbackTitle(
    'fix the flaky login test and make the whole suite pass again',
  );
  assert.equal(long.length, 40);
  assert.ok(long.endsWith('…'));
  assert.equal(long, 'fix the flaky login test and make the w…');

  // The ellipsis replaces trailing partial words' whitespace cleanly.
  assert.ok(!long.endsWith(' …'));
});

test('claude: ai-title from the session JSONL becomes the name', async () => {
  const fixture = makeFixture();
  const previousHome = process.env.HOME;
  process.env.HOME = join(fixture.dir, 'home');
  try {
    const sessionId = seedSession(fixture.db, {
      workspaceId: fixture.workspaceId,
      executor: 'claude',
      nativeSessionId: 'native-claude-1',
    });
    const cwd = join(fixture.dir, 'workspace');
    const jsonl = locateCcJsonl('native-claude-1', cwd)!;
    mkdirSync(dirname(jsonl), { recursive: true });
    writeFileSync(
      jsonl,
      `${JSON.stringify({ type: 'ai-title', aiTitle: 'Fix login bug', sessionId: 'native-claude-1' })}\n`,
      'utf8',
    );

    const renamed: string[] = [];
    const service = makeService(
      fixture.db,
      new UnusedProxyManager() as unknown as ProxyManager,
      (_id, name) => renamed.push(name),
    );
    await service.maybeAutoTitle(sessionId);
    assert.deepEqual(renamed, ['Fix login bug']);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fixture.cleanup();
  }
});

test('claude: missing JSONL retries on later turns until the ai-title appears', async () => {
  const fixture = makeFixture();
  const previousHome = process.env.HOME;
  process.env.HOME = join(fixture.dir, 'home');
  try {
    const sessionId = seedSession(fixture.db, {
      workspaceId: fixture.workspaceId,
      executor: 'claude',
      nativeSessionId: 'native-claude-2',
    });
    const renamed: string[] = [];
    const service = makeService(
      fixture.db,
      new UnusedProxyManager() as unknown as ProxyManager,
      (_id, name) => renamed.push(name),
    );

    // Turn 1: Claude Code has not written the file / ai-title yet.
    await service.maybeAutoTitle(sessionId);
    assert.deepEqual(renamed, []);

    // Turn 2: the ai-title landed meanwhile → native title wins over fallback.
    const jsonl = locateCcJsonl('native-claude-2', join(fixture.dir, 'workspace'))!;
    mkdirSync(dirname(jsonl), { recursive: true });
    writeFileSync(
      jsonl,
      `${JSON.stringify({ type: 'ai-title', aiTitle: 'Late Title', sessionId: 'x' })}\n`,
      'utf8',
    );
    await service.maybeAutoTitle(sessionId);
    assert.deepEqual(renamed, ['Late Title']);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fixture.cleanup();
  }
});

test('claude: native lookup gives up after the 3rd completed turn and falls back', async () => {
  const fixture = makeFixture();
  const previousHome = process.env.HOME;
  process.env.HOME = join(fixture.dir, 'home'); // no JSONL ever appears
  try {
    const sessionId = seedSession(fixture.db, {
      workspaceId: fixture.workspaceId,
      executor: 'claude',
      nativeSessionId: 'native-claude-3',
    });
    seedUserMessage(fixture.db, sessionId, '  refactor the   session\nmanager tests  ');
    const renamed: string[] = [];
    const service = makeService(
      fixture.db,
      new UnusedProxyManager() as unknown as ProxyManager,
      (_id, name) => renamed.push(name),
    );

    await service.maybeAutoTitle(sessionId); // attempt 1
    await service.maybeAutoTitle(sessionId); // attempt 2
    assert.deepEqual(renamed, [], 'still waiting for the native ai-title');

    await service.maybeAutoTitle(sessionId); // attempt 3 → fallback
    assert.deepEqual(renamed, ['refactor the session manager tests']);

    // Once named, further completions are a no-op.
    fixture.db.prepare('UPDATE sessions SET name = ? WHERE id = ?')
      .run('refactor the session manager tests', sessionId);
    await service.maybeAutoTitle(sessionId);
    assert.deepEqual(renamed, ['refactor the session manager tests']);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    fixture.cleanup();
  }
});

test('codex: no native title capability → truncation fallback on the first turn', async () => {
  const fixture = makeFixture();
  try {
    const sessionId = seedSession(fixture.db, {
      workspaceId: fixture.workspaceId,
      executor: 'codex',
      nativeSessionId: 'native-codex-1',
    });
    seedUserMessage(
      fixture.db,
      sessionId,
      'fix the flaky login test and make the whole suite pass again',
    );
    const renamed: string[] = [];
    const service = makeService(
      fixture.db,
      new UnusedProxyManager() as unknown as ProxyManager,
      (_id, name) => renamed.push(name),
    );
    await service.maybeAutoTitle(sessionId);
    assert.deepEqual(renamed, ['fix the flaky login test and make the w…']);
  } finally {
    fixture.cleanup();
  }
});

test('an existing name is never overwritten and skips all lookups', async () => {
  const fixture = makeFixture();
  try {
    const sessionId = seedSession(fixture.db, {
      workspaceId: fixture.workspaceId,
      executor: 'codex',
      nativeSessionId: 'native-codex-2',
      name: 'User Chosen',
    });
    seedUserMessage(fixture.db, sessionId, 'hello');
    const renamed: string[] = [];
    const service = makeService(
      fixture.db,
      new UnusedProxyManager() as unknown as ProxyManager,
      (_id, name) => renamed.push(name),
    );
    assert.equal(service.maybeAutoTitle(sessionId), null);
    assert.deepEqual(renamed, []);
  } finally {
    fixture.cleanup();
  }
});

test('kimi: native listNativeSessions title is used; in-flight guard and rename race hold', async () => {
  const fixture = makeFixture();
  try {
    const sessionId = seedSession(fixture.db, {
      workspaceId: fixture.workspaceId,
      executor: 'kimi',
      nativeSessionId: 'native-kimi-1',
    });
    let release!: () => void;
    const proxy = new StubKimiProxyManager();
    proxy.gate = new Promise<void>(resolve => { release = resolve; });
    proxy.pages.push({
      sessions: [
        { sessionId: 'someone-else', title: 'Other Session' },
        { sessionId: 'native-kimi-1', title: 'Kimi Derived Title' },
      ],
    });
    const renamed: string[] = [];
    const service = makeService(
      fixture.db,
      proxy as unknown as ProxyManager,
      (_id, name) => renamed.push(name),
    );

    const first = service.maybeAutoTitle(sessionId);
    assert.ok(first, 'first call starts the derivation');
    await waitFor(() => proxy.listCalls === 1);

    // A duplicate completion event for the same session must not double-run.
    assert.equal(service.maybeAutoTitle(sessionId), null);
    assert.equal(proxy.listCalls, 1);

    // The user renamed while the async lookup was in flight → user wins.
    fixture.db.prepare('UPDATE sessions SET name = ? WHERE id = ?')
      .run('User Rename Wins', sessionId);
    release();
    await first;
    assert.deepEqual(renamed, [], 'no auto-title write after a concurrent user rename');
  } finally {
    fixture.cleanup();
  }
});

test('kimi: native title applies when the session is still unnamed', async () => {
  const fixture = makeFixture();
  try {
    const sessionId = seedSession(fixture.db, {
      workspaceId: fixture.workspaceId,
      executor: 'kimi',
      nativeSessionId: 'native-kimi-2',
    });
    const proxy = new StubKimiProxyManager();
    proxy.pages.push({
      sessions: [{ sessionId: 'native-kimi-2', title: '  Kimi\nTitle  ' }],
      nextCursor: 'unused',
    });
    const renamed: string[] = [];
    const service = makeService(
      fixture.db,
      proxy as unknown as ProxyManager,
      (_id, name) => renamed.push(name),
    );
    await service.maybeAutoTitle(sessionId);
    assert.deepEqual(renamed, ['Kimi Title']);
    assert.equal(proxy.listCalls, 1, 'match found on the first page; no pagination');
  } finally {
    fixture.cleanup();
  }
});

// --- End-to-end through SessionManager.completeTurn -------------------------

class RecordingProxyClient implements ProxyClient {
  readonly setNameCalls: string[] = [];
  private readonly notificationHandlers: NotificationHandler[] = [];
  private bound = false;

  constructor(
    readonly executor: Executor,
    private readonly key: string,
  ) {}

  async initialize() {
    return { mode: 'spawn' as const, protocolVersion: 'test', methods: [] };
  }

  async capabilities() {
    return { protocolVersion: 'test', models: [], slashCommands: [] };
  }

  async listSlashCommands() {
    return { commands: [] };
  }

  async createSession(params: CreateSessionParams) {
    this.bound = true;
    const nativeSessionId = this.executor === 'claude'
      ? params.claudeSessionId ?? `claude-native-${this.key}`
      : `codex-native-${this.key}`;
    return {
      session: {
        id: `proxy-${this.key}`,
        cwd: params.cwd,
        model: params.model ?? null,
        status: 'idle' as const,
        createdAt: '2026-08-10T00:00:00.000Z',
        updatedAt: '2026-08-10T00:00:00.000Z',
        lastError: null,
      },
      nativeSessionId,
    };
  }

  async startTurn(_params: StartTurnParams) {
    return {
      session: {
        id: `proxy-${this.key}`,
        cwd: '/workspace',
        model: null,
        status: 'running' as const,
        createdAt: '2026-08-10T00:00:00.000Z',
        updatedAt: '2026-08-10T00:00:00.000Z',
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
  async respondApproval() {}
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

  async getOrCreate(key: string, executor: Executor): Promise<ProxyClient> {
    let client = this.clients.get(key);
    if (!client) {
      client = new RecordingProxyClient(executor, key);
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

function makeManager(db: Db, dir: string, proxies: RecordingProxyManager): SessionManager {
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

function sessionName(db: Db, sessionId: string): string | null {
  const row = db.prepare('SELECT name FROM sessions WHERE id = ?').get(sessionId) as
    | { name: string | null }
    | undefined;
  return row?.name ?? null;
}

test('e2e: codex session is named from its first user message on turn completion', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gian-auto-title-e2e-codex-'));
  const workspacePath = join(dir, 'workspace');
  mkdirSync(workspacePath, { recursive: true });
  const db = openDatabase(dir);
  try {
    const workspaceId = seedWorkspace(db, workspacePath);
    const proxies = new RecordingProxyManager();
    const sessions = makeManager(db, dir, proxies);
    const session = await sessions.createSession({
      workspace_id: workspaceId,
      executor: 'codex',
    });
    assert.equal(sessionName(db, session.id), null);

    await sessions.sendMessage(session.id, 'fix the   flaky\nlogin test please');
    proxies.client(session.id).fire({
      method: 'turn.completed',
      params: { sessionId: `proxy-${session.id}`, data: { status: 'completed' } },
    });

    await waitFor(() => sessionName(db, session.id) !== null);
    assert.equal(sessionName(db, session.id), 'fix the flaky login test please');
    // The write went through renameSession → native name-sync fires too.
    await waitFor(() => proxies.client(session.id).setNameCalls.length === 1);
    assert.deepEqual(proxies.client(session.id).setNameCalls, ['fix the flaky login test please']);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('e2e: claude session picks up the ai-title from its JSONL on turn completion', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gian-auto-title-e2e-claude-'));
  const workspacePath = join(dir, 'workspace');
  mkdirSync(workspacePath, { recursive: true });
  const previousHome = process.env.HOME;
  process.env.HOME = join(dir, 'home');
  const db = openDatabase(dir);
  try {
    const workspaceId = seedWorkspace(db, workspacePath);
    const proxies = new RecordingProxyManager();
    const sessions = makeManager(db, dir, proxies);
    const session = await sessions.createSession({
      workspace_id: workspaceId,
      executor: 'claude',
    });
    assert.ok(session.native_session_id);

    await sessions.sendMessage(session.id, 'please fix the login bug');
    // Claude Code writes the ai-title asynchronously around the first turn.
    const jsonl = locateCcJsonl(session.native_session_id!, workspacePath)!;
    mkdirSync(dirname(jsonl), { recursive: true });
    writeFileSync(
      jsonl,
      `${JSON.stringify({ type: 'ai-title', aiTitle: 'Fix Login Bug', sessionId: session.native_session_id })}\n`,
      'utf8',
    );

    proxies.client(session.id).fire({
      method: 'turn.completed',
      params: { sessionId: `proxy-${session.id}`, data: { status: 'completed' } },
    });

    await waitFor(() => sessionName(db, session.id) !== null);
    assert.equal(sessionName(db, session.id), 'Fix Login Bug');
    // renameSession also appended a custom-title line for the native CLI.
    await waitFor(() => readFileSync(jsonl, 'utf8').includes('custom-title'));
    const lastLine = readFileSync(jsonl, 'utf8').trim().split('\n').at(-1)!;
    assert.deepEqual(JSON.parse(lastLine), {
      type: 'custom-title',
      customTitle: 'Fix Login Bug',
      sessionId: session.native_session_id,
    });
  } finally {
    db.close();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(dir, { recursive: true, force: true });
  }
});
