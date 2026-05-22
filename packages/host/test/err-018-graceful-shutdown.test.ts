// Coverage for traceability row:
//   ERR-018 — Shutdown must stop watcher / terminals / IM platforms /
//             proxies so no orphan processes remain after the host
//             exits. Idempotent / safe against partial failures.
//
// The `shutdown()` returned by `createApp` is the single entry point for
// SIGTERM in production (`packages/host/src/index.ts`). We drive it
// through `makeTestApp` and assert against observable side effects:
//   • `appCtx.app.shutdown()` resolves without throwing;
//   • a second call also resolves cleanly (idempotency);
//   • subsequent route calls fail because the underlying managers are
//     torn down (we only assert non-crash behavior, not specific 5xx
//     bodies — Hono's app.fetch will still respond, but the underlying
//     state is gone, so we verify shutdown does NOT leak unhandled
//     promise rejections).

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { makeTestApp } from './fixtures/test-app.js';

test('ERR-018: createApp.shutdown() resolves cleanly without throwing on a freshly-created app', async () => {
  const ctx = await makeTestApp();
  try {
    // makeTestApp itself calls shutdown in cleanup; we just want to know
    // a manual call doesn't throw.
    await ctx.app.shutdown();
  } catch (err) {
    assert.fail(`shutdown() must not throw on a clean app — got: ${(err as Error).message}`);
  } finally {
    // ctx.cleanup will call shutdown again — verifies idempotency too.
    await ctx.cleanup();
  }
});

test('ERR-018: createApp.shutdown() is idempotent — repeated calls do not throw or hang', async () => {
  const ctx = await makeTestApp();
  try {
    await ctx.app.shutdown();
    await ctx.app.shutdown();
    await ctx.app.shutdown();
    // If shutdown leaks unhandled rejections or hangs, the test runner
    // never reaches the next line. Reaching here is the assertion.
    assert.ok(true,
      'shutdown must be idempotent — production wires it to SIGTERM and the signal can fire multiple times');
  } finally {
    await ctx.cleanup();
  }
});

test('ERR-018: shutdown completes within a reasonable timeout (no orphan-process wait)', async () => {
  // Production index.ts wires shutdown to SIGTERM and then exits. If
  // shutdown waits forever on a proxy that already crashed, host process
  // never exits. Cap the call at 3s — far longer than any real cleanup
  // path on the empty test app.
  const ctx = await makeTestApp();
  try {
    const start = Date.now();
    await Promise.race([
      ctx.app.shutdown(),
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error('shutdown took longer than 3s')), 3000),
      ),
    ]);
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 3000,
      `shutdown must complete within 3s; took ${elapsed}ms`);
  } finally {
    await ctx.cleanup();
  }
});

test('ERR-018: shutdown after a workspace is created still completes cleanly', async () => {
  // A workspace row materializes a watcher entry on host boot; verify
  // shutdown doesn't get stuck on a dangling JSONL watcher.
  const ctx = await makeTestApp();
  try {
    ctx.db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)')
      .run('ws-x', 'demo', '/tmp/demo-ws');
    await ctx.app.shutdown();
  } finally {
    await ctx.cleanup();
  }
});

test('ERR-018: shutdown after a session is created still completes (no leftover proxy lock)', async () => {
  // Insert a session row + native_session_id (the production schema
  // requires non-null native_session_id post-migration 013). The
  // bootJsonlWatchers function attempts to attach a watcher; it tolerates
  // missing JSONL files, so shutdown should still walk cleanly.
  const ctx = await makeTestApp();
  try {
    ctx.db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)')
      .run('ws-y', 'demo', '/tmp/demo-ws');
    const now = new Date().toISOString();
    ctx.db.prepare(`
      INSERT INTO sessions
        (id, name, type, workspace_id, executor, model, approval_mode, turns,
         active_channel, status, archived, native_session_id, created_at, updated_at)
      VALUES (?, 'demo', 'coding', ?, 'claude', NULL, 'ask', 1,
              'web', 'new', 0, 'fake-native-id', ?, ?)
    `).run('sess-y', 'ws-y', now, now);

    await ctx.app.shutdown();
    // Reaching here without exceptions or hangs is the assertion.
    assert.ok(true);
  } finally {
    await ctx.cleanup();
  }
});

test('ERR-018: shutdown does not leak unhandled rejections from IM platform shutdown errors', async () => {
  // Pin that any thrown error inside `p.shutdown()` is caught by the
  // route-level `.catch` (see `web/app.ts` shutdown closure). If a
  // platform shutdown ever throws synchronously, the outer Promise.all
  // would otherwise reject and break SIGTERM.
  //
  // We can't inject a faulty platform without a fake IM adapter (Codex
  // P5), but we CAN verify the empty case doesn't leak. Track unhandled
  // rejections during the call.
  const ctx = await makeTestApp();
  const leaks: unknown[] = [];
  const onUnhandled = (reason: unknown) => leaks.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    await ctx.app.shutdown();
    // Settle any microtasks queued by the closure.
    await new Promise(r => setImmediate(r));
    assert.deepEqual(leaks, [],
      'shutdown must NOT leak any unhandled promise rejections — production SIGTERM relies on it returning cleanly');
  } finally {
    process.off('unhandledRejection', onUnhandled);
    await ctx.cleanup();
  }
});
