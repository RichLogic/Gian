import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ProxyNotification, ServerToClientMessage } from '@gian/shared';
import { openDatabase } from '../src/storage/db.js';
import { SessionManager } from '../src/session/manager.js';
import { TaskManager } from '../src/task/manager.js';
import {
  getOrCreateRootWorkspace,
  buildManagerSystemPrompt,
  MANAGER_MODEL,
  MANAGER_EFFORT,
} from '../src/task/manager-session.js';
import type { ProxyManager } from '../src/proxy/manager.js';
import type { ProxyClient, NotificationHandler } from '../src/proxy/types.js';
import type { WsBroadcaster } from '../src/web/ws-broadcast.js';
import { ApprovalManager } from '../src/approval/index.js';
import { QueueManager } from '../src/queue/index.js';

/** Codex-flavored stub that records the params passed to startTurn so the test
 *  can assert the Manager turn is forced read-only. */
class StubCodexClient implements ProxyClient {
  readonly executor = 'codex' as const;
  notificationHandlers: NotificationHandler[] = [];
  lastStartTurnParams: Record<string, unknown> | null = null;

  async initialize() {
    return { mode: 'spawn' as const, protocolVersion: '0.1.0', methods: [] };
  }
  async capabilities() {
    return { protocolVersion: '0.1.0', models: [], slashCommands: [] };
  }
  async listSlashCommands() {
    return { commands: [] };
  }
  async createSession(params: { cwd: string; threadId?: string }) {
    const nativeSessionId = params.threadId ?? `cx_${randomUUID()}`;
    return {
      session: {
        id: nativeSessionId,
        cwd: params.cwd,
        threadId: nativeSessionId,
        model: null,
        status: 'idle' as const,
        createdAt: '2026-06-23T00:00:00.000Z',
        updatedAt: '2026-06-23T00:00:00.000Z',
        lastError: null,
      },
      nativeSessionId,
    };
  }
  async interruptTurn() { /* no-op */ }
  async respondApproval() { /* no-op */ }
  async startTurn(params: Record<string, unknown>) {
    this.lastStartTurnParams = params;
    return {
      session: {
        id: 'proxy_x',
        cwd: '/tmp',
        model: null,
        status: 'running' as const,
        createdAt: '2026-06-23T00:00:00.000Z',
        updatedAt: '2026-06-23T00:00:00.000Z',
        lastError: null,
      },
      turn: { id: 'proxy_turn' },
    };
  }
  async closeSession() { /* no-op */ }
  async shutdown() { /* no-op */ }
  forceKill() { /* no-op */ }
  setName() { return Promise.resolve(); }

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
  client = new StubCodexClient();
  async getOrCreate(): Promise<ProxyClient> {
    return this.client;
  }
  get(): ProxyClient {
    return this.client;
  }
  async closeAll(): Promise<void> { /* no-op */ }
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
  const dir = mkdtempSync(join(tmpdir(), 'gian-p3-test-'));
  const db = openDatabase(dir);
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
  const tasks = new TaskManager(db);
  return { dir, db, proxyMgr, broadcaster, sessions, tasks };
}

