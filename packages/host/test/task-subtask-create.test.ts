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

async function createSubtask(ctx: TaskCreateCtx, executor: string) {
  return ctx.appCtx.fetch(`/api/tasks/${ctx.taskId}/subtasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workspace_id: ctx.workspaceId,
      executor,
      name: `subtask-${executor}`,
    }),
  });
}

test('POST /api/tasks/:id/subtasks accepts dsh instead of treating it as an unknown executor', async () => {
  const ctx = await setup();
  try {
    const response = await createSubtask(ctx, 'dsh');
    const body = await response.json() as { error?: string };
    assert.notEqual(
      body.error,
      'executor must be claude, codex, kimi, or grok',
      'DSH Task sessions were rejected by a stale executor allowlist',
    );
    if (response.status === 400) {
      assert.fail(`dsh still rejected at the task route: ${body.error}`);
    }
  } finally {
    await ctx.cleanup();
  }
});

test('POST /api/tasks/:id/subtasks still rejects an unknown executor', async () => {
  const ctx = await setup();
  try {
    const response = await createSubtask(ctx, 'nope');
    const body = await response.json() as { error?: string };
    assert.equal(response.status, 400);
    assert.match(String(body.error), /executor must be/);
  } finally {
    await ctx.cleanup();
  }
});
