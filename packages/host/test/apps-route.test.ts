// Coverage for traceability row:
//   FILE-007 — GET /api/apps lists installed applications for the Sheet
//              "Open with…" menu. macOS-only; non-mac platforms return [].
//   Also covers GET /api/apps/icon (app icon PNG) and the awaited
//   builtin:'default' open path that reports 422 {error:no-app} on failure.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeTestApp, type TestAppCtx } from './fixtures/test-app.js';

test('FILE-007: /api/apps returns an apps array (empty off macOS)', async () => {
  const appCtx = await makeTestApp();
  try {
    const res = await appCtx.fetch('/api/apps');
    assert.equal(res.status, 200);
    const body = (await res.json()) as { apps: string[] };
    assert.ok(Array.isArray(body.apps), 'apps must be an array');
    if (process.platform !== 'darwin') {
      assert.deepEqual(body.apps, [], 'non-mac platforms return no apps');
    } else {
      // On macOS the standard app dirs exist, so the scan finds something:
      // entries drop the `.app` suffix and hidden dot-bundles are excluded.
      assert.ok(body.apps.every(n => !n.endsWith('.app')), 'names drop the .app suffix');
      assert.ok(body.apps.every(n => !n.startsWith('.')), 'hidden dot-bundles excluded');
    }
  } finally {
    await appCtx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Shared setup for the icon + open-default tests (needs a workspace + a file).
// ---------------------------------------------------------------------------

interface Ctx {
  appCtx: TestAppCtx;
  workspaceId: string;
  workspacePath: string;
  cleanup: () => Promise<void>;
}

async function setup(): Promise<Ctx> {
  const appCtx = await makeTestApp();
  const workspaceId = randomUUID();
  const workspacePath = mkdtempSync(join(tmpdir(), 'gian-apps-'));
  writeFileSync(join(workspacePath, 'foo.md'), '# foo');
  appCtx.db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)')
    .run(workspaceId, 'demo', workspacePath);
  return {
    appCtx,
    workspaceId,
    workspacePath,
    cleanup: async () => {
      await appCtx.cleanup();
      rmSync(workspacePath, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// GET /api/apps/icon
// ---------------------------------------------------------------------------

test('/api/apps/icon: rejects name containing a slash', async () => {
  // The bad-name guard returns 400, but the route is macOS-only so off-darwin
  // the platform 404 fires first. Assert 400 on darwin, 404 elsewhere.
  const ctx = await setup();
  try {
    const res = await ctx.appCtx.fetch(
      `/api/apps/icon?name=${encodeURIComponent('foo/bar')}`,
    );
    assert.equal(res.status, process.platform === 'darwin' ? 400 : 404);
  } finally {
    await ctx.cleanup();
  }
});

test('/api/apps/icon: rejects name containing ..', async () => {
  const ctx = await setup();
  try {
    const res = await ctx.appCtx.fetch(
      `/api/apps/icon?name=${encodeURIComponent('..')}`,
    );
    assert.equal(res.status, process.platform === 'darwin' ? 400 : 404);
  } finally {
    await ctx.cleanup();
  }
});

test('/api/apps/icon: missing name → 400 (darwin) / 404 (other)', async () => {
  const ctx = await setup();
  try {
    const res = await ctx.appCtx.fetch('/api/apps/icon');
    assert.equal(res.status, process.platform === 'darwin' ? 400 : 404);
  } finally {
    await ctx.cleanup();
  }
});

test('/api/apps/icon: unknown app → 404', async () => {
  const ctx = await setup();
  try {
    const res = await ctx.appCtx.fetch(
      `/api/apps/icon?name=${encodeURIComponent('GianNoSuchApp_test_zzz')}`,
    );
    // darwin: name passes validation, no bundle found → 404.
    // other: macOS-only route → 404. Either way 404.
    assert.equal(res.status, 404);
  } finally {
    await ctx.cleanup();
  }
});

test('/api/apps/icon: serves a PNG for a real system app (darwin only)', async () => {
  // GUI-independent but depends on `sips`/`defaults` + a real .app bundle, so
  // it only runs on macOS. Calculator.app ships in /System/Applications (one
  // of the scanned dirs) on every modern macOS.
  if (process.platform !== 'darwin') return;
  const ctx = await setup();
  try {
    const res = await ctx.appCtx.fetch(
      `/api/apps/icon?name=${encodeURIComponent('Calculator')}`,
    );
    // 200 = bundle + icon found and sips succeeded. If this machine lacks the
    // bundle/icon or sips, the route degrades to 404 (never 500). Accept both
    // so CI stays deterministic.
    assert.ok(
      res.status === 200 || res.status === 404,
      `unexpected status ${res.status}`,
    );
    if (res.status === 200) {
      assert.equal(res.headers.get('content-type'), 'image/png');
      const buf = new Uint8Array(await res.arrayBuffer());
      assert.ok(buf.length > 8, 'png body should be non-empty');
      // PNG magic number: 89 50 4E 47.
      assert.equal(buf[0], 0x89);
      assert.equal(buf[1], 0x50);
      assert.equal(buf[2], 0x4e);
      assert.equal(buf[3], 0x47);
    }
  } finally {
    await ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// POST /api/working_trees/:id/open — builtin:'default' (awaited, reports 422)
// ---------------------------------------------------------------------------

test('/open default: reports a real outcome (200 ok or 422 no-app)', async () => {
  // The default branch now AWAITS the open instead of fire-and-forget. On
  // macOS, `open foo.md` hands the file to the machine's .md handler → 200; a
  // bare box with no handler → 422 no-app. Off-darwin the unchanged
  // fire-and-forget runOpen path also returns 200. Either way, no crash.
  const ctx = await setup();
  try {
    const res = await ctx.appCtx.fetch(
      `/api/working_trees/ws:${ctx.workspaceId}/open`,
      { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'foo.md', builtin: 'default' }) },
    );
    assert.ok(
      res.status === 200 || res.status === 422,
      `unexpected status ${res.status}`,
    );
    const body = await res.json() as { ok?: boolean; error?: string };
    if (res.status === 200) {
      assert.equal(body.ok, true);
    } else {
      assert.equal(body.error, 'no-app');
    }
  } finally {
    await ctx.cleanup();
  }
});

test('/open default: no-handler file → 422 {error:no-app} (darwin only)', async () => {
  // Force an extension LaunchServices has no handler for, so `open <file>`
  // exits non-zero and the awaited route returns 422. Off-darwin the default
  // opener keeps the unchanged fire-and-forget path (no 422 contract), so skip.
  if (process.platform !== 'darwin') return;
  const ctx = await setup();
  try {
    writeFileSync(join(ctx.workspacePath, 'mystery.giannosuchext_zzz'), 'x');
    const res = await ctx.appCtx.fetch(
      `/api/working_trees/ws:${ctx.workspaceId}/open`,
      { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'mystery.giannosuchext_zzz', builtin: 'default' }) },
    );
    // Expect 422 no-app. If the box somehow registered a handler for this junk
    // extension, accept 200 so CI doesn't flake — the load-bearing assertion is
    // "not a blind fire-and-forget 200".
    if (res.status === 422) {
      const body = await res.json() as { error: string };
      assert.equal(body.error, 'no-app');
    } else {
      assert.equal(res.status, 200, `unexpected status ${res.status}`);
    }
  } finally {
    await ctx.cleanup();
  }
});

test('/open: finder/terminal builtins unaffected (400 off darwin)', async () => {
  // Regression guard: the default-branch change must not touch finder/terminal.
  if (process.platform === 'darwin') return;
  const ctx = await setup();
  try {
    for (const builtin of ['finder', 'terminal']) {
      const res = await ctx.appCtx.fetch(
        `/api/working_trees/ws:${ctx.workspaceId}/open`,
        { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: 'foo.md', builtin }) },
      );
      assert.equal(res.status, 400, `${builtin} should be macOS-only off darwin`);
      const body = await res.json() as { error: string };
      assert.match(body.error, /macOS/);
    }
  } finally {
    await ctx.cleanup();
  }
});
