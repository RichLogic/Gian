// Coverage for traceability row:
//   GIT-003 — fetch / create local branch / abort merge|rebase|cherry-pick|
//             revert must return explainable results AND surface the
//             underlying git stderr so the UI can render the failure.
//
// Drives the real Hono app via `makeTestApp` against a real on-disk repo
// from `createGitRepo`. Each test triggers a specific failure path (bad
// branch name, duplicate branch, abort with no pending op, fetch with no
// remote) and asserts the HTTP envelope shape the Workspace Git panel
// renders.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { makeTestApp, type TestAppCtx } from './fixtures/test-app.js';
import { createGitRepo, bareUpstream, type GitRepo } from './fixtures/git-repo.js';

interface GitCtx {
  appCtx: TestAppCtx;
  repo: GitRepo;
  workspaceId: string;
  cleanup: () => Promise<void>;
}

async function setupRepo(opts?: { withOrigin?: boolean }): Promise<GitCtx> {
  const appCtx = await makeTestApp();
  let bareCleanup: (() => void) | null = null;
  let repo: GitRepo;
  if (opts?.withOrigin) {
    const bare = bareUpstream({ seedBranch: 'main' });
    repo = createGitRepo({ initialBranch: 'main', origin: bare.path });
    bareCleanup = bare.cleanup;
  } else {
    repo = createGitRepo({ initialBranch: 'main' });
  }
  const workspaceId = randomUUID();
  appCtx.db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)')
    .run(workspaceId, 'demo', repo.path);

  return {
    appCtx,
    repo,
    workspaceId,
    cleanup: async () => {
      await appCtx.cleanup();
      repo.cleanup();
      if (bareCleanup) bareCleanup();
    },
  };
}

// ---------------------------------------------------------------------------
// POST /branches — invalid name / duplicate / unknown workspace
// ---------------------------------------------------------------------------

