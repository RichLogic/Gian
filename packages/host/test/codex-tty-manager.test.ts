// Coverage for traceability row:
//   CODEX-TTY-001 — Host-side coordinator for the Codex CLI runtime mode.
//                   Mirrors TtyManager (claude) minus the hook subsystem
//                   (codex has no `--settings` hook surface). Validates
//                   start / stop / input / resize / replay routing AND
//                   the dual-id discipline on tty.* notifications.
//
// The proxy client is duck-typed via `isCodexTtyClient` so we hand the
// manager a small stub instead of dragging in CodexProxyHost (which
// spawns a subprocess in its constructor).

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session, ServerToClientMessage } from '@gian/shared';
import { openDatabase } from '../src/storage/db.js';
import type { Db } from '../src/storage/db.js';
import type { WsBroadcaster } from '../src/web/ws-broadcast.js';
import type { ProxyManager } from '../src/proxy/manager.js';
import { CodexTtyManager } from '../src/tty/codex-manager.js';

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

interface StubCallLog {
  ttyStart: Array<Record<string, unknown>>;
  ttyKill: Array<{ gianSessionId: string }>;
  ttyInput: Array<{ gianSessionId: string; data?: string; text?: string }>;
  ttyResize: Array<{ gianSessionId: string; cols: number; rows: number }>;
  ttyReplay: Array<{ gianSessionId: string }>;
}

function makeStubClient(proxySessionId: string | null = 'proxy-sess-1') {
  const calls: StubCallLog = {
    ttyStart: [], ttyKill: [], ttyInput: [], ttyResize: [], ttyReplay: [],
  };
  const client = {
    getProxySessionId: () => proxySessionId,
    async ttyStart(params: Record<string, unknown>) {
      calls.ttyStart.push(params);
      return { ok: true as const, replay: ['cmVwbGF5'], alive: true };
    },
    async ttyInput(params: { gianSessionId: string; data?: string; text?: string }) {
      calls.ttyInput.push(params);
      return { ok: true as const };
    },
    async ttyResize(params: { gianSessionId: string; cols: number; rows: number }) {
      calls.ttyResize.push(params);
      return { ok: true as const };
    },
    async ttyReplay(params: { gianSessionId: string }) {
      calls.ttyReplay.push(params);
      return { chunks: ['Y2h1bms='], alive: true };
    },
    async ttyKill(params: { gianSessionId: string }) {
      calls.ttyKill.push(params);
      return { ok: true as const };
    },
  };
  return { client, calls };
}

class CapturingBroadcaster {
  messages: ServerToClientMessage[] = [];
  add() {} remove() {} send() {}
  broadcast(msg: ServerToClientMessage) { this.messages.push(msg); }
  get size() { return 0; }
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'gian-codex-tty-test-'));
  const db = openDatabase(dir);
  const broadcaster = new CapturingBroadcaster();
  const stub = makeStubClient();
  const proxyMgr = {
    get: (_id: string): unknown => stub.client,
  } as unknown as ProxyManager;
  const mgr = new CodexTtyManager(db, proxyMgr, broadcaster as unknown as WsBroadcaster);
  return { dir, db, broadcaster, mgr, stub, proxyMgr };
}

function teardown(ctx: { dir: string; db: Db }) {
  ctx.db.close();
  rmSync(ctx.dir, { recursive: true, force: true });
}

