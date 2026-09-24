import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateCanonicalId, type RemoteExecutionTarget } from '@gian/remote-protocol';
import { openDatabase } from '../src/storage/db.js';
import { RemoteExecutionBindings } from '../src/remote/execution-bindings.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'gian-execution-binding-'));
  const db = openDatabase(dir);
  const store = new RemoteExecutionBindings(db, () => 1000);
  const taskId = generateCanonicalId();
  db.prepare('INSERT INTO tasks (id, name) VALUES (?, ?)').run(taskId, 'Local Task');
  function session(task: string | null = taskId) {
    const id = generateCanonicalId();
    db.prepare('INSERT INTO sessions (id, executor, native_session_id, task_id) VALUES (?, ?, ?, ?)')
      .run(id, 'codex', generateCanonicalId(), task);
    return id;
  }
  return {
    dir, db, store, taskId, session,
    close() { if (db.open) db.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

function target(overrides: Partial<RemoteExecutionTarget> = {}): RemoteExecutionTarget {
  return {
    server_origin: 'https://remote.example', server_identity_fingerprint: 'a'.repeat(64),
    account_id: '42', host_id: generateCanonicalId(), remote_session_id: generateCanonicalId(),
    ...overrides,
  };
}

test('binding remote execution preserves local Task membership and is idempotent', () => {
  const f = fixture();
  try {
    const localId = f.session();
    const input = { local_session_id: localId, target: target() };
    const bound = f.store.bind(input);
    assert.deepEqual(f.store.bind(input), bound);
    assert.equal(bound.revision, 1);
    assert.deepEqual(f.db.prepare('SELECT task_id FROM sessions WHERE id = ?').get(localId), { task_id: f.taskId });
    assert.equal((f.db.prepare('SELECT COUNT(*) AS count FROM tasks').get() as { count: number }).count, 1);
    assert.throws(() => f.store.bind({ local_session_id: generateCanonicalId(), target: target() }), /local session not found/);
  } finally { f.close(); }
});

test('one local Task supports independent local and multiple remote execution Sessions', () => {
  const f = fixture();
  try {
    const local = f.session();
    const a = f.store.bind({ local_session_id: f.session(), target: target() });
    const b = f.store.bind({ local_session_id: f.session(), target: target() });
    assert.equal(f.store.get(local), null);
    assert.notEqual(a.target.host_id, b.target.host_id);
    assert.equal((f.db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE task_id = ?')
      .get(f.taskId) as { count: number }).count, 3);
  } finally { f.close(); }
});

test('an already-used local Session cannot silently become a remote execution', () => {
  const f = fixture();
  try {
    const localId = f.session();
    f.db.prepare("UPDATE sessions SET status = 'running' WHERE id = ?").run(localId);
    assert.throws(() => f.store.bind({ local_session_id: localId, target: target() }), /already executed/);
    const historical = f.session();
    f.db.prepare('INSERT INTO turns (id, session_id, turn_number, status) VALUES (?, ?, ?, ?)')
      .run(generateCanonicalId(), historical, 1, 'done');
    assert.throws(() => f.store.bind({ local_session_id: historical, target: target() }), /already executed/);
    const bound = f.store.bind({ local_session_id: f.session(), target: target() });
    f.db.prepare("UPDATE sessions SET status = 'done' WHERE id = ?").run(bound.local_session_id);
    assert.throws(() => f.store.retarget(bound.local_session_id, 1, target()), /already executed/);
  } finally { f.close(); }
});

test('takeover reuses a local mapping but never copies another controller Task relation', () => {
  const a = fixture();
  const b = fixture();
  try {
    const remote = target();
    const boundA = a.store.bind({ local_session_id: a.session(), target: remote });
    const localB = b.session(null);
    const boundB = b.store.bind({ local_session_id: localB, target: remote });
    assert.deepEqual(boundA.target, boundB.target);
    assert.notEqual(boundA.local_session_id, boundB.local_session_id);
    assert.deepEqual(b.db.prepare('SELECT task_id FROM sessions WHERE id = ?').get(localB), { task_id: null });
    assert.equal(b.store.find(remote)?.local_session_id, localB);
    assert.throws(() => b.store.bind({ local_session_id: b.session(), target: remote }), /already has a local session/);
  } finally { a.close(); b.close(); }
});

test('retarget is revision-fenced and freezes before any uncertain remote send', () => {
  const f = fixture();
  try {
    const original = f.store.bind({ local_session_id: f.session(), target: target() });
    const next = f.store.retarget(original.local_session_id, original.revision, target());
    assert.equal(next.revision, 2);
    assert.throws(() => f.store.assertCurrent(original), /binding changed/);
    assert.throws(() => f.store.retarget(next.local_session_id, 1, target()), /binding changed/);
    const started = f.store.markStarted(next.local_session_id, 2);
    assert.equal(started.execution_started_at, 1000);
    assert.deepEqual(f.store.markStarted(next.local_session_id, 2), started);
    assert.deepEqual(f.store.retarget(next.local_session_id, 2, next.target), started);
    assert.throws(() => f.store.retarget(next.local_session_id, 2, target()), /already fixed/);
    assert.throws(() => f.store.bind({ local_session_id: next.local_session_id, target: original.target }), /binding changed/);
  } finally { f.close(); }
});

test('binding survives restart, Server identity is pinned, and local deletion only removes the mapping', () => {
  const f = fixture();
  try {
    const bound = f.store.bind({ local_session_id: f.session(), target: target() });
    f.store.markStarted(bound.local_session_id, bound.revision);
    f.db.close();
    const db = openDatabase(f.dir);
    try {
      const store = new RemoteExecutionBindings(db);
      assert.equal(store.get(bound.local_session_id)?.execution_started_at, 1000);
      assert.equal(store.find({ ...bound.target, server_identity_fingerprint: 'b'.repeat(64) }), null);
      db.prepare('DELETE FROM sessions WHERE id = ?').run(bound.local_session_id);
      assert.equal(store.get(bound.local_session_id), null);
      assert.equal((db.prepare('SELECT COUNT(*) AS count FROM tasks').get() as { count: number }).count, 1);
    } finally { db.close(); }
  } finally { f.close(); }
});
