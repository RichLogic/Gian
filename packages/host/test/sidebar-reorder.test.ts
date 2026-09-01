// Sidebar drag reorder endpoints (2026-08-29, migration 067):
// POST /api/tasks/reorder persists `tasks.sort_order` and
// POST /api/sessions/reorder persists `sessions.workspace_order` /
// `sessions.task_order` per scope. Neither bumps `updated_at` and neither
// broadcasts — the web operation layer converges canonical state itself.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { Db } from '../src/storage/db.js';
import { makeTestApp } from './fixtures/test-app.js';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function insertTask(db: Db, id: string, createdAt: string) {
  db.prepare(
    `INSERT INTO tasks (id, name, status, created_at, updated_at)
     VALUES (?, ?, 'open', ?, ?)`,
  ).run(id, id, createdAt, createdAt);
}

function insertSession(
  db: Db,
  id: string,
  workspaceId: string | null,
  taskId: string | null = null,
) {
  db.prepare(
    `INSERT INTO sessions (id, name, type, task_id, workspace_id, executor, native_session_id)
     VALUES (?, ?, ?, ?, ?, 'codex', ?)`,
  ).run(id, id, taskId ? 'subtask' : 'coding', taskId, workspaceId, `native-${id}`);
}

test('POST /api/tasks/reorder persists the manual order; untouched tasks stay automatic above it', async () => {
  const ctx = await makeTestApp();
  try {
    insertTask(ctx.db, 'task-a', '2026-08-01T00:00:00.000Z');
    insertTask(ctx.db, 'task-b', '2026-08-02T00:00:00.000Z');
    insertTask(ctx.db, 'task-c', '2026-08-03T00:00:00.000Z');

    const before = await (await ctx.fetch('/api/tasks')).json() as Array<{ id: string }>;
    assert.deepEqual(before.map(task => task.id), ['task-c', 'task-b', 'task-a']);

    const response = await ctx.fetch('/api/tasks/reorder', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ ids: ['task-a', 'task-c'] }),
    });
    assert.equal(response.status, 200);

    const after = await (await ctx.fetch('/api/tasks')).json() as Array<{ id: string }>;
    // task-b was never dragged: its NULL sort_order keeps it ABOVE the manual
    // range (a fresh task lands on top, matching the pre-drag behavior).
    assert.deepEqual(after.map(task => task.id), ['task-b', 'task-a', 'task-c']);
    // A reorder is view metadata — updated_at stays untouched.
    assert.equal(
      (ctx.db.prepare('SELECT updated_at FROM tasks WHERE id = ?').get('task-a') as { updated_at: string }).updated_at,
      '2026-08-01T00:00:00.000Z',
    );
  } finally {
    await ctx.cleanup();
  }
});

test('POST /api/tasks/reorder rejects a missing ids array', async () => {
  const ctx = await makeTestApp();
  try {
    const response = await ctx.fetch('/api/tasks/reorder', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 400);
  } finally {
    await ctx.cleanup();
  }
});

test('POST /api/sessions/reorder persists workspace scope order and never leaks into another scope', async () => {
  const ctx = await makeTestApp();
  try {
    ctx.db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)').run('ws-1', 'demo', '/tmp/demo-ws');
    ctx.db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)').run('ws-2', 'other', '/tmp/other-ws');
    insertSession(ctx.db, 's1', 'ws-1');
    insertSession(ctx.db, 's2', 'ws-1');
    insertSession(ctx.db, 's9', 'ws-2');

    const response = await ctx.fetch('/api/sessions/reorder', {
      method: 'POST',
      headers: JSON_HEADERS,
      // s9 belongs to another workspace — the parent guard must skip it.
      body: JSON.stringify({ scope: 'workspace', parentId: 'ws-1', ids: ['s2', 's1', 's9'] }),
    });
    assert.equal(response.status, 200);

    const orderOf = (id: string) =>
      (ctx.db.prepare('SELECT workspace_order FROM sessions WHERE id = ?').get(id) as { workspace_order: number | null })
        .workspace_order;
    assert.equal(orderOf('s2'), 1);
    assert.equal(orderOf('s1'), 2);
    assert.equal(orderOf('s9'), null);
  } finally {
    await ctx.cleanup();
  }
});

test('POST /api/sessions/reorder persists task scope order (Tasks rail subtasks)', async () => {
  const ctx = await makeTestApp();
  try {
    ctx.db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)').run('ws-1', 'demo', '/tmp/demo-ws');
    insertTask(ctx.db, 'task-1', '2026-08-01T00:00:00.000Z');
    insertSession(ctx.db, 'st1', 'ws-1', 'task-1');
    insertSession(ctx.db, 'st2', 'ws-1', 'task-1');

    const response = await ctx.fetch('/api/sessions/reorder', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ scope: 'task', parentId: 'task-1', ids: ['st2', 'st1'] }),
    });
    assert.equal(response.status, 200);

    const orderOf = (id: string) =>
      (ctx.db.prepare('SELECT task_order FROM sessions WHERE id = ?').get(id) as { task_order: number | null })
        .task_order;
    assert.equal(orderOf('st2'), 1);
    assert.equal(orderOf('st1'), 2);
  } finally {
    await ctx.cleanup();
  }
});

test('POST /api/sessions/reorder rejects an unknown scope', async () => {
  const ctx = await makeTestApp();
  try {
    const response = await ctx.fetch('/api/sessions/reorder', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ scope: 'nope', parentId: null, ids: [] }),
    });
    assert.equal(response.status, 400);
  } finally {
    await ctx.cleanup();
  }
});
