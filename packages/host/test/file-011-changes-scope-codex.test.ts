// Coverage for the Codex-aligned diff scopes (FILE-011) on the Changes review
// backend. Extends FILE-010 (all/unstaged/staged) with the three history
// scopes the picker gained to match Codex's five-option menu:
//   - commit   → HEAD's committed delta (parent..HEAD; empty-tree..HEAD at root)
//   - branch   → whole branch vs its base (merge-base) + untracked + working
//   - lastturn → files the agent edited in its most recent turn (file_change
//                events), shown as their live diff vs HEAD
//
// Drives the routes via `makeTestApp` + a real git fixture, mirroring
// file-010-changes-scope.test.ts.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { makeTestApp, type TestAppCtx } from './fixtures/test-app.js';
import { createGitRepo, type GitRepo } from './fixtures/git-repo.js';

interface ChangedEntry {
  path: string;
  kind: 'create' | 'update' | 'delete' | 'rename';
  staged: boolean;
  added: number;
  removed: number;
}

interface Ctx {
  appCtx: TestAppCtx;
  repo: GitRepo;
  workspaceId: string;
  wsTreeId: string;
  cleanup: () => Promise<void>;
}

async function setup(): Promise<Ctx> {
  const appCtx = await makeTestApp();
  const repo = createGitRepo({
    initialBranch: 'main',
    files: {
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
    wsTreeId: `ws:${workspaceId}`,
    cleanup: async () => {
      await appCtx.cleanup();
      repo.cleanup();
    },
  };
}

async function fetchChanged(ctx: Ctx, treeId: string, scope: string): Promise<ChangedEntry[]> {
  const res = await ctx.appCtx.fetch(`/api/working_trees/${treeId}/changed?scope=${scope}`);
  assert.equal(res.status, 200, `/changed fetch failed: ${res.status}`);
  return await res.json() as ChangedEntry[];
}

async function fetchDiff(ctx: Ctx, treeId: string, path: string, scope: string): Promise<string> {
  const res = await ctx.appCtx.fetch(
    `/api/working_trees/${treeId}/diff?path=${encodeURIComponent(path)}&scope=${scope}`,
  );
  assert.equal(res.status, 200, `/diff fetch failed: ${res.status}`);
  return ((await res.json()) as { diff: string }).diff;
}

// Register a worktree-backed session pointing at the repo, plus `turns` and
// `file_change` events, so `wt:<id>` resolves and lastturn has data.
function seedSession(
  ctx: Ctx,
  turns: Array<{ turnNumber: number; paths: string[] }>,
): string {
  const sessionId = randomUUID();
  ctx.appCtx.db.prepare(
    `INSERT INTO sessions (id, workspace_id, executor, worktree_path, branch, base_branch, native_session_id)
     VALUES (?, ?, 'claude', ?, 'main', 'main', ?)`,
  ).run(sessionId, ctx.workspaceId, ctx.repo.path, randomUUID());
  for (const turn of turns) {
    const turnId = randomUUID();
    ctx.appCtx.db.prepare(
      `INSERT INTO turns (id, session_id, turn_number, status) VALUES (?, ?, ?, 'completed')`,
    ).run(turnId, sessionId, turn.turnNumber);
    for (const p of turn.paths) {
      ctx.appCtx.db.prepare(
        `INSERT INTO events (id, session_id, turn_id, call_id, type, data)
         VALUES (?, ?, ?, ?, 'file_change', ?)`,
      ).run(randomUUID(), sessionId, turnId, randomUUID(), JSON.stringify({ files: [{ path: p }] }));
    }
  }
  return sessionId;
}

// ---------------------------------------------------------------------------
// commit scope
// ---------------------------------------------------------------------------

test('FILE-011: commit scope at the root commit lists every file as a create (empty-tree base)', async () => {
  const ctx = await setup();
  try {
    // HEAD is the initial (root) commit — no parent, so the base is the empty tree.
    const changed = await fetchChanged(ctx, ctx.wsTreeId, 'commit');
    const paths = changed.map(e => e.path).sort();
    assert.deepEqual(paths, ['README.md', 'src/app.ts', 'src/util.ts']);
    for (const e of changed) {
      assert.equal(e.kind, 'create', `${e.path} is added in the root commit`);
      assert.equal(e.staged, false, 'committed entries are never staged=true');
    }
  } finally {
    await ctx.cleanup();
  }
});

test('FILE-011: commit scope shows only HEAD\'s committed delta, not the working tree', async () => {
  const ctx = await setup();
  try {
    // A second commit touching src/app.ts (+1 line over its parent).
    ctx.repo.commit('src/app.ts', "console.log('init')\nconsole.log('two')\n");
    // An uncommitted working-tree edit that must NOT appear in commit scope.
    writeFileSync(join(ctx.repo.path, 'src/util.ts'), 'export const u = 1;\nworking only\n');

    const changed = await fetchChanged(ctx, ctx.wsTreeId, 'commit');
    const app = changed.find(e => e.path === 'src/app.ts');
    assert.ok(app, 'the committed file is in commit scope');
    assert.equal(app!.kind, 'update');
    assert.equal(app!.added, 1, 'parent..HEAD counts +1');
    assert.equal(app!.removed, 0);
    assert.equal(changed.find(e => e.path === 'src/util.ts'), undefined,
      'an uncommitted working edit is not part of the last commit');

    const diff = await fetchDiff(ctx, ctx.wsTreeId, 'src/app.ts', 'commit');
    assert.match(diff, /console\.log\('two'\)/, 'commit diff renders the committed hunk');
  } finally {
    await ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// branch scope
// ---------------------------------------------------------------------------

test('FILE-011: branch scope = committed + working + untracked, vs the merge-base with the default branch', async () => {
  const ctx = await setup();
  try {
    // Branch off main and commit one change there.
    ctx.repo.checkout('feature', { create: true });
    ctx.repo.commit('src/util.ts', 'export const u = 2;\n'); // committed on branch
    // Plus an uncommitted working edit and a brand-new untracked file.
    writeFileSync(join(ctx.repo.path, 'src/app.ts'), "console.log('init')\nbranch wip\n");
    writeFileSync(join(ctx.repo.path, 'NEW.md'), 'x\ny\n');

    const changed = await fetchChanged(ctx, ctx.wsTreeId, 'branch');
    const byPath = new Map(changed.map(e => [e.path, e]));

    assert.ok(byPath.has('src/util.ts'), 'committed-on-branch change is in branch scope');
    assert.ok(byPath.has('src/app.ts'), 'uncommitted working change is in branch scope');
    const nw = byPath.get('NEW.md');
    assert.ok(nw, 'untracked new file is part of the branch vs base');
    assert.equal(nw!.kind, 'create');
    assert.equal(nw!.added, 2, 'untracked counted from disk');
  } finally {
    await ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// lastturn scope
// ---------------------------------------------------------------------------

test('FILE-011: lastturn scope returns only the files the agent touched in its most recent turn', async () => {
  const ctx = await setup();
  try {
    const sessionId = seedSession(ctx, [
      { turnNumber: 1, paths: ['src/app.ts'] },   // earlier turn
      { turnNumber: 2, paths: ['src/util.ts'] },  // most recent turn
    ]);
    // Both files differ from HEAD in the working tree.
    writeFileSync(join(ctx.repo.path, 'src/app.ts'), "console.log('init')\nturn1\n");
    writeFileSync(join(ctx.repo.path, 'src/util.ts'), 'export const u = 1;\nturn2\n');

    const changed = await fetchChanged(ctx, `wt:${sessionId}`, 'lastturn');
    assert.deepEqual(changed.map(e => e.path), ['src/util.ts'],
      'only the latest turn\'s file is included');
    assert.equal(changed[0]!.added, 1, 'live diff vs HEAD counts the working edit');
  } finally {
    await ctx.cleanup();
  }
});

test('FILE-011: lastturn scope is empty for a non-session (ws:) working tree', async () => {
  const ctx = await setup();
  try {
    writeFileSync(join(ctx.repo.path, 'src/app.ts'), "console.log('init')\nedit\n");
    const changed = await fetchChanged(ctx, ctx.wsTreeId, 'lastturn');
    assert.deepEqual(changed, [], 'no session → no turns → no lastturn files');
  } finally {
    await ctx.cleanup();
  }
});
