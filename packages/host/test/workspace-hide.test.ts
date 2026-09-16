// UI-WS-HIDE-001 retired (2026-09-16): the Workspace hidden feature no
// longer exists — every repo shows everywhere. The `hidden` column stays for
// schema/API compatibility (migration 078 resets every row to 0); this file
// now pins the retirement contract: PATCH /api/workspaces/:id silently
// ignores `hidden` like any other unknown key.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { makeTestApp } from './fixtures/test-app.js';
import type { Workspace } from '@gian/shared';

test('UI-WS-HIDE-001 (retired) · workspaces keep the hidden column, default 0', async () => {
  const ctx = await makeTestApp();
  const wsId = randomUUID();
  ctx.db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)')
    .run(wsId, 'demo', '/tmp/demo-ws-hide');

  const row = ctx.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(wsId) as Workspace;
  assert.equal(row.hidden, 0, 'new row should default to hidden=0');

  await ctx.cleanup?.();
});

test('UI-WS-HIDE-001 (retired) · PATCH /api/workspaces/:id silently ignores hidden', async () => {
  const ctx = await makeTestApp();
  const wsId = randomUUID();
  ctx.db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)')
    .run(wsId, 'demo', '/tmp/demo-ws-patch');

  // `hidden` is not an updatable key anymore: alongside a real field it is
  // skipped (200, value untouched)…
  let res = await ctx.fetch(`/api/workspaces/${wsId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'renamed', hidden: true }),
  });
  assert.equal(res.status, 200);
  let after = ctx.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(wsId) as Workspace;
  assert.equal(after.name, 'renamed');
  assert.equal(after.hidden, 0, 'hidden is ignored, never written');

  // …and a hidden-only patch carries no updatable fields at all (400), same
  // as any unknown-only body.
  res = await ctx.fetch(`/api/workspaces/${wsId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hidden: true }),
  });
  assert.equal(res.status, 400);

  res = await ctx.fetch(`/api/workspaces/${wsId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hidden: 'yes' }),
  });
  assert.equal(res.status, 400, 'no hidden type validation either — just no updatable fields');

  after = ctx.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(wsId) as Workspace;
  assert.equal(after.hidden, 0);

  await ctx.cleanup?.();
});
