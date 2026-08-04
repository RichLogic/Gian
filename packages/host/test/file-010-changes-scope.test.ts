// Coverage for the "Changes review" backend (FILE-010):
//   - GET /api/working_trees/:id/changed?scope=all|unstaged|staged buckets a
//     file into the right slice with the right per-file line counts.
//   - GET /api/working_trees/:id/diff?scope=... selects the matching git diff.
//   - POST /api/working_trees/:id/stage  (git add)   moves a file into staged.
//   - POST /api/working_trees/:id/unstage (git reset HEAD) reverses it.
//   - The default `changed` (no scope) is byte-for-byte the legacy shape.
//
// Drives the routes via `makeTestApp` + a real git fixture, mirroring
// file-004-changed.test.ts.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { makeTestApp, type TestAppCtx } from './fixtures/test-app.js';
import { createGitRepo, type GitRepo } from './fixtures/git-repo.js';

interface Ctx {
  appCtx: TestAppCtx;
  repo: GitRepo;
  treeId: string;
  cleanup: () => Promise<void>;
}

async function setup(): Promise<Ctx> {
  const appCtx = await makeTestApp();
  const repo = createGitRepo({
    initialBranch: 'main',
    files: {
      'README.md': '# initial\n',
      'src/app.ts': "console.log('init')\n",
      'src/util.ts': 'export const u = 1;\n',
    },
  });
  const workspaceId = randomUUID();
  appCtx.db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)')
    .run(workspaceId, 'demo', repo.path);
  return {
    appCtx,
    repo,
    treeId: `ws:${workspaceId}`,
    cleanup: async () => {
      await appCtx.cleanup();
      repo.cleanup();
    },
  };
}

interface ChangedEntry {
  path: string;
  kind: 'create' | 'update' | 'delete' | 'rename';
  staged: boolean;
  added: number;
  removed: number;
}

async function fetchChanged(ctx: Ctx, scope?: string): Promise<ChangedEntry[]> {
  const q = scope ? `?scope=${scope}` : '';
  const res = await ctx.appCtx.fetch(`/api/working_trees/${ctx.treeId}/changed${q}`);
  assert.equal(res.status, 200, `/changed fetch failed: ${res.status}`);
  return await res.json() as ChangedEntry[];
}

async function fetchDiff(ctx: Ctx, path: string, scope?: string): Promise<string> {
  const q = scope ? `&scope=${scope}` : '';
  const res = await ctx.appCtx.fetch(
    `/api/working_trees/${ctx.treeId}/diff?path=${encodeURIComponent(path)}${q}`,
  );
  assert.equal(res.status, 200, `/diff fetch failed: ${res.status}`);
  return ((await res.json()) as { diff: string }).diff;
}

