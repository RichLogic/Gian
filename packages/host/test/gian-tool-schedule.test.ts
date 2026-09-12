// Gian Tool schedule.* surface (contract A/M): internal standard actors see
// and manage only Schedules bound to their own conversation, control-session
// binding is derived from the credential (never params), external controllers
// are denied, create blocks on the Host-enforced confirmation, and
// run_now converges on the pre-allocated Run id across retries.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GianToolMethod, ServerToClientMessage } from '@gian/shared';
import { openDatabase, type Db } from '../src/storage/db.js';
import { TaskManager } from '../src/task/manager.js';
import { GianToolService } from '../src/tool/service.js';
import { GianToolAccessController } from '../src/tool/access.js';
import type { GianToolActor } from '../src/tool/credentials.js';
import type { WsBroadcaster } from '../src/web/ws-broadcast.js';
import { ScheduleService } from '../src/schedule/service.js';

const START = Date.parse('2026-09-01T12:00:00.000Z');
const CLOCK = () => ({ ms: START, iso: new Date(START).toISOString() });

const ALL_METHODS: GianToolMethod[] = [
  'catalog.get_create_options',
  'task.list', 'task.get', 'task.create', 'task.update',
  'session.list', 'session.get', 'session.read', 'session.create', 'session.update',
  'session.assign_task', 'session.set_subtask_state', 'session.archive', 'session.send',
  'session.cancel_delivery', 'session.wait', 'session.stop',
  'worktree.create_and_bind',
  'interaction.list', 'interaction.respond',
  'schedule.preview', 'schedule.create', 'schedule.list', 'schedule.get',
  'schedule.update', 'schedule.pause', 'schedule.resume', 'schedule.run_now',
  'schedule.archive',
];

function internalActor(sessionId: string): GianToolActor {
  return {
    kind: 'internal_session',
    credentialId: `cred-${sessionId}`,
    callerId: `internal-session:${sessionId}`,
    role: 'standard',
    grants: [...ALL_METHODS],
    expiresAt: '2027-08-27T00:00:00.000Z',
    sessionId,
    agentId: 'agent-1',
    workspaceId: 'workspace-1',
    taskId: null,
  };
}

function externalActor(clientId: string): GianToolActor {
  return {
    kind: 'external_controller',
    credentialId: `cred-ext-${clientId}`,
    callerId: `external-controller:${clientId}`,
    role: 'admin',
    grants: [...ALL_METHODS],
    expiresAt: '2027-08-27T00:00:00.000Z',
    clientId,
  };
}

interface Fixture {
  dir: string;
  db: Db;
  tool: GianToolService;
  access: GianToolAccessController;
  schedule: ScheduleService;
  sessionA: string;
  sessionB: string;
}

function setup(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'gian-tool-schedule-'));
  const db = openDatabase(dir);
  const wsId = randomUUID();
  db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)').run(wsId, 'ws', '/tmp/ws');
  const sessionA = randomUUID();
  const sessionB = randomUUID();
  for (const id of [sessionA, sessionB]) {
    db.prepare(
      `INSERT INTO sessions (id, name, type, workspace_id, executor, status, archived, hidden, native_session_id, conversation_usage_complete, created_at, updated_at)
       VALUES (?, 'conv', 'coding', ?, 'claude', 'done', 0, 0, ?, 1, datetime('now'), datetime('now'))`,
    ).run(id, wsId, `native-${id}`);
  }
  const broadcaster = {
    broadcast() {},
    add() {},
    remove() {},
    send() {},
    size: 0,
  } as unknown as WsBroadcaster;
  const schedule = new ScheduleService({ db, broadcaster, now: CLOCK });
  const tool = new GianToolService({
    db,
    tasks: new TaskManager(db),
    sessions: { setDeliveryLifecycle() {} } as never,
    approvals: {} as never,
    broadcaster,
    schedule,
  });
  return { dir, db, tool, access: new GianToolAccessController(tool, db), schedule, sessionA, sessionB };
}

function teardown(fx: Fixture): void {
  fx.db.close();
  rmSync(fx.dir, { recursive: true, force: true });
}

interface CallOptions {
  idempotencyKey?: string;
  actor?: GianToolActor;
}

