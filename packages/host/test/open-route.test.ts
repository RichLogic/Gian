import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeTestApp, type TestAppCtx } from './fixtures/test-app.js';
import { saveConfig } from '../src/storage/config.js';

interface Ctx {
  appCtx: TestAppCtx;
  workspaceId: string;
  workspacePath: string;
  cleanup: () => Promise<void>;
}

async function setup(): Promise<Ctx> {
  const appCtx = await makeTestApp();
  const workspaceId = randomUUID();
  const workspacePath = mkdtempSync(join(tmpdir(), 'gian-open-'));
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

test('/open: known editor_id passes pre-spawn checks', async () => {
  const ctx = await setup();
  try {
    // Seed an editor pointing at a no-op shell builtin so spawn succeeds
    // without launching a GUI app. `true` exists on macOS + Linux; on
    // Windows skip this assertion.
    if (process.platform === 'win32') return;
    saveConfig(ctx.appCtx.db, {
      external_editors: [
        { id: 'e1', name: 'true', command: 'true', args: [] },
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
  } finally {
    await ctx.cleanup();
  }
});
