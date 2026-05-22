// Coverage for traceability row:
//   ERR-009 — When a proxy child exits (cc-proxy crash, codex host exit,
//             runtime.error followed by SIGTERM, …) the host must:
//               • decline every pending approval for the session;
//               • drop the cached proxySessionId;
//               • flip the active turn to error and the session to error;
//               • broadcast session:updated + approval:updated so the UI
//                 doesn't sit on stale state.
//
// Drives SessionManager + ApprovalManager with the deterministic fake
// proxy used by queue-and-busy.test.ts. The proxy exit channel is the
// `onExit` callback registered by SessionManager during bringUpProxySession;
// the fake exposes a `fireExit(code)` hook so tests can trigger the path
// without spawning a real child.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ProxyNotification, ServerToClientMessage } from '@gian/shared';
import { openDatabase } from '../src/storage/db.js';
import { SessionManager } from '../src/session/manager.js';
import type { ProxyManager } from '../src/proxy/manager.js';
import type { ProxyClient, NotificationHandler } from '../src/proxy/types.js';
import type { WsBroadcaster } from '../src/web/ws-broadcast.js';
import { ApprovalManager } from '../src/approval/index.js';
import { QueueManager } from '../src/queue/index.js';

// ---------------------------------------------------------------------------
// Fake proxy with onExit hook
// ---------------------------------------------------------------------------

class FakeProxyClient implements ProxyClient {
  readonly executor: 'claude' | 'codex' = 'claude';
  notificationHandlers: NotificationHandler[] = [];
  exitHandlers: Array<(code: number | null) => void> = [];

  async initialize() { return { mode: 'spawn' as const, protocolVersion: '0.1.0', methods: [] }; }
  async capabilities() { return { protocolVersion: '0.1.0', models: [], slashCommands: [] }; }
  async listSlashCommands() { return { commands: [] }; }
  async createSession(params: { cwd: string; claudeSessionId?: string }) {
    const nativeSessionId = params.claudeSessionId ?? `cc_${randomUUID()}`;
    return {
      session: {
        id: nativeSessionId,
        cwd: params.cwd,
        claudeSessionId: nativeSessionId,
        model: null,
        status: 'idle' as const,
        createdAt: '2026-05-17T00:00:00.000Z',
        updatedAt: '2026-05-17T00:00:00.000Z',
        lastError: null,
      },
      nativeSessionId,
    };
  }
  async interruptTurn() {}
  async respondApproval() {}
  async startTurn() {
    return {
      session: {
        id: 'proxy_x', cwd: '/tmp', model: null,
        status: 'running' as const,
        createdAt: '2026-05-17T00:00:00.000Z', updatedAt: '2026-05-17T00:00:00.000Z',
        lastError: null,
      },
      turn: { id: 'proxy_turn' },
    };
  }
  async closeSession() {}
  async shutdown() {}
  forceKill() {}
  onNotification(handler: NotificationHandler) {
    this.notificationHandlers.push(handler);
    return () => { this.notificationHandlers = this.notificationHandlers.filter(h => h !== handler); };
  }
  onExit(handler: (code: number | null) => void) {
    this.exitHandlers.push(handler);
    return () => { this.exitHandlers = this.exitHandlers.filter(h => h !== handler); };
  }
  fire(notification: ProxyNotification): void {
    for (const h of this.notificationHandlers) h(notification);
  }
  /** Simulate the proxy child exiting. Mirrors the real ChildProcess `exit`
   *  event the cc/codex proxy clients forward to SessionManager. */
  fireExit(code: number | null = 1): void {
    for (const h of this.exitHandlers) h(code);
  }
}

class FakeProxyManager {
  client = new FakeProxyClient();
  async getOrCreate(): Promise<ProxyClient> { return this.client; }
  get(): ProxyClient { return this.client; }
  async closeAll(): Promise<void> {}
}

class CapturingBroadcaster {
  messages: ServerToClientMessage[] = [];
  add() {} remove() {} send() {}
  broadcast(msg: ServerToClientMessage): void { this.messages.push(msg); }
  get size() { return 0; }
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'gian-err009-'));
  const db = openDatabase(dir);
  const wsId = randomUUID();
  db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)')
    .run(wsId, 'test', '/tmp/test-ws');

  const proxyMgr = new FakeProxyManager();
  const broadcaster = new CapturingBroadcaster();
  const approvals = new ApprovalManager(broadcaster as unknown as WsBroadcaster);
  const queue = new QueueManager(db);
  const sessions = new SessionManager(
    db,
    proxyMgr as unknown as ProxyManager,
    broadcaster as unknown as WsBroadcaster,
    approvals,
    queue,
    dir,
  );
  approvals.setRespondFn((sid, aid, dec) => sessions.respondApproval(sid, aid, dec));
  approvals.setGetModeFn(sid => sessions.getSession(sid).approval_mode);
  return { dir, db, wsId, sessions, proxyMgr, broadcaster, approvals };
}

