// Coverage for traceability rows:
//   QUEUE-001  — running turn must queue, not start a concurrent turn.
//   QUEUE-002  — reorder / remove / clear / sendNow / FIFO semantics.
//   INV-009    — per-session queue drain takes priority over job continuation.
//   ERR-005    — startTurn SESSION_BUSY rollback must drop the phantom turn
//                without flipping the still-running session into 'error'.
//
// All scenarios drive a deterministic in-process fake proxy — never the real
// claude / codex binary. Each assertion is concrete: row counts, status
// strings, broadcast message types, queue order.

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
// Deterministic fakes — no real proxy spawn, no I/O outside the tmp DB.
// ---------------------------------------------------------------------------

class FakeProxyClient implements ProxyClient {
  readonly executor = 'claude' as const;
  notificationHandlers: NotificationHandler[] = [];
  /** When set, the NEXT startTurn call rejects with this error. */
  failNextStartTurn: Error | null = null;
  /** Records every startTurn invocation (for FIFO assertions). */
  startTurnCalls: Array<{ input: unknown }> = [];

  async initialize() {
    return { mode: 'spawn' as const, protocolVersion: '0.1.0', methods: [] };
  }
  async capabilities() {
    return { protocolVersion: '0.1.0', models: [], slashCommands: [] };
  }
  async listSlashCommands() {
    return { commands: [] };
  }
  async createSession(params: { cwd: string; claudeSessionId?: string; threadId?: string }) {
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
  async interruptTurn() { /* no-op */ }
  async respondApproval() { /* no-op */ }
  async startTurn(params: unknown) {
    this.startTurnCalls.push({ input: params });
    if (this.failNextStartTurn) {
      const err = this.failNextStartTurn;
      this.failNextStartTurn = null;
      throw err;
    }
    return {
      session: {
        id: 'proxy_x',
        cwd: '/tmp',
        model: null,
        status: 'running' as const,
        createdAt: '2026-05-17T00:00:00.000Z',
        updatedAt: '2026-05-17T00:00:00.000Z',
        lastError: null,
      },
      turn: { id: 'proxy_turn' },
    };
  }
  async closeSession() { /* no-op */ }
  async shutdown() { /* no-op */ }
  forceKill() { /* no-op */ }
  onNotification(handler: NotificationHandler) {
    this.notificationHandlers.push(handler);
    return () => {
      this.notificationHandlers = this.notificationHandlers.filter(h => h !== handler);
    };
  }
  onExit() {
    return () => {};
  }
  fire(notification: ProxyNotification): void {
    for (const h of this.notificationHandlers) h(notification);
  }
}

class FakeProxyManager {
  client = new FakeProxyClient();
  async getOrCreate(): Promise<ProxyClient> {
    return this.client;
  }
  get(): ProxyClient {
    return this.client;
  }
  async closeAll(): Promise<void> { /* no-op */ }
}

class CapturingBroadcaster {
  messages: ServerToClientMessage[] = [];
  add() {}
  remove() {}
  send() {}
  broadcast(msg: ServerToClientMessage): void {
    this.messages.push(msg);
  }
  get size() {
    return 0;
  }
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'gian-queue-test-'));
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

  return { dir, db, wsId, proxyMgr, broadcaster, sessions, queue };
}

function teardown(ctx: { dir: string; db: ReturnType<typeof openDatabase> }) {
  ctx.db.close();
  rmSync(ctx.dir, { recursive: true, force: true });
}

// Wait one microtask tick so fire-and-forget chains in handleLifecycle settle.
async function tick() { await new Promise(r => setTimeout(r, 0)); }

// ---------------------------------------------------------------------------
// QUEUE-001 — concurrent send must enqueue, not start a second turn.
// ---------------------------------------------------------------------------

test('QUEUE-001: sendMessage during an active turn throws and is routed to enqueueMessage', async () => {
  const ctx = setup();
  try {
    const { sessions, proxyMgr, queue } = ctx;
    const session = await sessions.createSession({ workspace_id: ctx.wsId, executor: 'claude' });

    await sessions.sendMessage(session.id, 'first');
    assert.equal(proxyMgr.client.startTurnCalls.length, 1, 'first turn was started');

    // Second send while activeTurns has session.id must reject with a clear
    // message; ws-handler reads this and routes the payload to enqueueMessage.
    await assert.rejects(
      sessions.sendMessage(session.id, 'second'),
      /turn already in flight.*enqueue instead/,
      'second concurrent send must be rejected, not silently start another turn',
    );

    // No second startTurn was issued — the proxy did NOT see a parallel turn.
    assert.equal(proxyMgr.client.startTurnCalls.length, 1,
      'proxy must not see a concurrent startTurn while a prior turn is running');

    // Caller can recover by enqueueing. The queue is the supported "do this next" channel.
    sessions.enqueueMessage(session.id, 'second');
    const list = queue.list(session.id);
    assert.equal(list.length, 1);
    assert.equal(list[0]!.text, 'second');
  } finally {
    teardown(ctx);
  }
});