// Build a minimal codex Session row + insert into DB so persistMode's
// UPDATE finds it. Returns the row that callers pass to mgr.start.
function seedCodexSession(db: Db, over: Partial<Session> = {}): Session {
  const sessionId = over.id ?? 'sess-codex-1';
  const wsId = 'ws-1';
  // Workspace row is required for FK in some installs; keep it cheap.
  db.prepare('INSERT OR IGNORE INTO workspaces (id, name, path) VALUES (?, ?, ?)')
    .run(wsId, 'test', '/tmp/test-ws');
  const now = '2026-05-20T00:00:00.000Z';
  db.prepare(`
    INSERT INTO sessions (
      id, name, type, workspace_id, executor, model, approval_mode,
      thinking_effort, turns, active_channel, status, archived,
      worktree_path, branch, base_branch, worktree_outcome,
      native_session_id, runtime_mode, created_at, updated_at
    ) VALUES (?, ?, 'coding', ?, 'codex', ?, 'manual', NULL, 1, 'web',
              'idle', 0, NULL, NULL, NULL, NULL, ?, 'structured', ?, ?)
  `).run(
    sessionId, over.name ?? 'codex test', wsId,
    over.model ?? null,
    Object.hasOwn(over, 'native_session_id') ? over.native_session_id : 'codex-thread-uuid-xyz',
    now, now,
  );
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as Session;
}

// ---------------------------------------------------------------------------
// CODEX-TTY-001 — start
// ---------------------------------------------------------------------------

test('CODEX-TTY-001: start forwards triple-id payload (gianSessionId / proxySessionId / codexThreadId)', async () => {
  const ctx = setup();
  try {
    const session = seedCodexSession(ctx.db);
    const result = await ctx.mgr.start(session, '/tmp/work', { cols: 100, rows: 32 });
    assert.deepEqual(result, { replay: ['cmVwbGF5'], alive: true });
    assert.equal(ctx.stub.calls.ttyStart.length, 1);
    const call = ctx.stub.calls.ttyStart[0]!;
    assert.equal(call.gianSessionId, session.id);
    assert.equal(call.proxySessionId, 'proxy-sess-1');
    assert.equal(call.codexThreadId, 'codex-thread-uuid-xyz');
    assert.equal(call.cwd, '/tmp/work');
    assert.equal(call.cols, 100);
    assert.equal(call.rows, 32);
  } finally { teardown(ctx); }
});

test('CODEX-TTY-001: start persists runtime_mode=tty and broadcasts session:runtime-switched + session:updated', async () => {
  const ctx = setup();
  try {
    const session = seedCodexSession(ctx.db);
    await ctx.mgr.start(session, '/tmp/work', { cols: 100, rows: 32 });

    const row = ctx.db.prepare('SELECT runtime_mode FROM sessions WHERE id = ?').get(session.id) as { runtime_mode: string };
    assert.equal(row.runtime_mode, 'tty');

    const sw = ctx.broadcaster.messages.find(m => m.type === 'session:runtime-switched');
    assert.ok(sw, 'session:runtime-switched broadcast missing');
    const upd = ctx.broadcaster.messages.find(m => m.type === 'session:updated');
    assert.ok(upd, 'session:updated broadcast missing');
  } finally { teardown(ctx); }
});

test('CODEX-TTY-001: start throws if session.executor !== codex (manager is codex-only)', async () => {
  const ctx = setup();
  try {
    const session = seedCodexSession(ctx.db);
    const claudeLike = { ...session, executor: 'claude' as const };
    await assert.rejects(
      ctx.mgr.start(claudeLike as Session, '/tmp/work', { cols: 80, rows: 24 }),
      /non-codex session/,
    );
  } finally { teardown(ctx); }
});

test('CODEX-TTY-001: start throws if native_session_id is missing (caller must run ensureProxySession first)', async () => {
  const ctx = setup();
  try {
    // The native_session_id check runs before any DB read, so we hand the
    // manager a Session-shaped object directly instead of round-tripping
    // through SQLite (which enforces NOT NULL on this column).
    const seed = seedCodexSession(ctx.db);
    const sansNativeId = { ...seed, native_session_id: null } as Session;
    await assert.rejects(
      ctx.mgr.start(sansNativeId, '/tmp/work', { cols: 80, rows: 24 }),
      /no native_session_id/,
    );
  } finally { teardown(ctx); }
});

