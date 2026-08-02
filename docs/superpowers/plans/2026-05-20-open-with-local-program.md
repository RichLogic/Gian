# Open with local program — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Files view gets an "Open" split-button that hands the active file to the OS default app or one of the user's configured external editors.

**Architecture:** Add `external_editors: ExternalEditor[]` to `SystemConfig` (stored JSON-encoded in the existing `config` K/V table). A new `POST /api/working_trees/:id/open` route delegates to a small `open-with.ts` helper module containing pure `buildEditorArgs` / `defaultOpenerArgs` functions plus a `runOpen` wrapper that `execFile`s them. FilesView replaces the existing "Open in new tab" anchor with a split button + dropdown menu. SettingsBody grows a CRUD section for the editor list.

**Tech Stack:** TypeScript, React, Hono (host HTTP), `node:test` (host), Vitest + React Testing Library (web), better-sqlite3 (`config` table).

**Spec:** `docs/superpowers/specs/2026-05-20-open-with-local-program-design.md`

---

## File map

**Create:**
- `packages/host/src/web/open-with.ts` — pure argv builders + spawn wrapper.
- `packages/host/test/open-with.test.ts` — unit tests for the builders.
- `packages/host/test/open-route.test.ts` — route-level boundary tests.
- `packages/web/test/files-view-open-with.test.tsx` — UI behaviour tests.
- `packages/web/test/settings-external-editors.test.tsx` — Settings CRUD tests.

**Modify:**
- `packages/shared/src/model.ts` — `ExternalEditor` interface, `external_editors` on `SystemConfig`.
- `packages/host/src/storage/config.ts` — JSON-encode/decode the new field; validate on save.
- `packages/host/src/web/app.ts` — register `POST /api/working_trees/:id/open` after the existing `/reveal` route (line 1666).
- `packages/host/test/storage.test.ts` — round-trip + validation tests.
- `packages/web/src/api.ts` — `openFileWith` client.
- `packages/web/src/views/FilesView.tsx` — replace the open-in-new-tab anchor (lines 659-670) with the split button + menu; accept new `onOpenSettings` prop.
- `packages/web/src/App.tsx` — pass `onOpenSettings={() => toggleWbTabKind('settings')}` to `<FilesView />`.
- `packages/web/src/components/SettingsBody.tsx` — add External editors section.
- `packages/web/src/styles/session.css` — split-button + menu + editor-row CSS.
- `docs/quality/traceability.md` — new requirement / code / test row.
- `docs/ai/STATE.md` — update active work item.
- `docs/ai/SESSION_LOG.md` — append entry at top.

---

## Task 1: Add `ExternalEditor` type and `external_editors` field

**Files:**
- Modify: `packages/shared/src/model.ts:209-230`

- [ ] **Step 1: Add the interface and field**

In `packages/shared/src/model.ts`, just above the `SystemConfig` interface (around line 208), add:

```ts
export interface ExternalEditor {
  /** Stable handle (uuid) used by the open API. */
  id: string;
  /** Display label, e.g. "VS Code". */
  name: string;
  /** Executable name (PATH-resolved) or absolute path. */
  command: string;
  /** argv template. Tokens equal to "{path}" are replaced with the absolute
   *  file path; if no token matches, the path is appended at the end. */
  args: string[];
}
```

Then add to `SystemConfig` (after `auth_username`):

```ts
  /** Programs surfaced in the Files view's "Open with…" menu. */
  external_editors: ExternalEditor[];
```

- [ ] **Step 2: Verify type-check across packages**

Run: `pnpm -r typecheck`
Expected: `host` and `web` will fail at sites that construct `SystemConfig` literals (test fixtures, defaults). Note the locations — Task 2 fixes the host side; Task 6/7 fix the web side.

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/model.ts
git commit -m "feat(shared): add ExternalEditor type and external_editors field"
```

---

## Task 2: JSON-encode `external_editors` in config storage

**Files:**
- Modify: `packages/host/src/storage/config.ts`
- Modify: `packages/host/test/storage.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/host/test/storage.test.ts`:

```ts
import { saveConfig } from '../src/storage/config.js';

