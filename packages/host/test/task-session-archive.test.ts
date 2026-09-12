import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ServerToClientMessage, Session } from '@gian/shared';
import { ApprovalManager } from '../src/approval/index.js';
import type { SessionManager } from '../src/session/manager.js';
import { SessionLifecycleService } from '../src/session/lifecycle-service.js';
import { SessionRepository } from '../src/session/repository.js';
import { openDatabase } from '../src/storage/db.js';
import { TaskManager } from '../src/task/manager.js';
import { updateTaskWithSessionArchive } from '../src/task/update-with-session-archive.js';
import type { WsBroadcaster } from '../src/web/ws-broadcast.js';

function assignmentLifecycle(db: ReturnType<typeof openDatabase>) {
  const messages: ServerToClientMessage[] = [];
  const broadcaster = {
    broadcast(message: ServerToClientMessage) {
      messages.push(message);
    },
  } as unknown as WsBroadcaster;
  const approvals = new ApprovalManager(broadcaster);
  const lifecycle = new SessionLifecycleService(
    db,
    new SessionRepository(db),
    approvals,
    broadcaster,
    {
      async bringUpProxySession() {
        throw new Error('unused in assignment tests');
      },
      async discardProxy() {},
      async teardownProxy() {},
      forgetConversationUsage() {},
    },
  );
  return { lifecycle, messages };
}

