// ScheduleRepository persistence contract for migration 069 (ADR-0053):
// 068 is retired and must never be reused, the occurrence unique index is the
// final duplicate boundary, revisions CAS, terminal settles are fenced, and
// confirmations resolve only while pending and unexpired.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { openDatabase, type Db } from '../src/storage/db.js';
import { ScheduleRepository } from '../src/schedule/repository.js';

const NOW = '2026-09-01T12:00:00.000Z';
const NOW_MS = Date.parse(NOW);

interface Fixture {
  db: Db;
  dir: string;
  repo: ScheduleRepository;
  scheduleId: string;
}

function setup(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'schedule-repo-'));
  const db = openDatabase(dir);
  const repo = new ScheduleRepository(db);
  const row = repo.insertSchedule({
    id: randomUUID(),
    name: 'Repo schedule',
    prompt: 'p',
    trigger: { kind: 'cron', expression: '*/15 * * * *' },
    timezone: 'UTC',
    misfirePolicy: 'skip',
    nextRunAt: '2026-09-01T12:15:00.000Z',
    controlSessionId: randomUUID(),
    creatorActorId: 'internal-session:actor',
    now: NOW,
  });
  return { db, dir, repo, scheduleId: row.id };
}

function teardown(fx: Fixture): void {
  fx.db.close();
  rmSync(fx.dir, { recursive: true, force: true });
}

test('migration 068 stays retired: a fresh database records only 069', () => {
  const fx = setup();
  try {
    const applied = fx.db.prepare(
      `SELECT filename FROM migrations WHERE filename LIKE '06%' ORDER BY filename`,
    ).all() as Array<{ filename: string }>;
    const names = applied.map(row => row.filename);
    assert.equal(names.includes('068_scheduled_automations.sql'), false);
    assert.equal(names.includes('069_conversation_schedules.sql'), true);
    // A fresh database has the new conversation-bound schema only.
    const columns = fx.db.prepare('PRAGMA table_info(schedules)').all() as Array<{ name: string }>;
    assert.ok(columns.some(column => column.name === 'control_session_id'));
  } finally {
    teardown(fx);
  }
});

