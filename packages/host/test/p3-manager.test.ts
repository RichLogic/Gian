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
import { deleteTaskCascade } from '../src/task/delete-cascade.js';
import {
  getOrCreateRootWorkspace,
  buildManagerSystemPrompt,
  managerRuntimeFor,
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
    // Pin the PM to codex so it drives the codex stub (the executor is now a
    // per-Task choice; default is claude).
    const task = tasks.createTask({ name: 'Ship P3', manager_executor: 'codex' });
    const m1 = await sessions.ensureManagerSession(task.id);
    const m2 = await sessions.ensureManagerSession(task.id);

    const rt = managerRuntimeFor('codex');
    assert.equal(m1.id, m2.id, 'idempotent — one manager per task');
    assert.equal(m1.type, 'manager');
    assert.equal(m1.executor, 'codex');
    assert.equal(m1.task_id, task.id);
    assert.equal(m1.model, rt.model);
    assert.equal(m1.thinking_effort, rt.effort);
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

test('manager turn honors its approval_mode (default plan → read-only; auto → writable)', async () => {
  const { dir, db, proxyMgr, sessions, tasks } = setup();
  try {
    const task = tasks.createTask({ name: 'Audit', manager_executor: 'codex' });
    const mgr = await sessions.ensureManagerSession(task.id);

    // No policy is forced anymore (decision 2026-06-29): the Manager honors its
    // approval_mode like any session. Default is 'plan' → codex read-only +
    // on-request, so a fresh Manager plans/reads.
    await sessions.sendManagerMessage(task.id, 'what is this project?');
    let params = proxyMgr.client.lastStartTurnParams;
    assert.ok(params, 'startTurn was called');
    assert.equal(params!.sandbox, 'read-only', 'plan → read-only');
    assert.equal(params!.approvalPolicy, 'on-request', 'plan → on-request');
    assert.equal(params!.thinking, managerRuntimeFor('codex').effort, 'effort applied per-turn');

    // Escalate to 'auto' → the next turn is writable (workspace-write).
    await sessions.stopTurn(mgr.id);
    sessions.setApprovalMode(mgr.id, 'auto');
    await sessions.sendManagerMessage(task.id, 'now make the change');
    params = proxyMgr.client.lastStartTurnParams;
    assert.equal(params!.sandbox, 'workspace-write', 'auto → workspace-write');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Codex-only permission modes are enforced and mapped at host boundaries', async () => {
  const { dir, db, proxyMgr, sessions } = setup();
  try {
    const wsId = randomUUID();
    db.prepare(`INSERT INTO workspaces (id, name, path, hidden) VALUES (?, 'repo', ?, 0)`).run(wsId, dir);

    await assert.rejects(
      () => sessions.createSession({
        workspace_id: wsId,
        executor: 'claude',
        approval_mode: 'full-access',
      }),
      /codex-only/,
      'new claude sessions cannot persist full-access',
    );

    const claude = await sessions.createSession({ workspace_id: wsId, executor: 'claude' });
    assert.throws(
      () => sessions.setApprovalMode(claude.id, 'full-access'),
      /codex-only/,
      'existing claude sessions cannot be switched to full-access',
    );
    assert.throws(
      () => sessions.setApprovalMode(claude.id, 'custom'),
      /codex-only/,
      'existing claude sessions cannot be switched to custom',
    );

    const codex = await sessions.createSession({ workspace_id: wsId, executor: 'codex' });
    sessions.setApprovalMode(codex.id, 'full-access');
    await sessions.sendMessage(codex.id, 'use the fast lane');
    assert.equal(proxyMgr.client.lastStartTurnParams?.sandbox, 'danger-full-access');
    assert.equal(proxyMgr.client.lastStartTurnParams?.approvalPolicy, 'never');

    await sessions.stopTurn(codex.id);
    sessions.setApprovalMode(codex.id, 'custom');
    await sessions.sendMessage(codex.id, 'use config.toml');
    assert.equal(proxyMgr.client.lastStartTurnParams?.useConfiguredPermissions, true);
    assert.equal(proxyMgr.client.lastStartTurnParams?.sandbox, undefined);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sendManagerMessage prepends the system prompt on the first turn only', async () => {
  const { dir, db, proxyMgr, sessions, tasks } = setup();
  try {
    const task = tasks.createTask({ name: 'Plan release', description: 'cut v1', manager_executor: 'codex' });
    await sessions.sendManagerMessage(task.id, 'first');
    const firstInput = (proxyMgr.client.lastStartTurnParams!.input as Array<{ text: string }>)[0]!.text;
    assert.match(firstInput, /project Manager/, 'system prompt prepended on first turn');
    assert.match(firstInput, /<<gian:action>>/, 'create_subtask action-envelope protocol included');
    assert.match(firstInput, /natural-language/, 'NL-align-then-act instruction included');
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
        runtime_mode: 'structured', summary: null,
        completed_at: '2026-06-28T00:00:00Z', created_at: '', updated_at: '',
      },
    ],
    workspacePaths: ['/Users/x/Coding/app'],
    rootPath: '/Users/x/Coding',
  });
  assert.match(prompt, /Refactor auth/);
  // Shows user-completion (completed_at), not turn status (spec §B).
  assert.match(prompt, /login flow \[claude\/completed\]/);
  assert.match(prompt, /\/Users\/x\/Coding\/app/);
  assert.match(prompt, /\.ai\//);
});

test('completeSubtask sets completed_at (not turn status); reopen clears it', async () => {
  const { dir, db, sessions, tasks } = setup();
  try {
    const task = tasks.createTask({ name: 'Build' });
    const wsId = randomUUID();
    db.prepare(`INSERT INTO workspaces (id, name, path, hidden) VALUES (?, 'tmp', ?, 0)`).run(wsId, dir);
    const sub = await sessions.createSession({
      workspace_id: wsId, executor: 'codex', type: 'subtask', task_id: task.id,
    });
    const read = () => db.prepare('SELECT status, completed_at FROM sessions WHERE id = ?')
      .get(sub.id) as { status: string; completed_at: string | null };

    assert.equal(read().completed_at, null, 'starts not completed');

    sessions.completeSubtask(sub.id);
    const done = read();
    assert.ok(done.completed_at, 'completed_at set on complete');
    assert.notEqual(done.status, 'done', 'completion does NOT force turn status=done');

    sessions.reopenSubtask(sub.id);
    assert.equal(read().completed_at, null, 'reopen clears completed_at');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('updateTask refuses status=done while a subtask turn is running/pending', async () => {
  const { dir, db, sessions, tasks } = setup();
  try {
    const task = tasks.createTask({ name: 'Ship' });
    const wsId = randomUUID();
    db.prepare(`INSERT INTO workspaces (id, name, path, hidden) VALUES (?, 'tmp', ?, 0)`).run(wsId, dir);
    const sub = await sessions.createSession({
      workspace_id: wsId, executor: 'codex', type: 'subtask', task_id: task.id,
    });

    db.prepare(`UPDATE sessions SET status = 'running' WHERE id = ?`).run(sub.id);
    assert.throws(
      () => tasks.updateTask(task.id, { status: 'done' }),
      /TASK_HAS_ACTIVE_SUBTASKS/,
      'blocked while subtask turn running',
    );

    // Settling the subtask turn (done = terminal, not active) lets the Task close.
    db.prepare(`UPDATE sessions SET status = 'done' WHERE id = ?`).run(sub.id);
    assert.equal(tasks.updateTask(task.id, { status: 'done' }).status, 'done');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deleteTask cascade: listSessionIdsForTask enumerates PM+subtasks; deleting them lets the task delete', async () => {
  const { dir, db, sessions, tasks } = setup();
  try {
    const task = tasks.createTask({ name: 'Cascade', manager_executor: 'codex' });
    const mgr = await sessions.ensureManagerSession(task.id);
    const wsId = randomUUID();
    db.prepare(`INSERT INTO workspaces (id, name, path, hidden) VALUES (?, 'tmp', ?, 0)`).run(wsId, dir);
    const sub = await sessions.createSession({
      workspace_id: wsId, executor: 'codex', type: 'subtask', task_id: task.id,
    });

    // Enumerates the PM manager + every subtask (what ws-handler cascades over).
    assert.deepEqual(
      new Set(sessions.listSessionIdsForTask(task.id)),
      new Set([mgr.id, sub.id]),
      'lists the task PM + subtask',
    );

    // The guard blocks deleting a task while sessions still reference it.
    assert.throws(() => tasks.deleteTask(task.id), /task has associated sessions/);

    // Cascade (as REST + ws-handler do): tear down each owned session, then the
    // task row deletes cleanly with no dangling references.
    await deleteTaskCascade(tasks, sessions, task.id);
    assert.equal(sessions.listSessionIdsForTask(task.id).length, 0, 'no sessions ref the task');
    assert.equal(
      (db.prepare('SELECT COUNT(*) AS c FROM tasks WHERE id = ?').get(task.id) as { c: number }).c,
      0,
      'task row is gone',
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('manager action path is always-on (no GIAN_TASK_ROLES): a create_subtask envelope builds a subtask directly', async () => {
  const prevFlag = process.env.GIAN_TASK_ROLES;
  delete process.env.GIAN_TASK_ROLES; // prove it works with the global feature OFF
  const { dir, db, proxyMgr, sessions, tasks } = setup();
  try {
    const wsId = randomUUID();
    db.prepare(`INSERT INTO workspaces (id, name, path, hidden) VALUES (?, 'Repo', ?, 0)`).run(wsId, dir);
    const task = tasks.createTask({ name: 'Ship', manager_executor: 'codex' });
    const mgr = await sessions.ensureManagerSession(task.id);

    // The manager aligned in NL and ended its reply with the action envelope.
    // Drive the structured action path: run one manager turn, then complete it
    // with a final text carrying the envelope (codex carries the authoritative
    // final text on the turn.completed notification).
    const finalText = 'Sounds good — spinning that up.\n\n'
      + '<<gian:action>>{"method":"create_subtask","params":{"workspace":"Repo","executor":"kimi","brief":"do the thing","name":"Wire it"}}<</gian:action>>';
    await sessions.sendMessage(mgr.id, 'build it');
    proxyMgr.client.fire({
      method: 'turn.completed',
      params: { sessionId: 'proxy_x', data: { status: 'completed', summary: { assistantText: finalText } } },
    });

    // recordParsed is synchronous → the action row exists immediately even with
    // GIAN_TASK_ROLES unset (the manager path is exempt from the gate).
    const row = db.prepare('SELECT action_id FROM task_actions WHERE session_id = ?').get(mgr.id) as { action_id: string } | undefined;
    assert.ok(row, 'the manager create_subtask action was recorded with the feature flag OFF');

    // The async drive authorizes (no loop → execute, PM aligned) and builds the
    // subtask. Poll briefly for the created session.
    let subs: Array<{ executor: string }> = [];
    for (let i = 0; i < 200 && subs.length === 0; i++) {
      await new Promise(r => setImmediate(r));
      subs = db.prepare(`SELECT executor FROM sessions WHERE task_id = ? AND type = 'subtask'`).all(task.id) as Array<{ executor: string }>;
    }
    assert.equal(subs.length, 1, 'exactly one subtask built directly from the envelope');
    assert.equal(subs[0].executor, 'kimi');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
    if (prevFlag === undefined) delete process.env.GIAN_TASK_ROLES;
    else process.env.GIAN_TASK_ROLES = prevFlag;
  }
});

test('manager pending action resumes on startup even when GIAN_TASK_ROLES is off', async () => {
  const prevFlag = process.env.GIAN_TASK_ROLES;
  delete process.env.GIAN_TASK_ROLES; // manager actions are always-on; other roles stay gated
  const { dir, db, sessions, tasks } = setup();
  try {
    const wsId = randomUUID();
    db.prepare(`INSERT INTO workspaces (id, name, path, hidden) VALUES (?, 'Repo', ?, 0)`).run(wsId, dir);
    const task = tasks.createTask({ name: 'Resume PM action', manager_executor: 'codex' });
    const mgr = await sessions.ensureManagerSession(task.id);
    const payload = {
      method: 'create_subtask',
      params: { workspace: 'Repo', executor: 'codex', brief: 'resume the side effect', name: 'Resume build' },
    };

    // Simulate the crash window: recordParsed committed the row, but the host
    // restarted before driveRecorded ran the side effect.
    db.prepare(
      `INSERT INTO task_actions(action_id, task_id, session_id, host_turn_id, source_turn_key, method, payload_hash, payload, status)
       VALUES('resume-manager-action', ?, ?, 'turn-1', 'turn-1', 'create_subtask', 'hash-1', ?, 'parsed')`,
    ).run(task.id, mgr.id, JSON.stringify(payload));

    sessions.resumePendingTaskActions();

    let action: { status: string } | undefined;
    for (let i = 0; i < 200; i++) {
      await new Promise(r => setImmediate(r));
      action = db.prepare(`SELECT status FROM task_actions WHERE action_id = 'resume-manager-action'`).get() as { status: string } | undefined;
      if (action?.status === 'done') break;
    }
    assert.equal(action?.status, 'done', 'startup resume drove the manager action to done');
    const subs = db.prepare(`SELECT name, executor FROM sessions WHERE task_id = ? AND type = 'subtask'`).all(task.id) as Array<{ name: string | null; executor: string }>;
    assert.equal(subs.length, 1, 'resumed create_subtask built one subtask');
    assert.equal(subs[0].name, 'Resume build');
    assert.equal(subs[0].executor, 'codex');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
    if (prevFlag === undefined) delete process.env.GIAN_TASK_ROLES;
    else process.env.GIAN_TASK_ROLES = prevFlag;
  }
});