test('QUEUE-001: queued message is consumed exactly once on turn.completed (serial, FIFO)', async () => {
  const ctx = setup();
  try {
    const { sessions, proxyMgr, queue, broadcaster, db } = ctx;
    const session = await sessions.createSession({ workspace_id: ctx.wsId, executor: 'claude' });

    await sessions.sendMessage(session.id, 'turn-A');
    sessions.enqueueMessage(session.id, 'turn-B');
    sessions.enqueueMessage(session.id, 'turn-C');

    assert.equal(queue.list(session.id).length, 2, 'two messages queued behind active turn');
    assert.equal(proxyMgr.client.startTurnCalls.length, 1, 'only the first send hit the proxy');

    // Complete turn A. handleLifecycle → maybeAutoSendNext pops head ("turn-B").
    proxyMgr.client.fire({
      method: 'turn.completed',
      params: { sessionId: 'proxy_x', data: { status: 'completed' } },
    });
    await tick();

    assert.equal(proxyMgr.client.startTurnCalls.length, 2,
      'queue drain on turn.completed must trigger exactly one new startTurn');
    assert.equal(queue.list(session.id).length, 1, 'one message remains queued (turn-C)');

    // Complete turn B → turn-C drains next.
    proxyMgr.client.fire({
      method: 'turn.completed',
      params: { sessionId: 'proxy_x', data: { status: 'completed' } },
    });
    await tick();
    assert.equal(proxyMgr.client.startTurnCalls.length, 3, 'turn-C drained on second completion');
    assert.equal(queue.list(session.id).length, 0, 'queue empty after all drained');

    // FIFO order: persisted user_message texts in chronological order match send order.
    const msgs = db
      .prepare("SELECT data FROM events WHERE session_id = ? AND type = 'user_message' ORDER BY rowid")
      .all(session.id) as Array<{ data: string }>;
    const texts = msgs.map(m => JSON.parse(m.data).text);
    assert.deepEqual(texts, ['turn-A', 'turn-B', 'turn-C'],
      'persisted user_message events must reflect FIFO send order');

    // A queue:updated broadcast fired on every mutation (add x2 + pop x2).
    const queueBroadcasts = broadcaster.messages.filter(m => m.type === 'queue:updated');
    assert.ok(queueBroadcasts.length >= 4, `at least 4 queue:updated broadcasts (got ${queueBroadcasts.length})`);
  } finally {
    teardown(ctx);
  }
});

// ---------------------------------------------------------------------------
// QUEUE-002 — reorder / remove / clear / sendNow.
// ---------------------------------------------------------------------------

// queue_entries.session_id is a FK to sessions(id) (migration 020). The
// QUEUE-002 unit tests need a real session row to insert against; build one
// via SessionManager.createSession so the FK is satisfied and we still skip
// any turn machinery.
async function makeSessionId(ctx: ReturnType<typeof setup>): Promise<string> {
  const s = await ctx.sessions.createSession({ workspace_id: ctx.wsId, executor: 'claude' });
  return s.id;
}

test('QUEUE-002: QueueManager assigns monotonically increasing sort_order and list returns FIFO', async () => {
  const ctx = setup();
  try {
    const { queue } = ctx;
    const sid = await makeSessionId(ctx);
    const a = queue.add(sid, 'A');
    const b = queue.add(sid, 'B');
    const c = queue.add(sid, 'C');

    const list = queue.list(sid);
    assert.deepEqual(list.map(e => e.text), ['A', 'B', 'C'], 'insertion order preserved');
    assert.equal(list[0]!.id, a.id);
    assert.equal(list[1]!.id, b.id);
    assert.equal(list[2]!.id, c.id);
  } finally {
    teardown(ctx);
  }
});

