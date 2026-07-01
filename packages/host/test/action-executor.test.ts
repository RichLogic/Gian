// Coverage for traceability row:
//   ACTION-EXEC-001 — executor dedup / authorize / execute / stage / confirm /
//                     reject over the real task_actions + task_loops tables.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GianAction, Session } from '@gian/shared';
import { openDatabase, type Db } from '../src/storage/db.js';
import { ActionExecutor, type ActionExecutorDeps } from '../src/task/action-executor.js';
import { insertLoop, getActiveLoop } from '../src/task/task-store.js';
import { computeActionId, computePayloadHash } from '../src/task/action-parser.js';

const CREATE: GianAction = { method: 'create_subtask', params: { workspace: 'repoA', executor: 'claude', brief: 'do X' } };
const SUBMIT: GianAction = { method: 'submit_step', params: { status: 'done', headline: 'ok', verdict: 'pass' } };

interface Fixture {
  db: Db;
  ex: ActionExecutor;
  mgr: Session;
  eng: Session;
  calls: {
    createSubtask: unknown[];
    messageSubtask: unknown[];
    writeStepSummary: unknown[];
    onStepSubmitted: unknown[];
  };
  dispose(): void;
}

function insertSession(db: Db, id: string, type: string): Session {
  db.prepare(
    `INSERT INTO sessions(id,name,type,task_id,workspace_id,executor,approval_mode,turns,status,archived,unread,native_session_id,runtime_mode,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`,
  ).run(id, null, type, 't1', 'w1', 'claude', 'plan', 0, 'new', 0, 0, `nat-${id}`, 'structured');
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Session;
}

