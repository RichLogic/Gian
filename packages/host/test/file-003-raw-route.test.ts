// Coverage for traceability rows (HTTP route dimension):
//   FILE-003 — `/api/working_trees/:id/raw` must serve the file bytes
//              with the MIME / inline disposition / nosniff /
//              X-Frame-Options:DENY / Cache-Control headers from
//              `buildRawPreviewHeaders` AND enforce the 20 MiB cap.
//   SEC-009 — HTML and SVG raw responses must carry the strict CSP
//              sandbox (frame-ancestors / object-src / script-src
//              constraints) so a user-authored asset cannot pivot into
//              the host origin.
//
// `packages/host/test/file-003-raw-preview.test.ts` already covers
// `buildRawPreviewHeaders` directly. This file pins the integration:
// the route invokes the helper AND returns the bytes through Hono with
// every header preserved through the response object.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { makeTestApp, type TestAppCtx } from './fixtures/test-app.js';

interface RawCtx {
  appCtx: TestAppCtx;
  workspacePath: string;
  workspaceId: string;
  treeId: string;
  cleanup: () => Promise<void>;
}

async function setup(files: Record<string, string | Buffer>): Promise<RawCtx> {
  const appCtx = await makeTestApp();
  const workspacePath = mkdtempSync(join(tmpdir(), 'gian-file003-raw-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(workspacePath, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content as string | Buffer);
  }
  const workspaceId = randomUUID();
  appCtx.db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)')
    .run(workspaceId, 'demo', workspacePath);
  return {
    appCtx,
    workspacePath,
    workspaceId,
    treeId: `ws:${workspaceId}`,
    cleanup: async () => {
      await appCtx.cleanup();
      rmSync(workspacePath, { recursive: true, force: true });
    },
  };
}

async function fetchRaw(ctx: RawCtx, path: string): Promise<Response> {
  return ctx.appCtx.fetch(`/api/working_trees/${ctx.treeId}/raw?path=${encodeURIComponent(path)}`);
}

// ---------------------------------------------------------------------------
// FILE-003 — baseline headers on a plain text file
// ---------------------------------------------------------------------------

test('FILE-003: /raw on a .txt file returns 200 with all 7 mandatory safety headers', async () => {
  const ctx = await setup({ 'note.txt': 'hello world\n' });
  try {
    const res = await fetchRaw(ctx, 'note.txt');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Content-Type'), 'text/plain; charset=utf-8');
    assert.equal(res.headers.get('Content-Length'), '12');
    assert.equal(res.headers.get('Content-Disposition'), 'inline; filename="note.txt"');
    assert.equal(res.headers.get('Cache-Control'), 'private, max-age=60');
    assert.equal(res.headers.get('Referrer-Policy'), 'no-referrer');
    assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(res.headers.get('X-Frame-Options'), 'DENY');
    // Body byte-for-byte match.
    assert.equal(await res.text(), 'hello world\n');
  } finally {
    await ctx.cleanup();
  }
});

test('FILE-003: /raw resolves MIME from the extension (PNG / PDF / JSON, etc.)', async () => {
  const ctx = await setup({
    'image.png': Buffer.from([0x89, 0x50, 0x4e, 0x47]), // PNG magic bytes
    'doc.pdf': Buffer.from('%PDF-1.4\n'),
    'data.json': '{"ok":true}',
    'styles.css': 'body { margin: 0 }',
  });
  try {
    assert.equal((await fetchRaw(ctx, 'image.png')).headers.get('Content-Type'), 'image/png');
    assert.equal((await fetchRaw(ctx, 'doc.pdf')).headers.get('Content-Type'), 'application/pdf');
    assert.equal((await fetchRaw(ctx, 'data.json')).headers.get('Content-Type'), 'application/json');
    assert.equal((await fetchRaw(ctx, 'styles.css')).headers.get('Content-Type'), 'text/css; charset=utf-8');
  } finally {
    await ctx.cleanup();
  }
});

