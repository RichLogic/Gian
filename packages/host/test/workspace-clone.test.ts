// Coverage for the clone-only endpoint (issue #57 new-workspace redesign):
// POST /api/workspaces/clone materializes a git remote under
// <workspace_root>/<name> WITHOUT registering a workspace row — the form
// fills its Directory field from the response and Create (adopt) registers
// it afterwards.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveConfig } from '../src/storage/config.js';
import { bareUpstream } from './fixtures/git-repo.js';
import { makeTestApp } from './fixtures/test-app.js';

test('clone-only: clones into workspace_root/<url-derived name> without registering', async () => {
  const ctx = await makeTestApp();
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gian-clone-root-')));
  const upstream = bareUpstream();
  try {
    saveConfig(ctx.db, { workspace_root: root });
    const res = await ctx.fetch('/api/workspaces/clone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ git_remote: upstream.path }),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { path: string; name: string };
    // URL basename of a gian-gitfx-bare-XXXX tmp dir, sanitized.
    assert.ok(body.name.length > 0);
    assert.equal(body.path, join(root, body.name));
    assert.ok(readdirSync(body.path).length > 0, 'clone produced files');
    // Clone-only: no workspace row may appear.
    const rows = ctx.db.prepare('SELECT COUNT(*) AS n FROM workspaces').get() as { n: number };
    assert.equal(rows.n, 0);
  } finally {
    upstream.cleanup();
    rmSync(root, { recursive: true, force: true });
    await ctx.cleanup();
  }
});

test('clone-only: explicit name wins and the path feeds a normal adopt-create', async () => {
  const ctx = await makeTestApp();
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gian-clone-root-')));
  const upstream = bareUpstream();
  try {
    saveConfig(ctx.db, { workspace_root: root });
    const cloneRes = await ctx.fetch('/api/workspaces/clone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ git_remote: upstream.path, name: 'cloned-proj' }),
    });
    assert.equal(cloneRes.status, 200);
    const cloned = await cloneRes.json() as { path: string; name: string };
    assert.equal(cloned.name, 'cloned-proj');
    assert.equal(cloned.path, join(root, 'cloned-proj'));

    // The form's Create adopts the cloned directory verbatim.
    const createRes = await ctx.fetch('/api/workspaces', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'cloned-proj', path: cloned.path }),
    });
    assert.equal(createRes.status, 200);
    const created = await createRes.json() as { workspace: { path: string } };
    assert.equal(created.workspace.path, cloned.path);
  } finally {
    upstream.cleanup();
    rmSync(root, { recursive: true, force: true });
    await ctx.cleanup();
  }
});

test('clone-only: missing git_remote is a 400; recloning the same target fails cleanly', async () => {
  const ctx = await makeTestApp();
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gian-clone-root-')));
  const upstream = bareUpstream();
  try {
    saveConfig(ctx.db, { workspace_root: root });
    const missing = await ctx.fetch('/api/workspaces/clone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(missing.status, 400);

    const first = await ctx.fetch('/api/workspaces/clone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ git_remote: upstream.path, name: 'dupe' }),
    });
    assert.equal(first.status, 200);
    // Target now exists and is non-empty — a second clone must not clobber.
    const second = await ctx.fetch('/api/workspaces/clone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ git_remote: upstream.path, name: 'dupe' }),
    });
    assert.equal(second.status, 400);
  } finally {
    upstream.cleanup();
    rmSync(root, { recursive: true, force: true });
    await ctx.cleanup();
  }
});
