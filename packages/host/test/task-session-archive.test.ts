import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Session } from '@gian/shared';
import type { SessionManager } from '../src/session/manager.js';
import { openDatabase } from '../src/storage/db.js';
import { TaskManager } from '../src/task/manager.js';
import { updateTaskWithSessionArchive } from '../src/task/update-with-session-archive.js';

test('Task done archives owned sessions and reopening restores them without changing completion', () => {
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
    assert.equal(rows[0]?.completed_at, completedAt);
    assert.equal(rows[1]?.completed_at, null);
    assert.equal(notifications.length, 1);
    assert.ok(notifications[0]?.every(session => session.workspace_id === 'ws-1'));

    updateTaskWithSessionArchive(tasks, sessions, task.id, { status: 'open' });
    rows = db.prepare(
      'SELECT * FROM sessions WHERE task_id = ? ORDER BY id',
    ).all(task.id) as Session[];
    assert.deepEqual(rows.map(session => session.archived), [0, 0]);
    assert.equal(rows[0]?.completed_at, completedAt);
    assert.equal(rows[1]?.completed_at, null);
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
