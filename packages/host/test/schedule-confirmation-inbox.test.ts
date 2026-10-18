// Schedule confirmation Inbox mirror. NOT_RUN.
// Fixtures go through the real migration chain. openDatabase applies 090.
// The upgrade case applies 001–089 itself, then lets openDatabase apply 090.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import type { ServerToClientMessage } from '@gian/shared';
import {
  isAttentionMessage,
  isScheduleConfirmationAttentionMessage,
} from '../../shared/src/attention.js';
import type { AttentionMessage } from '../../shared/src/attention.js';
import { publishFreshScheduleConfirmationAttention } from '../src/schedule/confirmation-attention.js';
import { openDatabase, type Db } from '../src/storage/db.js';
import type { WsBroadcaster } from '../src/web/ws-broadcast.js';
import { ScheduleService } from '../src/schedule/service.js';
import { ScheduleError } from '../src/schedule/errors.js';
import { InboxService } from '../src/inbox/service.js';
import { scheduleConfirmationInboxObserver } from '../src/inbox/schedule-confirmation-producer.js';

const START = Date.parse('2026-09-01T12:00:00.000Z');
const PROMPT = 'PROMPT_SECRET_do_not_copy';
const CRON_TRIGGER = { kind: 'cron' as const, expression: '30 9 * * *' };
const SUMMARY = 'Cron `30 9 * * *`';

class CapturingBroadcaster {
  messages: ServerToClientMessage[] = [];
  add() {}
  remove() {}
  send() {}
  broadcast(message: ServerToClientMessage): void { this.messages.push(message); }
  get size() { return 0; }
}

class FaultSink {
  failOpen = false;
  failClose = false;
  constructor(private readonly inner: InboxService) {}
  applySignal(input: unknown): unknown {
    const kind = typeof input === 'object' && input !== null && 'kind' in input
      ? (input as { kind?: unknown }).kind
      : undefined;
    if (kind === 'schedule.confirmation' && this.failOpen) throw new Error('inbox open failed');
    if (kind === 'schedule.confirmation.closed' && this.failClose) throw new Error('inbox close failed');
    return this.inner.applySignal(input);
  }
}

interface InboxStored {
  id: string;
  source_key: string;
  source_kind: string;
  status: string;
  generation: number;
  tombstone: number;
  title: string;
  summary: string;
  target_json: string;
  display_json: string;
  read_at: string | null;
}

interface Fixture {
  dir: string;
  db: Db;
  service: ScheduleService;
  inbox: InboxService;
  faults: FaultSink;
  broadcaster: CapturingBroadcaster;
  sessionId: string;
  clockMs: number;
  wakeCount: number;
}

function setup(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'schedule-confirmation-inbox-'));
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
    clockMs: START,
    wakeCount: 0,
    inbox: undefined as unknown as InboxService,
    faults: undefined as unknown as FaultSink,
    service: undefined as unknown as ScheduleService,
  };
  const inbox = new InboxService(db, { broadcast() {} });
  const faults = new FaultSink(inbox);
  const service = new ScheduleService({
    db,
    broadcaster: broadcaster as unknown as WsBroadcaster,
    wake: () => { fixture.wakeCount += 1; },
    now: () => ({ ms: fixture.clockMs, iso: new Date(fixture.clockMs).toISOString() }),
  });
  service.setConfirmationInbox(scheduleConfirmationInboxObserver(db, faults));
  fixture.inbox = inbox;
  fixture.faults = faults;
  fixture.service = service;
  return fixture;
}

function dispose(fx: Fixture): void {
  fx.db.close();
  rmSync(fx.dir, { recursive: true, force: true });
}

function create(fx: Fixture, domainId: string, toolRequestId: string) {
  return fx.service.createConfirmation({
    name: 'Morning digest',
    prompt: PROMPT,
    trigger: CRON_TRIGGER,
    timezone: 'UTC',
    controlSessionId: fx.sessionId,
    createdByActorId: 'internal-session:actor',
    scheduleDomainId: domainId,
    toolRequestId,
  });
}

function inboxRows(db: Db, confirmationId: string): InboxStored[] {
  return db.prepare(
    `SELECT id, source_key, source_kind, status, generation, tombstone, title, summary,
            target_json, display_json, read_at
       FROM inbox_items WHERE source_key = ?`,
  ).all(`schedule.confirmation:${confirmationId}`) as InboxStored[];
}

function oneInbox(db: Db, confirmationId: string): InboxStored {
  const rows = inboxRows(db, confirmationId);
  assert.equal(rows.length, 1);
  return rows[0]!;
}

function scheduleCount(db: Db, id: string): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM schedules WHERE id = ?').get(id) as { n: number };
  return row.n;
}

