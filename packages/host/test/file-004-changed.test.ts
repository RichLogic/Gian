// Coverage for traceability row:
//   FILE-004 — /changed endpoint must parse `git status --porcelain=1 -z`
//              into the four `kind`s (create / update / delete / rename),
//              attach numstat (added / removed) for tracked changes, and
//              count line-counts for untracked text files.
//
// Drives the route via `makeTestApp` + a real git fixture. Each test
// engineers a specific status row shape and asserts the JSON envelope.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { writeFileSync, unlinkSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { makeTestApp, type TestAppCtx } from './fixtures/test-app.js';
import { createGitRepo, type GitRepo } from './fixtures/git-repo.js';

interface ChangedCtx {
  appCtx: TestAppCtx;
  repo: GitRepo;
  workspaceId: string;
  treeId: string;
  cleanup: () => Promise<void>;
}

async function setup(): Promise<ChangedCtx> {
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
    workspaceId,
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

async function fetchChanged(ctx: ChangedCtx): Promise<ChangedEntry[]> {
  const res = await ctx.appCtx.fetch(`/api/working_trees/${ctx.treeId}/changed`);
  assert.equal(res.status, 200, `/changed fetch failed: ${res.status}`);
  return await res.json() as ChangedEntry[];
}

// ---------------------------------------------------------------------------
// FILE-004 — empty repo
// ---------------------------------------------------------------------------

test('FILE-004: /changed returns [] for a clean repo', async () => {
  const ctx = await setup();
  try {
    const out = await fetchChanged(ctx);
    assert.deepEqual(out, [],
      'clean repo must return [] — Files-Changed renders the "no changes" empty state');
  } finally {
    await ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// FILE-004 — kind=update (existing tracked file modified)
// ---------------------------------------------------------------------------

test('FILE-004: modifying a tracked file is reported with kind=update and unstaged', async () => {
  const ctx = await setup();
  try {
    writeFileSync(join(ctx.repo.path, 'src/app.ts'),
      "console.log('init')\nconsole.log('added line')\n");
    const out = await fetchChanged(ctx);
    const entry = out.find(e => e.path === 'src/app.ts');
    assert.ok(entry, 'modified file must appear in /changed output');
    assert.equal(entry!.kind, 'update');
    assert.equal(entry!.staged, false, 'unstaged modification must be staged=false');
  } finally {
    await ctx.cleanup();
  }
});

test('FILE-004: staging a modified tracked file flips staged=true', async () => {
  const ctx = await setup();
  try {
    writeFileSync(join(ctx.repo.path, 'src/app.ts'), 'new content\n');
    ctx.repo.git(['add', 'src/app.ts']);
    const out = await fetchChanged(ctx);
    const entry = out.find(e => e.path === 'src/app.ts');
    assert.ok(entry);
    assert.equal(entry!.staged, true);
    assert.equal(entry!.kind, 'update');
  } finally {
    await ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// FILE-004 — kind=create (staged new file) vs untracked (?)
// ---------------------------------------------------------------------------

test('FILE-004: an untracked file is reported with kind=create and staged=false', async () => {
  const ctx = await setup();
  try {
    writeFileSync(join(ctx.repo.path, 'NEW.md'), 'line 1\nline 2\nline 3\n');
    const out = await fetchChanged(ctx);
    const entry = out.find(e => e.path === 'NEW.md');
    assert.ok(entry, 'untracked file must appear in /changed output');
    assert.equal(entry!.kind, 'create');
    assert.equal(entry!.staged, false,
      'untracked files are NOT staged (status code "??") even though the kind is create');
    assert.equal(entry!.added, 3,
      'untracked file added count must equal its line count (3 newlines → 3 lines)');
  } finally {
    await ctx.cleanup();
  }
});

test('FILE-004: a staged new file is reported with kind=create AND staged=true', async () => {
  const ctx = await setup();
  try {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(ctx.repo.path, 'docs'), { recursive: true });
    writeFileSync(join(ctx.repo.path, 'docs/note.md'), 'note\n');
    ctx.repo.git(['add', 'docs/note.md']);
    const out = await fetchChanged(ctx);
    const entry = out.find(e => e.path === 'docs/note.md');
    assert.ok(entry);
    assert.equal(entry!.kind, 'create');
    assert.equal(entry!.staged, true);
  } finally {
    await ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// FILE-004 — kind=delete
// ---------------------------------------------------------------------------

test('FILE-004: deleting a tracked file is reported with kind=delete', async () => {
  const ctx = await setup();
  try {
    unlinkSync(join(ctx.repo.path, 'src/util.ts'));
    const out = await fetchChanged(ctx);
    const entry = out.find(e => e.path === 'src/util.ts');
    assert.ok(entry);
    assert.equal(entry!.kind, 'delete');
    assert.equal(entry!.staged, false,
      'an `rm` without `git rm` is unstaged');
  } finally {
    await ctx.cleanup();
  }
});

test('FILE-004: `git rm` for a tracked file is reported staged=true', async () => {
  const ctx = await setup();
  try {
    ctx.repo.git(['rm', 'src/util.ts']);
    const out = await fetchChanged(ctx);
    const entry = out.find(e => e.path === 'src/util.ts');
    assert.ok(entry);
    assert.equal(entry!.kind, 'delete');
    assert.equal(entry!.staged, true);
  } finally {
    await ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// FILE-004 — kind=rename
// ---------------------------------------------------------------------------

test('FILE-004: a `git mv`-renamed file is reported with kind=rename', async () => {
  const ctx = await setup();
  try {
    ctx.repo.git(['mv', 'src/util.ts', 'src/utility.ts']);
    const out = await fetchChanged(ctx);
    // The rename appears as a single entry with kind='rename'. The
    // route discards the trailing old-name record from the -z stream.
    const entry = out.find(e => e.path === 'src/utility.ts');
    assert.ok(entry, 'renamed file must appear under its NEW name');
    assert.equal(entry!.kind, 'rename');
    assert.equal(entry!.staged, true,
      '`git mv` stages the rename — staged=true');
    // src/util.ts should NOT appear separately as a delete — the
    // rename record consumes both records from the -z stream.
    assert.equal(out.find(e => e.path === 'src/util.ts'), undefined,
      'rename must NOT also produce a separate delete entry for the old path');
  } finally {
    await ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// FILE-004 — numstat: added / removed for tracked diffs
// ---------------------------------------------------------------------------

test('FILE-004: tracked update populates added/removed line counts via `git diff --numstat HEAD`', async () => {
  const ctx = await setup();
  try {
    // Replace a 1-line file with 3 lines → +3 -1 (the original line is
    // gone, three new lines added).
    writeFileSync(join(ctx.repo.path, 'src/util.ts'),
      'line a\nline b\nline c\nline d\n');
    const out = await fetchChanged(ctx);
    const entry = out.find(e => e.path === 'src/util.ts');
    assert.ok(entry);
    assert.equal(entry!.kind, 'update');
    assert.ok(entry!.added >= 1,
      `added must be > 0 after replacing the file; got ${entry!.added}`);
    assert.ok(entry!.removed >= 1,
      `removed must be > 0 since the original line vanished; got ${entry!.removed}`);
  } finally {
    await ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// FILE-004 — error paths
// ---------------------------------------------------------------------------

test('FILE-004: /changed on a non-existent working_trees id returns 404', async () => {
  const ctx = await setup();
  try {
    const res = await ctx.appCtx.fetch('/api/working_trees/no-such-tree/changed');
    assert.equal(res.status, 404);
  } finally {
    await ctx.cleanup();
  }
});

test('FILE-004: /changed on a workspace path that is NOT a git repo returns [] (graceful)', async () => {
  // Drop the .git dir on the existing repo to simulate a non-repo
  // workspace (vs. setting up a fresh non-repo workspace, which would
  // collide with the fixture). git status will exit non-zero and the
  // route catches → [].
  const ctx = await setup();
  try {
    ctx.repo.git(['add', '-A']);
    // Wipe the .git dir to remove repo-ness.
    const fs = await import('node:fs');
    fs.rmSync(join(ctx.repo.path, '.git'), { recursive: true, force: true });
    const out = await fetchChanged(ctx);
    assert.deepEqual(out, [],
      'a path that is not a git repo must return [] — the Files panel renders "no changes"');
  } finally {
    await ctx.cleanup();
  }
});

// Suppress unused-import warning for renameSync (intentional — the route
// handles `git mv` renames itself; we don't need to call renameSync here).
void renameSync;
