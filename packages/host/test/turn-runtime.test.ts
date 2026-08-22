import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { SessionHistoryStore } from '../src/session/history-store.js';
import { TurnRuntime } from '../src/session/turn-runtime.js';
import { openDatabase } from '../src/storage/db.js';

function tempRuntime() {
  const dir = mkdtempSync(join(tmpdir(), 'gian-turn-runtime-'));
  const db = openDatabase(dir);
  db.prepare(
    `INSERT INTO workspaces (id, name, path) VALUES ('ws', 'ws', '/tmp/ws')`,
  ).run();
  db.prepare(
    `INSERT INTO sessions (id, workspace_id, executor, native_session_id, created_at, updated_at)
     VALUES ('s1', 'ws', 'claude', 'native-1', '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z')`,
  ).run();
  const history = new SessionHistoryStore(db);
  const runtime = new TurnRuntime(db, history);
  return {
    runtime,
    close() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('bindProviderTurn rejects settled ids unless the start response is authoritative', () => {
  const ctx = tempRuntime();
  try {
    const first = ctx.runtime.start('s1', 't1', '2026-08-20T00:00:00.000Z');
    assert.equal(ctx.runtime.bindProviderTurn('s1', first.id, 'p1'), true);
    assert.equal(ctx.runtime.bindProviderTurn('s1', 'other', 'p2'), false);
    assert.equal(ctx.runtime.bindProviderTurn('s1', first.id, 'p2'), false);
    ctx.runtime.finish('s1', 'completed', '2026-08-20T00:00:01.000Z');

    const second = ctx.runtime.start('s1', 't2', '2026-08-20T00:00:02.000Z');
    assert.equal(ctx.runtime.bindProviderTurn('s1', second.id, 'p1'), false);
    assert.equal(ctx.runtime.bindProviderTurn('s1', second.id, 'p1', true), true);
    assert.equal(ctx.runtime.get('s1')?.providerTurnId, 'p1');
  } finally {
    ctx.close();
  }
});

test('requestStop, cancelStop, and forget only track the active host turn', () => {
  const ctx = tempRuntime();
  try {
    assert.equal(ctx.runtime.requestStop('s1'), null);
    const turn = ctx.runtime.start('s1', 't1', '2026-08-20T00:00:00.000Z');
    assert.deepEqual(ctx.runtime.requestStop('s1'), turn);
    assert.equal(ctx.runtime.isStopRequested('s1'), true);
    assert.equal(ctx.runtime.isStopRequested('s1', turn.id), true);
    assert.equal(ctx.runtime.isStopRequested('s1', 'other'), false);

    ctx.runtime.cancelStop('s1', 'other');
    assert.equal(ctx.runtime.isStopRequested('s1', turn.id), true);
    ctx.runtime.cancelStop('s1', turn.id);
    assert.equal(ctx.runtime.isStopRequested('s1'), false);

    ctx.runtime.requestStop('s1');
    ctx.runtime.forget('s1');
    assert.equal(ctx.runtime.has('s1'), false);
    assert.equal(ctx.runtime.isStopRequested('s1'), false);
  } finally {
    ctx.close();
  }
});