test('QUEUE-002: reorder swaps positions but keeps ids; popNext follows the new order', async () => {
  const ctx = setup();
  try {
    const { queue } = ctx;
    const sid = await makeSessionId(ctx);
    const a = queue.add(sid, 'A');
    const b = queue.add(sid, 'B');
    const c = queue.add(sid, 'C');

    queue.reorder(sid, [c.id, a.id, b.id]);
    const reordered = queue.list(sid).map(e => e.text);
    assert.deepEqual(reordered, ['C', 'A', 'B']);

    const popped1 = queue.popNext(sid);
    assert.equal(popped1?.text, 'C', 'pop returns new head after reorder');
    const popped2 = queue.popNext(sid);
    assert.equal(popped2?.text, 'A');

    // New add must tail the queue, not jump in front of leftover B.
    queue.add(sid, 'D');
    assert.deepEqual(queue.list(sid).map(e => e.text), ['B', 'D']);
  } finally {
    teardown(ctx);
  }
});

test('QUEUE-002: remove deletes a single entry; clear wipes all; sendNow drains and returns FIFO', async () => {
  const ctx = setup();
  try {
    const { queue } = ctx;
    const sid = await makeSessionId(ctx);
    const a = queue.add(sid, 'A');
    queue.add(sid, 'B');
    const c = queue.add(sid, 'C');

    queue.remove(sid, a.id);
    assert.deepEqual(queue.list(sid).map(e => e.text), ['B', 'C']);

    queue.add(sid, 'D');
    const drained = queue.sendNow(sid);
    assert.deepEqual(drained.map(e => e.text), ['B', 'C', 'D'],
      'sendNow drains every queued entry in FIFO order');
    assert.equal(queue.list(sid).length, 0, 'queue empty after sendNow');

    // clear() is a no-op on an empty queue (no throw, no rows).
    queue.add(sid, 'E');
    queue.clear(sid);
    assert.equal(queue.list(sid).length, 0);

    // Removed id reference is safe.
    queue.remove(sid, c.id); // already gone
    assert.equal(queue.list(sid).length, 0);
  } finally {
    teardown(ctx);
  }
});

test('QUEUE-002: per-session isolation — adding to session B does not leak into session A', async () => {
  const ctx = setup();
  try {
    const { queue } = ctx;
    const sidA = await makeSessionId(ctx);
    const sidB = await makeSessionId(ctx);
    queue.add(sidA, 'a1');
    queue.add(sidA, 'a2');
    queue.add(sidB, 'b1');

    assert.deepEqual(queue.list(sidA).map(e => e.text), ['a1', 'a2']);
    assert.deepEqual(queue.list(sidB).map(e => e.text), ['b1']);

    queue.clear(sidA);
    assert.equal(queue.list(sidA).length, 0);
    assert.equal(queue.list(sidB).length, 1, 'clearing session A must not touch session B');
  } finally {
    teardown(ctx);
  }
});

// ---------------------------------------------------------------------------
// INV-009 — Queue drain takes priority over Job continuation.
// ---------------------------------------------------------------------------

test('INV-009: queue drain takes priority over Job auto-continue on turn.completed', async () => {
  const ctx = setup();
  try {
    const { sessions, proxyMgr, queue } = ctx;
    const session = await sessions.createSession({ workspace_id: ctx.wsId, executor: 'claude' });

    // Switch into Job Mode (auto + turns>1). First sendMessage initializes a Job.
    sessions.setApprovalMode(session.id, 'auto', 5);

    await sessions.sendMessage(session.id, 'kick off job');
    assert.equal(proxyMgr.client.startTurnCalls.length, 1);

    // User adds a queued message mid-turn — must beat job's "continue".
    sessions.enqueueMessage(session.id, 'user-priority');

    proxyMgr.client.fire({
      method: 'turn.completed',
      params: { sessionId: 'proxy_x', data: { status: 'completed' } },
    });
    await tick();

    // Exactly ONE new turn was started (queue drain), not two (queue + job).
    assert.equal(proxyMgr.client.startTurnCalls.length, 2,
      'queue drain must fire instead of job continue, not both');
    assert.equal(queue.list(session.id).length, 0, 'queued entry consumed');

    // Verify the proxy received the queued text, not the literal "continue".
    const lastCall = proxyMgr.client.startTurnCalls[1]!;
    const lastInput = (lastCall.input as { input: Array<{ type: string; text: string }> }).input;
    const textItem = lastInput.find(i => i.type === 'text');
    assert.ok(textItem, 'last startTurn carried a text input item');
    assert.equal(textItem!.text, 'user-priority',
      'queued user text wins over job-generated "continue" payload');
  } finally {
    teardown(ctx);
  }
});

