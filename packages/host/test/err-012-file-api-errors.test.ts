// ERR-012 — File APIs expose stable, actionable status/body pairs for every
// expected client failure. Binary data is rejected by the JSON text endpoint
// and remains byte-preserving through /raw.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { makeTestApp, type TestAppCtx } from './fixtures/test-app.js';

interface FileApiCtx {
  appCtx: TestAppCtx;
  workspacePath: string;
  treeId: string;
  cleanup: () => Promise<void>;
}

async function setup(files: Record<string, string | Buffer> = {}): Promise<FileApiCtx> {
  const appCtx = await makeTestApp();
  const workspacePath = mkdtempSync(join(tmpdir(), 'gian-err012-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(workspacePath, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  const workspaceId = randomUUID();
  appCtx.db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)')
    .run(workspaceId, 'ERR-012 fixture', workspacePath);
  return {
    appCtx,
    workspacePath,
    treeId: `ws:${workspaceId}`,
    cleanup: async () => {
      await appCtx.cleanup();
      rmSync(workspacePath, { recursive: true, force: true });
    },
  };
}

async function errorBody(res: Response): Promise<string> {
  return ((await res.json()) as { error: string }).error;
}

test('ERR-012: /file and /raw reject missing path and unknown tree consistently', async () => {
  const ctx = await setup();
  try {
    for (const endpoint of ['file', 'raw']) {
      const missingPath = await ctx.appCtx.fetch(`/api/working_trees/${ctx.treeId}/${endpoint}`);
      assert.equal(missingPath.status, 400);
      assert.equal(await errorBody(missingPath), 'path required');

      const missingTree = await ctx.appCtx.fetch(`/api/working_trees/ws:no-such-tree/${endpoint}?path=a.txt`);
      assert.equal(missingTree.status, 404);
      assert.equal(await errorBody(missingTree), 'working tree not found');
    }
    const workspaceId = ctx.treeId.slice('ws:'.length);
    const legacyMissingPath = await ctx.appCtx.fetch(`/api/workspaces/${workspaceId}/file`);
    assert.equal(legacyMissingPath.status, 400);
    assert.equal(await errorBody(legacyMissingPath), 'path required');
    const legacyMissingWorkspace = await ctx.appCtx.fetch('/api/workspaces/no-such-workspace/file?path=a.txt');
    assert.equal(legacyMissingWorkspace.status, 404);
    assert.equal(await errorBody(legacyMissingWorkspace), 'workspace not found');
  } finally {
    await ctx.cleanup();
  }
});

test('ERR-012: /file and /raw map a missing file to stable 404', async () => {
  const ctx = await setup();
  try {
    for (const endpoint of ['file', 'raw']) {
      const res = await ctx.appCtx.fetch(`/api/working_trees/${ctx.treeId}/${endpoint}?path=missing.txt`);
      assert.equal(res.status, 404);
      assert.equal(await errorBody(res), 'file not found');
    }
    const workspaceId = ctx.treeId.slice('ws:'.length);
    const legacy = await ctx.appCtx.fetch(`/api/workspaces/${workspaceId}/file?path=missing.txt`);
    assert.equal(legacy.status, 404);
    assert.equal(await errorBody(legacy), 'file not found');
  } finally {
    await ctx.cleanup();
  }
});

test('ERR-012: /file and /raw reject directory reads with stable 400', async () => {
  const ctx = await setup();
  try {
    mkdirSync(join(ctx.workspacePath, 'docs'));
    for (const endpoint of ['file', 'raw']) {
      const res = await ctx.appCtx.fetch(`/api/working_trees/${ctx.treeId}/${endpoint}?path=docs`);
      assert.equal(res.status, 400);
      assert.equal(await errorBody(res), 'not a file');
    }
    const workspaceId = ctx.treeId.slice('ws:'.length);
    const legacy = await ctx.appCtx.fetch(`/api/workspaces/${workspaceId}/file?path=docs`);
    assert.equal(legacy.status, 400);
    assert.equal(await errorBody(legacy), 'not a file');
  } finally {
    await ctx.cleanup();
  }
});

test('ERR-012: text and raw endpoints enforce their documented size limits', async () => {
  const ctx = await setup({
    'text-too-large.txt': Buffer.alloc(1024 * 1024 + 1, 0x61),
    'raw-too-large.bin': Buffer.alloc(20 * 1024 * 1024 + 1, 0x61),
  });
  try {
    const text = await ctx.appCtx.fetch(`/api/working_trees/${ctx.treeId}/file?path=text-too-large.txt`);
    assert.equal(text.status, 413);
    assert.equal(await errorBody(text), 'file too large');

    const workspaceId = ctx.treeId.slice('ws:'.length);
    const legacyText = await ctx.appCtx.fetch(`/api/workspaces/${workspaceId}/file?path=text-too-large.txt`);
    assert.equal(legacyText.status, 413);
    assert.equal(await errorBody(legacyText), 'file too large');

    const raw = await ctx.appCtx.fetch(`/api/working_trees/${ctx.treeId}/raw?path=raw-too-large.bin`);
    assert.equal(raw.status, 413);
    assert.equal(await errorBody(raw), 'file too large');
  } finally {
    await ctx.cleanup();
  }
});

test('ERR-012: binary content is explicit on /file and byte-preserving on /raw', async () => {
  const binary = Buffer.from([0x00, 0xff, 0x41, 0x0a]);
  const ctx = await setup({ 'blob.bin': binary });
  try {
    const text = await ctx.appCtx.fetch(`/api/working_trees/${ctx.treeId}/file?path=blob.bin`);
    assert.equal(text.status, 415);
    assert.equal(await errorBody(text), 'binary file; use raw endpoint');

    const workspaceId = ctx.treeId.slice('ws:'.length);
    const legacy = await ctx.appCtx.fetch(`/api/workspaces/${workspaceId}/file?path=blob.bin`);
    assert.equal(legacy.status, 415);
    assert.equal(await errorBody(legacy), 'binary file; use raw endpoint');

    const raw = await ctx.appCtx.fetch(`/api/working_trees/${ctx.treeId}/raw?path=blob.bin`);
    assert.equal(raw.status, 200);
    assert.equal(raw.headers.get('Content-Type'), 'application/octet-stream');
    assert.equal(raw.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.deepEqual(Buffer.from(await raw.arrayBuffer()), binary);
  } finally {
    await ctx.cleanup();
  }
});

test('ERR-012: ENOTDIR paths are stable 404s instead of internal errors', async () => {
  const ctx = await setup({ 'plain.txt': 'text' });
  try {
    const workspaceId = ctx.treeId.slice('ws:'.length);
    for (const url of [
      `/api/working_trees/${ctx.treeId}/file?path=plain.txt/child`,
      `/api/working_trees/${ctx.treeId}/raw?path=plain.txt/child`,
      `/api/workspaces/${workspaceId}/file?path=plain.txt/child`,
    ]) {
      const response = await ctx.appCtx.fetch(url);
      assert.equal(response.status, 404, url);
      assert.equal(await errorBody(response), 'file not found', url);
    }
  } finally {
    await ctx.cleanup();
  }
});