test('CODEX-TTY-001: start throws if proxy returns no client for the session', async () => {
  const ctx = setup();
  try {
    const session = seedCodexSession(ctx.db);
    // Override proxy.get to return undefined (simulates ensureProxySession
    // never having run; caller broke the contract).
    const proxyMgr = { get: () => undefined } as unknown as ProxyManager;
    const mgr = new CodexTtyManager(ctx.db, proxyMgr, ctx.broadcaster as unknown as WsBroadcaster);
    await assert.rejects(
      mgr.start(session, '/tmp/work', { cols: 80, rows: 24 }),
      /no codex-proxy client/,
    );
  } finally { teardown(ctx); }
});

test('CODEX-TTY-001: start throws if facade has no proxySessionId yet (createSession never ran)', async () => {
  const ctx = setup();
  try {
    const session = seedCodexSession(ctx.db);
    const stub = makeStubClient(null);
    const proxyMgr = { get: () => stub.client } as unknown as ProxyManager;
    const mgr = new CodexTtyManager(ctx.db, proxyMgr, ctx.broadcaster as unknown as WsBroadcaster);
    await assert.rejects(
      mgr.start(session, '/tmp/work', { cols: 80, rows: 24 }),
      /no proxySessionId/,
    );
  } finally { teardown(ctx); }
});

// ---------------------------------------------------------------------------
// CODEX-TTY-001 — stop
// ---------------------------------------------------------------------------

test('CODEX-TTY-001: stop calls ttyKill and persists runtime_mode=structured', async () => {
  const ctx = setup();
  try {
    const session = seedCodexSession(ctx.db);
    await ctx.mgr.start(session, '/tmp/work', { cols: 80, rows: 24 });
    ctx.broadcaster.messages.length = 0;
    await ctx.mgr.stop(session);

    assert.equal(ctx.stub.calls.ttyKill.length, 1);
    assert.equal(ctx.stub.calls.ttyKill[0]!.gianSessionId, session.id);

    const row = ctx.db.prepare('SELECT runtime_mode FROM sessions WHERE id = ?').get(session.id) as { runtime_mode: string };
    assert.equal(row.runtime_mode, 'structured');
  } finally { teardown(ctx); }
});

test('CODEX-TTY-001: stop is safe when no client is present (proxy already gone)', async () => {
  const ctx = setup();
  try {
    const session = seedCodexSession(ctx.db);
    const proxyMgr = { get: () => undefined } as unknown as ProxyManager;
    const mgr = new CodexTtyManager(ctx.db, proxyMgr, ctx.broadcaster as unknown as WsBroadcaster);
    await mgr.stop(session);  // must not throw
    const row = ctx.db.prepare('SELECT runtime_mode FROM sessions WHERE id = ?').get(session.id) as { runtime_mode: string };
    assert.equal(row.runtime_mode, 'structured', 'persistMode must still run even when proxy is gone');
  } finally { teardown(ctx); }
});

// ---------------------------------------------------------------------------
// CODEX-TTY-001 — input / resize / replay passthrough
// ---------------------------------------------------------------------------

test('CODEX-TTY-001: input forwards data / text to ttyInput', async () => {
  const ctx = setup();
  try {
    await ctx.mgr.input('sess-1', { data: Buffer.from('ls\n').toString('base64') });
    await ctx.mgr.input('sess-1', { text: 'hello' });
    assert.equal(ctx.stub.calls.ttyInput.length, 2);
    assert.equal(ctx.stub.calls.ttyInput[0]!.gianSessionId, 'sess-1');
    assert.equal(ctx.stub.calls.ttyInput[1]!.text, 'hello');
  } finally { teardown(ctx); }
});

test('CODEX-TTY-001: resize forwards cols/rows to ttyResize', async () => {
  const ctx = setup();
  try {
    await ctx.mgr.resize('sess-1', 132, 48);
    assert.deepEqual(ctx.stub.calls.ttyResize, [{ gianSessionId: 'sess-1', cols: 132, rows: 48 }]);
  } finally { teardown(ctx); }
});

