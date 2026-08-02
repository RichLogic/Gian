# Paste-Screenshot Attachments (v1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user paste an image (screenshot or copied bitmap) into the Composer; host writes it under `$GIAN_DATA_DIR/attachments/<session_id>/` and forwards its absolute path to cc/codex via the existing `LocalImageInputItem` channel.

**Architecture:** Composer's `onPaste` reads `image/*` items off the clipboard, POSTs each to `/api/sessions/:id/attachments`, gets back the absolute path on disk. The path goes into the per-message `items[]` as `{type:'localImage', path}`. ws-handler / session manager already pass `items` through to the proxy. codex-proxy already understands `localImage`; cc-proxy stops rejecting it and tacks `[Attached image: <path>]` onto the text prompt so Claude's `Read` tool can pick it up. Attachments dir is purged on session delete.

**Tech Stack:** TypeScript everywhere. Frontend: React 19, no new deps. Host: Hono (already in use) for the POST route, `c.req.parseBody()` for multipart, node `fs/promises` for disk. Tests: `node:test` everywhere (matches existing `packages/host/test/*.test.ts` and `packages/proxies/*/test/*.test.ts`). Host tests run with `node --test --import tsx test/...`; proxy tests run after a build pass and execute against `dist/test/...`.

**Out of scope (explicit non-goals for this plan):**
- Paperclip / file picker / drag-from-Finder — deferred.
- Workspace-tree drag (zero-copy) — deferred.
- Non-image attachments (PDF, txt, code files) — deferred.
- Inline base64 image content blocks in cc-proxy (would require switching cc runtime to `--input-format stream-json`).

---

## File Structure

**New:**
- `packages/host/src/storage/attachments.ts` — disk helpers: `writeAttachment(sessionId, bytes, name, mime) → absolutePath`, `purgeSessionAttachments(sessionId) → void`. Single responsibility: filesystem only, no HTTP.
- `packages/host/test/file-005-attachment-upload.test.ts` — vitest covering the upload route happy-path, MIME reject, size reject, missing-session reject, purge on delete.
- `packages/proxies/cc-proxy/test/input-localimage.test.ts` — vitest for `normalizeInputItems` accepting `localImage`.
- `packages/proxies/cc-proxy/test/build-prompt.test.ts` — vitest for `buildPrompt` including the `[Attached image: …]` line.

**Modified:**
- `packages/host/src/web/app.ts` — register `POST /api/sessions/:id/attachments` route.
- `packages/host/src/session/manager.ts:957` (`deleteSession`) — call `purgeSessionAttachments` after the row is gone.
- `packages/proxies/cc-proxy/src/core/input.ts` — remove the `throw` for `localImage`; accept and pass through.
- `packages/proxies/cc-proxy/src/core/service.ts:38-43` (`buildPrompt`) — fold in `localImage` items as `[Attached image: <path>]`.
- `packages/web/src/api.ts` — add `uploadAttachment(sessionId, blob, filename) → {path, name, size, mime}`.
- `packages/web/src/components/Composer.tsx` — extend `PendingFile` shape, add `onPaste` handler, render thumbnails, include items in submit, clear after send.
- `packages/web/src/App.tsx:792-797` — extend the `message:send` ws.send to include `items` built from attachments + text.
- `packages/web/src/styles/coding.css` — composer chip thumbnail styles (small additions).

---

## Decisions locked

- **Storage path:** `$GIAN_DATA_DIR/attachments/<session_id>/<uuid>.<ext>`. UUID prefix prevents collisions; extension preserved for downstream tools that sniff by extension.
- **Filename in prompt:** absolute path only. Filename is unimportant; the LLM gets the path and reads it.
- **Size limit:** 20 MB per attachment (matches frontend `MAX_FILE_BYTES`). Enforced again on the server.
- **MIME whitelist (server-side):** `image/png`, `image/jpeg`, `image/webp`, `image/gif`. Reject everything else with 415.
- **Cleanup trigger:** session delete. No background TTL sweep for v1; orphans are tolerated.
- **Auth:** route lives under `/api/...` which is already covered by the existing auth middleware in `app.ts`.
- **cc-proxy image strategy:** plain-text path hint, not stream-json base64. Claude `Read` tool picks images up from disk on demand.
- **Session creation timing (verified):** Composer mounts only after `session:created` returns from the host. `App.tsx:171-173` calls `setSessions` before `setActiveSessionId`; `CodingView.tsx:239` gates SessionMain on a truthy `activeSession`. So the session row is guaranteed in DB before any paste, and Task 2's 404-on-unknown-session branch will not bite the first-message flow.

