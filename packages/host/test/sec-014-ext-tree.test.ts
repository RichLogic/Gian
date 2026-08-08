// Coverage for traceability row:
//   SEC-014 — ext: working-tree ids (external, agent-created worktrees) must
//             stay inside the same boundary as ws:/wt: ids. The id carries a
//             base64url-encoded path, but that path is a HINT ONLY:
//             resolveWorkingTree re-runs `git worktree list` for the named
//             workspace and accepts the id solely on membership. Stale
//             (removed worktree), forged (arbitrary directory), and malformed
//             ids must 404 exactly like other bad ids.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { makeTestApp, type TestAppCtx } from './fixtures/test-app.js';
import { createGitRepo, type GitRepo } from './fixtures/git-repo.js';
import { listGitWorktreesAsync } from '../src/workspace/git.js';

interface Ctx {
  appCtx: TestAppCtx;
  repo: GitRepo;
  workspaceId: string;
  workspacePath: string;
  worktreePath: string; // as reported by `git worktree list` (realpath form)
  cleanup: () => Promise<void>;
}

function extId(workspaceId: string, path: string): string {
  return `ext:${workspaceId}:${Buffer.from(path, 'utf8').toString('base64url')}`;
}

async function setup(): Promise<Ctx> {
  const appCtx = await makeTestApp();
  const repo = createGitRepo({ initialBranch: 'main' });
  // macOS tmpdir resolves through /private — the DB row stores the resolved
  // form so main-tree dedupe matches git's own report.
  const workspacePath = realpathSync(repo.path);
  const workspaceId = randomUUID();
  appCtx.db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)')
    .run(workspaceId, 'demo', workspacePath);

  const requested = `${repo.path}-agent-wt`;
  repo.git(['worktree', 'add', '-b', 'feature/agent', requested, 'main']);
  const worktreePath = (await listGitWorktreesAsync(workspacePath))
    .find(w => w.branch === 'feature/agent')!.path;

  return {
    appCtx,
    repo,
    workspaceId,
    workspacePath,
    worktreePath,
    cleanup: async () => {
      await appCtx.cleanup();
      repo.cleanup();
    },
  };
}

interface WorkingTreeRow {
  id: string;
  kind: string;
  label: string;
  path: string;
  branch: string | null;
  workspace_id: string;
  session_id: string | null;
  session_name: string | null;
}

// ---------------------------------------------------------------------------
// Discovery — external worktrees show up in both listing endpoints
// ---------------------------------------------------------------------------

test('SEC-014: /api/working_trees discovers external worktrees as ext: entries', async () => {
  const ctx = await setup();
  try {
    const res = await ctx.appCtx.fetch('/api/working_trees');
    assert.equal(res.status, 200);
    const rows = await res.json() as WorkingTreeRow[];
    const ext = rows.find(r => r.id.startsWith('ext:'));
    assert.ok(ext, 'external worktree must appear in the listing');
    assert.equal(ext!.id, extId(ctx.workspaceId, ctx.worktreePath));
    assert.equal(ext!.kind, 'worktree');
    assert.equal(ext!.path, ctx.worktreePath);
    assert.equal(ext!.branch, 'feature/agent');
    assert.equal(ext!.workspace_id, ctx.workspaceId);
    assert.equal(ext!.session_id, null);
    assert.equal(ext!.session_name, null);

    // The workspace main tree must NOT be re-listed as an ext: entry.
    const dupes = rows.filter(r => r.path === ctx.workspacePath);
    assert.equal(dupes.length, 1, 'main tree appears exactly once');
    assert.equal(dupes[0]!.id, `ws:${ctx.workspaceId}`);
  } finally {
    await ctx.cleanup();
  }
});

test('SEC-014: /api/working_trees dedupes DB-owned session worktrees (wt: wins)', async () => {
  const ctx = await setup();
  try {
    const sessionId = randomUUID();
    ctx.appCtx.db.prepare(
      `INSERT INTO sessions (id, workspace_id, executor, native_session_id, status, worktree_path, branch)
       VALUES (?, ?, 'claude', ?, 'new', ?, ?)`,
    ).run(sessionId, ctx.workspaceId, `cc_${sessionId}`, ctx.worktreePath, 'feature/agent');

    const res = await ctx.appCtx.fetch('/api/working_trees');
    const rows = await res.json() as WorkingTreeRow[];
    const atPath = rows.filter(r => r.path === ctx.worktreePath);
    assert.equal(atPath.length, 1, 'one row per physical worktree');
    assert.equal(atPath[0]!.id, `wt:${sessionId}`, 'the DB-owned wt: entry wins');
    assert.equal(atPath[0]!.session_id, sessionId);
  } finally {
    await ctx.cleanup();
  }
});

