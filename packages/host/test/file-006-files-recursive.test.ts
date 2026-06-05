// Coverage for traceability row:
//   FILE-006 — The recursive /files endpoint (FILES panel search index) must
//              list every file at every depth as workspace-relative paths,
//              applying the same ignore rules as /tree (dotfiles +
//              node_modules), and 404 on an unknown working tree.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { makeTestApp, type TestAppCtx } from './fixtures/test-app.js';

interface Ctx {
  appCtx: TestAppCtx;
  workspaceId: string;
  cleanup: () => Promise<void>;
}

async function setup(files: Record<string, string>): Promise<Ctx> {
  const appCtx = await makeTestApp();
  const workspacePath = mkdtempSync(join(tmpdir(), 'gian-file005-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(workspacePath, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  const workspaceId = randomUUID();
  appCtx.db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)')
    .run(workspaceId, 'demo', workspacePath);
  return {
    appCtx,
    workspaceId,
    cleanup: async () => {
      await appCtx.cleanup();
      rmSync(workspacePath, { recursive: true, force: true });
    },
  };
}

async function files(ctx: Ctx): Promise<string[]> {
  const res = await ctx.appCtx.fetch(`/api/working_trees/ws:${ctx.workspaceId}/files`);
  assert.equal(res.status, 200, `files fetch failed: ${res.status}`);
  const body = (await res.json()) as { files: string[] };
  return body.files;
}

test('FILE-006: /files returns every file recursively as workspace-relative paths', async () => {
  const ctx = await setup({
    'README.md': '# demo',
    'src/index.ts': 'export {}',
    'src/util/helpers.ts': 'export const x = 1',
    'docs/notes/todo.md': '- thing',
  });
  try {
    const out = await files(ctx);
    const set = new Set(out);
    assert.ok(set.has('README.md'));
    assert.ok(set.has('src/index.ts'));
    assert.ok(set.has('src/util/helpers.ts'), 'must descend into nested dirs');
    assert.ok(set.has('docs/notes/todo.md'));
    // Paths are relative, never absolute.
    assert.ok(out.every(p => !p.startsWith('/')), 'paths must be workspace-relative');
  } finally {
    await ctx.cleanup();
  }
});

test('FILE-006: /files hides dotfiles, dot-dirs, and node_modules at every depth', async () => {
  const ctx = await setup({
    '.env': 'SECRET=x',
    'keep.ts': 'a',
    'src/.cache/tmp.ts': 'a',
    'src/real.ts': 'a',
    'node_modules/pkg/index.js': 'a',
    'src/node_modules/nested/x.js': 'a',
  });
  try {
    const out = await files(ctx);
    assert.ok(out.includes('keep.ts'));
    assert.ok(out.includes('src/real.ts'));
    assert.ok(!out.some(p => p.includes('.env')), 'must skip dotfiles');
    assert.ok(!out.some(p => p.includes('.cache')), 'must skip dot-dirs at depth');
    assert.ok(!out.some(p => p.includes('node_modules')),
      'must skip node_modules at root AND nested');
  } finally {
    await ctx.cleanup();
  }
});

test('FILE-006: /files on an unknown working tree returns 404', async () => {
  const ctx = await setup({ 'a.ts': 'x' });
  try {
    const res = await ctx.appCtx.fetch('/api/working_trees/no-such-tree/files');
    assert.equal(res.status, 404);
  } finally {
    await ctx.cleanup();
  }
});
