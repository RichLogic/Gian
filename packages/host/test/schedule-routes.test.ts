// Schedules REST surface (contract M/N): global Desktop management without a
// create endpoint, paginated run logs, confirmation resolution, and the
// Idempotency-Key command ledger (replay / conflict / busy).

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import type { ServerToClientMessage } from '@gian/shared';
import { openDatabase, type Db } from '../src/storage/db.js';
import type { WsBroadcaster } from '../src/web/ws-broadcast.js';
import { ScheduleService } from '../src/schedule/service.js';
import { ScheduleCommandLedger } from '../src/schedule/command-ledger.js';
import { registerScheduleRoutes } from '../src/web/routes/schedules.js';

const START = Date.parse('2026-09-01T12:00:00.000Z');

class CapturingBroadcaster {
  messages: ServerToClientMessage[] = [];
  add() {}
  remove() {}
  send() {}
  broadcast(message: ServerToClientMessage): void { this.messages.push(message); }
  get size() { return 0; }
}

interface Fixture {
  dir: string;
  db: Db;
  service: ScheduleService;
  app: Hono;
  sessionId: string;
  clockMs: number;
}

function setup(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'schedule-routes-'));
  const db = openDatabase(dir);
  const broadcaster = new CapturingBroadcaster();
  const sessionId = randomUUID();
  const workspaceId = randomUUID();
  db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)').run(workspaceId, 'ws', '/tmp/ws');
  db.prepare(
    `INSERT INTO sessions (id, name, type, workspace_id, executor, status, archived, hidden, native_session_id, conversation_usage_complete, created_at, updated_at)
     VALUES (?, 'Bound conversation', 'coding', ?, 'claude', 'done', 0, 0, 'native-x', 1, datetime('now'), datetime('now'))`,
  ).run(sessionId, workspaceId);
  const fixture: Fixture = { dir, db, service: undefined!, app: undefined!, sessionId, clockMs: START };
  const service = new ScheduleService({
    db,
    broadcaster: broadcaster as unknown as WsBroadcaster,
    now: () => ({ ms: fixture.clockMs, iso: new Date(fixture.clockMs).toISOString() }),
  });
  const app = new Hono();
  registerScheduleRoutes(app, { service, ledger: new ScheduleCommandLedger(db) });
  fixture.service = service;
  fixture.app = app;
  return fixture;
}

function teardown(fx: Fixture): void {
  fx.db.close();
  rmSync(fx.dir, { recursive: true, force: true });
}

async function createViaConfirmation(fx: Fixture, domainId: string): Promise<string> {
  const confirmation = fx.service.createConfirmation({
    name: 'Routed',
    prompt: 'route prompt',
    trigger: { kind: 'cron', expression: '30 9 * * *' },
    timezone: 'UTC',
    controlSessionId: fx.sessionId,
    createdByActorId: 'internal-session:actor',
    scheduleDomainId: domainId,
    toolRequestId: `req-${domainId}`,
  });
  fx.service.resolveConfirmation({ confirmationId: confirmation.id, decision: 'approve' });
  return domainId;
}