test('FILE-003: /raw for an unknown extension falls back to application/octet-stream', async () => {
  // Important: an attacker-supplied `.foo` must NOT be served as text/html
  // — that would let smuggled HTML execute in the preview frame.
  const ctx = await setup({ 'mystery.foo': 'unknown payload' });
  try {
    const res = await fetchRaw(ctx, 'mystery.foo');
    assert.equal(res.headers.get('Content-Type'), 'application/octet-stream',
      'unknown extension MUST NOT inherit a sibling MIME — security boundary');
  } finally {
    await ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// SEC-009 — strict CSP for HTML + SVG
// ---------------------------------------------------------------------------

test('SEC-009: /raw on a .html file attaches a strict CSP that forbids framing, plugins, base, and form-action', async () => {
  const ctx = await setup({
    'preview.html': '<html><body><h1>hi</h1></body></html>',
  });
  try {
    const res = await fetchRaw(ctx, 'preview.html');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Content-Type'), 'text/html; charset=utf-8');
    const csp = res.headers.get('Content-Security-Policy');
    assert.ok(csp, 'HTML preview MUST carry a CSP header');
    for (const needle of [
      "frame-ancestors 'none'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "connect-src 'none'",
    ]) {
      assert.ok(csp!.includes(needle),
        `HTML CSP must include "${needle}" — sandboxing the preview`);
    }
  } finally {
    await ctx.cleanup();
  }
});

test('SEC-009: /raw on an .svg file attaches the tighter SVG CSP that forbids ALL scripts', async () => {
  const ctx = await setup({
    'icon.svg': '<svg xmlns="http://www.w3.org/2000/svg"><circle r="1"/></svg>',
  });
  try {
    const res = await fetchRaw(ctx, 'icon.svg');
    assert.equal(res.headers.get('Content-Type'), 'image/svg+xml');
    const csp = res.headers.get('Content-Security-Policy');
    assert.ok(csp, 'SVG preview MUST carry a CSP header (SVG can embed <script>)');
    assert.ok(csp!.includes("script-src 'none'"),
      'SVG CSP MUST set script-src to none — SVG <script> tags are an injection vector');
    assert.ok(csp!.includes("default-src 'none'"),
      'SVG CSP MUST start from deny-all default-src');
    assert.ok(csp!.includes("frame-ancestors 'none'"),
      'SVG CSP MUST forbid framing — defense in depth with X-Frame-Options:DENY');
  } finally {
    await ctx.cleanup();
  }
});

test('SEC-009: non-active content (PNG / PDF / JSON / TXT) does NOT receive a CSP header', async () => {
  // Adding CSP to inert types is harmless but the documented contract
  // says CSP is only attached for `text/html*` and `image/svg+xml`.
  const ctx = await setup({
    'image.png': Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    'doc.pdf': Buffer.from('%PDF-1.4\n'),
    'data.json': '{}',
    'note.txt': 'hi',
  });
  try {
    for (const rel of ['image.png', 'doc.pdf', 'data.json', 'note.txt']) {
      const res = await fetchRaw(ctx, rel);
      assert.equal(res.headers.get('Content-Security-Policy'), null,
        `${rel}: CSP header must NOT be attached for inert content`);
    }
  } finally {
    await ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// FILE-003 — 20 MiB cap and error paths
// ---------------------------------------------------------------------------

test('FILE-003: /raw returns 413 for files over the 20 MiB cap', async () => {
  // Build a ~20.5 MiB file. The cap is strict-greater-than 20 MiB.
  const ctx = await setup({
    'huge.bin': Buffer.alloc(20 * 1024 * 1024 + 1024, 0x61), // 20 MiB + 1 KiB
  });
  try {
    const res = await fetchRaw(ctx, 'huge.bin');
    assert.equal(res.status, 413,
      'files over 20 MiB must return 413 — preview shouldn\'t pipe huge buffers through the response');
    const body = await res.json() as { error: string };
    assert.match(body.error, /too large/);
  } finally {
    await ctx.cleanup();
  }
});

test('FILE-003: /raw returns 400 when path is missing', async () => {
  const ctx = await setup({ 'a.txt': 'x' });
  try {
    const res = await ctx.appCtx.fetch(`/api/working_trees/${ctx.treeId}/raw`);
    assert.equal(res.status, 400);
    const body = await res.json() as { error: string };
    assert.match(body.error, /path required/);
  } finally {
    await ctx.cleanup();
  }
});

test('FILE-003: /raw returns 404 for an unknown working_trees id', async () => {
  const ctx = await setup({});
  try {
    const res = await ctx.appCtx.fetch(`/api/working_trees/no-such-tree/raw?path=any.txt`);
    assert.equal(res.status, 404);
  } finally {
    await ctx.cleanup();
  }
});

test('FILE-003: /raw rejects path-traversal attempts with 400 (defers to safe-path helper)', async () => {
  // SEC-008 covers the safe-path helper at unit level; here we pin
  // the integration: the /raw route honors the helper.
  const ctx = await setup({ 'a.txt': 'x' });
  try {
    const res = await fetchRaw(ctx, '../escape.txt');
    assert.equal(res.status, 400);
    const body = await res.json() as { error: string };
    assert.match(body.error, /path escapes/);
  } finally {
    await ctx.cleanup();
  }
});

test('FILE-003: /raw returns 400 when the resolved path points at a directory, not a file', async () => {
  const ctx = await setup({ 'a.txt': 'x' });
  try {
    mkdirSync(join(ctx.workspacePath, 'somedir'), { recursive: true });
    const res = await fetchRaw(ctx, 'somedir');
    assert.equal(res.status, 400);
    const body = await res.json() as { error: string };
    assert.match(body.error, /not a file/);
  } finally {
    await ctx.cleanup();
  }
});

test('FILE-003: /raw serves a file with a non-ASCII (CJK) name without crashing the response', async () => {
  // Regression for the production bug: a CJK basename landed verbatim in
  // Content-Disposition, Node threw ERR_INVALID_CHAR while writing headers,
  // and the response aborted mid-stream so the "Open" link never loaded.
  const name = '方案二详细设计-第一期-密码加密.html';
  const html = '<html><body><h1>你好</h1></body></html>';
  const ctx = await setup({ [`docs/${name}`]: html });
  try {
    const res = await fetchRaw(ctx, `docs/${name}`);
    assert.equal(res.status, 200, 'CJK-named files must serve, not 500');
    assert.equal(res.headers.get('Content-Type'), 'text/html; charset=utf-8');
    const dispo = res.headers.get('Content-Disposition')!;
    assert.ok(/^[\x00-\x7f]*$/.test(dispo),
      `Content-Disposition must be pure ASCII (ERR_INVALID_CHAR guard) — got: ${dispo}`);
    assert.ok(dispo.includes("filename*=UTF-8''"),
      'non-ASCII name must be advertised via RFC 5987 filename*');
    // Body served byte-for-byte (the CSP/headers path still applies).
    assert.equal(await res.text(), html);
  } finally {
    await ctx.cleanup();
  }
});

test('FILE-003: /raw strips embedded quotes from the filename in Content-Disposition (no header injection)', async () => {
  // The helper strips `"` from the basename. Pin via integration that
  // the route doesn't reintroduce it from `rel`.
  const ctx = await setup({ 'wei"rd.txt': 'odd' });
  try {
    const res = await fetchRaw(ctx, 'wei"rd.txt');
    assert.equal(res.status, 200);
    const dispo = res.headers.get('Content-Disposition');
    assert.equal(dispo, 'inline; filename="weird.txt"',
      'Content-Disposition must strip embedded quotes from the filename');
  } finally {
    await ctx.cleanup();
  }
});