test('Task done marks owned sessions completed then archives; reopening unarchives but keeps completion', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gian-task-archive-'));
  const db = openDatabase(dir);
  try {
    db.prepare(`INSERT INTO workspaces (id, name, path) VALUES ('ws-1', 'Repo', ?)`)
      .run(dir);
    const tasks = new TaskManager(db);
    const task = tasks.createTask({ name: 'Close and reopen' });
    const completedAt = '2026-08-04T08:00:00.000Z';
    db.prepare(
      `INSERT INTO sessions
         (id, name, type, task_id, workspace_id, executor, native_session_id, completed_at)
       VALUES (?, ?, 'subtask', ?, 'ws-1', 'codex', ?, ?)`,
    ).run('session-completed', 'Completed', task.id, 'native-completed', completedAt);
    db.prepare(
      `INSERT INTO sessions
         (id, name, type, task_id, workspace_id, executor, native_session_id)
       VALUES (?, ?, 'subtask', ?, 'ws-1', 'codex', ?)`,
    ).run('session-open', 'Open', task.id, 'native-open');

    const notifications: Session[][] = [];
    const sessions = {
      notifyTaskSessionsUpdated(taskId: string) {
        notifications.push(
          db.prepare('SELECT * FROM sessions WHERE task_id = ?').all(taskId) as Session[],
        );
      },
    } as unknown as SessionManager;

    updateTaskWithSessionArchive(tasks, sessions, task.id, { status: 'done' });
    let rows = db.prepare(
      'SELECT * FROM sessions WHERE task_id = ? ORDER BY id',
    ).all(task.id) as Session[];
    assert.deepEqual(rows.map(session => session.archived), [1, 1]);
    // T1 (2026-09-06): completion is stamped first — a previously completed
    // session keeps its own timestamp, the open one gets the close time.
    assert.equal(rows[0]?.completed_at, completedAt);
    assert.ok(rows[1]?.completed_at !== null);
    const stampedAt = rows[1]?.completed_at;
    assert.equal(notifications.length, 1);
    assert.ok(notifications[0]?.every(session => session.workspace_id === 'ws-1'));

    updateTaskWithSessionArchive(tasks, sessions, task.id, { status: 'open' });
    rows = db.prepare(
      'SELECT * FROM sessions WHERE task_id = ? ORDER BY id',
    ).all(task.id) as Session[];
    assert.deepEqual(rows.map(session => session.archived), [0, 0]);
    // Reopen restores visibility only — completion is NOT cleared.
    assert.equal(rows[0]?.completed_at, completedAt);
    assert.equal(rows[1]?.completed_at, stampedAt);
    assert.equal(notifications.length, 2);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Task done is rejected while a subtask turn is running or pending', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gian-task-active-'));
  const db = openDatabase(dir);
  try {
    db.prepare(`INSERT INTO workspaces (id, name, path) VALUES ('ws-1', 'Repo', ?)`)
      .run(dir);
    const tasks = new TaskManager(db);
    const task = tasks.createTask({ name: 'Ship' });
    db.prepare(
      `INSERT INTO sessions
         (id, name, type, task_id, workspace_id, executor, native_session_id, status)
       VALUES ('session-1', 'Running', 'subtask', ?, 'ws-1', 'codex', 'native-1', 'running')`,
    ).run(task.id);

    assert.throws(
      () => tasks.updateTask(task.id, { status: 'done' }),
      /TASK_HAS_ACTIVE_SUBTASKS/,
    );

    db.prepare(`UPDATE sessions SET status = 'done' WHERE id = 'session-1'`).run();
    assert.equal(tasks.updateTask(task.id, { status: 'done' }).status, 'done');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an active standalone Session can be atomically filed under an open Task', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gian-session-assign-task-'));
  const db = openDatabase(dir);
  try {
    db.prepare(`INSERT INTO workspaces (id, name, path) VALUES ('ws-1', 'Repo', ?)`)
      .run(dir);
    const task = new TaskManager(db).createTask({ name: 'Current work' });
    db.prepare(
      `INSERT INTO sessions
         (id, name, type, task_id, workspace_id, executor, native_session_id, status, archived)
       VALUES ('session-1', 'Standalone', 'coding', NULL, 'ws-1', 'codex', 'native-1', 'running', 0)`,
    ).run();
    const before = db.prepare('SELECT updated_at FROM sessions WHERE id = ?')
      .get('session-1') as { updated_at: string };
    const { lifecycle, messages } = assignmentLifecycle(db);

    lifecycle.assignTask('session-1', task.id);

    const session = db.prepare('SELECT * FROM sessions WHERE id = ?')
      .get('session-1') as Session;
    assert.equal(session.type, 'subtask');
    assert.equal(session.task_id, task.id);
    assert.equal(session.status, 'running', 'assignment does not disturb the active turn');
    assert.notEqual(session.updated_at, before.updated_at);
    const update = {
      type: 'session:updated',
      session: {
        id: 'session-1',
        type: 'subtask',
        task_id: task.id,
        updated_at: session.updated_at,
      },
    } as const;
    assert.deepEqual(messages, [update]);

    lifecycle.assignTask('session-1', task.id);
    assert.deepEqual(messages, [update, update], 'same-target retry is idempotent and re-broadcasts');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Session assignment: moves and releases are legal; closed targets and archived sessions reject', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gian-session-assign-reject-'));
  const db = openDatabase(dir);
  try {
    db.prepare(`INSERT INTO workspaces (id, name, path) VALUES ('ws-1', 'Repo', ?)`)
      .run(dir);
    const tasks = new TaskManager(db);
    const openTask = tasks.createTask({ name: 'Open' });
    const otherTask = tasks.createTask({ name: 'Other' });
    const closedTask = tasks.createTask({ name: 'Closed' });
    tasks.updateTask(closedTask.id, { status: 'done' });
    db.prepare(
      `INSERT INTO sessions
         (id, name, type, task_id, workspace_id, executor, native_session_id, archived)
       VALUES
         ('standalone', 'Standalone', 'coding', NULL, 'ws-1', 'codex', 'native-1', 0),
         ('archived', 'Archived', 'coding', NULL, 'ws-1', 'codex', 'native-2', 1),
         ('owned', 'Owned', 'subtask', ?, 'ws-1', 'codex', 'native-3', 0)`,
    ).run(otherTask.id);
    const { lifecycle, messages } = assignmentLifecycle(db);

    assert.throws(
      () => lifecycle.assignTask('standalone', closedTask.id),
      /task is not open/,
    );
    assert.throws(
      () => lifecycle.assignTask('archived', openTask.id),
      /session is archived/,
    );

    // Cross-task moves and release-to-standalone are legal (2026-09-06):
    // 'owned' moves to the open task, then releases back to standalone.
    lifecycle.assignTask('owned', openTask.id);
    let owned = db.prepare('SELECT type, task_id FROM sessions WHERE id = ?')
      .get('owned') as Pick<Session, 'type' | 'task_id'>;
    assert.deepEqual(owned, { type: 'subtask', task_id: openTask.id });

    lifecycle.assignTask('owned', null);
    owned = db.prepare('SELECT type, task_id FROM sessions WHERE id = ?')
      .get('owned') as Pick<Session, 'type' | 'task_id'>;
    assert.deepEqual(owned, { type: 'coding', task_id: null });

    // Releasing an already-standalone session is an idempotent no-op.
    lifecycle.assignTask('owned', null);
    owned = db.prepare('SELECT type, task_id FROM sessions WHERE id = ?')
      .get('owned') as Pick<Session, 'type' | 'task_id'>;
    assert.deepEqual(owned, { type: 'coding', task_id: null });

    const rows = db.prepare(
      'SELECT id, type, task_id, archived FROM sessions ORDER BY id',
    ).all() as Array<Pick<Session, 'id' | 'type' | 'task_id' | 'archived'>>;
    assert.deepEqual(rows, [
      { id: 'archived', type: 'coding', task_id: null, archived: 1 },
      { id: 'owned', type: 'coding', task_id: null, archived: 0 },
      { id: 'standalone', type: 'coding', task_id: null, archived: 0 },
    ]);
    // The legal move + release broadcast twice (plus one idempotent re-broadcast);
    // the rejected assigns never wrote, so no broadcast carries them.
    assert.deepEqual(
      messages.map(m => (m as { session?: { id?: string } }).session?.id),
      ['owned', 'owned', 'owned'],
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