test('INV-009: with empty queue, Job auto-continues after turn.completed (sanity for priority test)', async () => {
  const ctx = setup();
  try {
    const { sessions, proxyMgr } = ctx;
    const session = await sessions.createSession({ workspace_id: ctx.wsId, executor: 'claude' });
    sessions.setApprovalMode(session.id, 'auto', 3);

    await sessions.sendMessage(session.id, 'go');
    proxyMgr.client.fire({
      method: 'turn.completed',
      params: { sessionId: 'proxy_x', data: { status: 'completed' } },
    });
    await tick();

    assert.equal(proxyMgr.client.startTurnCalls.length, 2,
      'job continuation fires when nothing is queued');
    const lastInput = (proxyMgr.client.startTurnCalls[1]!.input as { input: Array<{ type: string; text: string }> }).input;
    assert.equal(lastInput[0]!.text, 'continue',
      'job-driven continuation sends literal "continue" payload');
  } finally {
    teardown(ctx);
  }
});

// ---------------------------------------------------------------------------
// ERR-005 — startTurn SESSION_BUSY rollback.
// ---------------------------------------------------------------------------

test('ERR-005: SESSION_BUSY from proxy rolls back the phantom turn without flipping session to error', async () => {
  const ctx = setup();
  try {
    const { sessions, proxyMgr, db } = ctx;
    const session = await sessions.createSession({ workspace_id: ctx.wsId, executor: 'claude' });

    // Make the next startTurn reject with SESSION_BUSY (the cc-proxy error
    // code from proxies/cc-proxy/src/core/service.ts:207).
    proxyMgr.client.failNextStartTurn = new Error('[SESSION_BUSY] This session already has an active turn.');

    await assert.rejects(
      sessions.sendMessage(session.id, 'attempt during busy'),
      /SESSION_BUSY/,
      'sendMessage must surface the SESSION_BUSY error to the caller',
    );

    // Phantom turn row + its user_message event were rolled back.
    const turnCount = (db.prepare('SELECT COUNT(*) AS c FROM turns WHERE session_id = ?')
      .get(session.id) as { c: number }).c;
    assert.equal(turnCount, 0, 'phantom running turn deleted on SESSION_BUSY');

    const userMsgCount = (db
      .prepare("SELECT COUNT(*) AS c FROM events WHERE session_id = ? AND type = 'user_message'")
      .get(session.id) as { c: number }).c;
    assert.equal(userMsgCount, 0,
      'optimistic user_message also rolled back so the UI does not display a phantom send');

    // Critically: session.status stays 'running' — the *real* prior turn on the
    // proxy is still alive; the SESSION_BUSY path must NOT mark it as errored.
    const sessionRow = db.prepare('SELECT status FROM sessions WHERE id = ?').get(session.id) as { status: string };
    assert.equal(sessionRow.status, 'running',
      'session.status preserved as running — SESSION_BUSY must not poison the live session');
  } finally {
    teardown(ctx);
  }
});

test('ERR-005: non-busy startTurn failure rolls back AND marks the turn as error', async () => {
  const ctx = setup();
  try {
    const { sessions, proxyMgr, db } = ctx;
    const session = await sessions.createSession({ workspace_id: ctx.wsId, executor: 'claude' });

    proxyMgr.client.failNextStartTurn = new Error('proxy crashed mid-startTurn');

    await assert.rejects(
      sessions.sendMessage(session.id, 'doomed send'),
      /proxy crashed/,
    );

    // For non-busy errors, completeTurn('error') flips status to 'error' (no rollback);
    // the optimistic turn row stays so the failure is auditable.
    const turn = db.prepare('SELECT status FROM turns WHERE session_id = ?').get(session.id) as
      | { status: string } | undefined;
    assert.ok(turn, 'turn row preserved for audit on non-busy failure');
    assert.equal(turn!.status, 'error',
      'non-busy startTurn rejection must mark the turn as error');

    const sessionRow = db.prepare('SELECT status FROM sessions WHERE id = ?').get(session.id) as { status: string };
    assert.equal(sessionRow.status, 'error',
      'session.status flipped to error on real startTurn failure (not SESSION_BUSY)');
  } finally {
    teardown(ctx);
  }
});