test('PERF-002: /api/working_trees reuses its scan cache until an explicit refresh', async () => {
  const ctx = await setup();
  const requested = `${ctx.repo.path}-agent-wt-2`;
  let secondPath: string | null = null;
  try {
    const initial = await ctx.appCtx.fetch('/api/working_trees');
    assert.equal(initial.status, 200);

    ctx.repo.git(['worktree', 'add', '-b', 'feature/agent-2', requested, 'main']);
    secondPath = (await listGitWorktreesAsync(ctx.workspacePath))
      .find(worktree => worktree.branch === 'feature/agent-2')!.path;

    const cached = await ctx.appCtx.fetch('/api/working_trees');
    assert.equal(cached.status, 200);
    const cachedRows = await cached.json() as WorkingTreeRow[];
    assert.equal(cachedRows.some(row => row.path === secondPath), false,
      'ordinary remounts reuse the bounded scan cache');

    const refreshed = await ctx.appCtx.fetch('/api/working_trees?refresh=1');
    assert.equal(refreshed.status, 200);
    const refreshedRows = await refreshed.json() as WorkingTreeRow[];
    assert.equal(refreshedRows.some(row => row.path === secondPath), true,
      'explicit repository refresh bypasses the cache');
  } finally {
    if (secondPath) {
      ctx.repo.git(['worktree', 'remove', '--force', secondPath]);
      ctx.repo.git(['branch', '-D', 'feature/agent-2']);
    }
    await ctx.cleanup();
  }
});

test('SEC-014: /api/workspaces/:id/trees also lists external worktrees', async () => {
  const ctx = await setup();
  try {
    const res = await ctx.appCtx.fetch(`/api/workspaces/${ctx.workspaceId}/trees`);
    assert.equal(res.status, 200);
    const rows = await res.json() as Array<{ id: string; kind: string; path: string; label: string }>;
    const ext = rows.find(r => r.id.startsWith('ext:'));
    assert.ok(ext, 'workspace tree listing includes the external worktree');
    assert.equal(ext!.kind, 'worktree');
    assert.equal(ext!.path, ctx.worktreePath);
    assert.equal(rows.filter(r => r.path === ctx.workspacePath).length, 1);
  } finally {
    await ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Resolution — valid ext: ids resolve; stale / forged / malformed ids 404
// ---------------------------------------------------------------------------

test('SEC-014: a valid ext: id resolves and serves the tree listing', async () => {
  const ctx = await setup();
  try {
    const id = encodeURIComponent(extId(ctx.workspaceId, ctx.worktreePath));
    const res = await ctx.appCtx.fetch(`/api/working_trees/${id}/tree`);
    assert.equal(res.status, 200, 'valid ext: id resolves like ws:/wt: ids');
    const entries = await res.json() as Array<{ name: string }>;
    assert.ok(entries.some(e => e.name === 'README.md'),
      'the resolved tree is the real worktree on disk');
  } finally {
    await ctx.cleanup();
  }
});

test('SEC-014: a stale ext: id (worktree removed) stops resolving → 404', async () => {
  const ctx = await setup();
  try {
    const id = encodeURIComponent(extId(ctx.workspaceId, ctx.worktreePath));
    ctx.repo.git(['worktree', 'remove', '--force', ctx.worktreePath]);
    const res = await ctx.appCtx.fetch(`/api/working_trees/${id}/tree`);
    assert.equal(res.status, 404,
      'membership is re-validated per call; a removed worktree must not resolve');
  } finally {
    await ctx.cleanup();
  }
});

test('SEC-014: a forged ext: id pointing at an arbitrary directory → 404', async () => {
  const ctx = await setup();
  try {
    for (const path of ['/etc', ctx.repo.path.replace(/\/[^/]*$/, '')]) {
      const id = encodeURIComponent(extId(ctx.workspaceId, path));
      const res = await ctx.appCtx.fetch(`/api/working_trees/${id}/tree`);
      assert.equal(res.status, 404,
        `forged path "${path}" is not a worktree of the workspace — must 404`);
    }
  } finally {
    await ctx.cleanup();
  }
});

test('SEC-014: malformed ext: ids → 404 (traversal, non-absolute, bad shape, unknown workspace)', async () => {
  const ctx = await setup();
  try {
    const attempts = [
      `ext:${ctx.workspaceId}:${Buffer.from('../../etc', 'utf8').toString('base64url')}`,
      `ext:${ctx.workspaceId}:${Buffer.from('relative/path', 'utf8').toString('base64url')}`,
      `ext:${ctx.workspaceId}:!!!not-base64!!!`,
      'ext:no-second-colon',
      'ext:',
      extId(randomUUID(), ctx.worktreePath), // valid shape, unknown workspace
    ];
    for (const attempt of attempts) {
      const res = await ctx.appCtx.fetch(
        `/api/working_trees/${encodeURIComponent(attempt)}/tree`,
      );
      assert.equal(res.status, 404, `ext id "${attempt}" must not resolve`);
    }
  } finally {
    await ctx.cleanup();
  }
});
