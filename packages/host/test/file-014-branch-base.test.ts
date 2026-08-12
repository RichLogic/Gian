// Coverage for the Branch scope's compare-base picker backend (FILE-011
// extension, Codex two-row UI):
//   - GET /api/working_trees/:id/branches → { head, base, branches } with the
//     remote default for the second-row `<head> → <base>` picker
//   - /changed?scope=branch&base=<ref> → branch diff against merge-base(ref)
//   - /diff?scope=branch&base=<ref>    → per-file diff against that base
//   - a bogus base falls back to the remote-default base (parseBaseRef)
//
// Drives the routes via `makeTestApp` + a real git fixture, mirroring
// file-013-commits-submenu.test.ts.

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

interface BranchList {
  head: string;
  base: string | null;
  branches: string[];
}

interface Ctx {
  appCtx: TestAppCtx;
  repo: GitRepo;
  wsTreeId: string;
  cleanup: () => Promise<void>;
}

async function setup(initialBranch: 'main' | 'master' = 'main'): Promise<Ctx> {
  const upstream = bareUpstream({ seedBranch: initialBranch });
  const appCtx = await makeTestApp();
  const repo = createGitRepo({
    initialBranch,
    files: {
      'src/a.ts': 'export const a = 0;\n',
      'src/b.ts': 'export const b = 0;\n',
    },
  });
  repo.git(['remote', 'add', 'origin', upstream.path]);
  repo.git(['push', '--force', 'origin', initialBranch]);
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

test('FILE-014: /branches returns head, remote-default base, and the branch list', async () => {
  const ctx = await setup();
  try {
    ctx.repo.checkout('feature', { create: true });

    const res = await ctx.appCtx.fetch(`/api/working_trees/${ctx.wsTreeId}/branches`);
    assert.equal(res.status, 200, `/branches fetch failed: ${res.status}`);
    const body = await res.json() as BranchList;

    assert.equal(body.head, 'feature');
    assert.equal(body.base, 'origin/main', 'the remote default ref is the compare base');
    assert.ok(body.branches.includes('main') && body.branches.includes('feature'));
    assert.ok(!body.branches.some(b => b.endsWith('/HEAD')), 'origin/HEAD symref is filtered out');
  } finally {
    await ctx.cleanup();
  }
});

test('FILE-014: a master repository defaults to origin/master', async () => {
  const ctx = await setup('master');
  try {
    ctx.repo.checkout('feature', { create: true });

    const res = await ctx.appCtx.fetch(`/api/working_trees/${ctx.wsTreeId}/branches`);
    assert.equal(res.status, 200);
    const body = await res.json() as BranchList;

    assert.equal(body.base, 'origin/master');
    assert.ok(body.branches.includes('origin/master'));
  } finally {
    await ctx.cleanup();
  }
});

test('FILE-014: /changed + /diff with scope=branch&base= diff against merge-base(base)', async () => {
  const ctx = await setup();
  try {
    ctx.repo.checkout('feature', { create: true });
    const c1 = ctx.repo.commit('src/a.ts', 'export const a = 1;\n', 'c1: touch a');
    ctx.repo.commit('src/b.ts', 'export const b = 1;\n', 'c2: touch b');

    // Remote-default base (origin/main) sees both branch commits…
    const autoRes = await ctx.appCtx.fetch(
      `/api/working_trees/${ctx.wsTreeId}/changed?scope=branch`,
    );
    assert.deepEqual(
      (await autoRes.json() as ChangedEntry[]).map(e => e.path).sort(),
      ['src/a.ts', 'src/b.ts'],
    );

    // …while pinning the base to c1 narrows the branch diff to c2 only.
    const res = await ctx.appCtx.fetch(
      `/api/working_trees/${ctx.wsTreeId}/changed?scope=branch&base=${c1}`,
    );
    assert.equal(res.status, 200);
    const changed = await res.json() as ChangedEntry[];
    assert.deepEqual(changed.map(e => e.path), ['src/b.ts'],
      'explicit base = c1 → only c2\'s file remains');

    const diffRes = await ctx.appCtx.fetch(
      `/api/working_trees/${ctx.wsTreeId}/diff?path=${encodeURIComponent('src/b.ts')}&scope=branch&base=${c1}`,
    );
    assert.equal(diffRes.status, 200);
    const { diff } = await diffRes.json() as { diff: string };
    assert.match(diff, /export const b = 1;/, 'per-file diff renders against the pinned base');
  } finally {
    await ctx.cleanup();
  }
});

test('FILE-014: a bogus base falls back to the remote-default base', async () => {
  const ctx = await setup();
  try {
    ctx.repo.checkout('feature', { create: true });
    ctx.repo.commit('src/a.ts', 'export const a = 1;\n', 'c1: touch a');

    const res = await ctx.appCtx.fetch(
      `/api/working_trees/${ctx.wsTreeId}/changed?scope=branch&base=${encodeURIComponent('bogus..ref')}`,
    );
    assert.equal(res.status, 200);
    const changed = await res.json() as ChangedEntry[];
    assert.deepEqual(changed.map(e => e.path), ['src/a.ts'],
      'invalid base is ignored → remote-default base (full branch diff)');
  } finally {
    await ctx.cleanup();
  }
});