function teardown(ctx: { dir: string; db: ReturnType<typeof openDatabase> }) {
  ctx.db.close();
  rmSync(ctx.dir, { recursive: true, force: true });
}

async function tick() { await new Promise(r => setImmediate(r)); }

// Fire a high-risk approval through the standard proxy path so it registers
// as pending in ApprovalManager (auto mode + low risk short-circuits; we use
// 'ask' mode + 'high' risk to force the registerPending path).
async function raiseApproval(
  proxy: FakeProxyManager,
  approvalId: string,
) {
  proxy.client.fire({
    method: 'approval.requested',
    params: {
      sessionId: 'proxy_x',
      data: {
        approvalId,
        toolName: 'Bash',
        // High-risk shell command — ApprovalManager registers as pending
        // for the default ask mode.
        inputPreview: JSON.stringify({ command: 'rm -rf /', description: 'wipe disk' }),
      },
    },
  });
  await tick();
}

// ---------------------------------------------------------------------------
// ERR-009 — pending approval cleanup
// ---------------------------------------------------------------------------

test('ERR-009: proxy exit declines every pending approval for the session', async () => {
  const ctx = setup();
  try {
    const session = await ctx.sessions.createSession({
      workspace_id: ctx.wsId, executor: 'claude', approval_mode: 'ask',
    });
    // Boot the proxy by sending a message; this also registers the onExit handler.
    await ctx.sessions.sendMessage(session.id, 'kick off');

    await raiseApproval(ctx.proxyMgr, 'appr-a');
    await raiseApproval(ctx.proxyMgr, 'appr-b');

    const pendingBefore = ctx.approvals.listPending().filter(a => a.sessionId === session.id);
    assert.equal(pendingBefore.length, 2,
      'two approvals must be pending before the proxy exits — guards the registerPending path');

    ctx.broadcaster.messages.length = 0;
    ctx.proxyMgr.client.fireExit(137);
    await tick();

    const pendingAfter = ctx.approvals.listPending().filter(a => a.sessionId === session.id);
    assert.equal(pendingAfter.length, 0,
      'all pending approvals for the session must be cleared on proxy exit');

    const updates = ctx.broadcaster.messages.filter(
      m => m.type === 'approval:updated',
    ) as Array<{ approval: { id: string; status: string; resolved_by: string } }>;
    const updatedIds = updates.map(u => u.approval.id).sort();
    assert.deepEqual(updatedIds, ['appr-a', 'appr-b'].sort(),
      'every pending approval must produce an approval:updated broadcast (UI clears cards)');
    for (const u of updates) {
      assert.equal(u.approval.status, 'declined',
        'cleared approvals must be reported as declined, not stuck in pending');
      assert.equal(u.approval.resolved_by, 'auto',
        'resolved_by must be `auto` so the UI shows "auto-declined" not user-initiated');
    }
  } finally {
    teardown(ctx);
  }
});

// ---------------------------------------------------------------------------
// ERR-009 — turn + session state flip
// ---------------------------------------------------------------------------

test('ERR-009: proxy exit mid-turn flips active turn to error and session to error', async () => {
  const ctx = setup();
  try {
    const session = await ctx.sessions.createSession({
      workspace_id: ctx.wsId, executor: 'claude', approval_mode: 'ask',
    });
    await ctx.sessions.sendMessage(session.id, 'work');

    // Confirm we have an active turn before the exit.
    const turnBefore = ctx.db.prepare(`
      SELECT status FROM turns WHERE session_id = ? ORDER BY rowid DESC LIMIT 1
    `).get(session.id) as { status: string };
    assert.equal(turnBefore.status, 'running');

    ctx.broadcaster.messages.length = 0;
    ctx.proxyMgr.client.fireExit(1);
    await tick();

    const turnAfter = ctx.db.prepare(`
      SELECT status, completed_at FROM turns WHERE session_id = ? ORDER BY rowid DESC LIMIT 1
    `).get(session.id) as { status: string; completed_at: string | null };
    assert.equal(turnAfter.status, 'error',
      'mid-turn proxy exit must mark the active turn as error');
    assert.ok(turnAfter.completed_at,
      'completed_at must be stamped so the UI doesn\'t spin forever waiting for the turn');

    const sessionRow = ctx.db.prepare('SELECT status FROM sessions WHERE id = ?')
      .get(session.id) as { status: string };
    assert.equal(sessionRow.status, 'error',
      'session.status must flip to error so the runner chip surfaces the crash');

    const updates = ctx.broadcaster.messages.filter(
      m => m.type === 'session:updated',
    ) as Array<{ session: { id: string; status?: string } }>;
    assert.ok(updates.some(u => u.session.id === session.id && u.session.status === 'error'),
      'session:updated must broadcast the error status so the runner chip refreshes');
  } finally {
    teardown(ctx);
  }
});

