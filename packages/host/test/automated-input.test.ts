// Coverage for traceability row:
//   TTY-AUTO-001 — host-owned TTY automation channel: paste when idle, queue
//                  when busy / pending-question, unsupported off-TTY.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session, ServerToClientMessage } from '@gian/shared';
import { openDatabase, type Db } from '../src/storage/db.js';
import { SessionManager } from '../src/session/manager.js';
import type { ProxyManager } from '../src/proxy/manager.js';
import type { TtyManager } from '../src/tty/manager.js';
import type { WsBroadcaster } from '../src/web/ws-broadcast.js';
import { ApprovalManager } from '../src/approval/index.js';
import { QueueManager } from '../src/queue/index.js';

class Bcast {
  add() {} remove() {} send() {} broadcast(_m: ServerToClientMessage) {}
  get size() { return 0; }
}

function makeTty() {
  const inputCalls: Array<{ sessionId: string; payload: { text?: string } }> = [];
  let pending = false;
  const fake = {
    async input(sessionId: string, payload: { text?: string }) { inputCalls.push({ sessionId, payload }); },
    hasPendingQuestion() { return pending; },
    async stop() {},
  } as unknown as TtyManager;
  return { fake, inputCalls, setPending: (v: boolean) => { pending = v; } };
}

function seed(db: Db, over: Partial<Session>): string {
  const id = over.id ?? 's1';
  db.prepare('INSERT OR IGNORE INTO workspaces (id, name, path) VALUES (?,?,?)').run('ws1', 'test', '/tmp/ws');
  const now = '2026-07-01T00:00:00.000Z';
  db.prepare(`INSERT INTO sessions (id,name,type,workspace_id,executor,model,approval_mode,thinking_effort,turns,active_channel,status,archived,worktree_path,branch,base_branch,worktree_outcome,native_session_id,runtime_mode,created_at,updated_at)
    VALUES (?, 'test','coding','ws1',?,NULL,'ask',NULL,1,'web',?,0,NULL,NULL,NULL,NULL,?,?,?,?)`)
    .run(id, over.executor ?? 'claude', over.status ?? 'done', `nat-${id}`, over.runtime_mode ?? 'tty', now, now);
  return id;
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'gian-autoinput-'));
  const db = openDatabase(dir);
  const queue = new QueueManager(db);
  const tty = makeTty();
  const sessions = new SessionManager(
    db, { get: () => null } as unknown as ProxyManager, new Bcast() as unknown as WsBroadcaster,
    new ApprovalManager(), queue, dir, null, tty.fake, null,
  );
  return { dir, db, sessions, tty, dispose: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('TTY-AUTO-001: idle Claude TTY → pasted immediately (delivered)', async () => {
  const f = setup();
  try {
    const sid = seed(f.db, { status: 'done', runtime_mode: 'tty', executor: 'claude' });
    const outcome = await f.sessions.automatedInput(sid, 'go do X', { reason: 'brief' });
    assert.equal(outcome, 'delivered');
    assert.deepEqual(f.tty.inputCalls, [{ sessionId: sid, payload: { text: 'go do X' } }]);
    assert.equal(f.sessions.getQueueLength(sid), 0);
  } finally { f.dispose(); }
});

test('TTY-AUTO-001: busy (running) → queued, not pasted', async () => {
  const f = setup();
  try {
    const sid = seed(f.db, { status: 'running', runtime_mode: 'tty', executor: 'claude' });
    const outcome = await f.sessions.automatedInput(sid, 'later', { reason: 'brief' });
    assert.equal(outcome, 'queued');
    assert.equal(f.tty.inputCalls.length, 0);
    assert.equal(f.sessions.getQueueLength(sid), 1);
  } finally { f.dispose(); }
});

test('TTY-AUTO-001: pending question → queued, not pasted', async () => {
  const f = setup();
  try {
    const sid = seed(f.db, { status: 'done', runtime_mode: 'tty', executor: 'claude' });
    f.tty.setPending(true);
    const outcome = await f.sessions.automatedInput(sid, 'x', { reason: 'brief' });
    assert.equal(outcome, 'queued');
    assert.equal(f.tty.inputCalls.length, 0);
    assert.equal(f.sessions.getQueueLength(sid), 1);
  } finally { f.dispose(); }
});

test('TTY-AUTO-001: idle but with a backlog → queued, does NOT jump the FIFO queue', async () => {
  const f = setup();
  try {
    const sid = seed(f.db, { status: 'done', runtime_mode: 'tty', executor: 'claude' });
    f.sessions.enqueueMessage(sid, 'older'); // pre-existing backlog
    const outcome = await f.sessions.automatedInput(sid, 'mine', { reason: 'brief' });
    assert.equal(outcome, 'queued');
    assert.equal(f.tty.inputCalls.length, 0); // did NOT paste the old head as "mine"
    assert.equal(f.sessions.getQueueLength(sid), 2); // both preserved in order
  } finally { f.dispose(); }
});

test('TTY-AUTO-001: structured session → unsupported (no paste, no queue)', async () => {
  const f = setup();
  try {
    const sid = seed(f.db, { status: 'done', runtime_mode: 'structured', executor: 'claude' });
    const outcome = await f.sessions.automatedInput(sid, 'x', { reason: 'brief' });
    assert.equal(outcome, 'unsupported');
    assert.equal(f.tty.inputCalls.length, 0);
    assert.equal(f.sessions.getQueueLength(sid), 0);
  } finally { f.dispose(); }
});

// High 3: TTY Stop-hook final text is parsed for a trailing gian:action.
test('TTY-AUTO-001: handleTtyTurnComplete parses a submit_step from TTY final text', async () => {
  const prev = process.env.GIAN_TASK_ROLES;
  process.env.GIAN_TASK_ROLES = '1';
  const f = setup();
  try {
    f.db.exec("INSERT INTO tasks(id,name,status,created_at,updated_at) VALUES('t1','T','open',datetime('now'),datetime('now'))");
    const sid = seed(f.db, { id: 'eng1', status: 'done', runtime_mode: 'tty', executor: 'claude' });
    f.db.prepare("UPDATE sessions SET type='subtask', task_id='t1' WHERE id=?").run(sid);
    const finalText =
      'All done.\n\n<<gian:action>>' +
      JSON.stringify({ method: 'submit_step', params: { status: 'done', headline: 'shipped', verdict: 'pass' } }) +
      '<</gian:action>>';
    f.sessions.handleTtyTurnComplete(sid, finalText);
    await new Promise(r => setImmediate(r)); // flush the fire-and-forget processing
    const action = f.db.prepare('SELECT method,status FROM task_actions WHERE session_id=?').get(sid) as { method: string; status: string } | undefined;
    assert.equal(action?.method, 'submit_step');
    assert.equal(action?.status, 'done');
    const summary = (f.db.prepare('SELECT summary FROM sessions WHERE id=?').get(sid) as { summary: string | null }).summary;
    assert.match(summary ?? '', /shipped/);
  } finally {
    f.dispose();
    if (prev === undefined) delete process.env.GIAN_TASK_ROLES;
    else process.env.GIAN_TASK_ROLES = prev;
  }
});

// High 1: the per-turn key is a stable ordinal, so two turns with IDENTICAL
// final text still execute as distinct actions; a re-fired Stop (same key) dedups.
test('TTY-AUTO-001: identical TTY final text across turns → distinct actions; same turnKey dedups', async () => {
  const prev = process.env.GIAN_TASK_ROLES;
  process.env.GIAN_TASK_ROLES = '1';
  const f = setup();
  const flush = () => new Promise(r => setImmediate(r));
  try {
    f.db.exec("INSERT INTO tasks(id,name,status,created_at,updated_at) VALUES('t1','T','open',datetime('now'),datetime('now'))");
    const sid = seed(f.db, { id: 'eng1', status: 'done', runtime_mode: 'tty', executor: 'claude' });
    f.db.prepare("UPDATE sessions SET type='subtask', task_id='t1' WHERE id=?").run(sid);
    const finalText =
      'done\n\n<<gian:action>>' +
      JSON.stringify({ method: 'submit_step', params: { status: 'done', headline: 'shipped', verdict: 'pass' } }) +
      '<</gian:action>>';
    const count = () => (f.db.prepare('SELECT COUNT(*) n FROM task_actions WHERE session_id=?').get(sid) as { n: number }).n;

    f.sessions.handleTtyTurnComplete(sid, finalText, `${sid}:1`);
    await flush();
    f.sessions.handleTtyTurnComplete(sid, finalText, `${sid}:2`);
    await flush();
    assert.equal(count(), 2); // two distinct turns → two actions despite identical text

    f.sessions.handleTtyTurnComplete(sid, finalText, `${sid}:2`); // re-fired Stop, same key
    await flush();
    assert.equal(count(), 2); // deduped
  } finally {
    f.dispose();
    if (prev === undefined) delete process.env.GIAN_TASK_ROLES;
    else process.env.GIAN_TASK_ROLES = prev;
  }
});
