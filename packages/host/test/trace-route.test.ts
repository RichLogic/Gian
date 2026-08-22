import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { ProxyNotification } from '@gian/proxy-protocol';
import { TraceEvidenceStore } from '../src/trace/evidence-store.js';
import { makeTestApp, type TestAppCtx } from './fixtures/test-app.js';

function rawNotification(value: { method: string; params: unknown }): ProxyNotification {
  return { jsonrpc: '2.0', ...value } as ProxyNotification;
}

function seedSession(db: TestAppCtx['db'], sessionId: string): void {
  db.exec(
    `INSERT INTO workspaces(id,name,path,sort_order,hidden,created_at,updated_at)
     VALUES('w1','workspace','/tmp',0,0,datetime('now'),datetime('now'));
     INSERT INTO sessions(id,name,type,workspace_id,executor,approval_mode,status,archived,unread,native_session_id,created_at,updated_at)
     VALUES('${sessionId}', 'trace', 'primary', 'w1', 'grok', 'plan', 'done', 0, 0, 'native', datetime('now'), datetime('now'));`,
  );
}

function startedNotification(sessionId: string, sequence: number): ProxyNotification {
  return rawNotification({
    method: 'turn.started',
    params: {
      eventId: `route-ev-${sequence}`,
      streamId: 'stream-1',
      sequence,
      sessionId,
      turnId: 't1',
      emittedAt: '2026-08-10T05:30:00.000Z',
      data: {},
    },
  });
}

test('TRACE: GET /api/sessions/:id/trace returns a snapshot and follows the 404 error model', async () => {
  const appCtx = await makeTestApp();
  try {
    const sessionId = randomUUID();
    seedSession(appCtx.db, sessionId);

    // A session that never executed a turn has a normal empty trace.
    const empty = await appCtx.fetch(`/api/sessions/${sessionId}/trace`);
    assert.equal(empty.status, 200);
    const emptyBody = (await empty.json()) as { sessionId: string; partial: boolean; items: unknown[] };
    assert.equal(emptyBody.sessionId, sessionId);
    assert.equal(emptyBody.partial, false, 'no turns and no evidence is a normal empty trace');
    assert.deepEqual(emptyBody.items, []);

    // A session that executed turns but has no recoverable evidence is partial.
    appCtx.db.prepare(
      `INSERT INTO turns (id, session_id, turn_number, status, created_at)
       VALUES ('t-lost', ?, 1, 'completed', datetime('now'))`,
    ).run(sessionId);
    const lost = await appCtx.fetch(`/api/sessions/${sessionId}/trace`);
    assert.equal(lost.status, 200);
    const lostBody = (await lost.json()) as { partial: boolean; items: unknown[] };
    assert.equal(lostBody.partial, true, 'turns without evidence are a partial trace');
    assert.deepEqual(lostBody.items, []);

    // Persist evidence through the same store the coordinator uses, then
    // re-read: the snapshot must contain the projected turn.
    const store = new TraceEvidenceStore(appCtx.db);
    store.persist(startedNotification(sessionId, 1));
    store.persist(rawNotification({
      method: 'turn.completed',
      params: {
        eventId: 'route-ev-2',
        streamId: 'stream-1',
        sequence: 2,
        sessionId,
        turnId: 't1',
        emittedAt: '2026-08-10T05:31:00.000Z',
        data: { stopReason: 'completed' },
      },
    }));
    const populated = await appCtx.fetch(`/api/sessions/${sessionId}/trace`);
    assert.equal(populated.status, 200);
    const body = (await populated.json()) as { partial: boolean; items: Array<{ kind: string; status: string; durationMs: number }> };
    assert.equal(body.partial, false);
    assert.equal(body.items.length, 1);
    assert.equal(body.items[0]!.kind, 'turn');
    assert.equal(body.items[0]!.status, 'succeeded');
    assert.equal(body.items[0]!.durationMs, 60000);

    // Unknown session follows the existing route error model (404 + error).
    const missing = await appCtx.fetch('/api/sessions/does-not-exist/trace');
    assert.equal(missing.status, 404);
    const missingBody = (await missing.json()) as { error: string };
    assert.ok(missingBody.error.includes('session not found'), missingBody.error);
  } finally {
    await appCtx.cleanup();
  }
});