test('a database that actually executed the withdrawn 068 upgrades to 069', () => {
  const dir = mkdtempSync(join(tmpdir(), 'schedule-repo-legacy-'));
  try {
    // 1. Rebuild a true legacy base: migrations 001..067 executed in order,
    //    then the withdrawn 068 DDL verbatim — exactly what a developer
    //    database from the reverted implementation looks like.
    const legacy = new Database(join(dir, 'gian.db'));
    legacy.pragma('journal_mode = WAL');
    legacy.pragma('foreign_keys = ON');
    legacy.exec(
      `CREATE TABLE migrations (filename TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    );
    const migrationsDir = fileURLToPath(new URL('../migrations', import.meta.url));
    const applied = readdirSync(migrationsDir)
      .filter(name => name.endsWith('.sql') && name < '068_')
      .sort();
    for (const file of applied) {
      legacy.exec(readFileSync(join(migrationsDir, file), 'utf8'));
      legacy.prepare('INSERT INTO migrations (filename) VALUES (?)').run(file);
    }
    const withdrawnSql = readFileSync(
      fileURLToPath(new URL('./fixtures/withdrawn-068_scheduled_automations.sql', import.meta.url)),
      'utf8',
    );
    legacy.exec(withdrawnSql);
    legacy.prepare(`INSERT INTO migrations (filename) VALUES ('068_scheduled_automations.sql')`).run();
    legacy.prepare(
      `INSERT INTO workspaces (id, name, path) VALUES ('ws-old', 'Old ws', '/tmp/old-ws')`,
    ).run();
    // A real row from the withdrawn era: workspace/agent-owned, no control session.
    legacy.prepare(
      `INSERT INTO schedules (
         id, name, status, workspace_id, task_id, agent_id, agent_name, prompt,
         trigger_kind, trigger_json, timezone, config_strategy, executor_config_json,
         overlap_policy, misfire_policy, next_run_at, creator_kind, creator_actor_id,
         created_at, updated_at, revision
       ) VALUES (
         'old-1', 'Old era', 'active', 'ws-old', NULL, 'agent-old', 'Old Agent',
         'p', 'cron', '{"kind":"cron","expression":"30 9 * * *"}', 'UTC', 'agent_defaults', '{}',
         'skip', 'skip', '2026-08-01T09:30:00.000Z', 'internal_session', 'a',
         datetime('now'), datetime('now'), 1
       )`,
    ).run();
    legacy.close();

    // 2. Opening with the current tree must apply 069 cleanly against the
    //    real old tables.
    const reopened = openDatabase(dir);
    const ledger = reopened.prepare(
      `SELECT COUNT(*) AS n FROM migrations
        WHERE filename IN ('068_scheduled_automations.sql', '069_conversation_schedules.sql')`,
    ).get() as { n: number };
    assert.equal(ledger.n, 2, 'both the legacy 068 ledger row and the new 069 coexist');
    const columns = reopened.prepare('PRAGMA table_info(schedules)').all() as Array<{ name: string }>;
    assert.ok(columns.some(column => column.name === 'control_session_id'));
    // The withdrawn-era rows cannot satisfy the frozen contract and are dropped.
    const rows = reopened.prepare('SELECT COUNT(*) AS n FROM schedules').get() as { n: number };
    assert.equal(rows.n, 0);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the occurrence unique index is the final duplicate boundary', () => {
  const fx = setup();
  try {
    fx.repo.insertRun({
      scheduleId: fx.scheduleId,
      triggerKind: 'scheduled',
      scheduledFor: '2026-09-01T12:15:00.000Z',
      now: NOW,
    });
    assert.throws(
      () => fx.repo.insertRun({
        scheduleId: fx.scheduleId,
        triggerKind: 'scheduled',
        scheduledFor: '2026-09-01T12:15:00.000Z',
        now: NOW,
      }),
      (error: unknown) => (error as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE',
    );
    // Manual runs at the same instant are allowed (they are user-initiated).
    fx.repo.insertRun({
      scheduleId: fx.scheduleId,
      triggerKind: 'manual',
      scheduledFor: '2026-09-01T12:15:00.000Z',
      now: NOW,
    });
  } finally {
    teardown(fx);
  }
});

test('terminal settles are fenced and dispatch phases never move backwards', () => {
  const fx = setup();
  try {
    const runId = fx.repo.insertRun({
      scheduleId: fx.scheduleId,
      triggerKind: 'scheduled',
      scheduledFor: '2026-09-01T12:15:00.000Z',
      now: NOW,
    }).id;
    const claimed = fx.repo.claimRunForDispatch(runId, 'lease-1', '2026-09-01T12:00:30.000Z', NOW);
    assert.equal(claimed?.dispatch_phase, 'claimed');
    const resolved = fx.repo.resolveRunMode(runId, 'bound_session', fx.scheduleId, null, NOW);
    assert.equal(resolved?.execution_mode, 'bound_session');
    // A second resolve from the claimed phase is fenced.
    const refused = fx.repo.resolveRunMode(runId, 'fork', 'other', null, NOW);
    assert.equal(refused, null);
    const dispatched = fx.repo.markRunDispatched(runId, 'turn-1', { model: 'sonnet' }, NOW);
    assert.equal(dispatched?.status, 'running');
    assert.equal(dispatched?.dispatch_phase, 'dispatched');
    assert.equal(dispatched?.lease_token, null);

    const settled = fx.repo.settleRun(runId, 'succeeded', { summary: 'done' }, NOW);
    assert.equal(settled?.status, 'succeeded');
    // Terminal settles never override.
    const fenced = fx.repo.settleRun(runId, 'failed', { errorCode: 'X' }, NOW);
    assert.equal(fenced, null);
    // Escalation after dispatch is impossible.
    const escalated = fx.repo.escalateRunToFork(runId, 'fork-x', { turn_id: 't', source_turn_id: 's' }, NOW);
    assert.equal(escalated, null);
  } finally {
    teardown(fx);
  }
});

test('escalateRunToFork is a one-way bound→fork transition while starting', () => {
  const fx = setup();
  try {
    const runId = fx.repo.insertRun({
      scheduleId: fx.scheduleId,
      triggerKind: 'scheduled',
      scheduledFor: '2026-09-01T12:15:00.000Z',
      now: NOW,
    }).id;
    fx.repo.claimRunForDispatch(runId, 'lease-2', '2026-09-01T12:00:30.000Z', NOW);
    fx.repo.resolveRunMode(runId, 'bound_session', 'control-1', null, NOW);
    const escalated = fx.repo.escalateRunToFork(runId, 'fork-1', { turn_id: 't1', source_turn_id: 's1' }, NOW);
    assert.equal(escalated?.execution_mode, 'fork');
    assert.equal(escalated?.target_session_id, 'fork-1');
    // Escalating twice is fenced: the mode is already fork.
    const twice = fx.repo.escalateRunToFork(runId, 'fork-2', { turn_id: 't', source_turn_id: 's' }, NOW);
    assert.equal(twice, null);
  } finally {
    teardown(fx);
  }
});

test('confirmations resolve exactly once while pending and unexpired', () => {
  const fx = setup();
  try {
    const row = fx.repo.insertConfirmation({
      id: randomUUID(),
      controlSessionId: randomUUID(),
      payload: { name: 'n' },
      scheduleId: 'sched-domain',
      createdByActorId: 'actor',
      toolRequestId: 'tool-req',
      expiresAt: '2026-09-01T12:30:00.000Z',
      now: NOW,
    });
    assert.equal(fx.repo.confirmationRowByToolRequest('tool-req')?.id, row.id);

    const approved = fx.repo.resolveConfirmation(row.id, 'approved', 'sched-domain', NOW);
    assert.equal(approved?.status, 'approved');
    // Second resolve is fenced.
    assert.equal(fx.repo.resolveConfirmation(row.id, 'rejected', null, NOW), null);

    const expiring = fx.repo.insertConfirmation({
      id: randomUUID(),
      controlSessionId: randomUUID(),
      payload: {},
      scheduleId: null,
      createdByActorId: 'actor',
      toolRequestId: null,
      expiresAt: '2026-09-01T12:30:00.000Z',
      now: NOW,
    });
    // Expired before the decision instant → refused.
    assert.equal(
      fx.repo.resolveConfirmation(expiring.id, 'approved', null, '2026-09-01T12:31:00.000Z'),
      null,
    );
    // Lazy expiry sweep transitions it.
    const expired = fx.repo.expirePendingConfirmations('2026-09-01T12:31:00.000Z');
    assert.deepEqual(expired, [expiring.id]);
    assert.equal(fx.repo.confirmationRow(expiring.id)?.status, 'expired');
  } finally {
    teardown(fx);
  }
});

test('lifecycle pauses keep active schedules fail-closed and clear next_run_at', () => {
  const fx = setup();
  try {
    fx.repo.pauseScheduleForLifecycle(fx.scheduleId, NOW);
    const row = fx.repo.scheduleRow(fx.scheduleId)!;
    assert.equal(row.status, 'paused');
    assert.equal(row.status_reason, 'lifecycle_blocked');
    assert.equal(row.next_run_at, null);
    // Due queries never see paused schedules.
    const due = fx.repo.materializeDueRuns({
      nowMs: NOW_MS + 3_600_000,
      nowIso: '2026-09-01T13:00:00.000Z',
      graceMs: 60_000,
      maxSchedules: 50,
      enumerationCap: 1_000,
    });
    assert.equal(due.length, 0);
  } finally {
    teardown(fx);
  }
});

test('unknown/lifecycle pauses also land on paused and completed Schedules', () => {
  const fx = setup();
  try {
    // paused (e.g. after run_now from a manual pause)
    fx.repo.setScheduleState(fx.scheduleId, {
      status: 'paused',
      statusReason: 'manual',
      clearNextRun: true,
    }, { now: NOW });
    fx.repo.pauseScheduleForUnknownRun(fx.scheduleId, NOW);
    let row = fx.repo.scheduleRow(fx.scheduleId)!;
    assert.equal(row.status_reason, 'unknown_run', 'unknown on a paused schedule blocks plain resume');

    // completed (a once Schedule completes before its Run settles)
    fx.repo.setScheduleState(fx.scheduleId, {
      status: 'active',
      statusReason: null,
      nextRunAt: '2026-09-01T12:15:00.000Z',
    }, { now: NOW });
    fx.repo.setScheduleState(fx.scheduleId, {
      status: 'completed',
      statusReason: null,
      clearNextRun: true,
    }, { now: NOW });
    fx.repo.pauseScheduleForLifecycle(fx.scheduleId, NOW);
    row = fx.repo.scheduleRow(fx.scheduleId)!;
    assert.equal(row.status, 'paused');
    assert.equal(row.status_reason, 'lifecycle_blocked');

    // archived schedules are never resurrected by a pause.
    fx.repo.setScheduleState(fx.scheduleId, {
      status: 'archived',
      statusReason: 'manual',
      clearNextRun: true,
    }, { now: NOW });
    fx.repo.pauseScheduleForUnknownRun(fx.scheduleId, NOW);
    row = fx.repo.scheduleRow(fx.scheduleId)!;
    assert.equal(row.status, 'archived');
    assert.equal(row.status_reason, 'manual');
  } finally {
    teardown(fx);
  }
});

test('fail-closed Run and Schedule writes roll back together', () => {
  const fx = setup();
  try {
    const run = fx.repo.insertRun({
      scheduleId: fx.scheduleId,
      triggerKind: 'manual',
      scheduledFor: NOW,
      now: NOW,
    });
    fx.db.exec(`
      CREATE TRIGGER reject_schedule_pause
      BEFORE UPDATE OF status ON schedules
      WHEN NEW.status = 'paused'
      BEGIN
        SELECT RAISE(ABORT, 'pause rejected');
      END;
    `);
    assert.throws(() => fx.repo.settleRunAndPauseSchedule(
      run.id,
      'unknown',
      'unknown_run',
      { errorCode: 'SCHEDULE_DISPATCH_UNKNOWN' },
      NOW,
    ));
    assert.equal(fx.repo.runRow(run.id)!.status, 'scheduled', 'Run settle rolled back');
    assert.equal(fx.repo.scheduleRow(fx.scheduleId)!.status, 'active', 'Schedule stayed unchanged');
  } finally {
    teardown(fx);
  }
});
