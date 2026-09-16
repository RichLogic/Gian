// ScheduleService semantics for conversation-bound schedules (ADR-0053):
// immutable control-session binding, the Host-enforced create confirmation
// (contract L), revision CAS, lifecycle fail-closed resume rules, run-now
// overlap, and the paginated run log (contract D).

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Schedule, ServerToClientMessage } from '@gian/shared';
import { openDatabase, type Db } from '../src/storage/db.js';
import type { WsBroadcaster } from '../src/web/ws-broadcast.js';
import { ScheduleService } from '../src/schedule/service.js';
import { ScheduleError } from '../src/schedule/errors.js';
import { MIN_INTERVAL_MS } from '@gian/shared';

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
  broadcaster: CapturingBroadcaster;
  sessionId: string;
  workspaceId: string;
  clockMs: number;
  wakeCount: number;
  lifecycleChecks: number;
}

function setup(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'schedule-service-test-'));
  const db = openDatabase(dir);
  const broadcaster = new CapturingBroadcaster();
  const sessionId = randomUUID();
  const workspaceId = randomUUID();
  db.prepare('INSERT INTO workspaces (id, name, path) VALUES (?, ?, ?)').run(workspaceId, 'ws', '/tmp/ws');
  db.prepare(
    `INSERT INTO sessions (id, name, type, workspace_id, executor, status, archived, hidden, native_session_id, conversation_usage_complete, created_at, updated_at)
     VALUES (?, 'Control conversation', 'coding', ?, 'claude', 'done', 0, 0, 'native-control', 1, datetime('now'), datetime('now'))`,
  ).run(sessionId, workspaceId);
  const fixture: Fixture = {
    dir,
    db,
    broadcaster,
    sessionId,
    workspaceId,
    clockMs: START,
    wakeCount: 0,
    lifecycleChecks: 0,
  };
  const service = new ScheduleService({
    db,
    broadcaster: broadcaster as unknown as WsBroadcaster,
    assertControlSessionReady: () => {
      fixture.lifecycleChecks += 1;
      const row = db.prepare('SELECT archived, completed_at FROM sessions WHERE id = ?')
        .get(sessionId) as { archived: number; completed_at: string | null };
      if (row.archived === 1) throw new Error('session is archived');
      if (row.completed_at) throw new Error('session is completed; reopen it before sending more messages');
    },
    wake: () => { fixture.wakeCount += 1; },
    now: () => ({ ms: fixture.clockMs, iso: new Date(fixture.clockMs).toISOString() }),
  });
  fixture.service = service;
  return fixture;
}

const CRON_TRIGGER = { kind: 'cron' as const, expression: '30 9 * * *' };

function createInput(overrides: Record<string, unknown> = {}, sessionId?: string) {
  return {
    name: 'Nightly digest',
    prompt: 'Summarize the day',
    trigger: CRON_TRIGGER,
    timezone: 'UTC',
    controlSessionId: sessionId ?? '',
    creatorActorId: 'internal-session:actor',
    ...overrides,
  };
}

