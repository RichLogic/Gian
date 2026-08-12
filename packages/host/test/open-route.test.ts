import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  makeTestApp,
  type TestAppCtx,
  type TestAppOptions,
} from './fixtures/test-app.js';
import { saveConfig } from '../src/storage/config.js';

interface Ctx {
  appCtx: TestAppCtx;
  workspaceId: string;
  workspacePath: string;
  cleanup: () => Promise<void>;
}

async function setup(options: TestAppOptions = {}): Promise<Ctx> {
  const appCtx = await makeTestApp(options);
  const workspaceId = randomUUID();
  const workspacePath = realpathSync(mkdtempSync(join(tmpdir(), 'gian-open-')));
  writeFileSync(join(workspacePath, 'foo.md'), '# foo');
  appCtx.db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)')
    .run(workspaceId, 'demo', workspacePath);
  return {
    appCtx,
    workspaceId,
    workspacePath,
    cleanup: async () => {
      await appCtx.cleanup();
      rmSync(workspacePath, { recursive: true, force: true });
    },
  };
}

test('/open: rejects unknown working-tree id', async () => {
  const ctx = await setup();
  try {
    const res = await ctx.appCtx.fetch(
      `/api/working_trees/ws:00000000-0000-0000-0000-000000000000/open`,
      { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'foo.md' }) },
    );
    assert.equal(res.status, 404);
  } finally {
    await ctx.cleanup();
  }
});

test('/open: rejects path traversal with 400', async () => {
  const ctx = await setup();
  try {
    const res = await ctx.appCtx.fetch(
      `/api/working_trees/ws:${ctx.workspaceId}/open`,
      { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: '../../../etc/passwd' }) },
    );
    assert.equal(res.status, 400);
    const body = await res.json() as { error: string };
    assert.match(body.error, /path escapes/);
  } finally {
    await ctx.cleanup();
  }
});

test('/open: rejects missing file with 404', async () => {
  const ctx = await setup();
  try {
    const res = await ctx.appCtx.fetch(
      `/api/working_trees/ws:${ctx.workspaceId}/open`,
      { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'does-not-exist.txt' }) },
    );
    assert.equal(res.status, 404);
    const body = await res.json() as { error: string };
    assert.match(body.error, /not found/i);
  } finally {
    await ctx.cleanup();
  }
});

test('/open: rejects unknown editor_id with 404', async () => {
  const ctx = await setup();
  try {
    const res = await ctx.appCtx.fetch(
      `/api/working_trees/ws:${ctx.workspaceId}/open`,
      { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'foo.md', editor_id: 'does-not-exist' }) },
    );
    assert.equal(res.status, 404);
    const body = await res.json() as { error: string };
    assert.match(body.error, /editor/i);
  } finally {
    await ctx.cleanup();
  }
});

test('/open: named macOS app uses the injected detached launcher', async () => {
  const ctx = await setup({ platform: 'darwin' });
  try {
    const res = await ctx.appCtx.fetch(
      `/api/working_trees/ws:${ctx.workspaceId}/open`,
      { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'foo.md', app: 'Example Editor' }) },
    );
    assert.equal(res.status, 200);
    assert.deepEqual(ctx.appCtx.openedCommands, [{
      mode: 'detached',
      command: {
        command: 'open',
        argv: ['-a', 'Example Editor', join(ctx.workspacePath, 'foo.md')],
      },
    }]);
  } finally {
    await ctx.cleanup();
  }
});

test('/open: `app` target is rejected off macOS without invoking a launcher', async () => {
  const ctx = await setup({ platform: 'linux' });
  try {
    const res = await ctx.appCtx.fetch(
      `/api/working_trees/ws:${ctx.workspaceId}/open`,
      { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'foo.md', app: 'Example Editor' }) },
    );
    assert.equal(res.status, 400);
    assert.deepEqual(ctx.appCtx.openedCommands, []);
  } finally {
    await ctx.cleanup();
  }
});

