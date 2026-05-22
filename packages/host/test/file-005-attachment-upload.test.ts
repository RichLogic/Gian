import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeAttachment, purgeSessionAttachments } from '../src/storage/attachments.js';

function withDataDir(): { dataDir: string; cleanup: () => void } {
  const dataDir = mkdtempSync(join(tmpdir(), 'gian-att-'));
  const prev = process.env.GIAN_DATA_DIR;
  process.env.GIAN_DATA_DIR = dataDir;
  return {
    dataDir,
    cleanup: () => {
      rmSync(dataDir, { recursive: true, force: true });
      if (prev === undefined) delete process.env.GIAN_DATA_DIR;
      else process.env.GIAN_DATA_DIR = prev;
    },
  };
}

test('writeAttachment writes a PNG into $GIAN_DATA_DIR/attachments/<session>/<uuid>.png', async () => {
  const { dataDir, cleanup } = withDataDir();
  try {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const path = await writeAttachment('sess-1', bytes, 'image/png');
    assert.ok(path.startsWith(join(dataDir, 'attachments', 'sess-1')));
    assert.ok(path.endsWith('.png'));
    assert.deepEqual(readFileSync(path), bytes);
  } finally { cleanup(); }
});

test('purgeSessionAttachments removes the session subdir', async () => {
  const { dataDir, cleanup } = withDataDir();
  try {
    const p = await writeAttachment('sess-2', Buffer.from([0x89]), 'image/png');
    assert.ok(existsSync(p));
    await purgeSessionAttachments('sess-2');
    assert.equal(existsSync(join(dataDir, 'attachments', 'sess-2')), false);
  } finally { cleanup(); }
});

test('purgeSessionAttachments is a no-op when the dir does not exist', async () => {
  const { cleanup } = withDataDir();
  try {
    await purgeSessionAttachments('never-existed'); // must not throw
  } finally { cleanup(); }
});

import { makeTestApp } from './fixtures/test-app.js';

async function withApp(): Promise<{ ctx: Awaited<ReturnType<typeof makeTestApp>>; sessionId: string }> {
  const ctx = await makeTestApp();
  // Insert a workspace row first — workspace_id is NOT NULL in the schema.
  const workspaceId = 'ws-test-1';
  ctx.db.prepare(
    `INSERT INTO workspaces (id, name, path) VALUES (?, 'test-ws', '/tmp/test-ws')`,
  ).run(workspaceId);
  // Minimal session row so the route's existence check passes.
  // native_session_id is NOT NULL (migration 013); supply a dummy value.
  const sessionId = 'sess-test-1';
  const now = new Date().toISOString();
  ctx.db.prepare(
    `INSERT INTO sessions (id, name, type, workspace_id, executor, model, approval_mode, turns, active_channel, status, archived, native_session_id, created_at, updated_at)
     VALUES (?, 'test', 'coding', ?, 'claude', NULL, 'ask', 1, 'web', 'idle', 0, 'native-test-1', ?, ?)`,
  ).run(sessionId, workspaceId, now, now);
  return { ctx, sessionId };
}

test('POST /api/sessions/:id/attachments writes the body to disk and returns {path,name,size,mime}', async () => {
  const { ctx, sessionId } = await withApp();
  try {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const form = new FormData();
    form.set('file', new Blob([png], { type: 'image/png' }), 'screenshot.png');
    const res = await ctx.fetch(`/api/sessions/${sessionId}/attachments`, { method: 'POST', body: form });
    assert.equal(res.status, 200);
    const body = await res.json() as { path: string; name: string; size: number; mime: string };
    assert.match(body.path, /\/attachments\/.+\.png$/);
    assert.equal(body.mime, 'image/png');
    assert.equal(body.size, png.length);
    assert.equal(body.name, 'screenshot.png');
  } finally { await ctx.cleanup(); }
});

test('POST /api/sessions/:id/attachments rejects unsupported mime with 415', async () => {
  const { ctx, sessionId } = await withApp();
  try {
    const form = new FormData();
    form.set('file', new Blob([Buffer.from('hello')], { type: 'text/plain' }), 'a.txt');
    const res = await ctx.fetch(`/api/sessions/${sessionId}/attachments`, { method: 'POST', body: form });
    assert.equal(res.status, 415);
  } finally { await ctx.cleanup(); }
});

test('POST /api/sessions/:id/attachments rejects oversized files with 413', async () => {
  const { ctx, sessionId } = await withApp();
  try {
    const big = Buffer.alloc(20 * 1024 * 1024 + 1, 1);
    const form = new FormData();
    form.set('file', new Blob([big], { type: 'image/png' }), 'big.png');
    const res = await ctx.fetch(`/api/sessions/${sessionId}/attachments`, { method: 'POST', body: form });
    assert.equal(res.status, 413);
  } finally { await ctx.cleanup(); }
});

test('POST /api/sessions/:id/attachments rejects unknown session_id with 404', async () => {
  const ctx = await makeTestApp();
  try {
    const form = new FormData();
    form.set('file', new Blob([Buffer.from('x')], { type: 'image/png' }), 'a.png');
    const res = await ctx.fetch('/api/sessions/no-such-session/attachments', { method: 'POST', body: form });
    assert.equal(res.status, 404);
  } finally { await ctx.cleanup(); }
});