test('ERR-009: proxy exit while idle (no active turn) clears caches but does NOT flip the session to error', async () => {
  // The session may have completed its turn cleanly and the proxy may exit
  // afterwards on shutdown. That's not an error — we only flip to error
  // when there's an active turn to fail. handleProxyExit returns early.
  const ctx = setup();
  try {
    const session = await ctx.sessions.createSession({
      workspace_id: ctx.wsId, executor: 'claude', approval_mode: 'ask',
    });
    await ctx.sessions.sendMessage(session.id, 'kick off');
    // Complete the turn cleanly so activeTurns is empty.
    ctx.proxyMgr.client.fire({
      method: 'turn.completed',
      params: { sessionId: 'proxy_x', data: { status: 'completed' } },
    });
    await tick();

    const sessionMid = ctx.db.prepare('SELECT status FROM sessions WHERE id = ?')
      .get(session.id) as { status: string };
    assert.equal(sessionMid.status, 'done',
      'turn.completed lands the session at done');

    ctx.broadcaster.messages.length = 0;
    ctx.proxyMgr.client.fireExit(0);
    await tick();

    const sessionAfter = ctx.db.prepare('SELECT status FROM sessions WHERE id = ?')
      .get(session.id) as { status: string };
    assert.equal(sessionAfter.status, 'done',
      'idle exit must NOT poison a successfully-finished session\'s status');

    // No turn errored row should appear from the exit path either.
    const turnRows = ctx.db.prepare(`SELECT status FROM turns WHERE session_id = ?`)
      .all(session.id) as Array<{ status: string }>;
    assert.equal(turnRows.length, 1);
    assert.equal(turnRows[0]!.status, 'completed',
      'completed turn stays completed; idle exit must not retroactively error it');
  } finally {
    teardown(ctx);
  }
});

// ---------------------------------------------------------------------------
// ERR-009 — next sendMessage must NOT hit stale proxySessionId cache
// ---------------------------------------------------------------------------

test('ERR-009: after proxy exit, the cached proxySessionId is dropped so the next sendMessage re-adopts', async () => {
  const ctx = setup();
  try {
    const session = await ctx.sessions.createSession({
      workspace_id: ctx.wsId, executor: 'claude', approval_mode: 'ask',
    });
    await ctx.sessions.sendMessage(session.id, 'first');
    // Exit while idle (turn still running but no notification arrived).
    ctx.proxyMgr.client.fireExit(1);
    await tick();

    // sendMessage must succeed by re-doing the proxy bring-up. The fake
    // proxy never breaks, so we mainly check we don't throw `no proxy for
    // session` from a stale cache.
    await ctx.sessions.sendMessage(session.id, 'after restart');

    const turns = ctx.db.prepare(`SELECT COUNT(*) AS c FROM turns WHERE session_id = ?`)
      .get(session.id) as { c: number };
    assert.equal(turns.c, 2,
      'second turn persisted after proxy-exit recovery (no stale cache failure)');
  } finally {
    teardown(ctx);
  }
});

// ---------------------------------------------------------------------------
// ERR-009 — sessionAllowed cache is also wiped (allow_session memo gone)
// ---------------------------------------------------------------------------

test('ERR-009: proxy exit wipes the per-session allow_session memo so the next session starts clean', async () => {
  // The cc normalizer maps Bash tool approvals to category='command'
  // (see mapCcToolNameToCategory). We use that here rather than guessing.
  const ctx = setup();
  try {
    const session = await ctx.sessions.createSession({
      workspace_id: ctx.wsId, executor: 'claude', approval_mode: 'ask',
    });
    await ctx.sessions.sendMessage(session.id, 'work');

    // Raise a pending approval, then approve it with `allow_session`.
    // `resolve` is synchronous in the manager API.
    await raiseApproval(ctx.proxyMgr, 'appr-allow');
    ctx.approvals.resolve('appr-allow', 'allow_session', 'user');
    assert.equal(ctx.approvals.wasAllowedForSession(session.id, 'command'), true,
      'sanity: allow_session memo for category=command was registered before exit');

    ctx.proxyMgr.client.fireExit(1);
    await tick();

    assert.equal(ctx.approvals.wasAllowedForSession(session.id, 'command'), false,
      'allow_session memo must be cleared on proxy exit — a fresh proxy must re-prompt');
  } finally {
    teardown(ctx);
  }
});