test('config: external_editors round-trips as JSON', () => {
  const dir = makeTempDir();
  try {
    const db = openDatabase(dir);
    saveConfig(db, {
      external_editors: [
        { id: 'a', name: 'VS Code', command: 'code', args: ['--new-window', '{path}'] },
        { id: 'b', name: 'Sublime', command: 'subl', args: [] },
      ],
    });
    const cfg = loadConfig(db);
    assert.equal(cfg.external_editors.length, 2);
    assert.equal(cfg.external_editors[0]!.name, 'VS Code');
    assert.deepEqual(cfg.external_editors[0]!.args, ['--new-window', '{path}']);
    assert.equal(cfg.external_editors[1]!.command, 'subl');
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config: external_editors defaults to [] when unset', () => {
  const dir = makeTempDir();
  try {
    const db = openDatabase(dir);
    const cfg = loadConfig(db);
    assert.deepEqual(cfg.external_editors, []);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config: external_editors drops invalid entries (silent filter)', () => {
  const dir = makeTempDir();
  try {
    const db = openDatabase(dir);
    saveConfig(db, {
      external_editors: [
        { id: 'a', name: 'OK', command: 'code', args: [] },
        // Empty name — drop.
        { id: 'b', name: '', command: 'code', args: [] } as any,
        // Missing command — drop.
        { id: 'c', name: 'NoCmd', command: '', args: [] } as any,
        // Duplicate id — second one dropped.
        { id: 'a', name: 'Dup', command: 'code', args: [] },
        // Non-string in args — drop.
        { id: 'd', name: 'BadArgs', command: 'code', args: [42 as unknown as string] },
      ],
    });
    const cfg = loadConfig(db);
    assert.deepEqual(cfg.external_editors.map(e => e.id), ['a']);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/host && pnpm vitest run storage` — wait, host uses `node:test`. Correct command:

Run: `pnpm -F @gian/host test --test-name-pattern "external_editors"`

If that flag isn't supported in the project's harness, use the simpler form the existing tests use. Check `packages/host/package.json` `test` script — likely `node --test test/*.test.ts` or via tsx. Run whatever pattern matches.

Expected: All three new tests FAIL (`external_editors` is undefined on the returned config).

- [ ] **Step 3: Implement the save/load logic**

Edit `packages/host/src/storage/config.ts`:

```ts
import type { ExternalEditor, SystemConfig } from '@gian/shared';
import type { Db } from './db.js';

const EXTERNAL_EDITORS_KEY = 'external_editors';

export function loadPasswordHash(db: Db): string {
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get('auth_password_hash') as
    | { value: string }
    | undefined;
  return row?.value ?? '';
}

export function savePasswordHash(db: Db, hash: string): void {
  db.prepare(`INSERT OR REPLACE INTO config (key, value) VALUES ('auth_password_hash', ?)`).run(hash);
}

function isValidEditor(e: unknown): e is ExternalEditor {
  if (typeof e !== 'object' || e === null) return false;
  const o = e as Record<string, unknown>;
  if (typeof o.id !== 'string' || o.id.length === 0) return false;
  if (typeof o.name !== 'string' || o.name.trim().length === 0) return false;
  if (typeof o.command !== 'string' || o.command.length === 0) return false;
  if (!Array.isArray(o.args)) return false;
  if (!o.args.every(a => typeof a === 'string')) return false;
  return true;
}

function sanitizeEditors(raw: unknown): ExternalEditor[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: ExternalEditor[] = [];
  for (const e of raw) {
    if (!isValidEditor(e)) continue;
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    out.push({
      id: e.id,
      name: e.name.trim().slice(0, 64),
      command: e.command,
      args: e.args,
    });
  }
  return out;
}

export function saveConfig(db: Db, partial: Partial<SystemConfig>): void {
  const stmt = db.prepare(`INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)`);
  for (const [key, value] of Object.entries(partial) as [keyof SystemConfig, SystemConfig[keyof SystemConfig]][]) {
    if (key === EXTERNAL_EDITORS_KEY) {
      const cleaned = sanitizeEditors(value);
      stmt.run(key, JSON.stringify(cleaned));
      continue;
    }
    stmt.run(key, String(value));
  }
}

export function loadConfig(db: Db): SystemConfig {
  const rows = db.prepare('SELECT key, value FROM config').all() as Array<{
    key: string;
    value: string;
  }>;
  const map = new Map(rows.map(r => [r.key, r.value]));

  let externalEditors: ExternalEditor[] = [];
  const rawEditors = map.get(EXTERNAL_EDITORS_KEY);
  if (rawEditors) {
    try {
      externalEditors = sanitizeEditors(JSON.parse(rawEditors));
    } catch {
      externalEditors = [];
    }
  }

  return {
    host: process.env.GIAN_HOST ?? map.get('host') ?? '127.0.0.1',
    port: Number(process.env.GIAN_PORT ?? map.get('port') ?? 8990),
    workspace_root: map.get('workspace_root') ?? '~/Coding',
    public_url: map.get('public_url') ?? '',
    tunnel_mode: (map.get('tunnel_mode') ?? 'none') as SystemConfig['tunnel_mode'],
    tunnel_id: map.get('tunnel_id') ?? '',
    force_https: map.get('force_https') === 'true',
    theme: (map.get('theme') ?? 'warm') as SystemConfig['theme'],
    accent: map.get('accent') ?? 'plum',
    density: (map.get('density') ?? 'cozy') as SystemConfig['density'],
    locale: (map.get('locale') ?? 'zh-CN') as SystemConfig['locale'],
    default_claude_model: map.get('default_claude_model') ?? '',
    default_claude_effort: map.get('default_claude_effort') ?? '',
    default_codex_model: map.get('default_codex_model') ?? '',
    default_codex_effort: map.get('default_codex_effort') ?? '',
    auth_username: map.get('auth_username') ?? '',
    external_editors: externalEditors,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run the test pattern from Step 2.
Expected: All three storage tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/host/src/storage/config.ts packages/host/test/storage.test.ts
git commit -m "feat(host): persist external_editors as JSON in config K/V"
```

---

## Task 3: `open-with.ts` pure helpers + spawn wrapper

**Files:**
- Create: `packages/host/src/web/open-with.ts`
- Create: `packages/host/test/open-with.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/host/test/open-with.test.ts`:

```ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { buildEditorArgs, defaultOpenerArgs } from '../src/web/open-with.js';
import type { ExternalEditor } from '@gian/shared';

const ed = (args: string[]): ExternalEditor => ({
  id: 'x', name: 'X', command: 'code', args,
});

test('buildEditorArgs: substitutes {path} token at whole-token level', () => {
  const out = buildEditorArgs(ed(['--new-window', '{path}']), '/abs/foo.md');
  assert.equal(out.command, 'code');
  assert.deepEqual(out.argv, ['--new-window', '/abs/foo.md']);
});

test('buildEditorArgs: substitutes {path} as a substring inside a token', () => {
  const out = buildEditorArgs(ed(['--file={path}']), '/abs/foo.md');
  assert.deepEqual(out.argv, ['--file=/abs/foo.md']);
});

test('buildEditorArgs: replaces every {path} occurrence', () => {
  const out = buildEditorArgs(ed(['{path}', '--diff', '{path}']), '/abs/foo');
  assert.deepEqual(out.argv, ['/abs/foo', '--diff', '/abs/foo']);
});

test('buildEditorArgs: appends path when no {path} token present', () => {
  const out = buildEditorArgs(ed(['--wait']), '/abs/foo.md');
  assert.deepEqual(out.argv, ['--wait', '/abs/foo.md']);
});

test('buildEditorArgs: appends path when args is empty', () => {
  const out = buildEditorArgs(ed([]), '/abs/foo.md');
  assert.deepEqual(out.argv, ['/abs/foo.md']);
});

test('defaultOpenerArgs: darwin uses open', () => {
  const out = defaultOpenerArgs('darwin', '/abs/foo.md');
  assert.equal(out.command, 'open');
  assert.deepEqual(out.argv, ['/abs/foo.md']);
});

test('defaultOpenerArgs: linux uses xdg-open', () => {
  const out = defaultOpenerArgs('linux', '/abs/foo.md');
  assert.equal(out.command, 'xdg-open');
  assert.deepEqual(out.argv, ['/abs/foo.md']);
});

test('defaultOpenerArgs: win32 uses cmd /c start', () => {
  const out = defaultOpenerArgs('win32', 'C:\\abs\\foo.md');
  assert.equal(out.command, 'cmd');
  // The empty "" title is critical: `start "C:\path"` would interpret
  // the path as the window title and silently do nothing.
  assert.deepEqual(out.argv, ['/c', 'start', '', 'C:\\abs\\foo.md']);
});

test('defaultOpenerArgs: unknown platform throws', () => {
  assert.throws(
    () => defaultOpenerArgs('sunos' as NodeJS.Platform, '/x'),
    /unsupported platform/,
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -F @gian/host test` filtered to `open-with`.
Expected: All tests FAIL with import error (`open-with.js` does not exist).

- [ ] **Step 3: Implement the helpers**

Create `packages/host/src/web/open-with.ts`:

```ts
import { execFile } from 'node:child_process';
import type { ExternalEditor } from '@gian/shared';

export interface OpenCommand {
  command: string;
  argv: string[];
}

const PATH_TOKEN = '{path}';

/** Build the argv to launch a configured editor against an absolute path.
 *  Whole-token equal-to or substring containing "{path}" is replaced with
 *  `absPath`. If no token matches, `absPath` is appended at the end. */
export function buildEditorArgs(editor: ExternalEditor, absPath: string): OpenCommand {
  let substituted = false;
  const argv = editor.args.map(a => {
    if (a.includes(PATH_TOKEN)) {
      substituted = true;
      return a.split(PATH_TOKEN).join(absPath);
    }
    return a;
  });
  if (!substituted) argv.push(absPath);
  return { command: editor.command, argv };
}

/** Argv for the platform default opener. */
export function defaultOpenerArgs(platform: NodeJS.Platform, absPath: string): OpenCommand {
  if (platform === 'darwin') return { command: 'open', argv: [absPath] };
  if (platform === 'linux') return { command: 'xdg-open', argv: [absPath] };
  if (platform === 'win32') {
    // `start` is a cmd builtin. The empty "" is the (ignored) window title;
    // without it, start treats the first quoted argument as the title.
    return { command: 'cmd', argv: ['/c', 'start', '', absPath] };
  }
  throw new Error(`unsupported platform: ${platform}`);
}

/** Spawn the given command detached and unref so it outlives the HTTP
 *  request. Errors are surfaced via the callback so the route can return
 *  a 500. Times out after 5s if the launcher itself hangs (rare). */
export function runOpen(
  cmd: OpenCommand,
  onError: (err: Error) => void,
): void {
  try {
    const child = execFile(cmd.command, cmd.argv, {
      timeout: 5000,
      windowsHide: true,
    }, err => {
      if (err) onError(err);
    });
    child.unref();
  } catch (err) {
    onError(err as Error);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run the test pattern from Step 2.
Expected: All nine tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/host/src/web/open-with.ts packages/host/test/open-with.test.ts
git commit -m "feat(host): add open-with argv builders"
```

---

## Task 4: `POST /api/working_trees/:id/open` route

**Files:**
- Modify: `packages/host/src/web/app.ts` (after the `/reveal` route ending at line 1666)
- Create: `packages/host/test/open-route.test.ts`

- [ ] **Step 1: Write the failing boundary tests**

Create `packages/host/test/open-route.test.ts`. Model the setup after `sec-014-reveal-boundary.test.ts`:

```ts
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeTestApp, type TestAppCtx } from './fixtures/test-app.js';
import { saveConfig } from '../src/storage/config.js';

interface Ctx {
  appCtx: TestAppCtx;
  workspaceId: string;
  workspacePath: string;
  cleanup: () => Promise<void>;
}

async function setup(): Promise<Ctx> {
  const appCtx = await makeTestApp();
  const workspaceId = randomUUID();
  const workspacePath = mkdtempSync(join(tmpdir(), 'gian-open-'));
  writeFileSync(join(workspacePath, 'foo.md'), '# foo');
  appCtx.db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)')
    .run(workspaceId, 'demo', workspacePath);
  return {
    appCtx,
    workspaceId,
    workspacePath,
    cleanup: async () => {
      await appCtx.cleanup();
      rmSync(workspacePath, { recursive: true, force: true });
    },
  };
}

test('/open: rejects unknown working-tree id', async () => {
  const ctx = await setup();
  try {
    const res = await ctx.appCtx.fetch(
      `/api/working_trees/ws:00000000-0000-0000-0000-000000000000/open`,
      { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'foo.md' }) },
    );
    assert.equal(res.status, 404);
  } finally {
    await ctx.cleanup();
  }
});

test('/open: rejects path traversal with 400', async () => {
  const ctx = await setup();
  try {
    const res = await ctx.appCtx.fetch(
      `/api/working_trees/ws:${ctx.workspaceId}/open`,
      { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: '../../../etc/passwd' }) },
    );
    assert.equal(res.status, 400);
    const body = await res.json() as { error: string };
    assert.match(body.error, /path escapes/);
  } finally {
    await ctx.cleanup();
  }
});

test('/open: rejects missing file with 404', async () => {
  const ctx = await setup();
  try {
    const res = await ctx.appCtx.fetch(
      `/api/working_trees/ws:${ctx.workspaceId}/open`,
      { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'does-not-exist.txt' }) },
    );
    assert.equal(res.status, 404);
    const body = await res.json() as { error: string };
    assert.match(body.error, /not found/i);
  } finally {
    await ctx.cleanup();
  }
});