async function callSchedule(
  fx: Fixture,
  actor: GianToolActor,
  method: GianToolMethod,
  params: Record<string, unknown>,
  options: CallOptions = {},
): Promise<{ ok: boolean; data?: Record<string, unknown>; error?: { code: string; message: string } }> {
  const result = await fx.access.call(actor, {
    request_id: randomUUID(),
    method,
    params,
    ...(options.idempotencyKey !== undefined || [
      'schedule.create', 'schedule.update', 'schedule.pause', 'schedule.resume',
      'schedule.run_now', 'schedule.archive',
    ].includes(method)
      ? { idempotency_key: options.idempotencyKey ?? `key-${randomUUID()}` }
      : {}),
  });
  return result as never;
}

const TRIGGER = { kind: 'cron' as const, expression: '30 9 * * *' };

test('schedule.create derives the binding from the credential and blocks until approval', async () => {
  const fx = setup();
  try {
    const actor = internalActor(fx.sessionA);
    // Params that try to steer the binding are rejected by validation before
    // anything else happens (contract A).
    const hijack = await callSchedule(fx, actor, 'schedule.create', {
      name: 'Hijack', prompt: 'p', trigger: TRIGGER, timezone: 'UTC',
      session_id: fx.sessionB, agent_id: 'agent-x', workspace_id: 'ws-x', task_id: 't',
    }, { idempotencyKey: 'hijack' });
    assert.equal(hijack.ok, false);
    assert.equal(hijack.error?.code, 'INVALID_ARGUMENT');

    // The legit create blocks; the test approves it out-of-band while the
    // Tool call is waiting, so both promises settle.
    let approve: (() => void) | null = null;
    const approvalDone = new Promise<void>(resolve => {
      approve = () => {
        const pendingList = fx.schedule.listConfirmations({ status: 'pending' });
        if (pendingList.length > 0) {
          fx.schedule.resolveConfirmation({ confirmationId: pendingList[0]!.id, decision: 'approve' });
        }
        resolve();
      };
    });
    const poll = (async () => {
      for (let i = 0; i < 300; i += 1) {
        await new Promise(resolve => setTimeout(resolve, 10));
        if (fx.schedule.listConfirmations({ status: 'pending' }).length > 0) {
          approve!();
          return;
        }
      }
      throw new Error('confirmation never appeared');
    })();
    const pending = callSchedule(fx, actor, 'schedule.create', {
      name: 'Approved one', prompt: 'p', trigger: TRIGGER, timezone: 'UTC',
    }, { idempotencyKey: 'create-1' });
    const result = await pending;
    await poll;
    await approvalDone;
    assert.equal(result.ok, true);
    const data = (result as { data?: { schedule: { control_session_id: string; name: string }; confirmation_id: string } }).data;
    assert.equal(data?.schedule.control_session_id, fx.sessionA);
    assert.equal(data?.schedule.name, 'Approved one');
  } finally {
    teardown(fx);
  }
});

test('external controllers are denied the whole schedule.* family (contract A)', async () => {
  const fx = setup();
  try {
    const actor = externalActor('ext-1');
    const listed = await callSchedule(fx, actor, 'schedule.list', {});
    assert.equal(listed.ok, false);
    assert.equal(listed.error?.code, 'PERMISSION_DENIED');
    const created = await callSchedule(fx, actor, 'schedule.create', {
      name: 'n', prompt: 'p', trigger: TRIGGER, timezone: 'UTC',
    }, { idempotencyKey: 'ext-create' });
    assert.equal(created.ok, false);
    assert.equal(created.error?.code, 'PERMISSION_DENIED');
  } finally {
    teardown(fx);
  }
});

