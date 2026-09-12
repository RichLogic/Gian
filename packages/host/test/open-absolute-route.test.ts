// Attachments-only OS Open. Preview (FILE-012) still accepts any absolute
// regular file; this route must not.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTestApp, type TestAppOptions } from './fixtures/test-app.js';
import { resolveAttachmentOpenPath } from '../src/web/routes/absolute-files.js';

function errorBody(body: unknown): string {
  return (body as { error: string }).error;
}

async function open(
  fetch: (path: string, init?: RequestInit) => Promise<Response>,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch('/api/files/open', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('resolveAttachmentOpenPath accepts only files under attachments', async () => {
  const ctx = await makeTestApp();
  try {
    const sessionDir = join(ctx.dataDir, 'attachments', 'sess-1');
    mkdirSync(sessionDir, { recursive: true });
    const file = join(sessionDir, 'plan.html');
    writeFileSync(file, '<html></html>');

    assert.equal(await resolveAttachmentOpenPath(file, ctx.dataDir), realpathSync(file));
    assert.equal(await resolveAttachmentOpenPath('plan.html', ctx.dataDir), null);
    assert.equal(await resolveAttachmentOpenPath(join(ctx.dataDir, 'other', 'x.txt'), ctx.dataDir), null);
    assert.equal(
      await resolveAttachmentOpenPath(join(ctx.dataDir, 'attachments', '..', 'secret.txt'), ctx.dataDir),
      null,
    );
  } finally {
    await ctx.cleanup();
  }
});

test('/api/files/open launches the default opener for an attachment', async () => {
  const ctx = await makeTestApp({ platform: 'darwin' });
  try {
    const sessionDir = join(ctx.dataDir, 'attachments', 'sess-1');
    mkdirSync(sessionDir, { recursive: true });
    const file = join(sessionDir, 'plan.html');
    writeFileSync(file, '<html></html>');

    const res = await open(ctx.fetch, { path: file, builtin: 'default' });
    assert.equal(res.status, 200);
    assert.deepEqual(ctx.openedCommands, [{
      mode: 'sync',
      command: { command: 'open', argv: [realpathSync(file)] },
    }]);
  } finally {
    await ctx.cleanup();
  }
});

test('/api/files/open rejects paths outside attachments without launching', async () => {
  const ctx = await makeTestApp({ platform: 'darwin' });
  try {
    const outside = join(ctx.dataDir, 'outside.txt');
    writeFileSync(outside, 'nope');
    const res = await open(ctx.fetch, { path: outside, builtin: 'default' });
    assert.equal(res.status, 400);
    assert.equal(errorBody(await res.json()), 'path outside attachments');
    assert.deepEqual(ctx.openedCommands, []);
  } finally {
    await ctx.cleanup();
  }
});

test('/api/files/open rejects relative paths, missing files, and directories', async () => {
  const ctx = await makeTestApp();
  try {
    const missing = await open(ctx.fetch, {});
    assert.equal(missing.status, 400);
    assert.equal(errorBody(await missing.json()), 'path required');

    const relative = await open(ctx.fetch, { path: 'plan.html' });
    assert.equal(relative.status, 400);
    assert.equal(errorBody(await relative.json()), 'absolute path required');

    const sessionDir = join(ctx.dataDir, 'attachments', 'sess-1');
    mkdirSync(sessionDir, { recursive: true });
    const gone = await open(ctx.fetch, { path: join(sessionDir, 'missing.html') });
    assert.equal(gone.status, 404);
    assert.equal(errorBody(await gone.json()), 'file not found');

    const dirRes = await open(ctx.fetch, { path: sessionDir });
    assert.equal(dirRes.status, 400);
    assert.equal(errorBody(await dirRes.json()), 'not a file');
  } finally {
    await ctx.cleanup();
  }
});

test('/api/files/open rejects a symlink that escapes attachments', async () => {
  const ctx = await makeTestApp({ platform: 'darwin' });
  try {
    const outside = join(ctx.dataDir, 'secret.txt');
    writeFileSync(outside, 'secret');
    const sessionDir = join(ctx.dataDir, 'attachments', 'sess-1');
    mkdirSync(sessionDir, { recursive: true });
    const link = join(sessionDir, 'link.txt');
    symlinkSync(outside, link);

    const res = await open(ctx.fetch, { path: link, builtin: 'default' });
    assert.equal(res.status, 400);
    assert.equal(errorBody(await res.json()), 'path outside attachments');
    assert.deepEqual(ctx.openedCommands, []);
  } finally {
    await ctx.cleanup();
  }
});

test('/api/files/open finder uses the injected launcher on macOS', async () => {
  const ctx = await makeTestApp({ platform: 'darwin' });
  try {
    const sessionDir = join(ctx.dataDir, 'attachments', 'sess-1');
    mkdirSync(sessionDir, { recursive: true });
    const file = join(sessionDir, 'notes.md');
    writeFileSync(file, 'hi');

    const res = await open(ctx.fetch, { path: file, builtin: 'finder' });
    assert.equal(res.status, 200);
    assert.deepEqual(ctx.openedCommands, [{
      mode: 'detached',
      command: { command: 'open', argv: ['-R', realpathSync(file)] },
    }]);
  } finally {
    await ctx.cleanup();
  }
});

test('/api/files/open preview still serves files outside attachments', async () => {
  const options: TestAppOptions = {};
  const ctx = await makeTestApp(options);
  try {
    const outside = join(ctx.dataDir, 'shot.png');
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    writeFileSync(outside, png);
    const res = await ctx.fetch(`/api/files/raw?path=${encodeURIComponent(outside)}`);
    assert.equal(res.status, 200);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), png);
  } finally {
    await ctx.cleanup();
  }
});