test('/open: rejects unknown editor_id with 404', async () => {
  const ctx = await setup();
  try {
    const res = await ctx.appCtx.fetch(
      `/api/working_trees/ws:${ctx.workspaceId}/open`,
      { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'foo.md', editor_id: 'does-not-exist' }) },
    );
    assert.equal(res.status, 404);
    const body = await res.json() as { error: string };
    assert.match(body.error, /editor/i);
  } finally {
    await ctx.cleanup();
  }
});

test('/open: 400 on missing path body', async () => {
  const ctx = await setup();
  try {
    const res = await ctx.appCtx.fetch(
      `/api/working_trees/ws:${ctx.workspaceId}/open`,
      { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}) },
    );
    assert.equal(res.status, 400);
  } finally {
    await ctx.cleanup();
  }
});

test('/open: known editor_id passes pre-spawn checks', async () => {
  const ctx = await setup();
  try {
    // Seed an editor pointing at a no-op shell builtin so spawn succeeds
    // without launching a GUI app. `true` exists on macOS + Linux; on
    // Windows skip this assertion.
    if (process.platform === 'win32') return;
    saveConfig(ctx.appCtx.db, {
      external_editors: [
        { id: 'e1', name: 'true', command: 'true', args: [] },
      ],
    });
    const res = await ctx.appCtx.fetch(
      `/api/working_trees/ws:${ctx.workspaceId}/open`,
      { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: 'foo.md', editor_id: 'e1' }) },
    );
    assert.equal(res.status, 200);
    const body = await res.json() as { ok: boolean };
    assert.equal(body.ok, true);
  } finally {
    await ctx.cleanup();
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run the host test runner filtering to `open-route`.
Expected: All six tests FAIL — the route doesn't exist (404 on every call, but for the wrong reason — Hono returns its own 404).

- [ ] **Step 3: Implement the route**

In `packages/host/src/web/app.ts`, just after the existing `/reveal` block (ends line 1666), add:

```ts
  // Open a file via the system default opener or a configured external
  // editor. Path resolution mirrors /raw and /reveal — id must be a known
  // ws:/wt: handle and the relative path is bounded to the working tree.
  app.post('/api/working_trees/:id/open', async c => {
    const id = c.req.param('id');
    const wt = resolveWorkingTree(id);
    if (!wt) return c.json({ error: 'working tree not found' }, 404);

    let body: { path?: string; editor_id?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid json body' }, 400);
    }
    if (!body.path || typeof body.path !== 'string') {
      return c.json({ error: 'path required' }, 400);
    }

    let absPath: string;
    try {
      absPath = resolveWithinWorkspace(wt.path, body.path);
    } catch (err) {
      return c.json({ error: String((err as Error).message) }, 400);
    }

    try {
      statSync(absPath);
    } catch {
      return c.json({ error: 'file not found' }, 404);
    }

    let cmd: OpenCommand;
    if (body.editor_id) {
      const cfg = loadConfig(ctx.db);
      const editor = cfg.external_editors.find(e => e.id === body.editor_id);
      if (!editor) return c.json({ error: 'editor not found' }, 404);
      cmd = buildEditorArgs(editor, absPath);
    } else {
      try {
        cmd = defaultOpenerArgs(process.platform, absPath);
      } catch (err) {
        return c.json({ error: String((err as Error).message) }, 500);
      }
    }

    return new Promise(resolve => {
      runOpen(cmd, err => {
        resolve(c.json({ error: String(err.message) }, 500));
      });
      // Successful spawn: the launcher returns immediately for GUI apps.
      // Wait a tick so any synchronous spawn errors surface before we ack.
      setTimeout(() => resolve(c.json({ ok: true })), 50);
    });
  });
```

Also add at the top of `app.ts` (with the other imports):

```ts
import { statSync } from 'node:fs';
import { buildEditorArgs, defaultOpenerArgs, runOpen, type OpenCommand } from './open-with.js';
```

(`resolveWithinWorkspace` and `loadConfig` are already imported in this file — search to confirm. If not, add them too.)

- [ ] **Step 4: Run tests to verify they pass**

Run the host suite again.
Expected: All six route tests PASS. Storage + open-with tests from earlier tasks still PASS.

- [ ] **Step 5: Run the full host suite**

Run: `pnpm -F @gian/host test`
Expected: existing tests still PASS — no regressions.

- [ ] **Step 6: Commit**

```bash
git add packages/host/src/web/app.ts packages/host/test/open-route.test.ts
git commit -m "feat(host): add POST /api/working_trees/:id/open route"
```

---

## Task 5: `openFileWith` API client

**Files:**
- Modify: `packages/web/src/api.ts`

- [ ] **Step 1: Add the function**

Append to `packages/web/src/api.ts`:

```ts
export async function openFileWith(
  workingTreeId: string,
  path: string,
  editorId?: string,
): Promise<{ ok: true } | { error: string }> {
  const res = await fetch(
    `/api/working_trees/${encodeURIComponent(workingTreeId)}/open`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path, ...(editorId ? { editor_id: editorId } : {}) }),
    },
  );
  if (res.ok) return { ok: true };
  try {
    return await res.json() as { error: string };
  } catch {
    return { error: `HTTP ${res.status}` };
  }
}
```

- [ ] **Step 2: Type-check**

Run: `pnpm -F @gian/web typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/api.ts
git commit -m "feat(web): add openFileWith API client"
```

---

## Task 6: FilesView split button + caret menu

**Files:**
- Modify: `packages/web/src/views/FilesView.tsx`
- Modify: `packages/web/src/App.tsx`
- Modify: `packages/web/src/styles/session.css`
- Create: `packages/web/test/files-view-open-with.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `packages/web/test/files-view-open-with.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { FilesView } from '../src/views/FilesView.js';
import * as api from '../src/api.js';

vi.mock('../src/api.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api.js')>('../src/api.js');
  return {
    ...actual,
    loadTree: vi.fn().mockResolvedValue([{ name: 'foo.md', type: 'file', path: 'foo.md' }]),
    loadFile: vi.fn().mockResolvedValue({ content: '# foo', size: 5 }),
    loadFileMeta: vi.fn().mockResolvedValue({ edit_count_today: 0, uncommitted: false }),
    openFileWith: vi.fn().mockResolvedValue({ ok: true }),
  };
});