test('CODEX-TTY-001: replay returns ring buffer chunks from ttyReplay', async () => {
  const ctx = setup();
  try {
    const out = await ctx.mgr.replay('sess-1');
    assert.deepEqual(out, { chunks: ['Y2h1bms='], alive: true });
    assert.equal(ctx.stub.calls.ttyReplay.length, 1);
  } finally { teardown(ctx); }
});

test('CODEX-TTY-001: input/resize/replay on unknown sessionId is a silent no-op (defensive)', async () => {
  const ctx = setup();
  try {
    const proxyMgr = { get: () => undefined } as unknown as ProxyManager;
    const mgr = new CodexTtyManager(ctx.db, proxyMgr, ctx.broadcaster as unknown as WsBroadcaster);
    await mgr.input('ghost', { data: 'x' });
    await mgr.resize('ghost', 100, 30);
    const result = await mgr.replay('ghost');
    assert.deepEqual(result, { chunks: [], alive: false });
  } finally { teardown(ctx); }
});

// ---------------------------------------------------------------------------
// CODEX-TTY-001 — handleProxyNotification (dual-id payload routing)
// ---------------------------------------------------------------------------

test('CODEX-TTY-001: handleProxyNotification(tty.output) broadcasts pty:output keyed on gianSessionId (NOT proxySessionId)', () => {
  const ctx = setup();
  try {
    ctx.mgr.handleProxyNotification({
      method: 'tty.output',
      params: {
        sessionId: 'proxy-sess-XYZ',   // proxy-side routing key — must NOT be used as session_id
        gianSessionId: 'gian-sess-ABC', // the actual host session id for WS routing
        data: Buffer.from('boot frame', 'utf8').toString('base64'),
      },
    });
    const out = ctx.broadcaster.messages.find(m => m.type === 'pty:output') as
      | { type: 'pty:output'; session_id: string; data: string } | undefined;
    assert.ok(out);
    assert.equal(out!.session_id, 'gian-sess-ABC',
      'pty:output must broadcast with gianSessionId, NOT the codex-proxy-side proxySessionId');
    assert.equal(Buffer.from(out!.data, 'base64').toString('utf8'), 'boot frame');
  } finally { teardown(ctx); }
});

test('CODEX-TTY-001: handleProxyNotification(tty.exited) broadcasts event keyed on gianSessionId', () => {
  const ctx = setup();
  try {
    ctx.mgr.handleProxyNotification({
      method: 'tty.exited',
      params: {
        sessionId: 'proxy-XYZ',
        gianSessionId: 'gian-ABC',
        code: 137,
        signal: 'SIGKILL',
      },
    });
    const ev = ctx.broadcaster.messages.find(
      m => m.type === 'event' && (m as { event?: string }).event === 'tty.exited',
    ) as { type: 'event'; session_id: string; data: { code: number; signal: string } } | undefined;
    assert.ok(ev);
    assert.equal(ev!.session_id, 'gian-ABC');
    assert.equal(ev!.data.code, 137);
    assert.equal(ev!.data.signal, 'SIGKILL');
  } finally { teardown(ctx); }
});

test('CODEX-TTY-001: handleProxyNotification ignores claude-shaped notifications (no gianSessionId in params)', () => {
  const ctx = setup();
  try {
    ctx.mgr.handleProxyNotification({
      method: 'tty.output',
      params: {
        // claude-side shape: only sessionId, no gianSessionId
        sessionId: 'claude-session',
        data: 'irrelevant',
      },
    });
    assert.equal(ctx.broadcaster.messages.length, 0,
      'codex manager must NOT broadcast for notifications lacking gianSessionId — those belong to claude TtyManager');
  } finally { teardown(ctx); }
});

test('CODEX-TTY-001: handleProxyNotification ignores unknown methods', () => {
  const ctx = setup();
  try {
    ctx.mgr.handleProxyNotification({
      method: 'turn.completed',
      params: { sessionId: 'p', gianSessionId: 'g' },
    });
    assert.equal(ctx.broadcaster.messages.length, 0);
  } finally { teardown(ctx); }
});
