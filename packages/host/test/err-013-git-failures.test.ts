// Coverage for traceability row (remaining endpoints):
//   ERR-013 — Git commands failing must return `{ ok: false, error }` or
//             4xx/5xx body, not crash the host.
//
// GIT-003 already covers POST /branches / /abort-merge / /fetch. This
// file fills the remaining git-touching endpoints in the same matrix
// row: /repo-info (must handle a non-repo workspace gracefully) and
// /diff (must return an empty diff for a missing or untracked file
// rather than 500). The contract is "no crash, explainable response."

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { makeTestApp, type TestAppCtx } from './fixtures/test-app.js';
import { createGitRepo, type GitRepo } from './fixtures/git-repo.js';

interface Ctx {
  appCtx: TestAppCtx;
  workspacePath: string;
  workspaceId: string;
  cleanupExtras: () => void;
  cleanup: () => Promise<void>;
}

async function setupGit(opts?: { realRepo?: boolean }): Promise<Ctx> {
  const appCtx = await makeTestApp();
  let workspacePath: string;
  let repo: GitRepo | null = null;
  let plainDir: string | null = null;
  if (opts?.realRepo) {
    repo = createGitRepo({ initialBranch: 'main' });
    workspacePath = repo.path;
  } else {
    plainDir = mkdtempSync(join(tmpdir(), 'gian-err013-non-repo-'));
    workspacePath = plainDir;
  }
  const workspaceId = randomUUID();
  appCtx.db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)')
    .run(workspaceId, 'demo', workspacePath);

  return {
    appCtx,
    workspacePath,
    workspaceId,
    cleanupExtras: () => {
      if (repo) repo.cleanup();
      if (plainDir) rmSync(plainDir, { recursive: true, force: true });
    },
    cleanup: async () => {
      await appCtx.cleanup();
      if (repo) repo.cleanup();
      if (plainDir) rmSync(plainDir, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// /repo-info — non-repo workspace must return a structured response, not 500
// ---------------------------------------------------------------------------

test('ERR-013: GET /repo-info on a non-repo workspace returns 200 with empty git info', async () => {
  const ctx = await setupGit({ realRepo: false });
  try {
    const res = await ctx.appCtx.fetch(`/api/workspaces/${ctx.workspaceId}/repo-info`);
    assert.equal(res.status, 200,
      'non-repo workspaces must still get a 200; git absence is not a server error');
    const body = await res.json() as { git: unknown; claudeMd: unknown };
    assert.ok(body.git, 'response must include a git block (even if empty)');
    assert.ok(body.claudeMd, 'response must include a claudeMd block (even if empty)');
  } finally {
    await ctx.cleanup();
  }
});

test('ERR-013: GET /repo-info on a real git repo returns populated isRepo/currentBranch fields', async () => {
  const ctx = await setupGit({ realRepo: true });
  try {
    const res = await ctx.appCtx.fetch(`/api/workspaces/${ctx.workspaceId}/repo-info`);
    assert.equal(res.status, 200);
    const body = await res.json() as {
      git: { isRepo: boolean; currentBranch: string | null };
      claudeMd: { exists: boolean };
    };
    assert.equal(body.git.isRepo, true,
      'isRepo must be true for a real workspace pointing at a git repo root');
    assert.equal(body.git.currentBranch, 'main',
      'real repo must surface the current branch as `currentBranch`');
    assert.equal(body.claudeMd.exists, false,
      'claudeMd.exists must be false when no CLAUDE.md file is present');
  } finally {
    await ctx.cleanup();
  }
});

test('ERR-013: GET /repo-info on unknown workspace returns 404 (not crashed)', async () => {
  const ctx = await setupGit({ realRepo: false });
  try {
    const res = await ctx.appCtx.fetch('/api/workspaces/no-such-ws/repo-info');
    assert.equal(res.status, 404);
    const body = await res.json() as { error: string };
    assert.match(body.error, /workspace not found/);
  } finally {
    await ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// /diff — missing / untracked file paths
// ---------------------------------------------------------------------------

test('ERR-013: GET /diff on a non-existent file returns 200 with empty diff (graceful)', async () => {
  const ctx = await setupGit({ realRepo: true });
  try {
    const res = await ctx.appCtx.fetch(
      `/api/workspaces/${ctx.workspaceId}/diff?path=does-not-exist.txt`,
    );
    assert.equal(res.status, 200,
      'a missing file is not a server error — empty diff is the contract');
    const body = await res.json() as { diff: string };
    assert.equal(body.diff, '',
      'missing-file diff must be empty so the Files panel can render "no changes"');
  } finally {
    await ctx.cleanup();
  }
});

test('ERR-013: GET /diff on an untracked text file returns 200 with a synthesized new-file diff', async () => {
  const ctx = await setupGit({ realRepo: true });
  try {
    // Create an untracked file in the workspace.
    writeFileSync(join(ctx.workspacePath, 'untracked.txt'), 'fresh content\n');
    const res = await ctx.appCtx.fetch(
      `/api/workspaces/${ctx.workspaceId}/diff?path=untracked.txt`,
    );
    assert.equal(res.status, 200);
    const body = await res.json() as { diff: string };
    assert.ok(body.diff.length > 0,
      'untracked file must produce a non-empty synthesized "new file" diff via --no-index');
    assert.match(body.diff, /\+fresh content/,
      'diff must include the file content as additions');
  } finally {
    await ctx.cleanup();
  }
});

test('ERR-013: GET /diff requires the `path` query param (400)', async () => {
  const ctx = await setupGit({ realRepo: true });
  try {
    const res = await ctx.appCtx.fetch(`/api/workspaces/${ctx.workspaceId}/diff`);
    assert.equal(res.status, 400);
    const body = await res.json() as { error: string };
    assert.match(body.error, /path required/);
  } finally {
    await ctx.cleanup();
  }
});

test('ERR-013: GET /diff with path traversal returns 400 (path escapes workspace)', async () => {
  // SEC-008 covers the path-safety helper; here we pin that the route's
  // error envelope shape stays consistent with the rest of ERR-013.
  const ctx = await setupGit({ realRepo: true });
  try {
    const res = await ctx.appCtx.fetch(
      `/api/workspaces/${ctx.workspaceId}/diff?path=../escape-attempt.txt`,
    );
    assert.equal(res.status, 400);
    const body = await res.json() as { error: string };
    assert.match(body.error, /path escapes workspace/);
  } finally {
    await ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// /diff on an unknown workspace
// ---------------------------------------------------------------------------

test('ERR-013: GET /diff on unknown workspace returns 404', async () => {
  const ctx = await setupGit({ realRepo: false });
  try {
    const res = await ctx.appCtx.fetch('/api/workspaces/no-such-ws/diff?path=any.txt');
    assert.equal(res.status, 404);
  } finally {
    await ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// /file — graceful failure modes
// ---------------------------------------------------------------------------

test('ERR-013: GET /file on a directory (not a regular file) returns 400', async () => {
  const ctx = await setupGit({ realRepo: true });
  try {
    mkdirSync(join(ctx.workspacePath, 'a-dir'));
    const res = await ctx.appCtx.fetch(
      `/api/workspaces/${ctx.workspaceId}/file?path=a-dir`,
    );
    assert.equal(res.status, 400);
    const body = await res.json() as { error: string };
    assert.match(body.error, /not a file/);
  } finally {
    await ctx.cleanup();
  }
});

test('ERR-013: GET /file on an oversized file returns 413', async () => {
  // The route caps text-file reads at 1 MiB; over that returns 413.
  const ctx = await setupGit({ realRepo: true });
  try {
    // Build a 1.5 MiB file. Faster than reading: write a single buffer.
    const big = Buffer.alloc(1024 * 1024 + 4096, 0x61); // 'a' bytes
    writeFileSync(join(ctx.workspacePath, 'big.txt'), big);
    const res = await ctx.appCtx.fetch(
      `/api/workspaces/${ctx.workspaceId}/file?path=big.txt`,
    );
    assert.equal(res.status, 413,
      'files over the 1 MiB cap must return 413, not stream a multi-megabyte JSON body');
    const body = await res.json() as { error: string };
    assert.match(body.error, /too large/);
  } finally {
    await ctx.cleanup();
  }
});