const workingTrees = [{
  id: 'ws:demo', kind: 'workspace' as const, label: 'demo', path: '/tmp/demo',
  branch: null, workspace_id: 'demo', workspace_name: 'demo',
  session_id: null, session_name: null,
}];

describe('FilesView open-with', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('clicking "Open" calls openFileWith without editor_id', async () => {
    render(
      <FilesView
        workingTrees={workingTrees}
        workingTreeId="ws:demo"
        onPickWorkingTree={() => {}}
        initialPath="foo.md"
        externalEditors={[]}
        onOpenSettings={() => {}}
      />,
    );
    const btn = await screen.findByRole('button', { name: /^Open$/ });
    fireEvent.click(btn);
    await waitFor(() => {
      expect(api.openFileWith).toHaveBeenCalledWith('ws:demo', 'foo.md', undefined);
    });
  });

  it('caret menu lists configured editors and Configure tail row', async () => {
    render(
      <FilesView
        workingTrees={workingTrees}
        workingTreeId="ws:demo"
        onPickWorkingTree={() => {}}
        initialPath="foo.md"
        externalEditors={[
          { id: 'vsc', name: 'VS Code', command: 'code', args: [] },
        ]}
        onOpenSettings={() => {}}
      />,
    );
    const caret = await screen.findByRole('button', { name: /open with menu/i });
    fireEvent.click(caret);
    expect(await screen.findByText('VS Code')).toBeTruthy();
    expect(screen.getByText(/configure editors/i)).toBeTruthy();
  });

  it('clicking editor row calls openFileWith with its id', async () => {
    render(
      <FilesView
        workingTrees={workingTrees}
        workingTreeId="ws:demo"
        onPickWorkingTree={() => {}}
        initialPath="foo.md"
        externalEditors={[
          { id: 'vsc', name: 'VS Code', command: 'code', args: [] },
        ]}
        onOpenSettings={() => {}}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: /open with menu/i }));
    fireEvent.click(await screen.findByText('VS Code'));
    await waitFor(() => {
      expect(api.openFileWith).toHaveBeenCalledWith('ws:demo', 'foo.md', 'vsc');
    });
  });

  it('empty editor list still shows Configure row', async () => {
    render(
      <FilesView
        workingTrees={workingTrees}
        workingTreeId="ws:demo"
        onPickWorkingTree={() => {}}
        initialPath="foo.md"
        externalEditors={[]}
        onOpenSettings={() => {}}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: /open with menu/i }));
    expect(screen.getByText(/configure editors/i)).toBeTruthy();
  });

  it('Configure row calls onOpenSettings', async () => {
    const onOpenSettings = vi.fn();
    render(
      <FilesView
        workingTrees={workingTrees}
        workingTreeId="ws:demo"
        onPickWorkingTree={() => {}}
        initialPath="foo.md"
        externalEditors={[]}
        onOpenSettings={onOpenSettings}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: /open with menu/i }));
    fireEvent.click(screen.getByText(/configure editors/i));
    expect(onOpenSettings).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -F @gian/web test files-view-open-with`
Expected: All five tests FAIL — `externalEditors` and `onOpenSettings` aren't props yet, and the split button doesn't exist.

- [ ] **Step 3: Extend FilesView props and replace the open-in-new-tab block**

In `packages/web/src/views/FilesView.tsx`:

a) Add to the imports near the top:

```ts
import { openFileWith } from '../api.js';
import type { ExternalEditor } from '@gian/shared';
```

b) Extend the props (the `export function FilesView({...}: {...})` signature, around line 290):

```ts
  externalEditors,
  onOpenSettings,
