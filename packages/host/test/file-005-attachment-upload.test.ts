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

test('writeAttachment preserves a safe extension for generic files', async () => {
  const { dataDir, cleanup } = withDataDir();
  try {
    const bytes = Buffer.from('hello');
    const path = await writeAttachment('sess-text', bytes, 'text/plain', 'notes.txt');
    assert.ok(path.startsWith(join(dataDir, 'attachments', 'sess-text')));
    assert.ok(path.endsWith('.txt'));
    assert.deepEqual(readFileSync(path), bytes);
  } finally { cleanup(); }
});

test('writeAttachment does not let a generic upload masquerade as an inline image', async () => {
  const { dataDir, cleanup } = withDataDir();
  try {
    const path = await writeAttachment(
      'sess-spoof',
      Buffer.from('<script>bad()</script>'),
      'text/html',
      'not-really.png',
    );
    assert.ok(path.startsWith(join(dataDir, 'attachments', 'sess-spoof')));
    assert.ok(path.endsWith('.bin'));
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

test('POST /api/sessions/:id/attachments accepts a generic file snapshot', async () => {
  const { ctx, sessionId } = await withApp();
  try {
    const form = new FormData();
    form.set('file', new Blob([Buffer.from('hello')], { type: 'text/plain' }), 'a.txt');
    const res = await ctx.fetch(`/api/sessions/${sessionId}/attachments`, { method: 'POST', body: form });
    assert.equal(res.status, 200);
    const body = await res.json() as { path: string; name: string; size: number; mime: string };
    assert.match(body.path, /\/attachments\/.+\.txt$/);
    assert.equal(body.name, 'a.txt');
    assert.equal(body.mime, 'text/plain');
    assert.equal(body.size, 5);
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

test('GET /api/sessions/:id/attachments/:filename serves the upload back with its mime', async () => {
  const { ctx, sessionId } = await withApp();
  try {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const form = new FormData();
    form.set('file', new Blob([png], { type: 'image/png' }), 'screenshot.png');
    const upload = await ctx.fetch(`/api/sessions/${sessionId}/attachments`, { method: 'POST', body: form });
    const body = await upload.json() as { path: string };
    const filename = body.path.split('/').pop()!;

    const res = await ctx.fetch(`/api/sessions/${sessionId}/attachments/${filename}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.deepEqual(bytes, png);
  } finally { await ctx.cleanup(); }
});

test('GET generic attachment forces an opaque download instead of inline same-origin content', async () => {
  const { ctx, sessionId } = await withApp();
  try {
    const form = new FormData();
    form.set('file', new Blob([Buffer.from('<script>bad()</script>')], { type: 'text/html' }), 'page.html');
    const upload = await ctx.fetch(`/api/sessions/${sessionId}/attachments`, { method: 'POST', body: form });
    const body = await upload.json() as { path: string };
    const filename = body.path.split('/').pop()!;

    const res = await ctx.fetch(`/api/sessions/${sessionId}/attachments/${filename}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/octet-stream');
    assert.equal(res.headers.get('content-disposition'), 'attachment');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  } finally { await ctx.cleanup(); }
});

test('GET generic attachment with an image-looking name still forces an opaque download', async () => {
  const { ctx, sessionId } = await withApp();
  try {
    const form = new FormData();
    form.set('file', new Blob([Buffer.from('<script>bad()</script>')], { type: 'text/html' }), 'page.png');
    const upload = await ctx.fetch(`/api/sessions/${sessionId}/attachments`, { method: 'POST', body: form });
    const body = await upload.json() as { path: string };
    const filename = body.path.split('/').pop()!;
    assert.match(filename, /\.bin$/);

    const res = await ctx.fetch(`/api/sessions/${sessionId}/attachments/${filename}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/octet-stream');
    assert.equal(res.headers.get('content-disposition'), 'attachment');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  } finally { await ctx.cleanup(); }
});

test('GET /api/sessions/:id/attachments/:filename refuses path traversal', async () => {
  const { ctx, sessionId } = await withApp();
  try {
    const res = await ctx.fetch(`/api/sessions/${sessionId}/attachments/..%2F..%2Fetc%2Fpasswd`);
    assert.equal(res.status, 404);
  } finally { await ctx.cleanup(); }
});

test('GET /api/sessions/:id/attachments/:filename returns 404 for a missing generic file', async () => {
  const { ctx, sessionId } = await withApp();
  try {
    const res = await ctx.fetch(`/api/sessions/${sessionId}/attachments/whatever.txt`);
    assert.equal(res.status, 404);
  } finally { await ctx.cleanup(); }
});

test('GET /api/sessions/:id/attachments/:filename returns 404 when the file is missing', async () => {
  const { ctx, sessionId } = await withApp();
  try {
    const res = await ctx.fetch(`/api/sessions/${sessionId}/attachments/00000000-0000-0000-0000-000000000000.png`);
    assert.equal(res.status, 404);
  } finally { await ctx.cleanup(); }
});