async function postPath(ctx: Ctx, action: 'stage' | 'unstage', path: string): Promise<Response> {
  return ctx.appCtx.fetch(`/api/working_trees/${ctx.treeId}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path }),
  });
}

// ---------------------------------------------------------------------------
// (a) scope=staged vs scope=unstaged bucket a modified file correctly.
// ---------------------------------------------------------------------------

test('FILE-010: a partially staged file appears in BOTH staged and unstaged scopes with the right counts', async () => {
  const ctx = await setup();
  try {
    // First edit + stage it (index now has +3 over HEAD).
    writeFileSync(join(ctx.repo.path, 'src/util.ts'),
      'export const u = 1;\nadded a\nadded b\nadded c\n');
    ctx.repo.git(['add', 'src/util.ts']);
    // Then add a further worktree-only edit (worktree now ahead of index).
    writeFileSync(join(ctx.repo.path, 'src/util.ts'),
      'export const u = 1;\nadded a\nadded b\nadded c\nworktree only\n');

    const staged = await fetchChanged(ctx, 'staged');
    const unstaged = await fetchChanged(ctx, 'unstaged');

    const s = staged.find(e => e.path === 'src/util.ts');
    const u = unstaged.find(e => e.path === 'src/util.ts');

    assert.ok(s, 'file must appear in staged scope (index vs HEAD differs)');
    assert.equal(s!.staged, true, 'staged-scope entries are staged=true');
    assert.equal(s!.kind, 'update');
    assert.equal(s!.added, 3, 'staged scope counts index-vs-HEAD: +3');
    assert.equal(s!.removed, 0);

    assert.ok(u, 'file must appear in unstaged scope (worktree vs index differs)');
    assert.equal(u!.staged, false, 'unstaged-scope entries are staged=false');
    assert.equal(u!.kind, 'update');
    assert.equal(u!.added, 1, 'unstaged scope counts worktree-vs-index: +1');
    assert.equal(u!.removed, 0);
  } finally {
    await ctx.cleanup();
  }
});

test('FILE-010: a fully-staged file is in staged scope only, NOT unstaged', async () => {
  const ctx = await setup();
  try {
    writeFileSync(join(ctx.repo.path, 'src/app.ts'),
      "console.log('init')\nconsole.log('x')\n");
    ctx.repo.git(['add', 'src/app.ts']);

    const staged = await fetchChanged(ctx, 'staged');
    const unstaged = await fetchChanged(ctx, 'unstaged');

    assert.ok(staged.find(e => e.path === 'src/app.ts'), 'fully staged → staged scope');
    assert.equal(unstaged.find(e => e.path === 'src/app.ts'), undefined,
      'fully staged file has nothing dirty in the worktree → absent from unstaged');
  } finally {
    await ctx.cleanup();
  }
});

test('FILE-010: an untracked file is in unstaged scope but NOT staged scope', async () => {
  const ctx = await setup();
  try {
    writeFileSync(join(ctx.repo.path, 'NEW.md'), 'a\nb\n');
    const staged = await fetchChanged(ctx, 'staged');
    const unstaged = await fetchChanged(ctx, 'unstaged');
    const u = unstaged.find(e => e.path === 'NEW.md');
    assert.ok(u, 'untracked file is an unstaged change');
    assert.equal(u!.kind, 'create');
    assert.equal(u!.staged, false);
    assert.equal(u!.added, 2, 'untracked line count via on-disk probe');
    assert.equal(staged.find(e => e.path === 'NEW.md'), undefined,
      'untracked file has nothing in the index → absent from staged scope');
  } finally {
    await ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// (b) stage → file shows staged; unstage reverses it.
// ---------------------------------------------------------------------------

test('FILE-010: POST /stage moves a modified file into the staged scope; /unstage reverses it', async () => {
  const ctx = await setup();
  try {
    writeFileSync(join(ctx.repo.path, 'src/app.ts'),
      "console.log('init')\nconsole.log('staged me')\n");

    // Before staging: unstaged only.
    let staged = await fetchChanged(ctx, 'staged');
    let unstaged = await fetchChanged(ctx, 'unstaged');
    assert.equal(staged.find(e => e.path === 'src/app.ts'), undefined);
    assert.ok(unstaged.find(e => e.path === 'src/app.ts'));

    // Stage.
    const stageRes = await postPath(ctx, 'stage', 'src/app.ts');
    assert.equal(stageRes.status, 200);
    assert.deepEqual(await stageRes.json(), { ok: true });

    staged = await fetchChanged(ctx, 'staged');
    unstaged = await fetchChanged(ctx, 'unstaged');
    const s = staged.find(e => e.path === 'src/app.ts');
    assert.ok(s, 'after /stage the file is in staged scope');
    assert.equal(s!.staged, true);
    assert.equal(unstaged.find(e => e.path === 'src/app.ts'), undefined,
      'after /stage nothing remains dirty in the worktree → absent from unstaged');

    // Unstage reverses it.
    const unstageRes = await postPath(ctx, 'unstage', 'src/app.ts');
    assert.equal(unstageRes.status, 200);
    assert.deepEqual(await unstageRes.json(), { ok: true });

    staged = await fetchChanged(ctx, 'staged');
    unstaged = await fetchChanged(ctx, 'unstaged');
    assert.equal(staged.find(e => e.path === 'src/app.ts'), undefined,
      'after /unstage the file leaves the staged scope');
    assert.ok(unstaged.find(e => e.path === 'src/app.ts'),
      'after /unstage the change is back in the worktree (unstaged) scope');
  } finally {
    await ctx.cleanup();
  }
});

test('FILE-010: POST /stage works for an untracked file (git add)', async () => {
  const ctx = await setup();
  try {
    writeFileSync(join(ctx.repo.path, 'fresh.txt'), 'hi\n');
    const res = await postPath(ctx, 'stage', 'fresh.txt');
    assert.equal(res.status, 200);
    const staged = await fetchChanged(ctx, 'staged');
    const s = staged.find(e => e.path === 'fresh.txt');
    assert.ok(s, 'a freshly-added untracked file shows up staged');
    assert.equal(s!.kind, 'create');
    assert.equal(s!.staged, true);
  } finally {
    await ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// stage/unstage error paths.
// ---------------------------------------------------------------------------

test('FILE-010: /stage and /unstage 404 on an unknown working tree', async () => {
  const ctx = await setup();
  try {
    for (const action of ['stage', 'unstage'] as const) {
      const res = await ctx.appCtx.fetch(`/api/working_trees/no-such/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'README.md' }),
      });
      assert.equal(res.status, 404, `${action} on missing tree must 404`);
    }
  } finally {
    await ctx.cleanup();
  }
});