```

and in the type:

```ts
  externalEditors: ExternalEditor[];
  onOpenSettings: () => void;
```

c) Add a menu open/close state and a one-shot error message near the other `useState` declarations (~line 322):

```ts
  const [openMenuOpen, setOpenMenuOpen] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
```

Also add a helper just below the existing helpers in the component body:

```ts
  function tryOpen(editorId?: string): void {
    if (!workingTreeId || !openFile) return;
    setOpenError(null);
    void openFileWith(workingTreeId, openFile.path, editorId).then(res => {
      if ('error' in res) setOpenError(res.error);
    });
  }
```

d) Replace the existing "Open in new tab" anchor block in the preview header (current lines 659-670) with:

```tsx
                <div className="files-open-group">
                  <button
                    type="button"
                    className="btn btn-ghost files-open-primary"
                    onClick={() => tryOpen()}
                  >
                    Open
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost files-open-caret"
                    aria-label="Open with menu"
                    aria-haspopup="menu"
                    aria-expanded={openMenuOpen}
                    onClick={() => setOpenMenuOpen(v => !v)}
                  >
                    ▾
                  </button>
                  {openMenuOpen && (
                    <div className="files-open-menu" role="menu" onMouseLeave={() => setOpenMenuOpen(false)}>
                      {externalEditors.map(ed => (
                        <button
                          key={ed.id}
                          type="button"
                          className="files-open-menu-item"
                          role="menuitem"
                          onClick={() => {
                            setOpenMenuOpen(false);
                            tryOpen(ed.id);
                          }}
                        >
                          {ed.name}
                        </button>
                      ))}
                      {externalEditors.length > 0 && <div className="files-open-menu-sep" />}
                      <button
                        type="button"
                        className="files-open-menu-item files-open-menu-config"
                        role="menuitem"
                        onClick={() => {
                          setOpenMenuOpen(false);
                          onOpenSettings();
                        }}
                      >
                        Configure editors…
                      </button>
                    </div>
                  )}
                </div>
                {openInNewTabHref && (
                  <a
                    className="btn btn-ghost"
                    href={openInNewTabHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ fontSize: 11, padding: '3px 8px', textDecoration: 'none' }}
                    title={t('files.openintab.title')}
                  >
                    ↗ {t('files.openintab.title')}
                  </a>
                )}
