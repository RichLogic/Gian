// Coverage for traceability rows:
//   QUEUE-TTY-001 — Beta queue drains into the PTY on the Stop hook.
//   QUEUE-TTY-002 — send_now pastes immediately in TTY (supplementary message).
//   STOP-TTY-001  — stopTurn interrupts the PTY (Esc), not structured interruptTurn.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session, ServerToClientMessage } from '@gian/shared';
import { openDatabase, type Db } from '../src/storage/db.js';
import { SessionManager } from '../src/session/manager.js';
import type { ProxyManager } from '../src/proxy/manager.js';
import { TtyManager } from '../src/tty/manager.js';
import type { WsBroadcaster } from '../src/web/ws-broadcast.js';
import { ApprovalManager } from '../src/approval/index.js';
import { QueueManager } from '../src/queue/index.js';

class CapturingBroadcaster {
  messages: ServerToClientMessage[] = [];
  add() {} remove() {}
  send() {}
  broadcast(msg: ServerToClientMessage) { this.messages.push(msg); }
  get size() { return 0; }
}

function makeFakeTty() {
  const inputCalls: Array<{ sessionId: string; payload: { data?: string; text?: string } }> = [];
  const interruptCalls: string[] = [];
  const fake = {
    async input(sessionId: string, payload: { data?: string; text?: string }) {
      inputCalls.push({ sessionId, payload });
    },
    async interrupt(sessionId: string) { interruptCalls.push(sessionId); },
    async stop() {},
  } as unknown as TtyManager;
  return { fake, inputCalls, interruptCalls };
}

function seedSession(db: Db, over: Partial<Session> = {}): string {
  const sessionId = over.id ?? 'sess-1';
  db.prepare('INSERT OR IGNORE INTO workspaces (id, name, path) VALUES (?, ?, ?)')
    .run('ws-1', 'test', '/tmp/test-ws');
  const now = '2026-06-01T00:00:00.000Z';
  db.prepare(`
    INSERT INTO sessions (
      id, name, type, workspace_id, executor, model, approval_mode,
      thinking_effort, turns, active_channel, status, archived,
      worktree_path, branch, base_branch, worktree_outcome,
      native_session_id, runtime_mode, created_at, updated_at
    ) VALUES (?, ?, 'coding', 'ws-1', ?, NULL, 'ask', NULL, 1, 'web',
              ?, 0, NULL, NULL, NULL, NULL, 'nat-1', ?, ?, ?)
  `).run(
    sessionId, 'test',
    over.executor ?? 'claude',
    over.status ?? 'running',
    over.runtime_mode ?? 'tty',
    now, now,
  );
  return sessionId;
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'gian-beta-queue-stop-'));
  const db = openDatabase(dir);
  const broadcaster = new CapturingBroadcaster();
  const proxy = { get: (_id: string): unknown => null } as unknown as ProxyManager;
  const queue = new QueueManager(db);
  const approvals = new ApprovalManager();
  const tty = makeFakeTty();
  const sessions = new SessionManager(
    db, proxy, broadcaster as unknown as WsBroadcaster, approvals, queue, dir,
    null, tty.fake, null,
  );
  return { dir, db, sessions, tty, broadcaster };
}

function teardown(ctx: { dir: string; db: Db }) {
  ctx.db.close();
  rmSync(ctx.dir, { recursive: true, force: true });
}

test('QUEUE-TTY-001: drainTtyQueue pastes the next queued message in TTY mode', () => {
  const ctx = setup();
  try {
    const sid = seedSession(ctx.db, { runtime_mode: 'tty', executor: 'claude' });
    ctx.sessions.enqueueMessage(sid, 'first');
    ctx.sessions.enqueueMessage(sid, 'second');
    ctx.sessions.drainTtyQueue(sid);
    assert.deepEqual(ctx.tty.inputCalls, [{ sessionId: sid, payload: { text: 'first' } }]);
    assert.equal(ctx.sessions.getQueueLength(sid), 1);
  } finally {
    teardown(ctx);
  }
});

test('QUEUE-TTY-001: drainTtyQueue no-ops in structured mode', () => {
  const ctx = setup();
  try {
    const sid = seedSession(ctx.db, { runtime_mode: 'structured', executor: 'claude' });
    ctx.sessions.enqueueMessage(sid, 'x');
    ctx.sessions.drainTtyQueue(sid);
    assert.equal(ctx.tty.inputCalls.length, 0);
    assert.equal(ctx.sessions.getQueueLength(sid), 1);
  } finally {
    teardown(ctx);
  }
});

test('QUEUE-TTY-001(e2e): a Stop hook drains one queued message via the wired handler', async () => {
  const ctx = setup();
  try {
    const sid = seedSession(ctx.db, { runtime_mode: 'tty', executor: 'claude' });
    // Wire exactly like app.ts does.
    const realTty = new TtyManager(
      ctx.db,
      { get: () => ({ async ttyInput() {} }) } as unknown as ProxyManager,
      ctx.broadcaster as unknown as WsBroadcaster,
      'http://127.0.0.1:8991',
    );
    ctx.sessions.setTtyManager(realTty);
    realTty.setTurnCompleteHandler(s => ctx.sessions.drainTtyQueue(s));

    ctx.sessions.enqueueMessage(sid, 'queued-1');
    await realTty.handleHook(sid, 'Stop', {});
    assert.equal(ctx.sessions.getQueueLength(sid), 0);
  } finally {
    teardown(ctx);
  }
});

test('QUEUE-TTY-002: send_now pastes head into PTY immediately in TTY mode', async () => {
  const ctx = setup();
  try {
    const sid = seedSession(ctx.db, { runtime_mode: 'tty', executor: 'claude' });
    ctx.sessions.enqueueMessage(sid, 'extra-now');
    await ctx.sessions.sendQueuedNow(sid);
    assert.deepEqual(ctx.tty.inputCalls, [{ sessionId: sid, payload: { text: 'extra-now' } }]);
    assert.equal(ctx.sessions.getQueueLength(sid), 0);
  } finally {
    teardown(ctx);
  }
});

test('STOP-TTY-001: stopTurn in claude TTY mode injects interrupt, not structured interruptTurn', async () => {
  const ctx = setup();
  try {
    const sid = seedSession(ctx.db, { runtime_mode: 'tty', executor: 'claude' });
    await ctx.sessions.stopTurn(sid);
    assert.deepEqual(ctx.tty.interruptCalls, [sid]);
  } finally {
    teardown(ctx);
  }
});

test('STOP-TTY-001: stopTurn in claude TTY mode settles status→done so the web spinner clears', async () => {
  // The Esc interrupt emits no turn.completed; without an explicit settle the
  // beta spinner (driven by `pending`) stayed stuck "running".
  const ctx = setup();
  try {
    const sid = seedSession(ctx.db, { runtime_mode: 'tty', executor: 'claude', status: 'running' });
    await ctx.sessions.stopTurn(sid);
    const updated = ctx.broadcaster.messages.find(
      m => m.type === 'session:updated' && (m as { session: { id: string; status?: string } }).session.id === sid,
    ) as { session: { status?: string } } | undefined;
    assert.ok(updated, 'stopTurn must broadcast session:updated for the TTY session');
    assert.equal(updated!.session.status, 'done');
    const row = ctx.db.prepare('SELECT status FROM sessions WHERE id = ?').get(sid) as { status: string };
    assert.equal(row.status, 'done', 'DB session status must settle to done');
  } finally {
    teardown(ctx);
  }
});
