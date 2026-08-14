// FILE-012 — clicked absolute paths outside every registered working tree
// must still preview in Files. These routes are the Host half:
//   GET /api/files/content  — text/markdown JSON
//   GET /api/files/raw      — bytes with FILE-003 / SEC-009 headers

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeTestApp, type TestAppCtx } from './fixtures/test-app.js';
import { resolveAbsolutePreviewPath } from '../src/web/routes/absolute-files.js';

interface PreviewCtx {
  appCtx: TestAppCtx;
  outsideDir: string;
  cleanup: () => Promise<void>;
}

async function setup(): Promise<PreviewCtx> {
  const appCtx = await makeTestApp();
  const outsideDir = mkdtempSync(join(tmpdir(), 'gian-file012-outside-'));
  return {
    appCtx,
    outsideDir,
    cleanup: async () => {
      await appCtx.cleanup();
      rmSync(outsideDir, { recursive: true, force: true });
    },
  };
}

function errorBody(body: unknown): string {
  return (body as { error: string }).error;
}

test('resolveAbsolutePreviewPath accepts only absolute paths and resolves . / ..', () => {
  assert.equal(resolveAbsolutePreviewPath(''), null);
  assert.equal(resolveAbsolutePreviewPath('notes.md'), null);
  assert.equal(resolveAbsolutePreviewPath('~/notes.md'), null);
  assert.equal(resolveAbsolutePreviewPath('/tmp/attachments/plan.md'), '/tmp/attachments/plan.md');
  assert.equal(resolveAbsolutePreviewPath('/tmp/attachments/../plan.md'), '/tmp/plan.md');
});

test('FILE-012: /api/files/content previews a markdown file outside every workspace', async () => {
  const ctx = await setup();
  try {
    const sessionId = '07b78b22-2b8d-4e18-96de-9c9ec73775e8';
    const dir = join(ctx.appCtx.dataDir, 'attachments', sessionId);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'grok-proxy-parity-technical-plan.md');
    writeFileSync(path, '# Plan\n\nPreview me.\n');

    const res = await ctx.appCtx.fetch(`/api/files/content?path=${encodeURIComponent(path)}`);
    assert.equal(res.status, 200);
    const body = await res.json() as { path: string; size: number; content: string };
    assert.equal(body.path, path);
    assert.equal(body.content, '# Plan\n\nPreview me.\n');
    assert.equal(body.size, Buffer.byteLength(body.content));
  } finally {
    await ctx.cleanup();
  }
});

test('FILE-012: /api/files/content rejects relative, missing, directory, binary, and oversized paths', async () => {
  const ctx = await setup();
  try {
    const missing = await ctx.appCtx.fetch('/api/files/content');
    assert.equal(missing.status, 400);
    assert.equal(errorBody(await missing.json()), 'path required');

    const relative = await ctx.appCtx.fetch('/api/files/content?path=notes.md');
    assert.equal(relative.status, 400);
    assert.equal(errorBody(await relative.json()), 'absolute path required');

    const gone = join(ctx.outsideDir, 'missing.md');
    const notFound = await ctx.appCtx.fetch(`/api/files/content?path=${encodeURIComponent(gone)}`);
    assert.equal(notFound.status, 404);
    assert.equal(errorBody(await notFound.json()), 'file not found');

    const dirRes = await ctx.appCtx.fetch(
      `/api/files/content?path=${encodeURIComponent(ctx.outsideDir)}`,
    );
    assert.equal(dirRes.status, 400);
    assert.equal(errorBody(await dirRes.json()), 'not a file');

    const binaryPath = join(ctx.outsideDir, 'blob.bin');
    writeFileSync(binaryPath, Buffer.from([0x00, 0xff, 0x41]));
    const binary = await ctx.appCtx.fetch(`/api/files/content?path=${encodeURIComponent(binaryPath)}`);
    assert.equal(binary.status, 415);
    assert.equal(errorBody(await binary.json()), 'binary file; use raw endpoint');

    const hugePath = join(ctx.outsideDir, 'huge.txt');
    writeFileSync(hugePath, Buffer.alloc(1024 * 1024 + 1, 0x61));
    const huge = await ctx.appCtx.fetch(`/api/files/content?path=${encodeURIComponent(hugePath)}`);
    assert.equal(huge.status, 413);
    assert.equal(errorBody(await huge.json()), 'file too large');
  } finally {
    await ctx.cleanup();
  }
});

test('FILE-012: /api/files/raw serves bytes with FILE-003 / SEC-009 headers', async () => {
  const ctx = await setup();
  try {
    const imagePath = join(ctx.outsideDir, 'shot.png');
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    writeFileSync(imagePath, png);
    const image = await ctx.appCtx.fetch(`/api/files/raw?path=${encodeURIComponent(imagePath)}`);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('Content-Type'), 'image/png');
    assert.equal(image.headers.get('Content-Disposition'), 'inline; filename="shot.png"');
    assert.equal(image.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(image.headers.get('X-Frame-Options'), 'DENY');
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);

    const htmlPath = join(ctx.outsideDir, 'preview.html');
    writeFileSync(htmlPath, '<html><body>hi</body></html>');
    const html = await ctx.appCtx.fetch(`/api/files/raw?path=${encodeURIComponent(htmlPath)}`);
    assert.equal(html.status, 200);
    const csp = html.headers.get('Content-Security-Policy') ?? '';
    assert.match(csp, /sandbox/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /object-src 'none'/);
  } finally {
    await ctx.cleanup();
  }
});