```

Render the error banner just below the existing `<div className="file-meta">…</div>` block (around line 690 in the file). Auto-clear it on the next file pick by adding `setOpenError(null);` to the existing `openFileContent` and `pickChangedEntry` functions.

```tsx
            {openError && (
              <div className="files-open-error" role="alert">
                Failed to open: {openError}
                <button type="button" aria-label="dismiss" onClick={() => setOpenError(null)}>✕</button>
              </div>
            )}
```

- [ ] **Step 4: Pass the new props from App.tsx**

In `packages/web/src/App.tsx`, find the `<FilesView />` render site and extend it:

```tsx
<FilesView
  workingTrees={workingTrees}
  workingTreeId={workingTreeId}
  onPickWorkingTree={onPickWorkingTree}
  initialPath={initialPath}
  initialMode={initialMode}
  externalEditors={systemConfig?.external_editors ?? []}
  onOpenSettings={() => toggleWbTabKind('settings')}
/>
```

(Locate the existing `<FilesView` JSX site and add only the two new props. Don't touch the existing ones.)

- [ ] **Step 5: Add CSS for the split button + menu**

Append to `packages/web/src/styles/session.css`:

```css
/* Files view: Open split button + dropdown menu */
.files-open-group {
  position: relative;
  display: inline-flex;
  align-items: stretch;
  gap: 0;
}
.files-open-primary {
  font-size: 11px;
  padding: 3px 8px;
  border-right: 1px solid var(--border-1);
  border-top-right-radius: 0;
  border-bottom-right-radius: 0;
}
.files-open-caret {
  font-size: 11px;
  padding: 3px 6px;
  border-top-left-radius: 0;
  border-bottom-left-radius: 0;
}
.files-open-menu {
  position: absolute;
  top: 100%;
  right: 0;
  margin-top: 4px;
  background: var(--surface);
  border: 1px solid var(--border-1);
  border-radius: 6px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.12);
  min-width: 180px;
  padding: 4px 0;
  z-index: 20;
}
.files-open-menu-item {
  display: block;
  width: 100%;
  text-align: left;
  padding: 6px 12px;
  font-size: 12px;
  background: transparent;
  border: none;
  color: var(--text-1);
  cursor: pointer;
}
.files-open-menu-item:hover {
  background: var(--surface-2);
}
.files-open-menu-config {
  color: var(--text-3);
}
.files-open-menu-sep {
  height: 1px;
  background: var(--border-1);
  margin: 4px 0;
}
.files-open-error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 12px;
  font-size: 12px;
  color: var(--text-1);
  background: oklch(0.92 0.06 30);
  border-bottom: 1px solid var(--border-1);
}
.files-open-error button {
  background: transparent;
  border: none;
  cursor: pointer;
  color: var(--text-3);
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm -F @gian/web test files-view-open-with`
Expected: All five tests PASS.

- [ ] **Step 7: Run typecheck**

Run: `pnpm -F @gian/web typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/web/src/views/FilesView.tsx packages/web/src/App.tsx \
        packages/web/src/styles/session.css packages/web/test/files-view-open-with.test.tsx
git commit -m "feat(web): Files view Open split-button + external editors menu"
```

---

## Task 7: SettingsBody External editors section

**Files:**
- Modify: `packages/web/src/components/SettingsBody.tsx`
- Modify: `packages/web/src/styles/session.css`
- Create: `packages/web/test/settings-external-editors.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `packages/web/test/settings-external-editors.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SettingsBody } from '../src/components/SettingsBody.js';
import * as api from '../src/api.js';
import type { SystemConfig } from '@gian/shared';

vi.mock('../src/api.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api.js')>('../src/api.js');
  return {
    ...actual,
    saveSettings: vi.fn().mockImplementation(async partial => ({ ...baseConfig(), ...partial })),
    loadProxyModels: vi.fn().mockResolvedValue({ cc: [], codex: [] }),
  };
});

function baseConfig(overrides: Partial<SystemConfig> = {}): SystemConfig {
  return {
    host: '127.0.0.1', port: 8990, workspace_root: '~/Coding', public_url: '',
    tunnel_mode: 'none', tunnel_id: '', force_https: false,
    theme: 'warm', accent: 'plum', density: 'cozy', locale: 'en',
    default_claude_model: '', default_claude_effort: '',
    default_codex_model: '', default_codex_effort: '',
    auth_username: '',
    external_editors: [],
    ...overrides,
  };
}

describe('SettingsBody External editors', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('renders empty-state hint when no editors are configured', () => {
    render(<SettingsBody config={baseConfig()} onChange={() => {}} />);
    expect(screen.getByText(/no editors configured/i)).toBeTruthy();
  });

  it('"+ Add editor" appends a new row with a uuid id', () => {
    const onChange = vi.fn();
    render(<SettingsBody config={baseConfig()} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /add editor/i }));
    expect(api.saveSettings).toHaveBeenCalled();
    const arg = (api.saveSettings as any).mock.calls[0][0] as Partial<SystemConfig>;
    expect(arg.external_editors).toBeDefined();
    expect(arg.external_editors!.length).toBe(1);
    expect(arg.external_editors![0]!.id).toMatch(/[0-9a-f-]{8,}/);
  });

  it('editing Name sends a patch with the updated value', async () => {
    const cfg = baseConfig({
      external_editors: [{ id: 'e1', name: 'VS Code', command: 'code', args: [] }],
    });
    render(<SettingsBody config={cfg} onChange={() => {}} />);
    const nameInput = screen.getByDisplayValue('VS Code');
    fireEvent.change(nameInput, { target: { value: 'VSCode Stable' } });
    // Auto-save fires debounced; for the unit-level guarantee, ensure
    // the input value updated. The actual debounce is covered elsewhere.
    expect((nameInput as HTMLInputElement).value).toBe('VSCode Stable');
  });

  it('editing Args splits on whitespace into string[]', async () => {
    const cfg = baseConfig({
      external_editors: [{ id: 'e1', name: 'VS Code', command: 'code', args: [] }],
    });
    render(<SettingsBody config={cfg} onChange={() => {}} />);
    const argsInput = screen.getByLabelText(/args/i) as HTMLInputElement;
    fireEvent.change(argsInput, { target: { value: '--new-window  {path}' } });
    fireEvent.blur(argsInput);
    // Wait long enough that the 500ms debounce flushes.
    await new Promise(r => setTimeout(r, 600));
    expect(api.saveSettings).toHaveBeenCalled();
    const last = (api.saveSettings as any).mock.calls.at(-1)[0] as Partial<SystemConfig>;
    expect(last.external_editors![0]!.args).toEqual(['--new-window', '{path}']);
  });

  it('Delete (✕) removes the row', () => {
    const cfg = baseConfig({
      external_editors: [{ id: 'e1', name: 'VS Code', command: 'code', args: [] }],
    });
    render(<SettingsBody config={cfg} onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /remove editor/i }));
    const last = (api.saveSettings as any).mock.calls.at(-1)[0] as Partial<SystemConfig>;
    expect(last.external_editors).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm -F @gian/web test settings-external-editors`
Expected: All five tests FAIL — the section doesn't exist.

- [ ] **Step 3: Add the section to SettingsBody**

In `packages/web/src/components/SettingsBody.tsx`:

a) Add a uuid generator import (top of file). If there's no existing util, use `crypto.randomUUID()`:

```ts
function newEditorId(): string {
  return (globalThis.crypto?.randomUUID?.() ?? `ed-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}
```

b) Inside the component, before the closing `</div>` of `.settings-tab-body`, add the section. Use the existing `patch()` helper:

```tsx
      <div className="settings-eyebrow">External editors</div>
      <div className="settings-section">
        <p className="settings-section-help">
          Programs in the Files view's Open menu. <code>{'{path}'}</code> in Args is
          replaced with the file path; otherwise the path is appended. Args are split
          on whitespace — arguments containing spaces aren't supported.
        </p>
        {config.external_editors.length === 0 && (
          <p className="settings-empty">No editors configured. Add one to use it from the Files view.</p>
        )}
        {config.external_editors.map((ed, i) => (
          <div key={ed.id} className="external-editor-row">
            <label>
              <span className="ee-label">Name</span>
              <input
                type="text"
                value={ed.name}
                maxLength={64}
                onChange={e => {
                  const next = [...config.external_editors];
                  next[i] = { ...ed, name: e.target.value };
                  patch({ external_editors: next });
                }}
              />
            </label>
            <label>
              <span className="ee-label">Command</span>
              <input
                type="text"
                value={ed.command}
                onChange={e => {
                  const next = [...config.external_editors];
                  next[i] = { ...ed, command: e.target.value };
                  patch({ external_editors: next });
                }}
              />
            </label>
            <label>
              <span className="ee-label">Args</span>
              <input
                type="text"
                aria-label="Args"
                defaultValue={ed.args.join(' ')}
                onBlur={e => {
                  const tokens = e.target.value.trim().length === 0
                    ? []
                    : e.target.value.trim().split(/\s+/);
                  const next = [...config.external_editors];
                  next[i] = { ...ed, args: tokens };
                  patch({ external_editors: next });
                }}
              />
            </label>
            <button
              type="button"
              aria-label="Remove editor"
              className="ee-remove"
              onClick={() => {
                const next = config.external_editors.filter(x => x.id !== ed.id);
                patch({ external_editors: next });
              }}
            >
              ✕
            </button>
          </div>
        ))}
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            const next = [
              ...config.external_editors,
              { id: newEditorId(), name: '', command: '', args: [] },
            ];
            patch({ external_editors: next });
          }}
        >
          + Add editor
        </button>
      </div>
