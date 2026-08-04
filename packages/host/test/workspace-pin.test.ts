// Coverage for UI-WS-PIN-001 — migration 044 adds Workspace.pinned
// column (0|1, default 0); PATCH /api/workspaces/:id accepts a boolean
// `pinned` patch alongside `hidden`.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { makeTestApp } from './fixtures/test-app.js';
import type { Workspace } from '@gian/shared';

test('UI-WS-PIN-001 · new workspaces default to pinned=0', async () => {
  const ctx = await makeTestApp();
  const wsId = randomUUID();
  ctx.db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)')
    .run(wsId, 'demo', '/tmp/demo-ws-pin');

  const row = ctx.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(wsId) as Workspace;
  assert.equal(row.pinned, 0, 'new row should default to pinned=0');

  await ctx.cleanup?.();
});

test('UI-WS-PIN-001 · PATCH /api/workspaces/:id sets and clears pinned', async () => {
  const ctx = await makeTestApp();
  const wsId = randomUUID();
  ctx.db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)')
    .run(wsId, 'demo', '/tmp/demo-ws-pin-patch');

  let res = await ctx.fetch(`/api/workspaces/${wsId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pinned: true }),
  });
  assert.equal(res.status, 200);
  let after = ctx.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(wsId) as Workspace;
  assert.equal(after.pinned, 1);

  res = await ctx.fetch(`/api/workspaces/${wsId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pinned: false }),
  });
  assert.equal(res.status, 200);
  after = ctx.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(wsId) as Workspace;
  assert.equal(after.pinned, 0);

  await ctx.cleanup?.();
});

test('UI-WS-PIN-001 · PATCH rejects non-boolean pinned', async () => {
  const ctx = await makeTestApp();
  const wsId = randomUUID();
  ctx.db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)')
    .run(wsId, 'demo', '/tmp/demo-ws-pin-bad');

  const res = await ctx.fetch(`/api/workspaces/${wsId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pinned: 'yes' }),
  });
  assert.equal(res.status, 400);

  await ctx.cleanup?.();
});