function retryOf(db: Db, confirmationId: string): { op: string; outcome: string | null; actor: string | null; detail: string } | undefined {
  return db.prepare(
    `SELECT op, outcome, actor, detail
       FROM schedule_confirmation_inbox_retries WHERE confirmation_id = ?`,
  ).get(confirmationId) as { op: string; outcome: string | null; actor: string | null; detail: string } | undefined;
}

function expectCode(run: () => void, code: string): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof ScheduleError);
    assert.equal(error.code, code);
    return true;
  });
}

function createdCount(messages: ServerToClientMessage[]): number {
  let count = 0;
  for (const message of messages) {
    if (message.type === 'schedule:changed' && message.reason === 'created') count += 1;
  }
  return count;
}

function confirmationCount(messages: ServerToClientMessage[], id: string): number {
  let count = 0;
  for (const message of messages) {
    if (message.type === 'schedule:confirmation' && message.confirmation.id === id) count += 1;
  }
  return count;
}

function refOf(row: InboxStored): { id: string; generation: number } {
  return { id: row.id, generation: row.generation };
}

test('migration 090 keeps inbox history and recreates the 088 search triggers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'inbox-090-upgrade-'));
  const raw = new Database(join(dir, 'gian.db'));
  let rawOpen = true;
  try {
    raw.pragma('journal_mode = WAL');
    raw.pragma('foreign_keys = ON');
    applyMigrationsBefore(raw, '090_inbox_schedule_confirmation.sql');
    const columnsBefore = raw.prepare('PRAGMA table_info(inbox_items)').all();
    const indexesBefore = namedIndexSql(raw);
    const triggersBefore = triggerSql(raw);
    const foreignKeysBefore = raw.prepare('PRAGMA foreign_key_list(inbox_items)').all();
    raw.prepare(
      `INSERT INTO inbox_items (
         id, source_key, source_kind, status, generation, revision, read_at, read_generation,
         notified_generation, title, summary, target_json, display_json, candidate_version,
         candidate_channel, skipped_version, skipped_channel, source_epoch, tombstone,
         created_at, updated_at, closed_at
       ) VALUES
       ('inbox-pending', 'session.question:pending', 'session.question', 'pending', 4, 2,
        NULL, NULL, 3, 'Need an answer', 'Which file?', '{"type":"unavailable","reason":"unknown"}',
        '{"kind":"session.question","interaction_id":"int-pending"}', NULL, NULL, NULL, NULL, NULL, 0,
        '2026-08-01T00:00:00.000Z', '2026-08-02T00:00:00.000Z', NULL),
       ('inbox-read', 'session.approval:done', 'session.approval', 'resolved', 2, 5,
        '2026-08-03T00:00:00.000Z', 2, 2, 'Approved command', 'ran', '{"type":"unavailable","reason":"unknown"}',
        '{"kind":"session.approval","interaction_id":"int-done","category":"command"}', NULL, NULL, NULL, NULL, NULL, 0,
        '2026-08-01T00:00:00.000Z', '2026-08-03T00:00:00.000Z', '2026-08-03T00:00:00.000Z'),
       ('inbox-tomb', 'product.update:integration:claude', 'product.update', 'expired', 1, 1,
        NULL, NULL, NULL, 'Update', 'closed', '{"type":"unavailable","reason":"unknown"}',
        '{"kind":"product.update","product":"integration","target_id":"claude","version":"1.0.0","channel":"stable","phase":"available","skipped_version":null}',
        '1.0.0', 'stable', NULL, NULL, 3, 1,
        '2026-08-01T00:00:00.000Z', '2026-08-04T00:00:00.000Z', '2026-08-04T00:00:00.000Z')`,
    ).run();
    raw.prepare('UPDATE inbox_meta SET revision = 7, collection_revision = 9 WHERE id = 1').run();
    raw.prepare(
      `INSERT INTO inbox_projection_facts (
         session_id, provider_event_id, turn_id, interaction_id, direction, occurrence_event_id,
         generation, bound, origin, source, writer, user_pending, user_source, applied
       ) VALUES ('sess-fact', 'evt-1', 'turn-1', 'int-1', 'open', 'evt-1', 1, 1, 'live', 'native', 'provider', 1, 1, 0)`,
    ).run();
    raw.prepare(
      `INSERT INTO inbox_source_epochs (source_key, epoch, version, channel, phase, catalog_sequence)
       VALUES ('product.update:integration:claude', 2, '1.2.3', 'stable', 'available', 4)`,
    ).run();
    const preserved = raw.prepare('SELECT * FROM inbox_items ORDER BY id').all();
    raw.close();
    rawOpen = false;

    const upgraded = openDatabase(dir);
    try {
      assert.deepEqual(upgraded.prepare('PRAGMA table_info(inbox_items)').all(), columnsBefore);
      assert.deepEqual(namedIndexSql(upgraded), indexesBefore);
      assert.deepEqual(triggerSql(upgraded), triggersBefore);
      assert.deepEqual(upgraded.prepare('PRAGMA foreign_key_list(inbox_items)').all(), foreignKeysBefore);
      assert.deepEqual(upgraded.prepare('SELECT * FROM inbox_items ORDER BY id').all(), preserved);
      const meta = upgraded.prepare('SELECT revision, collection_revision FROM inbox_meta WHERE id = 1').get() as {
        revision: number;
        collection_revision: number;
      };
      assert.deepEqual(meta, { revision: 7, collection_revision: 9 });
      const fact = upgraded.prepare(
        'SELECT session_id, source, writer, applied FROM inbox_projection_facts',
      ).get() as { session_id: string; source: string; writer: string; applied: number };
      assert.deepEqual(fact, { session_id: 'sess-fact', source: 'native', writer: 'provider', applied: 0 });
      const epoch = upgraded.prepare('SELECT epoch, version FROM inbox_source_epochs').get() as {
        epoch: number;
        version: string;
      };
      assert.deepEqual(epoch, { epoch: 2, version: '1.2.3' });
      const indexes = upgraded.prepare(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'inbox_projection_facts'`,
      ).all() as Array<{ name: string }>;
      assert.ok(indexes.some(index => index.name === 'inbox_projection_facts_unapplied'));
      assert.ok(indexes.some(index => index.name === 'inbox_projection_facts_occurrence'));
      const tableSql = (upgraded.prepare(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'inbox_items'`,
      ).get() as { sql: string }).sql;
      assert.equal(tableSql.includes("'schedule.confirmation'"), true);
      assert.equal(tableSql.includes("'session.question'"), true);
      assert.equal(tableSql.includes("'product.update'"), true);
      const applied = upgraded.prepare(
        `SELECT 1 AS ok FROM migrations WHERE filename = '090_inbox_schedule_confirmation.sql'`,
      ).get() as { ok: number } | undefined;
      assert.ok(applied);
      upgraded.prepare(
        `INSERT INTO inbox_items (
           id, source_key, source_kind, status, generation, revision, title, summary,
           target_json, display_json, tombstone, created_at, updated_at
         ) VALUES ('inbox-schedule', 'schedule.confirmation:conf-1', 'schedule.confirmation', 'pending', 1, 1,
           'Morning digest', 'Cron', '{"type":"schedule_confirmation","confirmation_id":"conf-1"}',
           '{"kind":"schedule.confirmation","confirmation_id":"conf-1","control_session_id":"sess-1"}',
           0, '2026-08-05T00:00:00.000Z', '2026-08-05T00:00:00.000Z')`,
      ).run();
      assert.throws(() => upgraded.prepare(
        `INSERT INTO inbox_items (
           id, source_key, source_kind, status, generation, revision, title, summary,
           target_json, display_json, tombstone, created_at, updated_at
         ) VALUES ('inbox-bad', 'schedule.confirmation:other', 'not-a-kind', 'pending', 1, 1,
           'x', 'y', '{}', '{}', 0, '2026-08-05T00:00:00.000Z', '2026-08-05T00:00:00.000Z')`,
      ).run());
      assert.throws(() => upgraded.prepare(
        `INSERT INTO inbox_items (
           id, source_key, source_kind, status, generation, revision, title, summary,
           target_json, display_json, tombstone, created_at, updated_at
         ) VALUES ('inbox-dup', 'session.question:pending', 'session.question', 'pending', 1, 1,
           'x', 'y', '{}', '{}', 0, '2026-08-05T00:00:00.000Z', '2026-08-05T00:00:00.000Z')`,
      ).run());
      upgraded.prepare(
        `DELETE FROM search_dirty WHERE kind = 'inbox' AND source_key = 'inbox-pending'`,
      ).run();
      upgraded.prepare(`UPDATE inbox_items SET title = title WHERE id = 'inbox-pending'`).run();
      const dirtyAfter = upgraded.prepare(
        `SELECT COUNT(*) AS n FROM search_dirty WHERE kind = 'inbox' AND source_key = 'inbox-pending'`,
      ).get() as { n: number };
      assert.equal(dirtyAfter.n, 1);
      const retries = upgraded.prepare(
        'SELECT COUNT(*) AS n FROM schedule_confirmation_inbox_retries',
      ).get() as { n: number };
      assert.equal(retries.n, 0);
    } finally {
      upgraded.close();
    }
  } finally {
    if (rawOpen) raw.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('opening a confirmation writes one generation-1 inbox row', () => {
  const fx = setup();
  try {
    const confirmation = create(fx, 'sched-open', 'tool-open');
    assert.equal(confirmation.status, 'pending');
    assert.equal('turn_id' in confirmation.payload.control_session, false);
    assert.equal(confirmation.payload.prompt, PROMPT);
    const row = oneInbox(fx.db, confirmation.id);
    assert.equal(row.source_kind, 'schedule.confirmation');
    assert.equal(row.source_key, `schedule.confirmation:${confirmation.id}`);
    assert.equal(row.status, 'pending');
    assert.equal(row.generation, 1);
    assert.equal(row.tombstone, 0);
    assert.equal(row.title, 'Morning digest');
    assert.equal(row.summary, SUMMARY);
    assert.equal(row.title.includes(PROMPT), false);
    assert.equal(row.summary.includes(PROMPT), false);
    assert.deepEqual(JSON.parse(row.target_json), {
      type: 'schedule_confirmation',
      confirmation_id: confirmation.id,
    });
    assert.deepEqual(JSON.parse(row.display_json), {
      kind: 'schedule.confirmation',
      confirmation_id: confirmation.id,
      control_session_id: fx.sessionId,
    });
    const item = fx.inbox.list().items.find(entry => entry.id === row.id);
    assert.ok(item);
    assert.deepEqual(item.actions, ['open', 'approve', 'reject']);
    const dirty = fx.db.prepare(
      `SELECT COUNT(*) AS n FROM search_dirty WHERE kind = 'inbox' AND source_key = ?`,
    ).get(row.id) as { n: number };
    assert.equal(dirty.n, 1);
    assert.equal(confirmationCount(fx.broadcaster.messages, confirmation.id), 1);
    assert.equal(retryOf(fx.db, confirmation.id), undefined);
  } finally {
    dispose(fx);
  }
});

test('approve with a matching inbox ref resolves generation 1 and creates the schedule once', () => {
  const fx = setup();
  try {
    const confirmation = create(fx, 'sched-approve', 'tool-approve');
    const row = oneInbox(fx.db, confirmation.id);
    const resolved = fx.service.resolveConfirmation({
      confirmationId: confirmation.id,
      decision: 'approve',
      expectedInbox: refOf(row),
    });
    assert.equal(resolved.status, 'approved');
    assert.equal(scheduleCount(fx.db, 'sched-approve'), 1);
    assert.equal(createdCount(fx.broadcaster.messages), 1);
    assert.equal(fx.wakeCount, 1);
    const closed = oneInbox(fx.db, confirmation.id);
    assert.equal(closed.id, row.id);
    assert.equal(closed.status, 'resolved');
    assert.equal(closed.generation, 1);
    assert.equal(closed.tombstone, 0);
    assert.ok(closed.read_at);
    const again = fx.service.resolveConfirmation({
      confirmationId: confirmation.id,
      decision: 'approve',
      expectedInbox: refOf(closed),
    });
    assert.equal(again.status, 'approved');
    assert.equal(scheduleCount(fx.db, 'sched-approve'), 1);
    assert.equal(createdCount(fx.broadcaster.messages), 1);
    assert.equal(fx.wakeCount, 1);
    expectCode(() => fx.service.resolveConfirmation({
      confirmationId: confirmation.id,
      decision: 'reject',
      expectedInbox: refOf(closed),
    }), 'PRECONDITION_FAILED');
    assert.equal(fx.service.getConfirmation(confirmation.id).status, 'approved');
  } finally {
    dispose(fx);
  }
});

test('a mismatched inbox ref does not resolve or create a schedule', () => {
  const fx = setup();
  try {
    const confirmation = create(fx, 'sched-stale', 'tool-stale');
    const row = oneInbox(fx.db, confirmation.id);
    expectCode(() => fx.service.resolveConfirmation({
      confirmationId: confirmation.id,
      decision: 'approve',
      expectedInbox: { id: row.id, generation: 2 },
    }), 'PRECONDITION_FAILED');
    expectCode(() => fx.service.resolveConfirmation({
      confirmationId: confirmation.id,
      decision: 'approve',
      expectedInbox: { id: randomUUID(), generation: 1 },
    }), 'PRECONDITION_FAILED');
    assert.equal(fx.service.getConfirmation(confirmation.id).status, 'pending');
    assert.equal(scheduleCount(fx.db, 'sched-stale'), 0);
    assert.equal(oneInbox(fx.db, confirmation.id).status, 'pending');
    expectCode(() => fx.service.resolveConfirmation({
      confirmationId: randomUUID(),
      decision: 'approve',
      expectedInbox: refOf(row),
    }), 'SCHEDULE_CONFIRMATION_NOT_FOUND');
    assert.equal(inboxRows(fx.db, confirmation.id).length, 1);
  } finally {
    dispose(fx);
  }
});

test('a stored reject is not returned as an approve when the inbox ref is present', () => {
  const fx = setup();
  try {
    const confirmation = create(fx, 'sched-decision', 'tool-decision');
    const row = oneInbox(fx.db, confirmation.id);
    const rejected = fx.service.resolveConfirmation({
      confirmationId: confirmation.id,
      decision: 'reject',
      expectedInbox: refOf(row),
    });
    assert.equal(rejected.status, 'rejected');
    assert.equal(scheduleCount(fx.db, 'sched-decision'), 0);
    const closed = oneInbox(fx.db, confirmation.id);
    assert.equal(closed.status, 'rejected');
    assert.equal(closed.generation, 1);
    expectCode(() => fx.service.resolveConfirmation({
      confirmationId: confirmation.id,
      decision: 'approve',
      expectedInbox: refOf(closed),
    }), 'PRECONDITION_FAILED');
    assert.equal(fx.service.getConfirmation(confirmation.id).status, 'rejected');
    assert.equal(scheduleCount(fx.db, 'sched-decision'), 0);
    const again = fx.service.resolveConfirmation({
      confirmationId: confirmation.id,
      decision: 'reject',
      expectedInbox: refOf(closed),
    });
    assert.equal(again.status, 'rejected');
    assert.equal(createdCount(fx.broadcaster.messages), 0);
  } finally {
    dispose(fx);
  }
});

test('omitted expected_inbox still returns the stored reject', () => {
  const fx = setup();
  try {
    const confirmation = create(fx, 'sched-omit', 'tool-omit');
    fx.service.resolveConfirmation({ confirmationId: confirmation.id, decision: 'reject' });
    const again = fx.service.resolveConfirmation({ confirmationId: confirmation.id, decision: 'approve' });
    assert.equal(again.status, 'rejected');
    assert.equal(scheduleCount(fx.db, 'sched-omit'), 0);
    assert.equal(oneInbox(fx.db, confirmation.id).generation, 1);
    assert.equal(oneInbox(fx.db, confirmation.id).status, 'rejected');
  } finally {
    dispose(fx);
  }
});

test('a pending confirmation past expiry expires in the resolve transaction and does not reopen', () => {
  const fx = setup();
  try {
    const matching = create(fx, 'sched-due', 'tool-due');
    const mismatched = create(fx, 'sched-due-mismatch', 'tool-due-mismatch');
    const matchRow = oneInbox(fx.db, matching.id);
    const mismatchRow = oneInbox(fx.db, mismatched.id);
    fx.clockMs += 30 * 60_000;
    expectCode(() => fx.service.resolveConfirmation({
      confirmationId: mismatched.id,
      decision: 'approve',
      expectedInbox: { id: mismatchRow.id, generation: 2 },
    }), 'PRECONDITION_FAILED');
    assert.equal(fx.service.getConfirmation(mismatched.id).status, 'pending');
    assert.equal(fx.service.getConfirmation(mismatched.id).resolved_at, null);
    assert.equal(oneInbox(fx.db, mismatched.id).status, 'pending');
    expectCode(() => fx.service.resolveConfirmation({
      confirmationId: matching.id,
      decision: 'approve',
      expectedInbox: refOf(matchRow),
    }), 'SCHEDULE_CONFIRMATION_EXPIRED');
    assert.equal(fx.service.getConfirmation(matching.id).status, 'expired');
    assert.equal(scheduleCount(fx.db, 'sched-due'), 0);
    const expired = oneInbox(fx.db, matching.id);
    assert.equal(expired.id, matchRow.id);
    assert.equal(expired.status, 'expired');
    assert.equal(expired.generation, 1);
    assert.equal(expired.tombstone, 0);
    fx.service.reconcileConfirmationInbox();
    const again = oneInbox(fx.db, matching.id);
    assert.equal(again.id, matchRow.id);
    assert.equal(again.generation, 1);
    assert.equal(again.status, 'expired');
  } finally {
    dispose(fx);
  }
});

test('an already expired confirmation stays expired for a matching ref and does not reopen', () => {
  const fx = setup();
  try {
    const confirmation = create(fx, 'sched-expired', 'tool-expired');
    const row = oneInbox(fx.db, confirmation.id);
    fx.clockMs += 30 * 60_000;
    fx.service.expireStaleConfirmations(new Date(fx.clockMs).toISOString());
    assert.equal(fx.service.getConfirmation(confirmation.id).status, 'expired');
    assert.equal(oneInbox(fx.db, confirmation.id).status, 'expired');
    expectCode(() => fx.service.resolveConfirmation({
      confirmationId: confirmation.id,
      decision: 'approve',
      expectedInbox: { id: row.id, generation: 2 },
    }), 'PRECONDITION_FAILED');
    assert.equal(fx.service.getConfirmation(confirmation.id).status, 'expired');
    expectCode(() => fx.service.resolveConfirmation({
      confirmationId: confirmation.id,
      decision: 'approve',
      expectedInbox: refOf(row),
    }), 'SCHEDULE_CONFIRMATION_EXPIRED');
    fx.service.reconcileConfirmationInbox();
    const closed = oneInbox(fx.db, confirmation.id);
    assert.equal(closed.id, row.id);
    assert.equal(closed.generation, 1);
    assert.equal(closed.status, 'expired');
    assert.equal(scheduleCount(fx.db, 'sched-expired'), 0);
  } finally {
    dispose(fx);
  }
});

test('reconcile restores a missing pending row and does not reopen a terminal confirmation', () => {
  const fx = setup();
  try {
    const pending = create(fx, 'sched-restore', 'tool-restore');
    const pendingRow = oneInbox(fx.db, pending.id);
    fx.db.prepare('DELETE FROM inbox_items WHERE id = ?').run(pendingRow.id);
    fx.service.reconcileConfirmationInbox();
    const restored = oneInbox(fx.db, pending.id);
    assert.equal(restored.status, 'pending');
    assert.equal(restored.generation, 1);
    assert.notEqual(restored.id, '');

    const rejected = create(fx, 'sched-gone', 'tool-gone');
    fx.service.resolveConfirmation({ confirmationId: rejected.id, decision: 'reject' });
    fx.db.prepare('DELETE FROM inbox_items WHERE source_key = ?').run(`schedule.confirmation:${rejected.id}`);
    fx.service.reconcileConfirmationInbox();
    assert.equal(inboxRows(fx.db, rejected.id).length, 0);

    const orphan = create(fx, 'sched-orphan', 'tool-orphan');
    const orphanRow = oneInbox(fx.db, orphan.id);
    fx.db.prepare('DELETE FROM schedule_confirmations WHERE id = ?').run(orphan.id);
    fx.service.reconcileConfirmationInbox();
    const closed = oneInbox(fx.db, orphan.id);
    assert.equal(closed.id, orphanRow.id);
    assert.equal(closed.status, 'expired');
    assert.equal(closed.generation, 1);
    assert.equal(closed.tombstone, 0);
  } finally {
    dispose(fx);
  }
});

test('a failed inbox open still returns the confirmation and the confirmation broadcast', () => {
  const fx = setup();
  try {
    fx.faults.failOpen = true;
    const confirmation = create(fx, 'sched-open-fault', 'tool-open-fault');
    assert.equal(confirmation.status, 'pending');
    assert.equal(confirmationCount(fx.broadcaster.messages, confirmation.id), 1);
    assert.equal(inboxRows(fx.db, confirmation.id).length, 0);
    assert.equal(fx.wakeCount, 0);
    const retry = retryOf(fx.db, confirmation.id);
    assert.ok(retry);
    assert.equal(retry.op, 'open');
    assert.equal(retry.outcome, null);
    assert.equal(retry.detail.includes(PROMPT), false);
    fx.faults.failOpen = false;
    const read = fx.service.getConfirmation(confirmation.id);
    assert.equal(read.status, 'pending');
    const row = oneInbox(fx.db, confirmation.id);
    assert.equal(row.generation, 1);
    assert.equal(row.status, 'pending');
    assert.equal(row.tombstone, 0);
    assert.equal(retryOf(fx.db, confirmation.id), undefined);
  } finally {
    dispose(fx);
  }
});

test('reconcile converges an open that failed after the confirmation was stored', () => {
  const fx = setup();
  try {
    fx.faults.failOpen = true;
    const confirmation = create(fx, 'sched-open-reconcile', 'tool-open-reconcile');
    assert.equal(inboxRows(fx.db, confirmation.id).length, 0);
    fx.faults.failOpen = false;
    fx.service.reconcileConfirmationInbox();
    const row = oneInbox(fx.db, confirmation.id);
    assert.equal(row.status, 'pending');
    assert.equal(row.generation, 1);
    assert.equal(retryOf(fx.db, confirmation.id), undefined);
    assert.equal(confirmationCount(fx.broadcaster.messages, confirmation.id), 1);
  } finally {
    dispose(fx);
  }
});

test('a failed approve close does not create a second schedule and a repeat resolve converges', () => {
  const fx = setup();
  try {
    const confirmation = create(fx, 'sched-close-fault', 'tool-close-fault');
    const row = oneInbox(fx.db, confirmation.id);
    fx.faults.failClose = true;
    const approved = fx.service.resolveConfirmation({
      confirmationId: confirmation.id,
      decision: 'approve',
      expectedInbox: refOf(row),
    });
    assert.equal(approved.status, 'approved');
    assert.equal(scheduleCount(fx.db, 'sched-close-fault'), 1);
    assert.equal(createdCount(fx.broadcaster.messages), 1);
    assert.equal(fx.wakeCount, 1);
    assert.equal(confirmationCount(fx.broadcaster.messages, confirmation.id), 2);
    assert.equal(oneInbox(fx.db, confirmation.id).status, 'pending');
    const retry = retryOf(fx.db, confirmation.id);
    assert.ok(retry);
    assert.equal(retry.op, 'close');
    assert.equal(retry.outcome, 'resolved');
    assert.equal(retry.actor, 'user');
    assert.equal(retry.detail.includes(PROMPT), false);
    const repeated = fx.service.resolveConfirmation({
      confirmationId: confirmation.id,
      decision: 'approve',
      expectedInbox: refOf(row),
    });
    assert.equal(repeated.status, 'approved');
    assert.equal(scheduleCount(fx.db, 'sched-close-fault'), 1);
    assert.equal(createdCount(fx.broadcaster.messages), 1);
    assert.equal(fx.wakeCount, 1);
    assert.equal(confirmationCount(fx.broadcaster.messages, confirmation.id), 2);
    assert.equal(oneInbox(fx.db, confirmation.id).status, 'pending');
    fx.faults.failClose = false;
    const converged = fx.service.resolveConfirmation({
      confirmationId: confirmation.id,
      decision: 'approve',
      expectedInbox: refOf(row),
    });
    assert.equal(converged.status, 'approved');
    const closed = oneInbox(fx.db, confirmation.id);
    assert.equal(closed.id, row.id);
    assert.equal(closed.status, 'resolved');
    assert.equal(closed.generation, 1);
    assert.equal(closed.tombstone, 0);
    assert.equal(scheduleCount(fx.db, 'sched-close-fault'), 1);
    assert.equal(createdCount(fx.broadcaster.messages), 1);
    assert.equal(fx.wakeCount, 1);
    assert.equal(retryOf(fx.db, confirmation.id), undefined);
  } finally {
    dispose(fx);
  }
});

test('reconcile converges a close that failed after the schedule commit', () => {
  const fx = setup();
  try {
    const confirmation = create(fx, 'sched-close-reconcile', 'tool-close-reconcile');
    const row = oneInbox(fx.db, confirmation.id);
    fx.faults.failClose = true;
    fx.service.resolveConfirmation({
      confirmationId: confirmation.id,
      decision: 'approve',
      expectedInbox: refOf(row),
    });
    assert.equal(scheduleCount(fx.db, 'sched-close-reconcile'), 1);
    assert.equal(oneInbox(fx.db, confirmation.id).status, 'pending');
    fx.faults.failClose = false;
    fx.service.reconcileConfirmationInbox();
    const closed = oneInbox(fx.db, confirmation.id);
    assert.equal(closed.id, row.id);
    assert.equal(closed.status, 'resolved');
    assert.equal(closed.generation, 1);
    assert.equal(scheduleCount(fx.db, 'sched-close-reconcile'), 1);
    assert.equal(createdCount(fx.broadcaster.messages), 1);
    assert.equal(fx.wakeCount, 1);
    assert.equal(retryOf(fx.db, confirmation.id), undefined);
  } finally {
    dispose(fx);
  }
});

function watchAttention(
  fx: Fixture,
  gate?: (kind: AttentionMessage['kind']) => boolean,
): AttentionMessage[] {
  const sent: AttentionMessage[] = [];
  fx.service.setConfirmationAttention((confirmation, inbox) => {
    publishFreshScheduleConfirmationAttention({
      db: fx.db,
      claim: (id, generation) => fx.inbox.claimNotification(id, generation),
      broadcast: message => { sent.push(message); },
      ...(gate ? { gate } : {}),
      confirmation,
      inbox,
    });
  });
  return sent;
}

function notifiedGeneration(db: Db, confirmationId: string): number | null {
  const row = db.prepare(
    `SELECT notified_generation AS generation FROM inbox_items WHERE source_key = ?`,
  ).get(`schedule.confirmation:${confirmationId}`) as { generation: number | null } | undefined;
  return row ? row.generation : null;
}

test('a new unread confirmation publishes approval attention without a turn', () => {
  const fx = setup();
  try {
    const sent = watchAttention(fx);
    const confirmation = create(fx, 'sched-os', 'tool-os');
    const row = oneInbox(fx.db, confirmation.id);
    assert.equal(sent.length, 1);
    const message = sent[0]!;
    assert.equal('turn' in message, false);
    assert.equal(isAttentionMessage(message), true);
    assert.equal(isScheduleConfirmationAttentionMessage(message), true);
    assert.equal(message.event, 'approval_needed');
    assert.equal(message.kind, 'approval');
    assert.equal(message.body, 'Approval needed');
    assert.equal(message.title, 'Control conversation');
    assert.equal(message.session_name, 'Control conversation');
    assert.equal(message.session_id, fx.sessionId);
    assert.equal(message.provider, 'claude');
    assert.deepEqual(message.target, {
      type: 'schedule_confirmation',
      confirmation_id: confirmation.id,
    });
    assert.deepEqual(message.inbox_ref, { id: row.id, generation: 1 });
    assert.equal(JSON.stringify(message).includes(PROMPT), false);
    assert.equal(notifiedGeneration(fx.db, confirmation.id), 1);
    assert.equal(isAttentionMessage({ ...message, turn: 1 }), false);
    fx.service.reconcileConfirmationInbox();
    fx.service.syncConfirmationInbox(confirmation.id);
    fx.service.getConfirmation(confirmation.id);
    fx.service.resolveConfirmation({ confirmationId: confirmation.id, decision: 'reject' });
    assert.equal(sent.length, 1);
    assert.equal(confirmationCount(fx.broadcaster.messages, confirmation.id), 1);
  } finally {
    dispose(fx);
  }
});

test('a failed open and a later reconcile do not publish schedule confirmation attention', () => {
  const fx = setup();
  try {
    const sent = watchAttention(fx);
    fx.faults.failOpen = true;
    const confirmation = create(fx, 'sched-os-fault', 'tool-os-fault');
    assert.equal(sent.length, 0);
    assert.equal(inboxRows(fx.db, confirmation.id).length, 0);
    assert.equal(confirmationCount(fx.broadcaster.messages, confirmation.id), 1);
    fx.faults.failOpen = false;
    fx.service.reconcileConfirmationInbox();
    assert.equal(oneInbox(fx.db, confirmation.id).generation, 1);
    assert.equal(sent.length, 0);
    assert.equal(notifiedGeneration(fx.db, confirmation.id), null);
  } finally {
    dispose(fx);
  }
});

test('a closed approval preference claims the confirmation and does not broadcast it', () => {
  const fx = setup();
  try {
    const sent = watchAttention(fx, () => false);
    const confirmation = create(fx, 'sched-os-gate', 'tool-os-gate');
    assert.equal(sent.length, 0);
    assert.equal(notifiedGeneration(fx.db, confirmation.id), 1);
    fx.service.reconcileConfirmationInbox();
    assert.equal(sent.length, 0);
  } finally {
    dispose(fx);
  }
});

test('a control session without a proxy plugin id does not publish confirmation attention', () => {
  const fx = setup();
  try {
    fx.db.prepare('UPDATE sessions SET executor = ? WHERE id = ?').run('shell', fx.sessionId);
    const sent = watchAttention(fx);
    const confirmation = create(fx, 'sched-os-executor', 'tool-os-executor');
    assert.equal(oneInbox(fx.db, confirmation.id).status, 'pending');
    assert.equal(sent.length, 0);
    assert.equal(notifiedGeneration(fx.db, confirmation.id), null);
    assert.equal(confirmationCount(fx.broadcaster.messages, confirmation.id), 1);
  } finally {
    dispose(fx);
  }
});

function namedIndexSql(db: Database.Database): Array<{ name: string; sql: string }> {
  return db.prepare(
    `SELECT name, sql FROM sqlite_master
      WHERE type = 'index' AND tbl_name = 'inbox_items' AND sql IS NOT NULL
      ORDER BY name`,
  ).all() as Array<{ name: string; sql: string }>;
}

function triggerSql(db: Database.Database): Array<{ name: string; sql: string }> {
  return db.prepare(
    `SELECT name, sql FROM sqlite_master
      WHERE type = 'trigger' AND tbl_name = 'inbox_items'
      ORDER BY name`,
  ).all() as Array<{ name: string; sql: string }>;
}

function applyMigrationsBefore(db: Database.Database, stopBefore: string): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      filename TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const dir = fileURLToPath(new URL('../migrations/', import.meta.url));
  const files = readdirSync(dir).filter(name => name.endsWith('.sql')).sort();
  const insert = db.prepare('INSERT INTO migrations (filename) VALUES (?)');
  for (const file of files) {
    if (file >= stopBefore) break;
    const sql = readFileSync(join(dir, file), 'utf8');
    const noTx = sql.slice(0, 200).includes('-- migration:no-transaction');
    if (noTx) {
      db.exec(sql);
      insert.run(file);
    } else {
      db.transaction(() => {
        db.exec(sql);
        insert.run(file);
      })();
    }
  }
}
