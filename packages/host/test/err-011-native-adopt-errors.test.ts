// Coverage for traceability row:
//   ERR-011 — Native session adopt/delete must reject:
//             • missing native_id (400)
//             • unsupported executor (400)
//             • already-adopted native session (409)
//             • cross-workspace native sessions (404)
//             • delete of an adopted native session (409)
//
// Drives the real Hono app via `makeTestApp` (createApp with proxy
// warmup gated off). The native scanner is exercised by injecting
// `process.env.HOME` to point at a per-test home dir — the scanner reads
// `homedir()` internally, and the dynamic `import('../native/scanner.js')`
// inside the route picks it up the same way.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { makeTestApp, type TestAppCtx } from './fixtures/test-app.js';
import { makeNativeHome, type NativeHome } from './fixtures/native-home.js';
import { clearNativeSessionsCache } from '../src/native/scanner.js';

interface NativeTestCtx {
  appCtx: TestAppCtx;
  home: NativeHome;
  workspaceId: string;
  workspacePath: string;
  prevHome: string | undefined;
  cleanup: () => Promise<void>;
}

async function setup(): Promise<NativeTestCtx> {
  const appCtx = await makeTestApp();
  const home = makeNativeHome();
  // Point the scanner at the tmp home. The scanner re-reads homedir() each
  // call, so this is sufficient and a previous test's HOME never leaks in.
  const prevHome = process.env['HOME'];
  process.env['HOME'] = home.path;
  // Always start from a clean scanner cache so per-workspace caching across
  // tests can't bleed.
  clearNativeSessionsCache();

  const workspaceId = randomUUID();
  const workspacePath = '/Users/test-user/projects/native-demo';
  appCtx.db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)')
    .run(workspaceId, 'demo', workspacePath);

  return {
    appCtx,
    home,
    workspaceId,
    workspacePath,
    prevHome,
    cleanup: async () => {
      await appCtx.cleanup();
      home.cleanup();
      if (prevHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = prevHome;
      clearNativeSessionsCache();
    },
  };
}