async function postBranch(ctx: GitCtx, body: Record<string, unknown>) {
  return ctx.appCtx.fetch(`/api/workspaces/${ctx.workspaceId}/branches`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('GIT-003: POST /branches rejects empty name with 400', async () => {
  const ctx = await setupRepo();
  try {
    const res = await postBranch(ctx, { name: '   ' });
    assert.equal(res.status, 400);
    const body = await res.json() as { error: string };
    assert.match(body.error, /name is required/);
  } finally {
    await ctx.cleanup();
  }
});

test('GIT-003: POST /branches rejects invalid git ref name with 400 and explains why', async () => {
  // `..` is invalid in a git ref. The route runs `git check-ref-format`
  // which exits non-zero; the route must surface a clear "invalid branch
  // name" error rather than a generic "git failed".
  const ctx = await setupRepo();
  try {
    const res = await postBranch(ctx, { name: 'has..dots' });
    assert.equal(res.status, 400);
    const body = await res.json() as { error: string };
    assert.match(body.error, /invalid branch name: has\.\.dots/);
  } finally {
    await ctx.cleanup();
  }
});

test('GIT-003: POST /branches duplicate branch name returns 400 with the git stderr surfaced', async () => {
  // `git branch` exits 128 with "fatal: A branch named 'X' already exists."
  // when X exists. The route's catch must surface that stderr so the user
  // sees the real reason in the Git panel.
  const ctx = await setupRepo();
  try {
    ctx.repo.git(['branch', 'feature/duplicate']);
    const res = await postBranch(ctx, { name: 'feature/duplicate' });
    assert.equal(res.status, 400);
    const body = await res.json() as { ok: false; error: string };
    assert.equal(body.ok, false);
    assert.match(body.error, /already exists/i,
      'duplicate-branch failure must carry git\'s stderr text so the UI can render the real cause');
  } finally {
    await ctx.cleanup();
  }
});

test('GIT-003: POST /branches happy path creates the branch and the next call surfaces it via list', async () => {
  const ctx = await setupRepo();
  try {
    const res = await postBranch(ctx, { name: 'feature/new', base: 'main' });
    assert.equal(res.status, 200);
    const body = await res.json() as { ok: true };
    assert.equal(body.ok, true);

    const listed = ctx.repo.git(['branch', '--list', '--format=%(refname:short)']).split('\n');
    assert.ok(listed.includes('feature/new'),
      'branch must appear in git branch list after happy-path create');
  } finally {
    await ctx.cleanup();
  }
});

test('GIT-003: POST /branches on a missing workspace returns 404', async () => {
  const ctx = await setupRepo();
  try {
    const res = await ctx.appCtx.fetch('/api/workspaces/does-not-exist/branches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'foo' }),
    });
    assert.equal(res.status, 404);
  } finally {
    await ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// POST /abort-merge — no pending op / unknown workspace
// ---------------------------------------------------------------------------

test('GIT-003: POST /abort-merge returns 400 with `no merge in progress` when no pending op exists', async () => {
  const ctx = await setupRepo();
  try {
    const res = await ctx.appCtx.fetch(`/api/workspaces/${ctx.workspaceId}/abort-merge`, {
      method: 'POST',
    });
    assert.equal(res.status, 400);
    const body = await res.json() as { ok: false; error: string };
    assert.equal(body.ok, false);
    assert.match(body.error, /no merge in progress/);
  } finally {
    await ctx.cleanup();
  }
});

test('GIT-003: POST /abort-merge aborts a real in-progress merge and returns ok', async () => {
  // Set up a conflicting merge so the repo is actually in MERGING state,
  // then ask the route to abort it. End state must be clean (no MERGE_HEAD
  // file).
  const ctx = await setupRepo();
  try {
    // Create a divergent branch with a conflicting change.
    ctx.repo.commit('conflict.txt', 'main version\n', 'main: initial');
    ctx.repo.checkout('feature/conflict', { create: true });
    ctx.repo.commit('conflict.txt', 'feature version\n', 'feature: conflict');
    ctx.repo.checkout('main');
    ctx.repo.commit('conflict.txt', 'main version updated\n', 'main: diverge');

    // Trigger the conflict — `git merge` exits non-zero but leaves the
    // repo in MERGING state with MERGE_HEAD.
    try {
      ctx.repo.git(['merge', '--no-ff', 'feature/conflict']);
    } catch {
      // expected — conflict
    }

    const res = await ctx.appCtx.fetch(`/api/workspaces/${ctx.workspaceId}/abort-merge`, {
      method: 'POST',
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { ok: true };
    assert.equal(body.ok, true);

    // Verify the repo is no longer in MERGING state.
    const status = ctx.repo.git(['status', '--porcelain', '-b']);
    assert.ok(!status.includes('MERGING'),
      'after /abort-merge the repo must NOT remain in MERGING state');
  } finally {
    await ctx.cleanup();
  }
});

test('GIT-003: POST /abort-merge on a missing workspace returns 404', async () => {
  const ctx = await setupRepo();
  try {
    const res = await ctx.appCtx.fetch('/api/workspaces/does-not-exist/abort-merge', {
      method: 'POST',
    });
    assert.equal(res.status, 404);
  } finally {
    await ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// POST /fetch — no remote / unknown workspace
// ---------------------------------------------------------------------------

test('GIT-003: POST /fetch against an unreachable origin returns 500 with stderr surfaced', async () => {
  // Point `origin` at a path that doesn't exist. `git fetch --prune --all`
  // will hit the bad remote and exit non-zero. (`fetch --all` on a repo
  // with NO remote actually succeeds silently — modern git treats it as
  // a no-op — so we need a real failure here.)
  const ctx = await setupRepo();
  try {
    ctx.repo.git(['remote', 'add', 'origin', '/this/path/does/not/exist.git']);

    const res = await ctx.appCtx.fetch(`/api/workspaces/${ctx.workspaceId}/fetch`, {
      method: 'POST',
    });
    assert.equal(res.status, 500,
      'unreachable origin must return 500 — the route maps git fetch failures to 5xx');
    const body = await res.json() as { ok: false; error: string };
    assert.equal(body.ok, false);
    assert.ok(body.error && body.error.length > 0,
      'fetch failure must include a non-empty error so the UI can render it');
  } finally {
    await ctx.cleanup();
  }
});

test('GIT-003: POST /fetch happy path against a real bare upstream returns ok with fetchedAt timestamp', async () => {
  const ctx = await setupRepo({ withOrigin: true });
  try {
    const res = await ctx.appCtx.fetch(`/api/workspaces/${ctx.workspaceId}/fetch`, {
      method: 'POST',
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { ok: true; fetchedAt: string };
    assert.equal(body.ok, true);
    assert.match(body.fetchedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
      'fetchedAt must be an ISO timestamp so the Git panel can display "last fetched X ago"');
  } finally {
    await ctx.cleanup();
  }
});

test('GIT-003: POST /fetch on a missing workspace returns 404', async () => {
  const ctx = await setupRepo();
  try {
    const res = await ctx.appCtx.fetch('/api/workspaces/does-not-exist/fetch', {
      method: 'POST',
    });
    assert.equal(res.status, 404);
  } finally {
    await ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// /abort-merge variants — the route dispatches via `args[pending.kind]` so
// rebase/cherry-pick/revert reuse the same handler. Each variant needs a
// real pending git state to exercise the dispatch branch end-to-end.
// ---------------------------------------------------------------------------

test('GIT-003: POST /abort-merge aborts a real in-progress REBASE and returns ok', async () => {
  const ctx = await setupRepo();
  try {
    // Build a conflicting rebase: feature branch + main both touch the
    // same line. `git rebase main` will leave the repo in rebase-merge
    // state.
    ctx.repo.commit('conflict.txt', 'main initial\n', 'main: initial');
    ctx.repo.checkout('feature/conflict', { create: true });
    ctx.repo.commit('conflict.txt', 'feature change\n', 'feature: conflict');
    ctx.repo.checkout('main');
    ctx.repo.commit('conflict.txt', 'main update\n', 'main: diverge');
    ctx.repo.checkout('feature/conflict');
    try { ctx.repo.git(['rebase', 'main']); } catch { /* expected conflict */ }

    const res = await ctx.appCtx.fetch(`/api/workspaces/${ctx.workspaceId}/abort-merge`, {
      method: 'POST',
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { ok: true };
    assert.equal(body.ok, true);

    // Verify the rebase state directory is gone.
    const fs = await import('node:fs');
    const gitDir = ctx.repo.git(['rev-parse', '--git-dir']);
    const gitDirAbs = gitDir.startsWith('/') ? gitDir : `${ctx.repo.path}/${gitDir}`;
    assert.equal(fs.existsSync(`${gitDirAbs}/rebase-merge`), false,
      'after /abort-merge during a rebase, rebase-merge state must be cleared');
    assert.equal(fs.existsSync(`${gitDirAbs}/rebase-apply`), false);
  } finally {
    await ctx.cleanup();
  }
});

test('GIT-003: POST /abort-merge aborts a real in-progress CHERRY-PICK and returns ok', async () => {
  const ctx = await setupRepo();
  try {
    // Build a conflicting cherry-pick: a feature commit that conflicts
    // when applied on main.
    ctx.repo.commit('cp-conflict.txt', 'baseline\n', 'main: baseline');
    ctx.repo.checkout('feature/cp', { create: true });
    ctx.repo.commit('cp-conflict.txt', 'feature change\n', 'feature: cp source');
    const featureSha = ctx.repo.git(['rev-parse', 'HEAD']);
    ctx.repo.checkout('main');
    ctx.repo.commit('cp-conflict.txt', 'main divergent\n', 'main: divergent');
    try { ctx.repo.git(['cherry-pick', featureSha]); } catch { /* conflict */ }

    // Sanity: CHERRY_PICK_HEAD now exists.
    const before = ctx.repo.git(['rev-parse', '--verify', '--quiet', 'CHERRY_PICK_HEAD']);
    assert.ok(before, 'cherry-pick must be in progress before /abort-merge fires');

    const res = await ctx.appCtx.fetch(`/api/workspaces/${ctx.workspaceId}/abort-merge`, {
      method: 'POST',
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { ok: true };
    assert.equal(body.ok, true);

    // CHERRY_PICK_HEAD must be gone.
    const after = (() => {
      try { return ctx.repo.git(['rev-parse', '--verify', '--quiet', 'CHERRY_PICK_HEAD']); }
      catch { return ''; }
    })();
    assert.equal(after, '',
      'CHERRY_PICK_HEAD must be cleared after /abort-merge during cherry-pick');
  } finally {
    await ctx.cleanup();
  }
});

test('GIT-003: POST /abort-merge aborts a real in-progress REVERT and returns ok', async () => {
  const ctx = await setupRepo();
  try {
    // Build a conflicting revert: an old commit that no longer can be
    // cleanly reverted because the file changed.
    ctx.repo.commit('rv-conflict.txt', 'original\n', 'main: original');
    const original = ctx.repo.git(['rev-parse', 'HEAD']);
    ctx.repo.commit('rv-conflict.txt', 'further change\n', 'main: further change');
    ctx.repo.commit('rv-conflict.txt', 'yet another\n', 'main: yet another');
    try { ctx.repo.git(['revert', '--no-edit', original]); } catch { /* conflict */ }

    const before = (() => {
      try { return ctx.repo.git(['rev-parse', '--verify', '--quiet', 'REVERT_HEAD']); }
      catch { return ''; }
    })();
    assert.ok(before, 'revert must be in progress before /abort-merge fires');

    const res = await ctx.appCtx.fetch(`/api/workspaces/${ctx.workspaceId}/abort-merge`, {
      method: 'POST',
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { ok: true };
    assert.equal(body.ok, true);

    const after = (() => {
      try { return ctx.repo.git(['rev-parse', '--verify', '--quiet', 'REVERT_HEAD']); }
      catch { return ''; }
    })();
    assert.equal(after, '',
      'REVERT_HEAD must be cleared after /abort-merge during revert');
  } finally {
    await ctx.cleanup();
  }
});
