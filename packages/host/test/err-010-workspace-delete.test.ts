// Coverage for traceability row:
//   ERR-010 — Workspace delete must always succeed (2026-08-06): sessions
//             referencing the workspace lose their affiliation via
//             ON DELETE SET NULL (migration 045) and surface in the
//             Sessions rail's 无归属 (Unfiled) group. Unknown ids still
//             return 404.
//
// Drives the real Hono app via `makeTestApp` against a real workspaces /
// sessions table — no proxy or git fixture needed because the behavior is
// a pure DB foreign-key action.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { makeTestApp, type TestAppCtx } from './fixtures/test-app.js';

interface DelCtx {
  appCtx: TestAppCtx;
  workspaceId: string;
  sessionIds: string[];
  cleanup: () => Promise<void>;
}

async function setupWs(opts?: {
  withSession?: boolean;
  withLiveWorktree?: boolean;
  withFinalizedWorktree?: boolean;
}): Promise<DelCtx> {
  const appCtx = await makeTestApp();
  const workspaceId = randomUUID();
  const sessionIds: string[] = [];
  appCtx.db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)')
    .run(workspaceId, 'demo', '/tmp/demo-ws');

  const now = new Date().toISOString();
  if (opts?.withSession) {
    const id = randomUUID();
    sessionIds.push(id);
    appCtx.db.prepare(`
      INSERT INTO sessions
        (id, name, type, workspace_id, executor, model, approval_mode,
         active_channel, status, archived, native_session_id, created_at, updated_at)
      VALUES (?, 'live', 'coding', ?, 'claude', NULL, 'ask',
              'web', 'new', 0, ?, ?, ?)
    `).run(id, workspaceId, `native-${randomUUID()}`, now, now);
  }
  if (opts?.withLiveWorktree) {
    const id = randomUUID();
    sessionIds.push(id);
    appCtx.db.prepare(`
      INSERT INTO sessions
        (id, name, type, workspace_id, executor, model, approval_mode,
         active_channel, status, archived,
         worktree_path, branch, base_branch, worktree_outcome,
         native_session_id, created_at, updated_at)
      VALUES (?, 'wt', 'coding', ?, 'claude', NULL, 'ask',
              'web', 'new', 0,
              '/tmp/demo-ws-wt', 'worktree/abc12345', 'main', NULL,
              ?, ?, ?)
    `).run(id, workspaceId, `native-${randomUUID()}`, now, now);
  }
  if (opts?.withFinalizedWorktree) {
    const id = randomUUID();
    sessionIds.push(id);
    appCtx.db.prepare(`
      INSERT INTO sessions
        (id, name, type, workspace_id, executor, model, approval_mode,
         active_channel, status, archived,
         worktree_path, branch, base_branch, worktree_outcome,
         native_session_id, created_at, updated_at)
      VALUES (?, 'wt-finalized', 'coding', ?, 'claude', NULL, 'ask',
              'web', 'done', 1,
              NULL, 'worktree/zzz99999', 'main', 'merged',
              ?, ?, ?)
    `).run(id, workspaceId, `native-${randomUUID()}`, now, now);
  }

  return {
    appCtx,
    workspaceId,
    sessionIds,
    cleanup: () => appCtx.cleanup(),
  };
}

async function deleteWorkspace(ctx: DelCtx): Promise<void> {
  const res = await ctx.appCtx.fetch(`/api/workspaces/${ctx.workspaceId}`, {
    method: 'DELETE',
  });
  assert.equal(res.status, 200);
  const body = await res.json() as { ok: boolean };
  assert.equal(body.ok, true);
}

function assertDeletedWithUnfiledSessions(ctx: DelCtx): void {
  const row = ctx.appCtx.db.prepare('SELECT id FROM workspaces WHERE id = ?')
    .get(ctx.workspaceId);
  assert.equal(row, undefined, 'workspace row must be removed');
  for (const sessionId of ctx.sessionIds) {
    const session = ctx.appCtx.db
      .prepare('SELECT workspace_id FROM sessions WHERE id = ?')
      .get(sessionId) as { workspace_id: string | null } | undefined;
    assert.ok(session, 'session row must survive the workspace delete');
    assert.equal(session.workspace_id, null,
      'session must lose its workspace affiliation (ON DELETE SET NULL)');
  }
}

// ---------------------------------------------------------------------------
// Delete always succeeds; sessions become unfiled
// ---------------------------------------------------------------------------

test('ERR-010: DELETE on an empty workspace succeeds with ok=true', async () => {
  const ctx = await setupWs();
  try {
    await deleteWorkspace(ctx);
    assertDeletedWithUnfiledSessions(ctx);
  } finally {
    await ctx.cleanup();
  }
});

test('ERR-010: DELETE with a plain session succeeds and unfiles the session', async () => {
  const ctx = await setupWs({ withSession: true });
  try {
    await deleteWorkspace(ctx);
    assertDeletedWithUnfiledSessions(ctx);
  } finally {
    await ctx.cleanup();
  }
});

test('ERR-010: DELETE with a live-worktree session succeeds and unfiles it', async () => {
  const ctx = await setupWs({ withLiveWorktree: true });
  try {
    await deleteWorkspace(ctx);
    assertDeletedWithUnfiledSessions(ctx);
    // The on-disk worktree is untouched — only the affiliation is dropped.
    const session = ctx.appCtx.db
      .prepare('SELECT worktree_path FROM sessions WHERE id = ?')
      .get(ctx.sessionIds[0]) as { worktree_path: string | null };
    assert.equal(session.worktree_path, '/tmp/demo-ws-wt');
  } finally {
    await ctx.cleanup();
  }
});

test('ERR-010: DELETE with an archived finalized-worktree session succeeds and unfiles it', async () => {
  const ctx = await setupWs({ withFinalizedWorktree: true });
  try {
    await deleteWorkspace(ctx);
    assertDeletedWithUnfiledSessions(ctx);
  } finally {
    await ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Unknown workspace
// ---------------------------------------------------------------------------

test('ERR-010: DELETE on a non-existent workspace returns 404', async () => {
  const ctx = await setupWs();
  try {
    const res = await ctx.appCtx.fetch('/api/workspaces/no-such-workspace', {
      method: 'DELETE',
    });
    assert.equal(res.status, 404);
    const body = await res.json() as { error: string };
    assert.match(body.error, /workspace not found/);
  } finally {
    await ctx.cleanup();
  }
});