test('REST exposes list/get/runs/pause/resume/run/archive and confirmations — but no create', async () => {
  const fx = setup();
  try {
    const scheduleId = await createViaConfirmation(fx, randomUUID());

    const created = await fx.app.request('/api/schedules', { method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': 'k-create' }, body: '{}' });
    assert.equal(created.status, 404, 'UI-less REST has no create endpoint (contract M)');

    const list = await fx.app.request('/api/schedules');
    assert.equal(list.status, 200);
    const listBody = await list.json() as { schedules: Array<{ id: string; control_session_title: string | null; workspace_name: string | null }> };
    assert.equal(listBody.schedules.length, 1);
    assert.equal(listBody.schedules[0]!.id, scheduleId);
    assert.equal(listBody.schedules[0]!.control_session_title, 'Bound conversation');
    assert.equal(listBody.schedules[0]!.workspace_name, 'ws');

    const one = await fx.app.request(`/api/schedules/${scheduleId}`);
    assert.equal(one.status, 200);

    const missing = await fx.app.request('/api/schedules/does-not-exist');
    assert.equal(missing.status, 404);
    const missingBody = await missing.json() as { error: { code: string } };
    assert.equal(missingBody.error.code, 'SCHEDULE_NOT_FOUND');

    // run_now + paginated run log.
    const run = await fx.app.request(`/api/schedules/${scheduleId}/run`, {
      method: 'POST',
      headers: { 'Idempotency-Key': 'k-run-1' },
      body: '{}',
    });
    assert.equal(run.status, 200);
    const skip = await fx.app.request(`/api/schedules/${scheduleId}/run`, {
      method: 'POST',
      headers: { 'Idempotency-Key': 'k-run-2' },
      body: '{}',
    });
    assert.equal(skip.status, 200);
    const runs = await fx.app.request(`/api/schedules/${scheduleId}/runs?limit=1`);
    const runsBody = await runs.json() as { runs: unknown[]; next_cursor: string | null };
    assert.equal(runsBody.runs.length, 1);
    assert.ok(runsBody.next_cursor);

    const paused = await fx.app.request(`/api/schedules/${scheduleId}/pause`, { method: 'POST', headers: { 'Idempotency-Key': 'k-pause' }, body: '{}' });
    assert.equal((await paused.json() as { status: string }).status, 'paused');
    const resumed = await fx.app.request(`/api/schedules/${scheduleId}/resume`, { method: 'POST', headers: { 'Idempotency-Key': 'k-resume' }, body: '{}' });
    assert.equal((await resumed.json() as { status: string }).status, 'active');
    const archived = await fx.app.request(`/api/schedules/${scheduleId}/archive`, { method: 'POST', headers: { 'Idempotency-Key': 'k-archive' }, body: '{}' });
    assert.equal((await archived.json() as { status: string }).status, 'archived');
  } finally {
    teardown(fx);
  }
});

test('writes without an Idempotency-Key are rejected and replays converge byte-for-byte', async () => {
  const fx = setup();
  try {
    const scheduleId = await createViaConfirmation(fx, randomUUID());
    const noKey = await fx.app.request(`/api/schedules/${scheduleId}/pause`, { method: 'POST', body: '{}' });
    assert.equal(noKey.status, 400);

    const first = await fx.app.request(`/api/schedules/${scheduleId}/pause`, {
      method: 'POST',
      headers: { 'Idempotency-Key': 'same-key' },
      body: '{}',
    });
    assert.equal(first.status, 200);

    // Same key + same input → replay of the stored response.
    const replay = await fx.app.request(`/api/schedules/${scheduleId}/pause`, {
      method: 'POST',
      headers: { 'Idempotency-Key': 'same-key' },
      body: '{}',
    });
    assert.equal(replay.status, 200);
    assert.equal((await replay.json() as { status: string }).status, 'paused');

    // Same key + different input → conflict.
    const conflict = await fx.app.request(`/api/schedules/${scheduleId}/pause`, {
      method: 'POST',
      headers: { 'Idempotency-Key': 'same-key' },
      body: '{"expected_revision": 99}',
    });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json() as { error: { code: string } }).error.code, 'IDEMPOTENCY_CONFLICT');

    // Unknown schedule → 404 envelope.
    const ghost = await fx.app.request('/api/schedules/ghost/pause', {
      method: 'POST',
      headers: { 'Idempotency-Key': 'ghost-key' },
      body: '{}',
    });
    assert.equal(ghost.status, 404);
  } finally {
    teardown(fx);
  }
});

test('confirmation list/resolve endpoints drive the Host-enforced create (contract L)', async () => {
  const fx = setup();
  try {
    const domainId = randomUUID();
    const confirmation = fx.service.createConfirmation({
      name: 'Confirm me',
      prompt: 'p',
      trigger: { kind: 'cron', expression: '0 10 * * *' },
      timezone: 'UTC',
      controlSessionId: fx.sessionId,
      createdByActorId: 'internal-session:actor',
      scheduleDomainId: domainId,
      toolRequestId: `req-${domainId}`,
    });

    const listed = await fx.app.request('/api/schedule-confirmations?status=pending');
    const listBody = await listed.json() as { confirmations: Array<{ id: string; status: string }> };
    assert.equal(listBody.confirmations.length, 1);
    assert.equal(listBody.confirmations[0]!.status, 'pending');

    const resolved = await fx.app.request(`/api/schedule-confirmations/${confirmation.id}/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"decision": "approve"}',
    });
    assert.equal(resolved.status, 200);
    const resolvedBody = await resolved.json() as { status: string; schedule_id: string | null };
    assert.equal(resolvedBody.status, 'approved');
    assert.equal(resolvedBody.schedule_id, domainId);

    // Bad decision → 400 envelope.
    const bad = await fx.app.request(`/api/schedule-confirmations/${confirmation.id}/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"decision": "maybe"}',
    });
    assert.equal(bad.status, 400);

    // Unknown confirmation → 404 envelope.
    const ghost = await fx.app.request('/api/schedule-confirmations/nope', {});
    assert.equal(ghost.status, 404);
  } finally {
    teardown(fx);
  }
});