---

## Task 1: Host storage helper

**Files:**
- Create: `packages/host/src/storage/attachments.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/host/test/file-005-attachment-upload.test.ts` with just the storage-level test first:

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/host && node --test --import tsx test/file-005-attachment-upload.test.ts`
Expected: FAIL — module `../src/storage/attachments.js` cannot be resolved.

- [ ] **Step 3: Implement `attachments.ts`**

```typescript
// packages/host/src/storage/attachments.ts
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveDataDir } from './paths.js';

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export const ALLOWED_MIME = new Set(Object.keys(MIME_EXT));
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

function sessionDir(sessionId: string): string {
  return join(resolveDataDir(), 'attachments', sessionId);
}

export async function writeAttachment(
  sessionId: string,
  bytes: Buffer,
  mime: string,
): Promise<string> {
  const ext = MIME_EXT[mime];
  if (!ext) throw new Error(`unsupported mime ${mime}`);
  const dir = sessionDir(sessionId);
  await mkdir(dir, { recursive: true });
  const filename = `${randomUUID()}.${ext}`;
  const path = join(dir, filename);
  await writeFile(path, bytes);
  return path;
}

export async function purgeSessionAttachments(sessionId: string): Promise<void> {
  await rm(sessionDir(sessionId), { recursive: true, force: true });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/host && node --test --import tsx test/file-005-attachment-upload.test.ts`
Expected: PASS (3 passing).

- [ ] **Step 5: Commit**

```bash
git add packages/host/src/storage/attachments.ts packages/host/test/file-005-attachment-upload.test.ts
git commit -m "feat(host): attachment storage helpers (writeAttachment, purgeSessionAttachments)"
```

---

## Task 2: HTTP upload route

**Files:**
- Modify: `packages/host/src/web/app.ts` (add new route, near other `/api/sessions/:id/...` routes around line 564–605)
- Modify: `packages/host/test/file-005-attachment-upload.test.ts` (append route-level tests)

- [ ] **Step 1: Write the failing route test**

The existing test fixture is `packages/host/test/fixtures/test-app.ts` exporting `makeTestApp(): Promise<TestAppCtx>` where `TestAppCtx` is `{app, db, dataDir, fetch, cleanup}`. Use `ctx.fetch(path, init)` (the fixture's wrapper around `app.fetch`) — **don't** call `app.request`. The fixture's DB is empty; insert a session row directly. Append to `file-005-attachment-upload.test.ts`:

```typescript
import { makeTestApp } from './fixtures/test-app.js';

async function withApp(): Promise<{ ctx: Awaited<ReturnType<typeof makeTestApp>>; sessionId: string }> {
  const ctx = await makeTestApp();
  // Minimal session row so the route's existence check passes.
  const sessionId = 'sess-test-1';
  const now = new Date().toISOString();
  ctx.db.prepare(
    `INSERT INTO sessions (id, name, type, workspace_id, executor, model, approval_mode, thinking_effort, turns, active_channel, status, archived, worktree_path, branch, base_branch, worktree_outcome, native_session_id, runtime_mode, created_at, updated_at)
     VALUES (?, 'test', 'chat', NULL, 'claude', NULL, 'ask', NULL, 1, NULL, 'idle', 0, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
  ).run(sessionId, now, now);
  return { ctx, sessionId };
}

// Note: the actual `sessions` table schema may differ — when this test
// fails on INSERT, copy the column list from an existing host test that
// seeds a session (e.g. `session-manager.test.ts`) rather than guessing.

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/host && node --test --import tsx test/file-005-attachment-upload.test.ts`
Expected: FAIL — route returns 404 for all four cases (no route registered yet).

- [ ] **Step 3: Register the route**

Insert into `packages/host/src/web/app.ts` after the existing `/api/sessions/:id/drop` block (line ~582):

```typescript
app.post('/api/sessions/:id/attachments', async c => {
  const sessionId = c.req.param('id');
  // 404 if no such session in DB
  const row = ctx.db.prepare('SELECT id FROM sessions WHERE id = ?').get(sessionId);
  if (!row) return c.json({ error: 'session not found' }, 404);

  const body = await c.req.parseBody();
  const file = body['file'];
  if (!(file instanceof File)) {
    return c.json({ error: 'file field required' }, 400);
  }
  const { ALLOWED_MIME, MAX_ATTACHMENT_BYTES, writeAttachment } =
    await import('../storage/attachments.js');
  if (!ALLOWED_MIME.has(file.type)) {
    return c.json({ error: `unsupported mime: ${file.type}` }, 415);
  }
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return c.json({ error: `file too large: ${file.size} bytes` }, 413);
  }
  const bytes = Buffer.from(await file.arrayBuffer());
  const path = await writeAttachment(sessionId, bytes, file.type);
  return c.json({ path, name: file.name, size: file.size, mime: file.type });
});
```

(Resolve the dynamic import to a top-of-file `import` if the existing file uses static imports throughout — match the file's style.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/host && node --test --import tsx test/file-005-attachment-upload.test.ts`
Expected: PASS (3 storage tests + 4 route tests).

- [ ] **Step 5: Commit**

```bash
git add packages/host/src/web/app.ts packages/host/test/file-005-attachment-upload.test.ts
git commit -m "feat(host): POST /api/sessions/:id/attachments uploads images to disk"
```

---

## Task 3: Purge attachments on session delete

**Files:**
- Modify: `packages/host/src/session/manager.ts:957-981` (`deleteSession`)

`AppHandle` doesn't expose `SessionManager`, so a clean integration test would require widening the test surface. Task 1 already covers `purgeSessionAttachments` directly. This task is a single one-line wire-up + manual verification in Task 10. **No new test is added here on purpose** — the cost (extending AppHandle for one assertion) is not worth it.

- [ ] **Step 1: Import the helper**

At the top of `packages/host/src/session/manager.ts`, near the other `storage/` imports:

```typescript
import { purgeSessionAttachments } from '../storage/attachments.js';
```

- [ ] **Step 2: Call it inside `deleteSession`**

In `packages/host/src/session/manager.ts:974` (right after `this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);`), add:

```typescript
await purgeSessionAttachments(sessionId);
```

- [ ] **Step 3: Typecheck**

Run: `cd packages/host && pnpm typecheck 2>&1 | grep manager.ts`
Expected: no errors from `manager.ts`.

- [ ] **Step 4: Commit**

```bash
git add packages/host/src/session/manager.ts
git commit -m "feat(host): purge attachments dir on session delete"
```

---

## Task 4: cc-proxy accepts `localImage`

**Files:**
- Create: `packages/proxies/cc-proxy/test/input-localimage.test.ts`
- Modify: `packages/proxies/cc-proxy/src/core/input.ts`

- [ ] **Step 1: Write the failing test**

cc-proxy uses `node:test` and runs against compiled output in `dist/`. Match the existing `test/service.test.ts` pattern:

```typescript
// packages/proxies/cc-proxy/test/input-localimage.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeInputItems } from '../src/core/input.js';

test('cc-proxy normalizeInputItems accepts a localImage with absolute path', () => {
  const out = normalizeInputItems(
    [{ type: 'localImage', path: '/tmp/foo.png' }],
    '/workdir',
  );
  assert.deepEqual(out, [{ type: 'localImage', path: '/tmp/foo.png' }]);
});

test('cc-proxy normalizeInputItems resolves a relative localImage path against cwd', () => {
  const out = normalizeInputItems(
    [{ type: 'localImage', path: 'rel.png' }],
    '/workdir',
  );
  assert.deepEqual(out, [{ type: 'localImage', path: '/workdir/rel.png' }]);
});

test('cc-proxy normalizeInputItems rejects empty localImage path', () => {
  assert.throws(
    () => normalizeInputItems([{ type: 'localImage', path: '   ' }], '/workdir'),
    /path/,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/proxies/cc-proxy && pnpm build && node --test dist/test/input-localimage.test.js`
Expected: FAIL — first test throws "not supported yet" (current behavior).

- [ ] **Step 3: Implement**

Replace the `localImage` branch in `packages/proxies/cc-proxy/src/core/input.ts`:

```typescript
import { resolve } from 'node:path';
import { createAppError } from './errors.js';
import type { InputItem } from './types.js';

export function normalizeInputItems(input: unknown, cwd: string): InputItem[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw createAppError(400, 'INVALID_REQUEST', 'input must be a non-empty array.');
  }

  return input.map((entry) => {
    if (!entry || typeof entry !== 'object') {
      throw createAppError(400, 'INVALID_REQUEST', 'Each input item must be an object.');
    }
    const record = entry as Record<string, unknown>;

    if (record.type === 'text') {
      const text = typeof record.text === 'string' ? record.text : '';
      if (!text.trim()) {
        throw createAppError(400, 'INVALID_REQUEST', 'text input items require non-empty text.');
      }
      return { type: 'text', text } satisfies InputItem;
    }

    if (record.type === 'localImage') {
      const path = typeof record.path === 'string' ? record.path.trim() : '';
      if (!path) {
        throw createAppError(400, 'INVALID_REQUEST', 'localImage items require a path.');
      }
      return { type: 'localImage', path: resolve(cwd, path) } satisfies InputItem;
    }

    throw createAppError(400, 'INVALID_REQUEST', `Unsupported input item type "${String(record.type)}".`);
  });
}
```

Also verify the cc-proxy `InputItem` union type already includes `LocalImageInputItem` (it should via `shared/src/proxy.ts` re-export — if not, extend `core/types.ts` to match).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/proxies/cc-proxy && pnpm build && node --test dist/test/input-localimage.test.js`
Expected: PASS (3 passing).

- [ ] **Step 5: Commit**

```bash
git add packages/proxies/cc-proxy/src/core/input.ts packages/proxies/cc-proxy/test/input-localimage.test.ts
git commit -m "feat(cc-proxy): accept localImage input items"
```

---

## Task 5: cc-proxy buildPrompt includes image path hint

**Files:**
- Create: `packages/proxies/cc-proxy/test/build-prompt.test.ts`
- Modify: `packages/proxies/cc-proxy/src/core/service.ts:38-43` (`buildPrompt`)

- [ ] **Step 1: Write the failing test**

`buildPrompt` is module-private. Export it narrowly for tests (tagged `// exported for tests`). Test file uses `node:test`, same import-from-src pattern as Task 4:

```typescript
// packages/proxies/cc-proxy/test/build-prompt.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPrompt } from '../src/core/service.js';

test('cc-proxy buildPrompt joins text items with double newline', () => {
  const out = buildPrompt([
    { type: 'text', text: 'hello' },
    { type: 'text', text: 'world' },
  ]);
  assert.equal(out, 'hello\n\nworld');
});

test('cc-proxy buildPrompt appends [Attached image: <path>] for localImage items', () => {
  const out = buildPrompt([
    { type: 'text', text: 'what is in this?' },
    { type: 'localImage', path: '/tmp/abc.png' },
  ]);
  assert.equal(out, 'what is in this?\n\n[Attached image: /tmp/abc.png]');
});

test('cc-proxy buildPrompt handles image-only input', () => {
  const out = buildPrompt([{ type: 'localImage', path: '/tmp/x.png' }]);
  assert.equal(out, '[Attached image: /tmp/x.png]');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/proxies/cc-proxy && pnpm build && node --test dist/test/build-prompt.test.js`
Expected: FAIL — `buildPrompt` not exported, or image case is dropped.

- [ ] **Step 3: Implement**

Edit `packages/proxies/cc-proxy/src/core/service.ts` lines 38–43:

```typescript
// exported for tests
export function buildPrompt(input: InputItem[]): string {
  const parts: string[] = [];
  for (const item of input) {
    if (item.type === 'text' && typeof item.text === 'string' && item.text.length > 0) {
      parts.push(item.text);
    } else if (item.type === 'localImage' && typeof item.path === 'string' && item.path.length > 0) {
      parts.push(`[Attached image: ${item.path}]`);
    }
  }
  return parts.join('\n\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/proxies/cc-proxy && pnpm build && node --test dist/test/build-prompt.test.js`
Expected: PASS (3 passing).

- [ ] **Step 5: Commit**

```bash
git add packages/proxies/cc-proxy/src/core/service.ts packages/proxies/cc-proxy/test/build-prompt.test.ts
git commit -m "feat(cc-proxy): include localImage paths in the prompt for Read tool pickup"
```

---

## Task 6: Frontend API helper

**Files:**
- Modify: `packages/web/src/api.ts`

- [ ] **Step 1: Add the helper**

Append to `packages/web/src/api.ts`:

```typescript
export interface UploadedAttachment {
  path: string;
  name: string;
  size: number;
  mime: string;
}

export async function uploadAttachment(
  sessionId: string,
  blob: Blob,
  filename: string,
): Promise<UploadedAttachment> {
  const form = new FormData();
  form.set('file', blob, filename);
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/attachments`, {
    method: 'POST',
    body: form,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`upload failed (${res.status}): ${detail || res.statusText}`);
  }
  return (await res.json()) as UploadedAttachment;
}
```

- [ ] **Step 2: Verify typecheck**

Run: `cd packages/web && pnpm typecheck 2>&1 | grep api.ts`
Expected: no errors from `api.ts` (pre-existing errors elsewhere are OK; we don't fix them in this plan).

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/api.ts
git commit -m "feat(web): uploadAttachment API helper"
```

---

## Task 7: Composer paste handler + extended PendingFile state

**Files:**
- Modify: `packages/web/src/components/Composer.tsx`

- [ ] **Step 1: Extend the `PendingFile` shape**

Replace the existing `PendingFile` interface (line 29-34) with:

```typescript
interface PendingFile {
  /** Local id so React keys are stable even when name is duplicated. */
  id: string;
  /** Display filename (paste auto-generates `paste-{timestamp}.png`). */
  name: string;
  size: number;
  sizeLabel: string;
  /** Object URL for thumbnail preview. Revoke when removed/sent. */
  previewUrl: string;
  /** Absolute path returned by the upload endpoint, or null while uploading. */
  path: string | null;
  /** True while the POST is in flight. */
  uploading: boolean;
  /** Set when the upload fails so the chip can show the error state. */
  error?: string;
}
```

- [ ] **Step 2: Update `removeFile`, add upload + paste handlers**

Replace `removeFile` (around line 408-410) with:

```typescript
function removeFile(id: string) {
  setPendingFiles(prev => {
    const target = prev.find(f => f.id === id);
    if (target) URL.revokeObjectURL(target.previewUrl);
    return prev.filter(f => f.id !== id);
  });
}
```

Add (anywhere near the other handlers):

```typescript
async function uploadOne(file: File): Promise<void> {
  const id = crypto.randomUUID();
  const previewUrl = URL.createObjectURL(file);
  const entry: PendingFile = {
    id,
    name: file.name,
    size: file.size,
    sizeLabel: fmtBytes(file.size),
    previewUrl,
    path: null,
    uploading: true,
  };
  setPendingFiles(prev => [...prev, entry]);

  try {
    const { uploadAttachment } = await import('../api.js');
    const result = await uploadAttachment(session.id, file, file.name);
    setPendingFiles(prev =>
      prev.map(f => f.id === id ? { ...f, path: result.path, uploading: false } : f),
    );
  } catch (err) {
    setPendingFiles(prev =>
      prev.map(f => f.id === id ? { ...f, uploading: false, error: String(err) } : f),
    );
  }
}

function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
  const items = Array.from(e.clipboardData?.items ?? []);
  const images = items.filter(it => it.kind === 'file' && it.type.startsWith('image/'));
  if (images.length === 0) return; // let normal text paste through
  e.preventDefault();
  for (const it of images) {
    const file = it.getAsFile();
    if (!file) continue;
    if (file.size > MAX_FILE_BYTES) continue; // silently drop; chip would be useless
    // Screenshots have empty name — fabricate one.
    const named = file.name ? file : new File([file], `paste-${Date.now()}.png`, { type: file.type });
    void uploadOne(named);
  }
}
```

- [ ] **Step 3: Wire `onPaste` onto the textarea**

Find the `<textarea ref={ref} …>` element. Add the `onPaste={handlePaste}` prop alongside the existing handlers.

- [ ] **Step 4: Update the chip rendering**

Find the chips block (around line 483-501). Replace with a version that shows the thumbnail + uploading state + error state. Keep the existing layout class names so the CSS additions in Task 8 hook on cleanly:

```tsx
{pendingFiles.length > 0 && (
  <div className="composer-attachments">
    {pendingFiles.map(f => (
      <div key={f.id} className={`att-chip${f.error ? ' is-error' : ''}${f.uploading ? ' is-uploading' : ''}`}>
        <img className="att-thumb" src={f.previewUrl} alt="" />
        <span className="att-name" title={f.error ?? f.name}>{f.name}</span>
        <span className="att-size">{f.sizeLabel}</span>
        <button className="att-remove" type="button" onClick={() => removeFile(f.id)} aria-label="Remove attachment">✕</button>
      </div>
    ))}
  </div>
)}
```

- [ ] **Step 5: Typecheck**

Run: `cd packages/web && pnpm typecheck 2>&1 | grep Composer.tsx`
Expected: no Composer-specific errors.

- [ ] **Step 6: Commit**

```bash
git add packages/web/src/components/Composer.tsx
git commit -m "feat(web): composer paste handler uploads images to the host"
```

---

## Task 8: Composer chip CSS

**Files:**
- Modify: `packages/web/src/styles/coding.css`

- [ ] **Step 1: Find the composer styles section**

Run: `grep -n "\.composer" packages/web/src/styles/coding.css | head`
Use the existing `.composer-*` block as the anchor; add the attachment styles immediately after it. **Don't introduce a new file.**

- [ ] **Step 2: Add the rules**

```css
.composer-attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 6px 10px 0;
}
.att-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 6px 3px 3px;
  background: var(--surface-2);
  border: 1px solid var(--hairline);
  border-radius: var(--r-2);
  font-size: 11px;
  max-width: 240px;
}
.att-chip.is-uploading { opacity: 0.6; }
.att-chip.is-error { border-color: var(--warn); color: var(--warn); }
.att-thumb {
  width: 28px; height: 28px;
  object-fit: cover;
  border-radius: var(--r-1);
  flex-shrink: 0;
}
.att-name {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.att-size {
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}
.att-remove {
  background: none;
  border: none;
  color: var(--text-3);
  cursor: pointer;
  font-size: 12px;
  padding: 0 2px;
}
.att-remove:hover { color: var(--text); }
```

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/styles/coding.css
git commit -m "feat(web): composer attachment chip styles"
```

---

## Task 9: Composer submit and App.tsx ws.send carry items

**Files:**
- Modify: `packages/web/src/components/Composer.tsx` (`submit`)
- Modify: `packages/web/src/App.tsx:781-798` (onSend callback)

- [ ] **Step 1: Extend the `onSend` prop type in Composer**

Around line 161 where `onSend` is typed:

```typescript
onSend: (
  text: string,
  opts?: {
    oneShotBypass?: boolean;
    /** Absolute paths of uploaded images for this turn. */
    imagePaths?: string[];
  },
) => void;
```

- [ ] **Step 2: Update `submit()` to forward image paths and clear chips**

Replace `submit` (line 371-383):

```typescript
function submit() {
  const trimmed = text.trim();
  // Wait for in-flight uploads to land before sending. We allow the send if
  // there's any text OR at least one ready attachment.
  const ready = pendingFiles.filter(f => !f.uploading && !f.error && f.path);
  if (!trimmed && ready.length === 0) return;
  if (pendingFiles.some(f => f.uploading)) return; // chip spinner indicates wait

  const imagePaths = ready.map(f => f.path!) ;
  if (disabled) {
    onQueueAdd(trimmed); // queue ignores images for now (out of scope)
  } else {
    onSend(trimmed, {
      ...(oneShotBypass ? { oneShotBypass: true } : {}),
      ...(imagePaths.length > 0 ? { imagePaths } : {}),
    });
    if (oneShotBypass) setOneShotBypass(false);
  }
  // Revoke object URLs and clear chips.
  for (const f of pendingFiles) URL.revokeObjectURL(f.previewUrl);
  setPendingFiles([]);
  setText('');
}
```

- [ ] **Step 3: Extend App.tsx onSend to emit items**

Replace the existing `onSend` callback (line 781-798) in `App.tsx`:

```typescript
onSend={(sessionId, text, opts) => {
  const exec = sessionsRef.current.find(s => s.id === sessionId)?.executor ?? 'claude';
  const optimistic = createOptimisticEcho({ sessionId, text, exec });
  setItemsBySession(prev => ({
    ...prev,
    [sessionId]: [...(prev[sessionId] ?? []), optimistic],
  }));
  setPendingBySession(p => ({ ...p, [sessionId]: true }));

  const items: Array<{ type: 'text'; text: string } | { type: 'localImage'; path: string }> = [];
  if (text.trim()) items.push({ type: 'text', text });
  for (const path of opts?.imagePaths ?? []) {
    items.push({ type: 'localImage', path });
  }

  ws.send({
    type: 'message:send',
    session_id: sessionId,
    text,
    ...(items.length > 0 ? { items } : {}),
    ...(opts?.oneShotBypass ? { oneShotBypass: true } : {}),
  });
}}
```

Update the corresponding `onSend` prop type wherever it's threaded (likely `SessionListView` or the workspace view's prop interface). Match the new signature: `(sessionId, text, opts?: {oneShotBypass?: boolean; imagePaths?: string[]}) => void`.

- [ ] **Step 4: Typecheck**

Run: `cd packages/web && pnpm typecheck 2>&1 | grep -E "Composer|App.tsx"`
Expected: no errors from these two files.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/Composer.tsx packages/web/src/App.tsx
git commit -m "feat(web): forward attachment paths as localImage items on message:send"
```

---

## Task 10: Manual smoke test

**Files:** none (verification only)

- [ ] **Step 1: Start the dev server**

```bash
export PATH=~/.nvm/versions/node/v22.18.0/bin:$PATH
GIAN_PORT=8991 GIAN_HOST_PORT=8991 pnpm dev
```

- [ ] **Step 2: Codex session smoke**

In the browser at http://localhost:5191/, open a **codex** session. Take a screenshot with `⌘⇧⌃4`. Click into the composer textarea, press `⌘V`. Expected:
- A chip with thumbnail appears in `.composer-attachments`.
- Inspect `~/.config/gian/attachments/<session_id>/` — one `<uuid>.png` file landed.
- Type "What's in this image?" and send. The chip clears.
- Codex describes the screenshot.

- [ ] **Step 3: Claude session smoke**

Open a **claude** session. Paste a screenshot, ask "What's in this image?". Expected:
- Same chip behavior.
- Claude's first action: a `Read` tool call against the path. Then its response describes the image.

- [ ] **Step 4: Session delete cleanup**

Delete the session from the sidebar. Verify `~/.config/gian/attachments/<session_id>/` is gone.

- [ ] **Step 5: Error path**

Try a non-image (drag a `.txt` into the textarea, or modify devtools to POST `text/plain` to the upload endpoint). Verify 415 and no chip.

- [ ] **Step 6: If everything passes, commit (no code change — empty placeholder commit not needed)**

The previous nine commits stand on their own.

---

## Self-Review Notes

- **Spec coverage:** Paste image (Task 7) → upload (Tasks 1–2) → message items (Task 9) → codex consumes natively, cc-proxy consumes via Tasks 4–5 → cleanup (Task 3). Covered.
- **No placeholders:** All steps include code or exact commands.
- **Type consistency:** `PendingFile` shape introduced in Task 7 is used unchanged in Tasks 7 and 9. `UploadedAttachment` in Task 6 matches what Task 2's route returns. `localImage` items match the existing `LocalImageInputItem` in `shared/src/proxy.ts`.
- **Test stack:** `node:test` everywhere. Host runs against TS source via `--import tsx`; proxies run against `dist/` after a build pass. Fixture for host integration is `test/fixtures/test-app.ts::makeTestApp`, returning `{app, db, dataDir, fetch, cleanup}`.
- **One execution-time check:** Task 2's `INSERT INTO sessions` column list mirrors the schema at `manager.ts:253`. If migrations land between plan-write and execution and a column is added with `NOT NULL`, the test INSERT will fail — copy the columns from a current host test that seeds a session (`session-manager.test.ts`).