test('/open: unknown builtin opener → 400', async () => {
  const ctx = await setup();
  try {
    const res = await ctx.appCtx.fetch(
      `/api/working_trees/ws:${ctx.workspaceId}/open`,
      { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'foo.md', builtin: 'nonsense' }) },
    );
    assert.equal(res.status, 400);
  } finally {
    await ctx.cleanup();
  }
});

test('/open: finder/terminal builtins are macOS-only (400 elsewhere)', async () => {
  const ctx = await setup({ platform: 'linux' });
  try {
    for (const builtin of ['finder', 'terminal']) {
      const res = await ctx.appCtx.fetch(
        `/api/working_trees/ws:${ctx.workspaceId}/open`,
        { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: 'foo.md', builtin }) },
      );
      assert.equal(res.status, 400, `${builtin} should be macOS-only off darwin`);
      const body = await res.json() as { error: string };
      assert.match(body.error, /macOS/);
    }
  } finally {
    await ctx.cleanup();
  }
});

test('/open: finder/terminal builtins use injected launchers on macOS', async () => {
  const ctx = await setup({ platform: 'darwin' });
  try {
    for (const builtin of ['finder', 'terminal']) {
      const res = await ctx.appCtx.fetch(
        `/api/working_trees/ws:${ctx.workspaceId}/open`,
        { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: 'foo.md', builtin }) },
      );
      assert.equal(res.status, 200);
    }
    assert.deepEqual(ctx.appCtx.openedCommands, [
      {
        mode: 'detached',
        command: { command: 'open', argv: ['-R', join(ctx.workspacePath, 'foo.md')] },
      },
      {
        mode: 'detached',
        command: { command: 'open', argv: ['-a', 'Terminal', ctx.workspacePath] },
      },
    ]);
  } finally {
    await ctx.cleanup();
  }
});

test('/open default: awaited macOS launcher success returns 200', async () => {
  const ctx = await setup({ platform: 'darwin' });
  try {
    const res = await ctx.appCtx.fetch(
      `/api/working_trees/ws:${ctx.workspaceId}/open`,
      { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'foo.md', builtin: 'default' }) },
    );
    assert.equal(res.status, 200);
    assert.deepEqual(ctx.appCtx.openedCommands, [{
      mode: 'sync',
      command: { command: 'open', argv: [join(ctx.workspacePath, 'foo.md')] },
    }]);
  } finally {
    await ctx.cleanup();
  }
});

test('/open default: awaited macOS launcher failure returns 422 no-app', async () => {
  const ctx = await setup({
    platform: 'darwin',
    runOpenSync() {
      throw new Error('no application knows how to open the file');
    },
  });
  try {
    const res = await ctx.appCtx.fetch(
      `/api/working_trees/ws:${ctx.workspaceId}/open`,
      { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'foo.md', builtin: 'default' }) },
    );
    assert.equal(res.status, 422);
    assert.deepEqual(await res.json(), { error: 'no-app' });
    assert.deepEqual(ctx.appCtx.openedCommands, []);
  } finally {
    await ctx.cleanup();
  }
});

test('/open: 400 on missing path body', async () => {
  const ctx = await setup();
  try {
    const res = await ctx.appCtx.fetch(
      `/api/working_trees/ws:${ctx.workspaceId}/open`,
      { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}) },
    );
    assert.equal(res.status, 400);
  } finally {
    await ctx.cleanup();
  }
});

test('/open: known editor_id uses the injected detached launcher', async () => {
  const ctx = await setup();
  try {
    saveConfig(ctx.appCtx.db, {
      external_editors: [
        { id: 'e1', name: 'Editor', command: '/example/editor', args: ['--file', '{path}'] },
      ],
    });
    const res = await ctx.appCtx.fetch(
      `/api/working_trees/ws:${ctx.workspaceId}/open`,
      { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'foo.md', editor_id: 'e1' }) },
    );
    assert.equal(res.status, 200);
    const body = await res.json() as { ok: boolean };
    assert.equal(body.ok, true);
    assert.deepEqual(ctx.appCtx.openedCommands, [{
      mode: 'detached',
      command: {
        command: '/example/editor',
        argv: ['--file', join(ctx.workspacePath, 'foo.md')],
      },
    }]);
  } finally {
    await ctx.cleanup();
  }
});