test('getOrCreateRootWorkspace is idempotent and hidden', () => {
  const { dir, db } = setup();
  try {
    const a = getOrCreateRootWorkspace(db);
    const b = getOrCreateRootWorkspace(db);
    assert.equal(a.id, b.id, 'same row returned on second call');
    const row = db.prepare('SELECT hidden FROM workspaces WHERE id = ?').get(a.id) as
      | { hidden: number } | undefined;
    assert.equal(row?.hidden, 1, 'root workspace is hidden');
    const count = (db.prepare('SELECT COUNT(*) AS c FROM workspaces').get() as { c: number }).c;
    assert.equal(count, 1, 'no duplicate root workspace');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureManagerSession creates one manager session bound to root (idempotent)', async () => {
  const { dir, db, sessions, tasks } = setup();
  try {
    const task = tasks.createTask({ name: 'Ship P3' });
    const m1 = await sessions.ensureManagerSession(task.id);
    const m2 = await sessions.ensureManagerSession(task.id);

    assert.equal(m1.id, m2.id, 'idempotent — one manager per task');
    assert.equal(m1.type, 'manager');
    assert.equal(m1.executor, 'codex');
    assert.equal(m1.task_id, task.id);
    assert.equal(m1.model, MANAGER_MODEL);
    assert.equal(m1.thinking_effort, MANAGER_EFFORT);
    assert.equal(m1.worktree_path, null, 'no worktree');

    const root = getOrCreateRootWorkspace(db);
    assert.equal(m1.workspace_id, root.id, 'bound to root workspace');

    const count = (db.prepare(
      `SELECT COUNT(*) AS c FROM sessions WHERE task_id = ? AND type = 'manager'`,
    ).get(task.id) as { c: number }).c;
    assert.equal(count, 1, 'exactly one manager row');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('manager turn is forced read-only regardless of approval_mode', async () => {
  const { dir, db, proxyMgr, sessions, tasks } = setup();
  try {
    const task = tasks.createTask({ name: 'Audit' });
    await sessions.sendManagerMessage(task.id, 'what is this project?');

    const params = proxyMgr.client.lastStartTurnParams;
    assert.ok(params, 'startTurn was called');
    assert.equal(params!.sandbox, 'read-only', 'sandbox forced read-only');
    assert.equal(params!.approvalPolicy, 'never', 'approvals forced never');
    assert.equal(params!.thinking, MANAGER_EFFORT, 'effort applied per-turn');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sendManagerMessage prepends the system prompt on the first turn only', async () => {
  const { dir, db, proxyMgr, sessions, tasks } = setup();
  try {
    const task = tasks.createTask({ name: 'Plan release', description: 'cut v1' });
    await sessions.sendManagerMessage(task.id, 'first');
    const firstInput = (proxyMgr.client.lastStartTurnParams!.input as Array<{ text: string }>)[0]!.text;
    assert.match(firstInput, /read-only project Manager/, 'system prompt prepended on first turn');
    assert.match(firstInput, /Plan release/, 'task name inlined');
    assert.match(firstInput, /first$/, 'user text appended after the prompt');

    // Settle the first turn (clears activeTurns) so a second send is allowed,
    // and now persistedTurnCount > 0 → no system-prompt prepend.
    const mgr = sessions.getManagerSession(task.id)!;
    await sessions.stopTurn(mgr.id);
    await sessions.sendManagerMessage(task.id, 'second');
    const secondInput = (proxyMgr.client.lastStartTurnParams!.input as Array<{ text: string }>)[0]!.text;
    assert.equal(secondInput, 'second', 'no system prompt on later turns');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildManagerSystemPrompt inlines subtask metadata and signposts', () => {
  const prompt = buildManagerSystemPrompt({
    task: {
      id: 't1', name: 'Refactor auth', description: null,
      status: 'open', created_at: '', updated_at: '',
    },
    subtasks: [
      {
        id: 's1', name: 'login flow', type: 'subtask', task_id: 't1',
        workspace_id: 'w1', executor: 'claude', model: null,
        approval_mode: 'auto', thinking_effort: null, turns: 1,
        active_channel: 'web', status: 'done', archived: 0, unread: 0,
        worktree_path: null, branch: null, base_branch: null,
        worktree_outcome: null, native_session_id: null,
        runtime_mode: 'structured', created_at: '', updated_at: '',
      },
    ],
    workspacePaths: ['/Users/x/Coding/app'],
    rootPath: '/Users/x/Coding',
  });
  assert.match(prompt, /Refactor auth/);
  assert.match(prompt, /login flow \[claude\/done\]/);
  assert.match(prompt, /\/Users\/x\/Coding\/app/);
  assert.match(prompt, /\.ai\//);
});
