// Coverage for UI-WS-HIDE-001 — migration 022 adds Workspace.hidden
// column (0|1, default 0), and existing `SELECT * FROM workspaces`
// query paths auto-pick it up.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { makeTestApp } from './fixtures/test-app.js';
import type { Workspace } from '@gian/shared';

test('UI-WS-HIDE-001 · new workspaces default to hidden=0 and SELECT * returns it', async () => {
  const ctx = await makeTestApp();
  const wsId = randomUUID();
  ctx.db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)')
    .run(wsId, 'demo', '/tmp/demo-ws-hide');

  const row = ctx.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(wsId) as Workspace;
  assert.equal(row.hidden, 0, 'new row should default to hidden=0');

  ctx.db.prepare('UPDATE workspaces SET hidden = 1 WHERE id = ?').run(wsId);
  const after = ctx.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(wsId) as Workspace;
  assert.equal(after.hidden, 1, 'after setting to 1, row should read back as 1');

  await ctx.cleanup?.();
});

test('UI-WS-HIDE-001 · PATCH /api/workspaces/:id sets and clears hidden', async () => {
  const ctx = await makeTestApp();
  const wsId = randomUUID();
  ctx.db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)')
    .run(wsId, 'demo', '/tmp/demo-ws-patch');

  // Set hidden = 1
  let res = await ctx.fetch(`/api/workspaces/${wsId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hidden: true }),
  });
  assert.equal(res.status, 200);
  let after = ctx.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(wsId) as Workspace;
  assert.equal(after.hidden, 1);

  // Clear hidden back to 0
  res = await ctx.fetch(`/api/workspaces/${wsId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hidden: false }),
  });
  assert.equal(res.status, 200);
  after = ctx.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(wsId) as Workspace;
  assert.equal(after.hidden, 0);

  await ctx.cleanup?.();
});

test('UI-WS-HIDE-001 · PATCH rejects non-boolean hidden', async () => {
  const ctx = await makeTestApp();
  const wsId = randomUUID();
  ctx.db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)')
    .run(wsId, 'demo', '/tmp/demo-ws-patch-bad');

  const res = await ctx.fetch(`/api/workspaces/${wsId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hidden: 'yes' }),
  });
  assert.equal(res.status, 400);

  await ctx.cleanup?.();
});