test('internal standard actors only see and manage their own conversation schedules', async () => {
  const fx = setup();
  try {
    const actorA = internalActor(fx.sessionA);
    const mine = fx.schedule.createSchedule({
      name: 'Mine', prompt: 'p', trigger: TRIGGER, timezone: 'UTC',
      controlSessionId: fx.sessionA, creatorActorId: actorA.callerId,
    });
    fx.schedule.createSchedule({
      name: 'Theirs', prompt: 'p', trigger: TRIGGER, timezone: 'UTC',
      controlSessionId: fx.sessionB, creatorActorId: 'internal-session:other',
    });

    const listed = await callSchedule(fx, actorA, 'schedule.list', {});
    assert.equal(listed.ok, true);
    const schedules = (listed.data as { schedules: Array<{ id: string }> }).schedules!;
    assert.equal(schedules.length, 1);
    assert.equal(schedules[0]!.id, mine.id);

    const foreign = fx.schedule.createSchedule({
      name: 'Foreign', prompt: 'p', trigger: TRIGGER, timezone: 'UTC',
      controlSessionId: fx.sessionB, creatorActorId: 'internal-session:other',
    });
    const denied = await callSchedule(fx, actorA, 'schedule.pause', { schedule_id: foreign.id });
    assert.equal(denied.ok, false);
    assert.equal(denied.error?.code, 'PERMISSION_DENIED');

    const got = await callSchedule(fx, actorA, 'schedule.get', { schedule_id: mine.id, include_runs: true });
    assert.equal(got.ok, true);
    assert.equal((got.data as { schedule: { id: string } }).schedule.id, mine.id);
    assert.ok(Array.isArray((got.data as { runs: unknown[] }).runs));
  } finally {
    teardown(fx);
  }
});

test('schedule.preview is pure and returns at least three occurrences', async () => {
  const fx = setup();
  try {
    const result = await callSchedule(fx, internalActor(fx.sessionA), 'schedule.preview', {
      trigger: { kind: 'interval', every_ms: 600_000, anchor_at: new Date(START).toISOString() },
      timezone: 'UTC',
    });
    assert.equal(result.ok, true);
    const occurrences = (result.data as { occurrences: string[] }).occurrences!;
    assert.ok(occurrences.length >= 3);
    assert.ok(occurrences.every(value => Date.parse(value) > START));
  } finally {
    teardown(fx);
  }
});

test('schedule.run_now converges on the same Run across idempotent retries', async () => {
  const fx = setup();
  try {
    const actor = internalActor(fx.sessionA);
    const scheduleId = fx.schedule.createSchedule({
      name: 'Reruns', prompt: 'p', trigger: TRIGGER, timezone: 'UTC',
      controlSessionId: fx.sessionA, creatorActorId: actor.callerId,
    }).id;
    const first = await callSchedule(fx, actor, 'schedule.run_now', { schedule_id: scheduleId }, { idempotencyKey: 'run-1' });
    assert.equal(first.ok, true);
    const second = await callSchedule(fx, actor, 'schedule.run_now', { schedule_id: scheduleId }, { idempotencyKey: 'run-1' });
    assert.equal(second.ok, true);
    const firstRun = (first.data as { run: { id: string; status: string } }).run!;
    const secondRun = (second.data as { run: { id: string } }).run!;
    assert.equal(firstRun.id, secondRun.id, 'the Tool ledger replays the same Run');
    assert.equal(firstRun.status, 'scheduled');
  } finally {
    teardown(fx);
  }
});

test('schedule create timeout returns TIMEOUT while approval stays possible', async () => {
  const fx = setup();
  try {
    const actor = internalActor(fx.sessionA);
    const timedOut = await callSchedule(fx, actor, 'schedule.create', {
      name: 'Slow approver', prompt: 'p', trigger: TRIGGER, timezone: 'UTC',
      confirmation_timeout_ms: 5_000,
    }, { idempotencyKey: 'create-slow' });
    assert.equal(timedOut.ok, false);
    assert.equal(timedOut.error?.code, 'TIMEOUT');
    // The pending confirmation outlives the Tool call; approving it later
    // still commits exactly one Schedule (converged on the pre-allocated id).
    const pending = fx.schedule.listConfirmations({ status: 'pending' });
    assert.equal(pending.length, 1);
    fx.schedule.resolveConfirmation({ confirmationId: pending[0]!.id, decision: 'approve' });
    const created = fx.schedule.listConfirmations({ status: 'approved' });
    assert.equal(created.length, 1);
    assert.ok(created[0]!.schedule_id);
    const schedule = fx.schedule.getSchedule(created[0]!.schedule_id!);
    assert.equal(schedule.name, 'Slow approver');
  } finally {
    teardown(fx);
  }
}, { timeout: 20000 });
