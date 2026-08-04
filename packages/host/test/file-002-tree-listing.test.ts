// Coverage for traceability row:
//   FILE-002 — File/Tree API must hide `.` dirs and `node_modules`,
//              cap text-file reads at 1 MiB, and return tree entries in
//              a stable sort (dirs first, then alphabetical).
//
// SEC-005 / SEC-008 already cover the path-traversal safety side.
// Round-4 `err-013-git-failures.test.ts` already covers the 1 MiB cap
// for /file. This file fills the remaining FILE-002 dimensions:
// the /tree endpoint's filtering + sort contract.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { makeTestApp, type TestAppCtx } from './fixtures/test-app.js';

interface TreeCtx {
  appCtx: TestAppCtx;
  workspacePath: string;
  workspaceId: string;
  cleanup: () => Promise<void>;
}

async function setupTree(opts: { files: Record<string, string>; dirs?: string[] }): Promise<TreeCtx> {
  const appCtx = await makeTestApp();
  const workspacePath = mkdtempSync(join(tmpdir(), 'gian-file002-'));
  // Seed dirs first so empty dirs survive.
  for (const dir of opts.dirs ?? []) {
    mkdirSync(join(workspacePath, dir), { recursive: true });
  }
  for (const [rel, content] of Object.entries(opts.files)) {
    const abs = join(workspacePath, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  const workspaceId = randomUUID();
  appCtx.db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)')
    .run(workspaceId, 'demo', workspacePath);
  return {
    appCtx,
    workspacePath,
    workspaceId,
    cleanup: async () => {
      await appCtx.cleanup();
      rmSync(workspacePath, { recursive: true, force: true });
    },
  };
}

interface TreeEntry { name: string; type: 'dir' | 'file'; path: string }

async function tree(ctx: TreeCtx, path = ''): Promise<TreeEntry[]> {
  const url = path
    ? `/api/working_trees/ws:${ctx.workspaceId}/tree?path=${encodeURIComponent(path)}`
    : `/api/working_trees/ws:${ctx.workspaceId}/tree`;
  const res = await ctx.appCtx.fetch(url);
  assert.equal(res.status, 200, `tree fetch failed: ${res.status}`);
  return (await res.json()) as TreeEntry[];
}

// ---------------------------------------------------------------------------
// FILE-002 — hidden-dir + node_modules filter
// ---------------------------------------------------------------------------

test('FILE-002: tree listing hides dot-prefixed entries (files AND dirs)', async () => {
  const ctx = await setupTree({
    dirs: ['.git', '.claude'],
    files: {
      '.env': 'SECRET=xxx',
      '.gitignore': 'dist',
      'README.md': '# demo',
      'src/app.ts': 'console.log("hi")',
    },
  });
  try {
    const entries = await tree(ctx);
    const names = entries.map(e => e.name);
    assert.ok(!names.includes('.git'), 'must hide .git dir');
    assert.ok(!names.includes('.claude'), 'must hide .claude dir');
    assert.ok(!names.includes('.env'), 'must hide .env file');
    assert.ok(!names.includes('.gitignore'), 'must hide .gitignore file');
    assert.ok(names.includes('README.md'), 'visible README.md must surface');
    assert.ok(names.includes('src'), 'visible src/ must surface');
  } finally {
    await ctx.cleanup();
  }
});

test('FILE-002: tree listing hides `node_modules` even though it does not start with a dot', async () => {
  const ctx = await setupTree({
    dirs: ['node_modules', 'src'],
    files: {
      'package.json': '{"name":"demo"}',
      'node_modules/.bin/foo': 'x',
      'src/index.ts': 'export {};',
    },
  });
  try {
    const entries = await tree(ctx);
    const names = entries.map(e => e.name);
    assert.ok(!names.includes('node_modules'),
      'node_modules must be hidden — it would dominate every tree and breaks the picker');
    assert.ok(names.includes('package.json'));
    assert.ok(names.includes('src'));
  } finally {
    await ctx.cleanup();
  }
});

test('FILE-002: tree filtering applies at every depth (subdir of a visible dir still hides dot entries)', async () => {
  const ctx = await setupTree({
    dirs: ['src/.cache'],
    files: {
      'src/index.ts': 'export {}',
      'src/.cache/.tmp': 'x',
      'src/utils.ts': 'export const u = 1',
    },
  });
  try {
    const subEntries = await tree(ctx, 'src');
    const names = subEntries.map(e => e.name);
    assert.ok(!names.includes('.cache'),
      'subdir listing must apply the same dot-filter as the root');
    assert.ok(names.includes('index.ts'));
    assert.ok(names.includes('utils.ts'));
  } finally {
    await ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// FILE-002 — sort order: dirs first, then alphabetical
// ---------------------------------------------------------------------------

test('FILE-002: tree returns dirs first, then files, each block alphabetically', async () => {
  const ctx = await setupTree({
    dirs: ['zzz-dir', 'aaa-dir', 'mmm-dir'],
    files: {
      'beta.ts': 'a',
      'alpha.ts': 'a',
      'gamma.ts': 'a',
    },
  });
  try {
    const entries = await tree(ctx);
    const ordered = entries.map(e => `${e.type}:${e.name}`);
    assert.deepEqual(ordered, [
      'dir:aaa-dir',
      'dir:mmm-dir',
      'dir:zzz-dir',
      'file:alpha.ts',
      'file:beta.ts',
      'file:gamma.ts',
    ], 'tree must group all dirs first (alphabetical) then all files (alphabetical)');
  } finally {
    await ctx.cleanup();
  }
});

test('FILE-002: tree sort is locale-aware via String.localeCompare (case-insensitive ish)', async () => {
  // localeCompare puts `Aardvark` and `apple` next to each other rather
  // than ASCII-ordering them. Pin the behavior so a future replacement
  // with a byte compare is loud.
  const ctx = await setupTree({
    files: {
      'Aardvark.ts': '',
      'apple.ts': '',
      'banana.ts': '',
      'Cake.ts': '',
    },
  });
  try {
    const entries = await tree(ctx);
    const names = entries.map(e => e.name);
    // The strict ASCII order would be Aardvark, Cake, apple, banana
    // (uppercase < lowercase). localeCompare interleaves them roughly
    // case-insensitively. Assert the latter.
    assert.deepEqual(names, ['Aardvark.ts', 'apple.ts', 'banana.ts', 'Cake.ts'],
      'localeCompare-based sort must group case-insensitively, NOT ASCII order');
  } finally {
    await ctx.cleanup();
  }
});

test('FILE-002: tree entry `path` is the workspace-relative path, not the absolute path', async () => {
  const ctx = await setupTree({
    files: { 'docs/notes.md': 'note' },
  });
  try {
    const entries = await tree(ctx);
    const docs = entries.find(e => e.name === 'docs');
    assert.ok(docs);
    assert.equal(docs!.path, 'docs',
      'top-level entry path must be the bare name, not an absolute path');

    const sub = await tree(ctx, 'docs');
    const notes = sub.find(e => e.name === 'notes.md');
    assert.equal(notes!.path, 'docs/notes.md',
      'nested entry path must be the workspace-relative path so the client can fetch it back');
  } finally {
    await ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// FILE-002 — graceful error paths
// ---------------------------------------------------------------------------

test('FILE-002: tree on unknown working_trees id returns 404', async () => {
  const ctx = await setupTree({ files: {} });
  try {
    const res = await ctx.appCtx.fetch('/api/working_trees/no-such-tree/tree');
    assert.equal(res.status, 404);
  } finally {
    await ctx.cleanup();
  }
});

test('FILE-002: tree with a path that escapes the working tree returns 400', async () => {
  const ctx = await setupTree({ files: { 'a.txt': 'x' } });
  try {
    const res = await ctx.appCtx.fetch(
      `/api/working_trees/ws:${ctx.workspaceId}/tree?path=${encodeURIComponent('../escape')}`,
    );
    assert.equal(res.status, 400);
    const body = await res.json() as { error: string };
    assert.match(body.error, /path escapes/);
  } finally {
    await ctx.cleanup();
  }
});

test('FILE-002: tree with a path pointing at a file (not a dir) returns 500 (readdir fails)', async () => {
  // The route doesn't pre-check that `path` is a directory — readdir
  // surfaces ENOTDIR which the route maps to 500. We pin this so the
  // contract is observable: clients can recognize the failure mode.
  const ctx = await setupTree({ files: { 'a.txt': 'hi' } });
  try {
    const res = await ctx.appCtx.fetch(
      `/api/working_trees/ws:${ctx.workspaceId}/tree?path=a.txt`,
    );
    assert.equal(res.status, 500,
      'readdir on a file path returns 500 with the underlying error in the body');
    const body = await res.json() as { error: string };
    assert.match(body.error, /ENOTDIR|not a directory/i);
  } finally {
    await ctx.cleanup();
  }
});
