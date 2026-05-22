// Coverage for traceability row:
//   SEC-014 — Git / file reveal / open browser behavior must not
//             bypass the safe-path / workspace boundary. The
//             `/api/working_trees/:id/reveal` endpoint takes only a
//             working-tree id (`ws:<workspace-id>` or `wt:<session-id>`)
//             — never a free-form path — so it's structurally bounded
//             to existing DB rows. We pin that contract.
//
// SEC-005 / SEC-008 already cover `resolveWithinWorkspace`; FILE-003 /
// SEC-009 cover the `/raw` HTTP route. This file closes the reveal
// boundary: arbitrary path strings, traversal attempts, and bogus id
// shapes must NOT reach `open`.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeTestApp, type TestAppCtx } from './fixtures/test-app.js';

interface Ctx {
  appCtx: TestAppCtx;
  workspaceId: string;
  cleanup: () => Promise<void>;
}

async function setup(): Promise<Ctx> {
  const appCtx = await makeTestApp();
  const workspaceId = randomUUID();
  const workspacePath = mkdtempSync(join(tmpdir(), 'gian-sec014-'));
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

// ---------------------------------------------------------------------------
// SEC-014 — reveal can only target known working trees
// ---------------------------------------------------------------------------

test('SEC-014: /reveal requires a `ws:<id>` or `wt:<id>` id; arbitrary path strings 404', async () => {
  const ctx = await setup();
  try {
    // Plain path — not a working_tree id. Route should reject.
    const res = await ctx.appCtx.fetch(
      `/api/working_trees/${encodeURIComponent('/etc/passwd')}/reveal`,
      { method: 'POST' },
    );
    assert.equal(res.status, 404,
      'arbitrary path string cannot resolve to a working tree — reveal must 404');
    const body = await res.json() as { error: string };
    assert.match(body.error, /working tree not found/);
  } finally {
    await ctx.cleanup();
  }
});

test('SEC-014: /reveal rejects path-traversal attempts in the id slot', async () => {
  const ctx = await setup();
  try {
    for (const attempt of [
      '../../../etc',
      'ws:../../../etc',
      'wt:../../etc',
      '..',
    ]) {
      const res = await ctx.appCtx.fetch(
        `/api/working_trees/${encodeURIComponent(attempt)}/reveal`,
        { method: 'POST' },
      );
      assert.equal(res.status, 404,
        `reveal must reject "${attempt}" — id is bounded to known DB rows`);
    }
  } finally {
    await ctx.cleanup();
  }
});

test('SEC-014: /reveal with an unknown `ws:<id>` returns 404 (workspace must exist in DB)', async () => {
  const ctx = await setup();
  try {
    const res = await ctx.appCtx.fetch(
      `/api/working_trees/ws:00000000-0000-0000-0000-000000000000/reveal`,
      { method: 'POST' },
    );
    assert.equal(res.status, 404,
      'a syntactically-valid id that doesn\'t exist in DB must NOT trigger an open()');
  } finally {
    await ctx.cleanup();
  }
});

test('SEC-014: /reveal with a `wt:<unknown-session>` 404s before touching the FS', async () => {
  const ctx = await setup();
  try {
    const res = await ctx.appCtx.fetch(
      `/api/working_trees/wt:nonexistent-session/reveal`,
      { method: 'POST' },
    );
    assert.equal(res.status, 404);
  } finally {
    await ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// SEC-014 — /raw + /diff already covered by SEC-005 + FILE-003. Pin one
// boundary case per endpoint here so a future refactor that swaps the
// resolveWithinWorkspace helper for something less strict trips both
// rows at once.
// ---------------------------------------------------------------------------

test('SEC-014: /raw with `..` in the rel path returns 400 (defers to safe-path helper)', async () => {
  const ctx = await setup();
  try {
    const res = await ctx.appCtx.fetch(
      `/api/working_trees/ws:${ctx.workspaceId}/raw?path=${encodeURIComponent('../../etc/passwd')}`,
    );
    assert.equal(res.status, 400);
    const body = await res.json() as { error: string };
    assert.match(body.error, /path escapes/);
  } finally {
    await ctx.cleanup();
  }
});

test('SEC-014: /diff with absolute path-escape returns 400 (defers to safe-path helper)', async () => {
  const ctx = await setup();
  try {
    const res = await ctx.appCtx.fetch(
      `/api/workspaces/${ctx.workspaceId}/diff?path=${encodeURIComponent('/etc/hosts')}`,
    );
    assert.equal(res.status, 400);
    const body = await res.json() as { error: string };
    assert.match(body.error, /path escapes/);
  } finally {
    await ctx.cleanup();
  }
});

test('SEC-014: /file with a tilde-relative path is treated as a literal path (not home expansion) and the safe-path helper still blocks the escape', async () => {
  // `~` is a shell construct. The route doesn't expand it; the safe-path
  // helper treats `~/something` as a relative path under the workspace.
  // If `~/x.txt` doesn't exist under the workspace, the route returns
  // a stat error (500 from inside `try`), NOT a successful read of the
  // user's home dir. We pin that the open / read never escapes.
  const ctx = await setup();
  try {
    const res = await ctx.appCtx.fetch(
      `/api/workspaces/${ctx.workspaceId}/file?path=${encodeURIComponent('~/.ssh/id_rsa')}`,
    );
    // Either 400 (path escapes if helper detects tilde) or 500 (stat fails
    // because workspace/~/.ssh/id_rsa doesn't exist). Either way: NOT
    // reading the user's real home.
    assert.notEqual(res.status, 200,
      `~ in path must NOT successfully read the user's home directory — got status ${res.status}`);
  } finally {
    await ctx.cleanup();
  }
});