function setup(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'gian-exec-'));
  const db = openDatabase(dir);
  db.exec("INSERT INTO tasks(id,name,status,created_at,updated_at) VALUES('t1','T','open',datetime('now'),datetime('now'))");
  db.exec("INSERT INTO workspaces(id,name,path,sort_order,hidden,created_at,updated_at) VALUES('w1','repoA','/tmp/repoA',0,0,datetime('now'),datetime('now'))");
  const mgr = insertSession(db, 'm1', 'manager');
  const eng = insertSession(db, 'e1', 'subtask');
  const calls = { createSubtask: [] as unknown[], messageSubtask: [] as unknown[], writeStepSummary: [] as unknown[], onStepSubmitted: [] as unknown[] };
  const deps: ActionExecutorDeps = {
    resolveWorkspaceId: n => (n === 'repoA' || n === '/tmp/repoA' ? 'w1' : null),
    // Insert a REAL session row so the loop's current_step_session_id FK holds
    // (mirrors production, where createSubtask spawns a real subtask session).
    createSubtask: async i => {
      calls.createSubtask.push(i);
      const id = `sub-${calls.createSubtask.length}`;
      insertSession(db, id, 'subtask');
      return id;
    },
    messageSubtask: async i => { calls.messageSubtask.push(i); return 'delivered'; },
    writeStepSummary: i => { calls.writeStepSummary.push(i); },
    onStepSubmitted: async i => { calls.onStepSubmitted.push(i); },
  };
  const ex = new ActionExecutor(db, deps);
  return { db, ex, mgr, eng, calls, dispose: () => { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('ACTION-EXEC-001: create_subtask from PM with no loop → staged (not executed)', async () => {
  const f = setup();
  try {
    const r = await f.ex.handle({ session: f.mgr, action: CREATE, blockText: 'B1', hostTurnId: 'ta', sourceTurnKey: 'ta' });
    assert.equal(r?.status, 'staged');
    assert.equal(f.calls.createSubtask.length, 0);
  } finally { f.dispose(); }
});

test('ACTION-EXEC-001: create_subtask from PM inside an active loop → executed + dedup', async () => {
  const f = setup();
  try {
    insertLoop(f.db, { id: 'l1', task_id: 't1', max_rounds: 3 });
    const r = await f.ex.handle({ session: f.mgr, action: CREATE, blockText: 'B2', hostTurnId: 'tb', sourceTurnKey: 'tb' });
    assert.equal(r?.status, 'done');
    assert.deepEqual(JSON.parse(r!.result!), { subtask_id: 'sub-1' });
    assert.equal(f.calls.createSubtask.length, 1);
    // Same turn re-parsed → deduped, not re-run.
    const again = await f.ex.handle({ session: f.mgr, action: CREATE, blockText: 'B2', hostTurnId: 'tb', sourceTurnKey: 'tb' });
    assert.equal(again?.action_id, r?.action_id);
    assert.equal(f.calls.createSubtask.length, 1);
    // The active loop's current step now points at the new engineer (anti-spoof).
    assert.equal(getActiveLoop(f.db, 't1')?.current_step_session_id, 'sub-1');
  } finally { f.dispose(); }
});

test('ACTION-EXEC-001: an interrupted "executing" action → failed (not silently re-run)', async () => {
  const f = setup();
  try {
    // Simulate a crash mid-execution: a row stuck at 'executing'.
    const actionId = computeActionId('m1', 'tz', computePayloadHash('BZ'));
    f.db.prepare(
      `INSERT INTO task_actions(action_id,task_id,session_id,host_turn_id,source_turn_key,method,payload_hash,payload,status)
       VALUES(?, 't1','m1','tz','tz','create_subtask',?, ?, 'executing')`,
    ).run(actionId, computePayloadHash('BZ'), JSON.stringify(CREATE));
    const r = await f.ex.handle({ session: f.mgr, action: CREATE, blockText: 'BZ', hostTurnId: 'tz', sourceTurnKey: 'tz' });
    assert.equal(r?.status, 'failed');
    assert.equal(f.calls.createSubtask.length, 0); // never double-created
  } finally { f.dispose(); }
});

test('ACTION-EXEC-001: recordParsed is synchronous + resume() re-drives it (durability)', async () => {
  const f = setup();
  try {
    insertLoop(f.db, { id: 'l1', task_id: 't1', max_rounds: 3 });
    // Simulate a crash between record and drive: record synchronously, stop.
    const rec = f.ex.recordParsed({ session: f.mgr, action: CREATE, blockText: 'BR', hostTurnId: 'tr', sourceTurnKey: 'tr' });
    assert.equal(rec?.status, 'parsed'); // row exists before any side effect
    assert.equal(f.calls.createSubtask.length, 0); // not executed yet
    // A startup scan re-drives it to completion.
    const done = await f.ex.resume(rec!.action_id, f.mgr);
    assert.equal(done?.status, 'done');
    assert.equal(f.calls.createSubtask.length, 1);
  } finally { f.dispose(); }
});

test('ACTION-EXEC-001: an interrupted "authorized" action re-drives to completion', async () => {
  const f = setup();
  try {
    insertLoop(f.db, { id: 'l1', task_id: 't1', max_rounds: 3 });
    const actionId = computeActionId('m1', 'ty', computePayloadHash('BY'));
    f.db.prepare(
      `INSERT INTO task_actions(action_id,task_id,session_id,host_turn_id,source_turn_key,method,payload_hash,payload,status)
       VALUES(?, 't1','m1','ty','ty','create_subtask',?, ?, 'authorized')`,
    ).run(actionId, computePayloadHash('BY'), JSON.stringify(CREATE));
    const r = await f.ex.handle({ session: f.mgr, action: CREATE, blockText: 'BY', hostTurnId: 'ty', sourceTurnKey: 'ty' });
    assert.equal(r?.status, 'done'); // re-driven past the interrupted point
    assert.equal(f.calls.createSubtask.length, 1);
  } finally { f.dispose(); }
});

test('ACTION-EXEC-001: create_subtask from an engineer → rejected (role gate)', async () => {
  const f = setup();
  try {
    const r = await f.ex.handle({ session: f.eng, action: CREATE, blockText: 'B3', hostTurnId: 'tc', sourceTurnKey: 'tc' });
    assert.equal(r?.status, 'rejected');
    assert.equal(f.calls.createSubtask.length, 0);
  } finally { f.dispose(); }
});

test('ACTION-EXEC-001: submit_step from an engineer → executed (summary + wake)', async () => {
  const f = setup();
  try {
    const r = await f.ex.handle({ session: f.eng, action: SUBMIT, blockText: 'B4', hostTurnId: 'td', sourceTurnKey: 'td' });
    assert.equal(r?.status, 'done');
    assert.equal(f.calls.writeStepSummary.length, 1);
    assert.equal(f.calls.onStepSubmitted.length, 1);
  } finally { f.dispose(); }
});

test('ACTION-EXEC-001: confirmStaged executes a staged action', async () => {
  const f = setup();
  try {
    const staged = await f.ex.handle({ session: f.mgr, action: CREATE, blockText: 'B5', hostTurnId: 'te', sourceTurnKey: 'te' });
    assert.equal(staged?.status, 'staged');
    const done = await f.ex.confirmStaged(staged!.action_id, f.mgr);
    assert.equal(done?.status, 'done');
    assert.equal(f.calls.createSubtask.length, 1);
  } finally { f.dispose(); }
});

test('ACTION-EXEC-001: rejectStaged rejects without executing', async () => {
  const f = setup();
  try {
    const staged = await f.ex.handle({ session: f.mgr, action: CREATE, blockText: 'B6', hostTurnId: 'tf', sourceTurnKey: 'tf' });
    const rejected = f.ex.rejectStaged(staged!.action_id);
    assert.equal(rejected?.status, 'rejected');
    assert.equal(f.calls.createSubtask.length, 0);
  } finally { f.dispose(); }
});