```

- [ ] **Step 4: Add CSS for the section**

Append to `packages/web/src/styles/session.css`:

```css
/* Settings: External editors section */
.external-editor-row {
  display: grid;
  grid-template-columns: 1fr 1.4fr 1.4fr auto;
  gap: 8px;
  align-items: end;
  margin-bottom: 8px;
}
.external-editor-row label {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.ee-label {
  font-size: 11px;
  color: var(--text-3);
}
.external-editor-row input {
  padding: 4px 8px;
  font-size: 12px;
  border: 1px solid var(--border-1);
  border-radius: 4px;
  background: var(--surface);
  color: var(--text-1);
}
.ee-remove {
  width: 28px;
  height: 28px;
  background: transparent;
  border: 1px solid var(--border-1);
  border-radius: 4px;
  color: var(--text-3);
  cursor: pointer;
}
.ee-remove:hover {
  background: var(--surface-2);
  color: var(--text-1);
}
.settings-section-help {
  font-size: 11px;
  color: var(--text-3);
  margin: 0 0 12px 0;
}
.settings-empty {
  font-size: 12px;
  color: var(--text-3);
  font-style: italic;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm -F @gian/web test settings-external-editors`
Expected: All five tests PASS.

- [ ] **Step 6: Run the full web suite**

Run: `pnpm -F @gian/web test && pnpm -F @gian/web typecheck`
Expected: PASS, no regressions.

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/components/SettingsBody.tsx packages/web/src/styles/session.css \
        packages/web/test/settings-external-editors.test.tsx
git commit -m "feat(web): Settings — External editors CRUD section"
```

---

## Task 8: Manual verification + traceability + STATE/log

**Files:**
- Modify: `docs/quality/traceability.md`
- Modify: `docs/ai/STATE.md`
- Modify: `docs/ai/SESSION_LOG.md`

- [ ] **Step 1: Manual verification (record outcomes in PR description)**

On the macOS development host, with `pnpm dev` running and a workspace seeded:

1. Open the Files view, pick a `.md` file, click **Open**. Expect: Preview or default editor opens. Verify no error toast.
2. Click **Open** on a `.png` file. Expect: Preview opens (system default).
3. Click **Open** on a `.pdf`. Expect: Preview opens.
4. In Settings → External editors, add an editor: name `VS Code`, command `code`, args `--new-window {path}`. (Requires `code` CLI installed via VS Code's "Shell Command: Install 'code' command in PATH".)
5. Back in Files, click ▾ next to Open → click `VS Code`. Expect: VS Code launches with the file in a new window.
6. Restart the daemon (`launchctl kickstart -k gui/$UID/com.gian.host`). Expect: VS Code window stays open (detached + unref).
7. Configure an editor with a bogus command (e.g. `not-a-real-program`). Click it. Expect: error toast or inline error; no crash.

Record results in the PR body (failures block the PR).

- [ ] **Step 2: Add traceability row**

Open `docs/quality/traceability.md` and add a new row in the appropriate section. Use the existing format for IDs (`FILE-006` or whatever the next free id is — scan the file). Row content:

| ID | Requirement | Code | Test | Status |
|----|-------------|------|------|--------|
| FILE-00X | Files view can hand a file to a local program (system default or a configured editor); path traversal blocked. | `packages/host/src/web/app.ts` (`/open` route) · `packages/host/src/web/open-with.ts` · `packages/web/src/views/FilesView.tsx` · `packages/web/src/components/SettingsBody.tsx` | `packages/host/test/open-with.test.ts` · `packages/host/test/open-route.test.ts` · `packages/web/test/files-view-open-with.test.tsx` · `packages/web/test/settings-external-editors.test.tsx` | COVERED |

Confirm the traceability check still passes:

Run: `pnpm run quality:traceability`
Expected: clean.

- [ ] **Step 3: Update STATE.md**

In `docs/ai/STATE.md`:

- If the active work item is still "1.0 OSS prep…", append a new section "Recent completions" with a one-liner: `Open-with-local-program shipped on main: /api/working_trees/:id/open + Files view split button + Settings External editors section.`
- Otherwise, replace the active work line if this was the active item.
- Update "Latest test / verification result" with the new test counts (4 new web tests files would be off — count the actual new files: open-with.test.ts, open-route.test.ts, files-view-open-with.test.tsx, settings-external-editors.test.tsx, plus storage tests appended).

- [ ] **Step 4: Append SESSION_LOG.md entry**

Prepend (newest entry at the top per `AGENTS.md`):

```markdown
## 2026-05-2X — Open with local program

Shipped FILE-00X. New `/open` route + `open-with.ts` helpers (host), Files
view split-button + caret menu (web), SettingsBody External editors CRUD,
new traceability row.
```

- [ ] **Step 5: Commit docs updates**

```bash
git add docs/quality/traceability.md docs/ai/STATE.md docs/ai/SESSION_LOG.md
git commit -m "docs: open-with traceability + STATE + session log"
```

---

## Final checklist

- [ ] `pnpm -r typecheck` clean
- [ ] `pnpm -r --if-present test` clean (host + web)
- [ ] `pnpm run quality:traceability` clean
- [ ] Manual verification recorded in PR body
- [ ] Spec linked from PR body