async function adoptBody(ctx: NativeTestCtx, body: Record<string, unknown>) {
  return ctx.appCtx.fetch(`/api/workspaces/${ctx.workspaceId}/native-sessions/adopt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Adopt — input validation
// ---------------------------------------------------------------------------

test('ERR-011: adopt rejects unsupported executor with 400', async () => {
  const ctx = await setup();
  try {
    const res = await adoptBody(ctx, { executor: 'gemini', native_session_id: 'x' });
    assert.equal(res.status, 400);
    const body = await res.json() as { error: string };
    assert.match(body.error, /executor must be claude or codex/);
  } finally {
    await ctx.cleanup();
  }
});

test('ERR-011: adopt rejects missing native_session_id with 400', async () => {
  const ctx = await setup();
  try {
    const res = await adoptBody(ctx, { executor: 'claude' });
    assert.equal(res.status, 400);
    const body = await res.json() as { error: string };
    assert.match(body.error, /native_session_id required/);
  } finally {
    await ctx.cleanup();
  }
});

test('ERR-011: adopt rejects unknown workspace with 404', async () => {
  const ctx = await setup();
  try {
    const res = await ctx.appCtx.fetch(`/api/workspaces/does-not-exist/native-sessions/adopt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ executor: 'claude', native_session_id: 'x' }),
    });
    assert.equal(res.status, 404);
    const body = await res.json() as { error: string };
    assert.match(body.error, /workspace not found/);
  } finally {
    await ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Adopt — already-adopted + scan-miss
// ---------------------------------------------------------------------------

test('ERR-011: adopt rejects a native session that is already adopted with 409 and points at the existing gian session', async () => {
  const ctx = await setup();
  try {
    // Pre-existing adoption: insert a session bound to nativeId 'taken'.
    const existing = randomUUID();
    const now = new Date().toISOString();
    ctx.appCtx.db.prepare(`
      INSERT INTO sessions
        (id, name, type, workspace_id, executor, model, approval_mode, turns,
         active_channel, status, archived, native_session_id, created_at, updated_at)
      VALUES (?, 'already-bound', 'coding', ?, 'claude', NULL, 'ask', 1,
              'web', 'new', 0, 'taken', ?, ?)
    `).run(existing, ctx.workspaceId, now, now);

    const res = await adoptBody(ctx, { executor: 'claude', native_session_id: 'taken' });
    assert.equal(res.status, 409);
    const body = await res.json() as { error: string; gian_session_id: string };
    assert.match(body.error, /Already adopted/);
    assert.equal(body.gian_session_id, existing,
      '409 body must point at the existing gian session id so the UI can navigate to it');
  } finally {
    await ctx.cleanup();
  }
});

test('ERR-011: adopt of a native session that does not exist on disk returns 404 (scan miss)', async () => {
  const ctx = await setup();
  try {
    // Home has no .claude/projects/<encoded>/<id>.jsonl for the workspace.
    const res = await adoptBody(ctx, { executor: 'claude', native_session_id: 'ghost' });
    assert.equal(res.status, 404);
    const body = await res.json() as { error: string };
    assert.match(body.error, /native session not found/);
  } finally {
    await ctx.cleanup();
  }
});

test('ERR-011: adopt of a native session that exists for a DIFFERENT workspace returns 404 (cross-workspace boundary)', async () => {
  const ctx = await setup();
  try {
    // Plant a cc session under a different workspace's encoded dir.
    ctx.home.addClaudeSession({
      workspacePath: '/Users/test-user/projects/other-repo',
      sessionId: 'belongs-elsewhere',
    });

    const res = await adoptBody(ctx, {
      executor: 'claude',
      native_session_id: 'belongs-elsewhere',
    });
    assert.equal(res.status, 404,
      'cross-workspace adoption MUST 404 — adopting another workspace\'s native session is a security boundary violation');
    const body = await res.json() as { error: string };
    assert.match(body.error, /native session not found in this workspace/);
  } finally {
    await ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Adopt — happy path sanity (anchors the negative tests above)
// ---------------------------------------------------------------------------

test('ERR-011: adopt happy path returns the new gian session row when the native session exists in this workspace', async () => {
  const ctx = await setup();
  try {
    const sid = ctx.home.addClaudeSession({
      workspacePath: ctx.workspacePath,
      sessionId: 'cc-adoptable',
    });
    const res = await adoptBody(ctx, {
      executor: 'claude',
      native_session_id: sid,
      name: 'Test adopted',
    });
    assert.equal(res.status, 200,
      'sanity: happy-path adopt must succeed — anchors the negative tests above');
    const body = await res.json() as { session: { native_session_id: string; name: string } };
    assert.equal(body.session.native_session_id, sid);
    assert.equal(body.session.name, 'Test adopted');
  } finally {
    await ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Delete — error paths
// ---------------------------------------------------------------------------

async function deleteNative(
  ctx: NativeTestCtx,
  executor: string,
  nativeId: string,
) {
  return ctx.appCtx.fetch(
    `/api/workspaces/${ctx.workspaceId}/native-sessions/${nativeId}?executor=${executor}`,
    { method: 'DELETE' },
  );
}

test('ERR-011: delete rejects unsupported executor query param with 400', async () => {
  const ctx = await setup();
  try {
    const res = await deleteNative(ctx, 'gemini', 'whatever');
    assert.equal(res.status, 400);
    const body = await res.json() as { error: string };
    assert.match(body.error, /executor query param must be claude or codex/);
  } finally {
    await ctx.cleanup();
  }
});

test('ERR-011: delete rejects an adopted native session with 409 and points at the gian session', async () => {
  const ctx = await setup();
  try {
    // Plant + adopt.
    const sid = ctx.home.addClaudeSession({
      workspacePath: ctx.workspacePath,
      sessionId: 'cc-bound',
    });
    const adoptRes = await adoptBody(ctx, { executor: 'claude', native_session_id: sid });
    assert.equal(adoptRes.status, 200);
    const adoptBody2 = await adoptRes.json() as { session: { id: string } };

    const delRes = await deleteNative(ctx, 'claude', sid);
    assert.equal(delRes.status, 409,
      'deleting an adopted native session must 409 — user has to drop the gian session first');
    const body = await delRes.json() as { error: string; gian_session_id: string };
    assert.match(body.error, /currently adopted/);
    assert.equal(body.gian_session_id, adoptBody2.session.id);
  } finally {
    await ctx.cleanup();
  }
});

test('ERR-011: delete of a non-existent native session in this workspace returns 404', async () => {
  const ctx = await setup();
  try {
    const res = await deleteNative(ctx, 'claude', 'ghost-id');
    assert.equal(res.status, 404);
    const body = await res.json() as { error: string };
    assert.match(body.error, /native session not found/);
  } finally {
    await ctx.cleanup();
  }
});

test('ERR-011: delete of a native session in a different workspace returns 404 (cross-workspace boundary)', async () => {
  const ctx = await setup();
  try {
    ctx.home.addClaudeSession({
      workspacePath: '/Users/test-user/projects/another-repo',
      sessionId: 'cross-leak',
    });
    const res = await deleteNative(ctx, 'claude', 'cross-leak');
    assert.equal(res.status, 404,
      'cross-workspace delete must NOT succeed — security boundary mirrors adopt');
  } finally {
    await ctx.cleanup();
  }
});
