import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { makeTestApp } from './fixtures/test-app.js';

test('Task creation accepts Kimi as the native Manager executor', async () => {
  const ctx = await makeTestApp();
  try {
    const response = await ctx.fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Kimi managed task',
        executor: 'kimi',
      }),
    });
    assert.equal(response.status, 200);
    const task = await response.json() as {
      name: string;
      manager_executor: string | null;
    };
    assert.equal(task.name, 'Kimi managed task');
    assert.equal(task.manager_executor, 'kimi');
  } finally {
    await ctx.cleanup();
  }
});
