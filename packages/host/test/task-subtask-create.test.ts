import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { makeTestApp, type TestAppCtx } from './fixtures/test-app.js';

interface TaskCreateCtx {
  appCtx: TestAppCtx;
  taskId: string;
  workspaceId: string;
  cleanup: () => Promise<void>;
}

async function setup(): Promise<TaskCreateCtx> {
  const appCtx = await makeTestApp();
  const workspaceId = randomUUID();
  const taskId = randomUUID();
  const now = new Date().toISOString();
  appCtx.db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)')
    .run(workspaceId, 'demo', '/tmp/demo-ws');
  appCtx.db.prepare(
    `INSERT INTO tasks (id, name, status, created_at, updated_at)
     VALUES (?, 'Validation', 'open', ?, ?)`,
  ).run(taskId, now, now);
  return {
    appCtx,
    taskId,
    workspaceId,
    cleanup: () => appCtx.cleanup(),
  };
}

async function createSubtask(ctx: TaskCreateCtx, body: Record<string, unknown>) {
  return ctx.appCtx.fetch(`/api/tasks/${ctx.taskId}/subtasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workspace_id: ctx.workspaceId,
      name: 'subtask',
      ...body,
    }),
  });
}

test('POST /api/tasks/:id/subtasks rejects the legacy executor-only shape', async () => {
  const ctx = await setup();
  try {
    const response = await createSubtask(ctx, { executor: 'dsh' });
    const body = await response.json() as { error?: string };
    assert.equal(response.status, 400);
    assert.equal(body.error, 'agent_id required');
  } finally {
    await ctx.cleanup();
  }
});

test('POST /api/tasks/:id/subtasks forwards explicit Agent identity', async () => {
  const ctx = await setup();
  try {
    const response = await createSubtask(ctx, {
      agent_id: 'missing-agent',
      executor: 'nope',
    });
    const body = await response.json() as { error?: string };
    assert.equal(response.status, 404);
    assert.match(String(body.error), /agent not found/);
  } finally {
    await ctx.cleanup();
  }
});