test('FILE-010: /stage and /unstage 400 when path is missing/empty', async () => {
  const ctx = await setup();
  try {
    for (const action of ['stage', 'unstage'] as const) {
      const res = await postPath(ctx, action, '');
      assert.equal(res.status, 400, `${action} with empty path must 400`);
    }
  } finally {
    await ctx.cleanup();
  }
});

test('FILE-010: /stage rejects a path that escapes the working tree (400)', async () => {
  const ctx = await setup();
  try {
    const res = await postPath(ctx, 'stage', '../escape.txt');
    assert.equal(res.status, 400, 'traversal must be rejected');
  } finally {
    await ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// /diff?scope selects the matching git diff.
// ---------------------------------------------------------------------------

test('FILE-010: /diff?scope=staged shows only the staged hunk; scope=unstaged shows only the worktree hunk', async () => {
  const ctx = await setup();
  try {
    writeFileSync(join(ctx.repo.path, 'src/util.ts'),
      'export const u = 1;\nSTAGED_LINE\n');
    ctx.repo.git(['add', 'src/util.ts']);
    writeFileSync(join(ctx.repo.path, 'src/util.ts'),
      'export const u = 1;\nSTAGED_LINE\nWORKTREE_LINE\n');

    const stagedDiff = await fetchDiff(ctx, 'src/util.ts', 'staged');
    const unstagedDiff = await fetchDiff(ctx, 'src/util.ts', 'unstaged');
    const allDiff = await fetchDiff(ctx, 'src/util.ts'); // default = all

    assert.ok(stagedDiff.includes('STAGED_LINE'), 'staged diff shows the staged add');
    assert.ok(!stagedDiff.includes('WORKTREE_LINE'),
      'staged diff (index vs HEAD) must NOT include the worktree-only line');

    assert.ok(unstagedDiff.includes('WORKTREE_LINE'),
      'unstaged diff (worktree vs index) shows the worktree-only add');
    assert.ok(!unstagedDiff.includes('+STAGED_LINE'),
      'unstaged diff must NOT re-add the already-staged line');

    assert.ok(allDiff.includes('STAGED_LINE') && allDiff.includes('WORKTREE_LINE'),
      'default (all = diff HEAD) shows both staged and worktree lines');
  } finally {
    await ctx.cleanup();
  }
});

test('FILE-010: /diff?scope=staged is empty for an untracked file (nothing in the index)', async () => {
  const ctx = await setup();
  try {
    writeFileSync(join(ctx.repo.path, 'untracked.txt'), 'x\n');
    const stagedDiff = await fetchDiff(ctx, 'untracked.txt', 'staged');
    assert.equal(stagedDiff, '', 'untracked file has no staged diff');
    const unstagedDiff = await fetchDiff(ctx, 'untracked.txt', 'unstaged');
    assert.ok(unstagedDiff.includes('untracked.txt'),
      'untracked file IS synthesized in unstaged scope via --no-index');
  } finally {
    await ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// (c) default `changed` (no scope) is unchanged from the legacy behavior.
// ---------------------------------------------------------------------------

test('FILE-010: default /changed (no scope) == /changed?scope=all and matches the legacy combined shape', async () => {
  const ctx = await setup();
  try {
    // A staged edit, a worktree-only edit, and an untracked file — enough to
    // distinguish the slices.
    writeFileSync(join(ctx.repo.path, 'src/app.ts'),
      "console.log('init')\nstaged edit\n");
    ctx.repo.git(['add', 'src/app.ts']);
    writeFileSync(join(ctx.repo.path, 'src/util.ts'),
      'export const u = 1;\nworktree edit\n');
    writeFileSync(join(ctx.repo.path, 'NEW.md'), 'one\ntwo\n');

    const def = await fetchChanged(ctx);
    const all = await fetchChanged(ctx, 'all');
    assert.deepEqual(def, all,
      'no-scope must be byte-for-byte equal to scope=all (GitBadge depends on it)');

    // Legacy expectations: app.ts staged, util.ts unstaged, NEW.md untracked
    // with its on-disk line count, all in one list.
    const app = def.find(e => e.path === 'src/app.ts');
    const util = def.find(e => e.path === 'src/util.ts');
    const neu = def.find(e => e.path === 'NEW.md');
    assert.ok(app && util && neu, 'all three files present in the combined default list');
    assert.equal(app!.staged, true, 'staged file reports staged=true in default scope');
    assert.equal(util!.staged, false, 'worktree-only edit reports staged=false');
    assert.equal(neu!.kind, 'create');
    assert.equal(neu!.staged, false);
    assert.equal(neu!.added, 2, 'untracked on-disk line count preserved in default scope');
    // numstat HEAD covers app.ts (+1) — proves the combined counts path runs.
    assert.equal(app!.added, 1);
  } finally {
    await ctx.cleanup();
  }
});