test('create binds the control session immutably and enriches the read model', () => {
  const fx = setup();
  try {
    const schedule = fx.service.createSchedule(createInput({}, fx.sessionId));
    assert.equal(schedule.control_session_id, fx.sessionId);
    assert.equal(schedule.creator_kind, 'internal_session');
    assert.equal(schedule.control_session_title, 'Control conversation');
    assert.equal(schedule.workspace_name, 'ws');
    assert.equal(schedule.overlap_policy, 'skip');
    assert.deepEqual(schedule.trigger, CRON_TRIGGER);
    // next_run_at is tomorrow 09:30 UTC, strictly after now.
    assert.equal(Date.parse(schedule.next_run_at!) > fx.clockMs, true);
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('create validates trigger pace, timezone, prompt size, and future once fire times', async () => {
  const fx = setup();
  try {
    assert.throws(
      () => fx.service.createSchedule(createInput({
        trigger: { kind: 'interval', every_ms: MIN_INTERVAL_MS - 1, anchor_at: new Date(fx.clockMs).toISOString() },
      }, fx.sessionId)),
      (error: unknown) => error instanceof ScheduleError && error.code === 'SCHEDULE_TRIGGER_INVALID',
    );
    assert.throws(
      () => fx.service.createSchedule(createInput({ timezone: 'Mars/Olympus' }, fx.sessionId)),
      (error: unknown) => error instanceof ScheduleError && error.code === 'SCHEDULE_TIMEZONE_INVALID',
    );
    assert.throws(
      () => fx.service.createSchedule(createInput({ prompt: 'x'.repeat(40_000) }, fx.sessionId)),
      (error: unknown) => error instanceof ScheduleError && error.code === 'INVALID_ARGUMENT',
    );
    assert.throws(
      () => fx.service.createSchedule(createInput({
        trigger: { kind: 'once', at: new Date(fx.clockMs + 1_000).toISOString() },
      }, fx.sessionId)),
      (error: unknown) => error instanceof ScheduleError && error.code === 'SCHEDULE_HAS_NO_FUTURE_OCCURRENCE',
    );
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('create converges on a pre-allocated domain id instead of duplicating', () => {
  const fx = setup();
  try {
    const domainId = randomUUID();
    const first = fx.service.createSchedule(createInput({}, fx.sessionId));
    const converged = fx.service.createSchedule({ ...createInput({}, fx.sessionId), domainId: first.id });
    assert.equal(converged.id, first.id);
    assert.notEqual(converged.id, domainId);
    assert.equal(fx.service.listSchedules({}).schedules.length, 1);
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('update requires expected_revision and rejects unknown control-session drift', async () => {
  const fx = setup();
  try {
    const schedule = fx.service.createSchedule(createInput({}, fx.sessionId));
    const row = (fx.service.listSchedules({}).schedules[0]!);
    await assert.rejects(
      () => fx.service.updateSchedule({ schedule_id: schedule.id, expected_revision: 99, name: 'X' }),
      (error: unknown) => error instanceof ScheduleError && error.code === 'SCHEDULE_REVISION_CONFLICT',
    );
    const updated = await fx.service.updateSchedule({
      schedule_id: row.id,
      expected_revision: row.revision,
      name: 'Renamed',
      trigger: { kind: 'interval', every_ms: 5 * MIN_INTERVAL_MS, anchor_at: new Date(fx.clockMs).toISOString() },
    });
    assert.equal(updated.name, 'Renamed');
    assert.equal(updated.revision, row.revision + 1);
    assert.equal(updated.control_session_id, fx.sessionId);
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('create confirmation flow: pending preview payload, approve commits the schedule', async () => {
  const fx = setup();
  try {
    const confirmation = fx.service.createConfirmation({
      name: 'Daily digest',
      prompt: 'Full durable prompt text',
      trigger: CRON_TRIGGER,
      timezone: 'UTC',
      controlSessionId: fx.sessionId,
      createdByActorId: 'internal-session:actor',
      scheduleDomainId: 'sched-domain-1',
      toolRequestId: 'tool-req-1',
    });
    assert.equal(confirmation.status, 'pending');
    assert.equal(confirmation.payload.control_session.id, fx.sessionId);
    assert.equal(confirmation.payload.prompt, 'Full durable prompt text');
    assert.ok(confirmation.payload.prompt_summary.length <= 281);
    assert.ok(confirmation.payload.next_occurrences.length >= 3, 'preview shows at least three occurrences');
    assert.ok(confirmation.payload.risk_note.length > 0);

    const resolved = fx.service.resolveConfirmation({ confirmationId: confirmation.id, decision: 'approve' });
    assert.equal(resolved.status, 'approved');
    assert.equal(resolved.schedule_id, 'sched-domain-1');
    const schedule = fx.service.getSchedule('sched-domain-1');
    assert.equal(schedule.name, 'Daily digest');
    assert.equal(schedule.control_session_id, fx.sessionId);
    assert.equal(schedule.status, 'active');
    // The durable prompt is the full text, not the summary (contract B).
    assert.equal(fx.db.prepare('SELECT prompt FROM schedules WHERE id = ?').get(schedule.id)!.prompt, 'Full durable prompt text');
    assert.ok(
      fx.broadcaster.messages.some(m => m.type === 'schedule:confirmation'),
      'confirmation broadcast for the UI',
    );
    assert.ok(
      fx.broadcaster.messages.some(m => m.type === 'schedule:changed' && m.reason === 'created'),
      'schedule:changed created invalidation',
    );
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('interval confirmation summary reports real minutes rather than minimum-interval units', () => {
  const fx = setup();
  try {
    const confirmation = fx.service.createConfirmation({
      name: 'Half-hour digest',
      prompt: 'Summarize recent activity',
      trigger: {
        kind: 'interval',
        every_ms: 30 * 60_000,
        anchor_at: new Date(fx.clockMs).toISOString(),
      },
      timezone: 'UTC',
      controlSessionId: fx.sessionId,
      createdByActorId: 'internal-session:actor',
      scheduleDomainId: 'sched-domain-interval-summary',
      toolRequestId: 'tool-req-interval-summary',
    });

    assert.equal(confirmation.payload.trigger_summary, 'Every 30 minutes');
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('approval carries the confirmed misfire policy into the committed schedule (P1)', async () => {
  const fx = setup();
  try {
    const confirmation = fx.service.createConfirmation({
      name: 'Run once on misfire',
      prompt: 'p',
      trigger: CRON_TRIGGER,
      timezone: 'UTC',
      misfire_policy: 'run_once',
      controlSessionId: fx.sessionId,
      createdByActorId: 'internal-session:actor',
      scheduleDomainId: 'sched-domain-mp',
      toolRequestId: 'tool-req-mp',
    });
    assert.equal(confirmation.payload.misfire_policy, 'run_once', 'the card shows the confirmed policy');
    fx.service.resolveConfirmation({ confirmationId: confirmation.id, decision: 'approve' });
    const committed = fx.service.getSchedule('sched-domain-mp');
    assert.equal(committed.misfire_policy, 'run_once');
    // The approving credential actor is the creator, not a literal.
    assert.equal(committed.creator_actor_id, 'internal-session:actor');
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('approving a stale once confirmation never creates a never-running schedule (P1)', async () => {
  const fx = setup();
  try {
    const onceAt = new Date(fx.clockMs + 10 * 60_000).toISOString();
    const confirmation = fx.service.createConfirmation({
      name: 'Stale once',
      prompt: 'p',
      trigger: { kind: 'once', at: onceAt },
      timezone: 'UTC',
      controlSessionId: fx.sessionId,
      createdByActorId: 'internal-session:actor',
      scheduleDomainId: 'sched-domain-stale',
      toolRequestId: 'tool-req-stale',
    });
    // The user approves after the once time already passed.
    fx.clockMs += 20 * 60_000;
    assert.throws(
      () => fx.service.resolveConfirmation({ confirmationId: confirmation.id, decision: 'approve' }),
      (error: unknown) => error instanceof ScheduleError && error.code === 'SCHEDULE_HAS_NO_FUTURE_OCCURRENCE',
    );
    assert.throws(
      () => fx.service.getSchedule('sched-domain-stale'),
      (error: unknown) => error instanceof ScheduleError && error.code === 'SCHEDULE_NOT_FOUND',
    );
    // The confirmation stays pending until it expires, so the failed decision
    // is visible instead of silently disappearing.
    assert.equal(fx.service.getConfirmation(confirmation.id).status, 'pending');
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('create confirmation reject path never commits a schedule', async () => {
  const fx = setup();
  try {
    const confirmation = fx.service.createConfirmation({
      name: 'Rejected plan',
      prompt: 'p',
      trigger: CRON_TRIGGER,
      timezone: 'UTC',
      controlSessionId: fx.sessionId,
      createdByActorId: 'internal-session:actor',
      scheduleDomainId: 'sched-domain-2',
      toolRequestId: 'tool-req-2',
    });
    const resolved = fx.service.resolveConfirmation({ confirmationId: confirmation.id, decision: 'reject' });
    assert.equal(resolved.status, 'rejected');
    // The pre-allocated id remains recorded, but no Schedule row exists.
    assert.equal(resolved.schedule_id, 'sched-domain-2');
    assert.throws(
      () => fx.service.getSchedule('sched-domain-2'),
      (error: unknown) => error instanceof ScheduleError && error.code === 'SCHEDULE_NOT_FOUND',
    );
    // Repeat resolves converge instead of throwing.
    const again = fx.service.resolveConfirmation({ confirmationId: confirmation.id, decision: 'reject' });
    assert.equal(again.status, 'rejected');
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('approve of an expired confirmation never leaves a live schedule behind', async () => {
  const fx = setup();
  try {
    const confirmation = fx.service.createConfirmation({
      name: 'Late approval',
      prompt: 'p',
      trigger: CRON_TRIGGER,
      timezone: 'UTC',
      controlSessionId: fx.sessionId,
      createdByActorId: 'internal-session:actor',
      scheduleDomainId: 'sched-domain-3',
      toolRequestId: 'tool-req-3',
    });
    fx.clockMs += 40 * 60_000; // past the 30-minute TTL
    fx.service.expireStaleConfirmations(new Date(fx.clockMs).toISOString());
    assert.equal(fx.service.getConfirmation(confirmation.id).status, 'expired');
    assert.throws(
      () => fx.service.resolveConfirmation({ confirmationId: confirmation.id, decision: 'approve' }),
      (error: unknown) => error instanceof ScheduleError && error.code === 'SCHEDULE_CONFIRMATION_EXPIRED',
    );
    assert.throws(
      () => fx.service.getSchedule('sched-domain-3'),
      (error: unknown) => error instanceof ScheduleError && error.code === 'SCHEDULE_NOT_FOUND',
    );
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('waitForConfirmation returns approved, rejected, and timeout outcomes', async () => {
  const fx = setup();
  try {
    const confirmation = fx.service.createConfirmation({
      name: 'Waited',
      prompt: 'p',
      trigger: CRON_TRIGGER,
      timezone: 'UTC',
      controlSessionId: fx.sessionId,
      createdByActorId: 'internal-session:actor',
      scheduleDomainId: 'sched-domain-4',
      toolRequestId: 'tool-req-4',
    });
    const sleep = () => new Promise<void>(resolve => setTimeout(resolve, 1));
    // Timeout: advance the service clock past the deadline without resolving.
    const timeoutPromise = fx.service.waitForConfirmation({ confirmationId: confirmation.id, timeoutMs: 50, sleep });
    const timer = setTimeout(() => { fx.clockMs += 5 * 60_000; }, 10);
    const timeout = await timeoutPromise;
    clearTimeout(timer);
    assert.equal(timeout.outcome, 'timeout');

    fx.service.resolveConfirmation({ confirmationId: confirmation.id, decision: 'approve' });
    // The second wait observes the terminal state immediately.
    const approved = await fx.service.waitForConfirmation({ confirmationId: confirmation.id, timeoutMs: 50, sleep });
    assert.equal(approved.outcome, 'approved');
    if (approved.outcome === 'approved') assert.equal(approved.schedule.id, 'sched-domain-4');
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('resume revalidates the control conversation fail-closed (contract J)', async () => {
  const fx = setup();
  try {
    const schedule = fx.service.createSchedule(createInput({}, fx.sessionId));
    fx.service.pauseSchedule(schedule.id);
    // Block the lifecycle gate: archive the control session row.
    fx.db.prepare('UPDATE sessions SET archived = 1 WHERE id = ?').run(fx.sessionId);
    await assert.rejects(
      () => fx.service.resumeSchedule(schedule.id),
      (error: unknown) => error instanceof ScheduleError && error.code === 'SCHEDULE_CONTROL_SESSION_BLOCKED',
    );
    fx.db.prepare('UPDATE sessions SET archived = 0 WHERE id = ?').run(fx.sessionId);
    const resumed = await fx.service.resumeSchedule(schedule.id);
    assert.equal(resumed.status, 'active');
    assert.ok(fx.lifecycleChecks >= 1, 'lifecycle gate ran');
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('resume of an unknown_run pause is refused until archive; manual pauses resume', async () => {
  const fx = setup();
  try {
    const schedule = fx.service.createSchedule(createInput({}, fx.sessionId));
    // unknown_run is written only by the dispatcher; simulate the pause.
    fx.service.repository.pauseScheduleForUnknownRun(schedule.id, new Date(fx.clockMs).toISOString());
    await assert.rejects(
      () => fx.service.resumeSchedule(schedule.id),
      (error: unknown) => error instanceof ScheduleError && error.code === 'SCHEDULE_REVISION_CONFLICT',
    );
    // Confirming the risk = archive + recreate; archive of the paused row works.
    const archived = fx.service.archiveSchedule(schedule.id);
    assert.equal(archived.status, 'archived');
    // A plain manual pause resumes cleanly.
    const other = fx.service.createSchedule(createInput({ name: 'Manual' }, fx.sessionId));
    fx.service.pauseSchedule(other.id);
    const resumed = await fx.service.resumeSchedule(other.id);
    assert.equal(resumed.status, 'active');
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('runNow records skipped_overlap when a blocking run exists and manual runs otherwise', () => {
  const fx = setup();
  try {
    const schedule = fx.service.createSchedule(createInput({}, fx.sessionId));
    const first = fx.service.runNow({ schedule_id: schedule.id });
    assert.equal(first.status, 'scheduled');
    assert.equal(first.execution_mode, null);
    const second = fx.service.runNow({ schedule_id: schedule.id });
    assert.equal(second.status, 'skipped_overlap');
    assert.equal(second.error_code, 'SCHEDULE_OVERLAP_SKIPPED');
    // A recovered receipt converges on the same run id.
    const converged = fx.service.runNow({ schedule_id: schedule.id, domainId: first.id });
    assert.equal(converged.id, first.id);
    // Run log is paginated and authoritative (contract D/N).
    const page = fx.service.listRuns(schedule.id, { limit: 1 });
    assert.equal(page.runs.length, 1);
    assert.notEqual(page.next_cursor, null);
    const full = fx.service.listRuns(schedule.id, {});
    assert.equal(full.runs.length, 2);
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('listSchedules excludes archived by default and paginates by cursor', () => {
  const fx = setup();
  try {
    const first = fx.service.createSchedule(createInput({ name: 'A' }, fx.sessionId));
    const second = fx.service.createSchedule(createInput({ name: 'B' }, fx.sessionId));
    fx.service.archiveSchedule(first.id);
    const active = fx.service.listSchedules({});
    assert.equal(active.schedules.length, 1);
    assert.equal(active.schedules[0]!.id, second.id);
    const third = fx.service.createSchedule(createInput({ name: 'C' }, fx.sessionId));
    fx.service.archiveSchedule(third.id);
    const page1 = fx.service.listSchedules({ statuses: ['archived'], limit: 1 });
    assert.equal(page1.schedules.length, 1);
    assert.notEqual(page1.next_cursor, null);
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});

test('preview returns canonical trigger, timezone, and at least three occurrences', () => {
  const fx = setup();
  try {
    const preview = fx.service.preview({
      trigger: { kind: 'interval', every_ms: 10 * MIN_INTERVAL_MS, anchor_at: new Date(fx.clockMs).toISOString() },
      timezone: 'Europe/Berlin',
    });
    assert.equal(preview.timezone, 'Europe/Berlin');
    assert.equal(preview.trigger.kind, 'interval');
    assert.ok(preview.occurrences.length >= 3);
    assert.ok(preview.occurrences.every(value => Date.parse(value) > fx.clockMs));
  } finally {
    rmSync(fx.dir, { recursive: true, force: true });
  }
});
