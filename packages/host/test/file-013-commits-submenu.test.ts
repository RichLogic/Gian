// Coverage for the Committed-submenu backend (FILE-011 extension): the
// Changes picker's Committed row lists the branch's commits and each pick
// pins the commit/diff scopes to that sha.
//   - GET /api/working_trees/:id/commits → branch commits since the remote
//     default's merge-base, newest first
//   - /changed?scope=commit&sha=<sha>  → that commit's delta (sha^..sha)
//   - /diff?scope=commit&sha=<sha>     → the per-file diff of that commit
//   - a bogus sha falls back to HEAD's delta (parseCommitSha)
//
// Drives the routes via `makeTestApp` + a real git fixture, mirroring
// file-011-changes-scope-codex.test.ts.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { makeTestApp, type TestAppCtx } from './fixtures/test-app.js';
import { bareUpstream, createGitRepo, type GitRepo } from './fixtures/git-repo.js';

interface ChangedEntry {
  path: string;
  kind: 'create' | 'update' | 'delete' | 'rename';
  staged: boolean;
  added: number;
  removed: number;
}

interface BranchCommit {
  sha: string;
  subject: string;
  rel: string;
}

interface Ctx {
  appCtx: TestAppCtx;
  repo: GitRepo;
  wsTreeId: string;
  cleanup: () => Promise<void>;
}

async function setup(): Promise<Ctx> {
  const upstream = bareUpstream();
  const appCtx = await makeTestApp();
  const repo = createGitRepo({
    initialBranch: 'main',
    files: {
      'src/app.ts': "console.log('init')\n",
      'src/util.ts': 'export const u = 1;\n',
    },
  });
  repo.git(['remote', 'add', 'origin', upstream.path]);
  repo.git(['push', '--force', 'origin', 'main']);
  repo.git(['remote', 'set-head', 'origin', '--auto']);
  const workspaceId = randomUUID();
  appCtx.db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)')
    .run(workspaceId, 'demo', repo.path);
  return {
    appCtx,
    repo,
    wsTreeId: `ws:${workspaceId}`,
    cleanup: async () => {
      await appCtx.cleanup();
      repo.cleanup();
      upstream.cleanup();
    },
  };
}

test('FILE-013: /commits lists commits since the remote default, newest-first', async () => {
  const ctx = await setup();
  try {
    const first = ctx.repo.commit('src/app.ts', "console.log('init')\nconsole.log('one')\n", 'feat: first on branch');
    const second = ctx.repo.commit('src/util.ts', 'export const u = 2;\n', 'feat: second on branch');
    // Match a conversation branch created from an already-ahead local main.
    // Comparing to local main would make this range empty; origin/main must
    // remain the baseline.
    ctx.repo.checkout('feature', { create: true });

    const res = await ctx.appCtx.fetch(`/api/working_trees/${ctx.wsTreeId}/commits`);
    assert.equal(res.status, 200, `/commits fetch failed: ${res.status}`);
    const commits = await res.json() as BranchCommit[];

    assert.deepEqual(commits.map(cm => cm.sha), [second, first],
      'newest first, only the two branch commits (init is at/before the merge-base)');
    assert.equal(commits[0]!.subject, 'feat: second on branch');
    assert.ok(commits[0]!.rel.length > 0, 'relative date is carried through');
  } finally {
    await ctx.cleanup();
  }
});

test('FILE-013: /commits is empty when the branch has no commits of its own', async () => {
  const ctx = await setup();
  try {
    const res = await ctx.appCtx.fetch(`/api/working_trees/${ctx.wsTreeId}/commits`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), [], 'plain main: nothing past the merge-base');
  } finally {
    await ctx.cleanup();
  }
});

test('FILE-013: /changed?scope=commit&sha= pins the diff to that commit', async () => {
  const ctx = await setup();
  try {
    const first = ctx.repo.commit('src/app.ts', "console.log('init')\nconsole.log('one')\n", 'c1');
    ctx.repo.commit('src/util.ts', 'export const u = 2;\n', 'c2');

    const res = await ctx.appCtx.fetch(
      `/api/working_trees/${ctx.wsTreeId}/changed?scope=commit&sha=${first}`,
    );
    assert.equal(res.status, 200);
    const changed = await res.json() as ChangedEntry[];
    assert.deepEqual(changed.map(e => e.path), ['src/app.ts'],
      'the pinned commit touches only its own file, not HEAD\'s');
    assert.equal(changed[0]!.added, 1);

    const diffRes = await ctx.appCtx.fetch(
      `/api/working_trees/${ctx.wsTreeId}/diff?path=${encodeURIComponent('src/app.ts')}&scope=commit&sha=${first}`,
    );
    assert.equal(diffRes.status, 200);
    const { diff } = await diffRes.json() as { diff: string };
    assert.match(diff, /console\.log\('one'\)/, 'per-file diff renders the pinned commit\'s hunk');
  } finally {
    await ctx.cleanup();
  }
});

test('FILE-013: a bogus sha falls back to HEAD\'s delta', async () => {
  const ctx = await setup();
  try {
    ctx.repo.commit('src/app.ts', "console.log('init')\nconsole.log('head')\n", 'head commit');

    const res = await ctx.appCtx.fetch(
      `/api/working_trees/${ctx.wsTreeId}/changed?scope=commit&sha=not-a-sha`,
    );
    assert.equal(res.status, 200);
    const changed = await res.json() as ChangedEntry[];
    assert.deepEqual(changed.map(e => e.path), ['src/app.ts'],
      'invalid sha is ignored → HEAD\'s committed delta');
  } finally {
    await ctx.cleanup();
  }
});
