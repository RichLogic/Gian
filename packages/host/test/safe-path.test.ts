// Coverage for traceability row:
//   SEC-005 — Workspace / working-tree file APIs must clamp every relative
//             path to the workspace boundary. Used by:
//               GET /api/workspaces/:id/file
//               GET /api/workspaces/:id/file_meta
//               GET /api/workspaces/:id/diff
//               GET /api/working_trees/:id/{tree,file,raw,diff,file_meta}
//             A regression here lets a remote authenticated user read any
//             file the daemon's UID can stat (~/.ssh, /etc/passwd, …).
//
// We test the underlying `resolveWithinWorkspace` helper directly: build a
// real tmp workspace with carefully crafted symlinks and assert that every
// escape attempt returns `null`, while legitimate paths return the real
// absolute path inside the workspace.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveWithinWorkspace } from '../src/workspace/safe-path.js';

interface Ctx {
  outside: string;          // tmpdir that lives OUTSIDE the workspace
  ws: string;               // workspace root (real path)
  cleanup: () => void;
}

function makeFs(): Ctx {
  // realpathSync collapses tmpdir on macOS (`/var/folders/...` → `/private/var/...`).
  // We must use the realpath form everywhere, otherwise `target.startsWith(rootReal + sep)`
  // fails for legitimate paths even when both live inside the same tmpdir.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gian-safepath-')));
  const ws = join(root, 'workspace');
  const outside = join(root, 'outside-secret');
  mkdirSync(ws, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'secret.txt'), 'shhhh — not for the agent');
  writeFileSync(join(ws, 'visible.txt'), 'safe contents');
  mkdirSync(join(ws, 'subdir'));
  writeFileSync(join(ws, 'subdir', 'nested.txt'), 'nested safe contents');
  return {
    outside,
    ws,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// Legitimate paths must succeed.
// ---------------------------------------------------------------------------

test('SEC-005: empty rel resolves to the workspace root itself', async () => {
  const ctx = makeFs();
  try {
    const resolved = await resolveWithinWorkspace(ctx.ws, '');
    assert.equal(resolved, ctx.ws, 'empty rel must return the real workspace root');
  } finally {
    ctx.cleanup();
  }
});

test('SEC-005: plain file inside workspace resolves to its real absolute path', async () => {
  const ctx = makeFs();
  try {
    const resolved = await resolveWithinWorkspace(ctx.ws, 'visible.txt');
    assert.equal(resolved, join(ctx.ws, 'visible.txt'));
  } finally {
    ctx.cleanup();
  }
});

test('SEC-005: nested path inside workspace resolves', async () => {
  const ctx = makeFs();
  try {
    const resolved = await resolveWithinWorkspace(ctx.ws, 'subdir/nested.txt');
    assert.equal(resolved, join(ctx.ws, 'subdir', 'nested.txt'));
  } finally {
    ctx.cleanup();
  }
});

test('SEC-005: non-existent path under workspace still resolves (file_meta / diff path)', async () => {
  // /diff and /file_meta routes pass paths that may not exist yet — the
  // helper must still return them as long as they're rooted inside the
  // workspace. The eventual stat/read failure is the caller's problem.
  const ctx = makeFs();
  try {
    const resolved = await resolveWithinWorkspace(ctx.ws, 'new/file-not-yet.txt');
    assert.equal(resolved, join(ctx.ws, 'new', 'file-not-yet.txt'));
  } finally {
    ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// `..` and absolute-path escapes must fail.
// ---------------------------------------------------------------------------

test('SEC-005: `..` traversal that escapes the workspace returns null', async () => {
  const ctx = makeFs();
  try {
    assert.equal(await resolveWithinWorkspace(ctx.ws, '../outside-secret/secret.txt'), null,
      '`..` escape must be blocked');
    assert.equal(await resolveWithinWorkspace(ctx.ws, '../../etc/passwd'), null,
      'multi-level `..` escape must be blocked');
  } finally {
    ctx.cleanup();
  }
});

test('SEC-005: `..` that stays inside the workspace is allowed', async () => {
  const ctx = makeFs();
  try {
    const resolved = await resolveWithinWorkspace(ctx.ws, 'subdir/../visible.txt');
    assert.equal(resolved, join(ctx.ws, 'visible.txt'),
      '`..` that lands back inside the workspace must still resolve');
  } finally {
    ctx.cleanup();
  }
});

test('SEC-005: absolute path that escapes workspace returns null', async () => {
  const ctx = makeFs();
  try {
    // `resolve(root, '/etc/passwd')` → '/etc/passwd' (absolute wins).
    assert.equal(await resolveWithinWorkspace(ctx.ws, '/etc/passwd'), null);
    assert.equal(await resolveWithinWorkspace(ctx.ws, '/'), null);
  } finally {
    ctx.cleanup();
  }
});

test('SEC-005: absolute path that points at the workspace root itself is accepted', async () => {
  const ctx = makeFs();
  try {
    // `resolve(root, root)` → root. This matches the helper's `target === rootReal` branch.
    const resolved = await resolveWithinWorkspace(ctx.ws, ctx.ws);
    assert.equal(resolved, ctx.ws);
  } finally {
    ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Symlink escapes — the most important class. Plain `resolve()` doesn't
// catch these; the helper's realpath walk is the only defense.
// ---------------------------------------------------------------------------

test('SEC-005: symlink inside workspace pointing OUTSIDE returns null', async () => {
  const ctx = makeFs();
  try {
    // workspace/escape → /…/outside-secret
    symlinkSync(ctx.outside, join(ctx.ws, 'escape'));
    assert.equal(await resolveWithinWorkspace(ctx.ws, 'escape/secret.txt'), null,
      'symlink → outside dir must be rejected even though the textual path stays under wsRoot');
    assert.equal(await resolveWithinWorkspace(ctx.ws, 'escape'), null,
      'symlink itself, when its target leaves the workspace, must also be rejected');
  } finally {
    ctx.cleanup();
  }
});

test('SEC-005: symlink pointing to a file OUTSIDE workspace returns null', async () => {
  const ctx = makeFs();
  try {
    // workspace/secret-shortcut → /…/outside-secret/secret.txt
    symlinkSync(join(ctx.outside, 'secret.txt'), join(ctx.ws, 'secret-shortcut'));
    assert.equal(await resolveWithinWorkspace(ctx.ws, 'secret-shortcut'), null,
      'symlinked file target outside workspace must be rejected');
  } finally {
    ctx.cleanup();
  }
});

test('SEC-005: deep symlink (parent dir is a symlink pointing outside) returns null', async () => {
  const ctx = makeFs();
  try {
    // workspace/inner → /…/outside-secret. Probe walks workspace/inner/secret.txt
    // → realpath of "workspace/inner" → /…/outside-secret, doesn't start with ws.
    symlinkSync(ctx.outside, join(ctx.ws, 'inner'));
    assert.equal(await resolveWithinWorkspace(ctx.ws, 'inner/secret.txt'), null);
    // Even a non-existent leaf under the escaping parent is blocked.
    assert.equal(await resolveWithinWorkspace(ctx.ws, 'inner/does-not-exist.txt'), null);
  } finally {
    ctx.cleanup();
  }
});

test('SEC-005: symlink pointing INTO the workspace (legitimate aliasing) is accepted', async () => {
  const ctx = makeFs();
  try {
    // workspace/alias → workspace/visible.txt. Stays under wsRoot → allowed.
    symlinkSync(join(ctx.ws, 'visible.txt'), join(ctx.ws, 'alias.txt'));
    const resolved = await resolveWithinWorkspace(ctx.ws, 'alias.txt');
    assert.equal(resolved, join(ctx.ws, 'visible.txt'),
      'in-workspace symlinks must resolve to their real target inside the workspace');
  } finally {
    ctx.cleanup();
  }
});

test('SEC-005: symlink whose target prefix-matches workspace name but is a sibling returns null', async () => {
  // Classic prefix-vs-boundary trap: workspace `/tmp/foo`, attacker symlink
  // points to `/tmp/foobar/secret`. A naive `.startsWith(rootReal)` check
  // (no separator) would mistakenly accept it. The helper uses `rootReal + sep`
  // which we encode in this assertion.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gian-safepath-prefix-')));
  try {
    const ws = join(root, 'ws');
    const sibling = join(root, 'ws-sibling');
    mkdirSync(ws);
    mkdirSync(sibling);
    writeFileSync(join(sibling, 'secret.txt'), 'sibling secret');
    symlinkSync(sibling, join(ws, 'link'));
    assert.equal(await resolveWithinWorkspace(ws, 'link/secret.txt'), null,
      'sibling dir whose name shares a prefix with the workspace must be rejected');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('SEC-005: missing workspace root itself returns null (no half-resolved leak)', async () => {
  const result = await resolveWithinWorkspace('/this/path/does/not/exist/anywhere', 'whatever.txt');
  assert.equal(result, null,
    'when wsRoot is unreadable, the helper must refuse — never return a half-resolved path');
});
