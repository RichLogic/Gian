// Inbox persistence: migration, source dedupe, generation CAS, read versus
// business status, reconcile, and notification-claim memory. NOT_RUN in this
// session. Producers are not wired here.

import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { WSContext } from 'hono/ws';
import { isInboxItemPublic, isInboxSyncSnapshot } from '@gian/shared';
import { attentionKindEnabled } from '../src/session/attention.js';
import { openDatabase, type Db } from '../src/storage/db.js';
import { InboxError, InboxService, type InboxWriteResult } from '../src/inbox/service.js';
import { InboxSignalError } from '../src/inbox/signal.js';
import { WsBroadcaster } from '../src/web/ws-broadcast.js';

interface Handle {
  dir: string;
  db: Db;
  service: InboxService;
  frames: Array<{ type: string }>;
  close: () => void;
}

function open(syncLimit?: number): Handle {
  const dir = mkdtempSync(join(tmpdir(), 'gian-inbox-'));
  const db = openDatabase(dir);
  let tick = 0;
  let seq = 0;
  const frames: Array<{ type: string }> = [];
  const service = new InboxService(db, {
    now: () => {
      tick += 1;
      const hours = String(Math.floor(tick / 3600)).padStart(2, '0');
      const minutes = String(Math.floor(tick / 60) % 60).padStart(2, '0');
      const seconds = String(tick % 60).padStart(2, '0');
      return `2026-10-09T${hours}:${minutes}:${seconds}.000Z`;
    },
    createId: () => `item-${String(++seq).padStart(2, '0')}`,
    broadcast: message => frames.push(message),
    ...(syncLimit ? { syncLimit } : {}),
  });
  return {
    dir,
    db,
    service,
    frames,
    close() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function question(
  id: string,
  generation = 1,
  title = 'Need a decision',
  summary = 'Choose one',
  sessionId = 'sess-1',
) {
  return {
    kind: 'session.question' as const,
    interaction_id: id,
    session_id: sessionId,
    turn: 2 as number | null,
    generation,
    title,
    summary,
  };
}

function approval(
  id: string,
  category: 'command' | 'permission' | 'browser' | 'plan' | 'schedule' = 'plan',
  sessionId = 'sess-1',
) {
  return {
    kind: 'session.approval' as const,
    interaction_id: id,
    session_id: sessionId,
    turn: 4,
    generation: 1,
    category,
    title: 'Approve plan',
    summary: 'Review the plan',
  };
}

function closeQuestion(
  id: string,
  generation: number,
  outcome: 'resolved' | 'cancelled' | 'expired',
  actor: 'user' | 'system',
  sessionId = 'sess-1',
) {
  return {
    kind: 'session.question.closed' as const,
    interaction_id: id,
    session_id: sessionId,
    generation,
    outcome,
    actor,
  };
}

function update(
  version: string,
  epoch: number,
  channel = 'stable',
  phase: 'available' | 'downloaded' | 'failed' = 'available',
  target = 'gian',
) {
  return {
    kind: 'product.update' as const,
    product: target === 'gian' ? 'gian' as const : 'integration' as const,
    target_id: target,
    version,
    channel,
    epoch,
    phase,
    title: 'Update available',
    summary: `${version} on ${channel}`,
  };
}

function mustItem(result: InboxWriteResult) {
  assert.ok(result.item);
  return result.item;
}

function rowCount(db: Db): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM inbox_items').get() as { n: number }).n;
}

function readGeneration(db: Db, id: string): number | null {
  const row = db.prepare('SELECT read_generation FROM inbox_items WHERE id = ?').get(id) as { read_generation: number | null };
  return row.read_generation;
}

function sourceEpoch(db: Db, id: string): number | null {
  const row = db.prepare('SELECT source_epoch FROM inbox_items WHERE id = ?').get(id) as { source_epoch: number | null };
  return row.source_epoch;
}

function tombstoneFlag(db: Db, id: string): number {
  const row = db.prepare('SELECT tombstone FROM inbox_items WHERE id = ?').get(id) as { tombstone: number };
  return row.tombstone;
}

function itemStamp(db: Db, id: string) {
  return db.prepare(
    `SELECT revision, updated_at, source_epoch, generation, status, title
     FROM inbox_items WHERE id = ?`,
  ).get(id) as {
    revision: number;
    updated_at: string;
    source_epoch: number | null;
    generation: number;
    status: string;
    title: string;
  };
}

test('migration creates inbox tables and revision 0', () => {
  const handle = open();
  try {
    const names = handle.db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('inbox_items', 'inbox_meta') ORDER BY name`,
    ).all() as Array<{ name: string }>;
    assert.deepEqual(names.map(row => row.name), ['inbox_items', 'inbox_meta']);
    const revision = handle.db.prepare(
      'SELECT revision, collection_revision FROM inbox_meta WHERE id = 1',
    ).get() as { revision: number; collection_revision: number };
    assert.equal(revision.revision, 0);
    assert.equal(revision.collection_revision, 0);
    const columns = handle.db.prepare('PRAGMA table_info(inbox_items)').all() as Array<{ name: string }>;
    const nameset = new Set(columns.map(column => column.name));
    assert.equal(nameset.has('payload'), false);
    assert.equal(nameset.has('command'), false);
    assert.equal(nameset.has('read_at'), true);
    assert.equal(nameset.has('source_key'), true);
    assert.equal(nameset.has('source_epoch'), true);
    assert.equal(nameset.has('tombstone'), true);
  } finally {
    handle.close();
  }
});

test('duplicate source updates one row and an identical replay does not bump revision or clear read', () => {
  const handle = open();
  try {
    const created = mustItem(handle.service.applySignal(question('q-1')));
    handle.service.markRead(created.id, created.generation);
    const revision = handle.service.count().inbox_revision;
    const frames = handle.frames.length;
    const again = handle.service.applySignal(question('q-1'));
    assert.equal(again.outcome, 'duplicate');
    assert.equal(again.item?.id, created.id);
    assert.equal(rowCount(handle.db), 1);
    assert.equal(handle.service.count().inbox_revision, revision);
    assert.equal(handle.frames.length, frames);
    assert.equal(handle.service.get(created.id).read_at !== null, true);
    const other = mustItem(handle.service.applySignal(question('q-2')));
    assert.notEqual(other.id, created.id);
    assert.equal(rowCount(handle.db), 2);
  } finally {
    handle.close();
  }
});

test('same session keeps distinct interactions, and plan approval is one item', () => {
  const handle = open();
  try {
    const first = mustItem(handle.service.applySignal(question('q-1')));
    const second = mustItem(handle.service.applySignal(question('q-2')));
    handle.service.resolve(closeQuestion('q-1', 1, 'resolved', 'user'));
    assert.equal(handle.service.get(first.id).status, 'resolved');
    assert.equal(handle.service.get(second.id).status, 'pending');
    const plan = mustItem(handle.service.applySignal(approval('apr-1', 'plan')));
    const changed = mustItem(handle.service.applySignal({ ...approval('apr-1', 'command'), summary: 'Run the command' }));
    assert.equal(changed.id, plan.id);
    assert.equal(changed.display.kind, 'session.approval');
    if (changed.display.kind === 'session.approval') assert.equal(changed.display.category, 'command');
    assert.equal(rowCount(handle.db), 3);
  } finally {
    handle.close();
  }
});

test('late older generation does not reopen a terminal item or mark the newer generation read', () => {
  const handle = open();
  try {
    const created = mustItem(handle.service.applySignal(question('q-1', 2)));
    const resolved = handle.service.resolve(closeQuestion('q-1', 2, 'resolved', 'user'));
    const readAt = mustItem(resolved).read_at;
    const revision = handle.service.count().inbox_revision;
    const late = handle.service.applySignal(question('q-1', 1));
    assert.equal(late.outcome, 'stale');
    assert.equal(late.item?.status, 'resolved');
    assert.equal(late.item?.generation, 2);
    assert.equal(late.item?.read_at, readAt);
    assert.equal(handle.service.count().inbox_revision, revision);
    assert.throws(
      () => handle.service.markRead(created.id, 1),
      (error: unknown) => error instanceof InboxError && error.code === 'STALE',
    );
    assert.equal(handle.service.get(created.id).read_at, readAt);
    const newer = handle.service.applySignal(question('q-1', 3, 'Fresh', 'Again'));
    assert.equal(newer.outcome, 'reopened');
    assert.equal(newer.item?.status, 'pending');
    assert.equal(newer.item?.generation, 3);
    assert.equal(newer.item?.read_at, null);
    const olderClose = handle.service.resolve(closeQuestion('q-1', 2, 'cancelled', 'system'));
    assert.equal(olderClose.outcome, 'stale');
    assert.equal(handle.service.get(created.id).status, 'pending');
    assert.equal(handle.service.get(created.id).generation, 3);
  } finally {
    handle.close();
  }
});

test('equal-generation content keeps read, and a newer generation clears it', () => {
  const handle = open();
  try {
    const created = mustItem(handle.service.applySignal(question('q-1', 1, 'One', 'Body')));
    const read = handle.service.markRead(created.id, 1);
    const updated = mustItem(handle.service.applySignal(question('q-1', 1, 'One more', 'Body')));
    assert.equal(updated.status, 'pending');
    assert.equal(updated.read_at, read.read_at);
    assert.equal(updated.unread, false);
    assert.equal(updated.revision, read.revision + 1);
    const reopenedResult = handle.service.applySignal(question('q-1', 3, 'Fresh', 'Body'));
    assert.equal(reopenedResult.outcome, 'reopened');
    const reopened = mustItem(reopenedResult);
    assert.equal(reopened.generation, 3);
    assert.equal(reopened.read_at, null);
    assert.equal(reopened.unread, true);
    assert.equal(reopened.status, 'pending');
    assert.throws(
      () => handle.service.markRead(reopened.id, 1),
      (error: unknown) => error instanceof InboxError && error.code === 'STALE',
    );
    assert.equal(handle.service.get(reopened.id).read_at, null);
    const marked = handle.service.markRead(reopened.id, 3);
    assert.equal(marked.unread, false);
    assert.equal(marked.status, 'pending');
  } finally {
    handle.close();
  }
});

test('user resolve reads the item, system resolve and reconcile do not', () => {
  const handle = open();
  try {
    mustItem(handle.service.applySignal(question('q-user')));
    const userClosed = mustItem(handle.service.resolve(closeQuestion('q-user', 1, 'resolved', 'user')));
    assert.equal(userClosed.status, 'resolved');
    assert.notEqual(userClosed.read_at, null);
    assert.equal(userClosed.actions.includes('answer'), false);

    const systemItem = mustItem(handle.service.applySignal(question('q-system')));
    const expired = mustItem(handle.service.resolve(closeQuestion('q-system', 1, 'expired', 'system')));
    assert.equal(expired.status, 'expired');
    assert.equal(expired.read_at, null);
    assert.equal(expired.unread, true);
    const again = handle.service.resolve(closeQuestion('q-system', 1, 'expired', 'user'));
    assert.equal(again.outcome, 'duplicate');
    assert.equal(handle.service.get(systemItem.id).read_at, null);
    const conflict = handle.service.resolve(closeQuestion('q-system', 1, 'resolved', 'user'));
    assert.equal(conflict.outcome, 'stale');
    assert.equal(handle.service.get(systemItem.id).status, 'expired');
    assert.equal(handle.service.get(systemItem.id).read_at, null);

    const live = mustItem(handle.service.applySignal(question('q-live')));
    const quiet = handle.frames.length;
    const same = handle.service.reconcile({
      scope: 'session.question',
      mode: 'complete',
      snapshot_revision: handle.service.collectionRevision(),
      live: [question('q-live')],
    });
    assert.equal(same.changed, 0);
    assert.equal(handle.frames.length, quiet);
    assert.equal(handle.service.get(live.id).read_at, null);
    assert.equal(handle.service.get(live.id).status, 'pending');

    const other = mustItem(handle.service.applySignal(question('q-other')));
    const reconciled = handle.service.reconcile({
      scope: 'session.question',
      mode: 'complete',
      snapshot_revision: handle.service.collectionRevision(),
      live: [question('q-live')],
    });
    assert.equal(reconciled.changed, 1);
    assert.equal(handle.service.get(other.id).status, 'expired');
    assert.equal(handle.service.get(other.id).read_at, null);
    assert.equal(handle.service.get(live.id).status, 'pending');

    mustItem(handle.service.applySignal(question('q-also')));
    const before = handle.service.count().inbox_revision;
    const wiped = handle.service.reconcile({
      scope: 'session.question',
      mode: 'complete',
      snapshot_revision: handle.service.collectionRevision(),
      live: [],
    });
    assert.equal(wiped.changed >= 2, true);
    assert.equal(handle.frames.at(-1)?.type, 'inbox:invalidated');
    assert.equal(handle.service.get(live.id).status, 'expired');
    assert.equal(handle.service.get(live.id).read_at, null);
    assert.equal(handle.service.count().pending_count, 0);
    assert.equal(handle.service.count().inbox_revision > before, true);
  } finally {
    handle.close();
  }
});

test('completion signals do not enter, and reconcile rejects them without expiring', () => {
  const handle = open();
  try {
    const pending = mustItem(handle.service.applySignal(question('q-1')));
    const revision = handle.service.count().inbox_revision;
    for (const kind of [
      'session.turn_completed',
      'session.turn_failed',
      'session.stopped',
      'session.retry',
      'session.streaming',
    ]) {
      const ignored = handle.service.applySignal({ kind });
      assert.equal(ignored.outcome, 'ignored');
      assert.equal(ignored.item, null);
    }
    assert.throws(
      () => handle.service.upsert({ kind: 'session.turn_completed' }),
      (error: unknown) => error instanceof InboxError && error.code === 'INVALID_ARGUMENT',
    );
    assert.throws(
      () => handle.service.reconcile({
        scope: 'session.question',
        mode: 'complete',
        snapshot_revision: handle.service.collectionRevision(),
        live: [question('q-1'), { kind: 'session.turn_completed' }],
      }),
      (error: unknown) => error instanceof InboxError && error.code === 'INVALID_ARGUMENT',
    );
    assert.equal(handle.service.get(pending.id).status, 'pending');
    assert.equal(handle.service.count().inbox_revision, revision);
    assert.equal(rowCount(handle.db), 1);
  } finally {
    handle.close();
  }
});

test('unknown kinds and unknown targets create no row', () => {
  const handle = open();
  try {
    assert.throws(
      () => handle.service.applySignal({ kind: 'notes.custom' }),
      (error: unknown) => error instanceof InboxSignalError && error.code === 'INVALID_SOURCE',
    );
    assert.throws(
      () => handle.service.applySignal({ type: 'current' }),
      (error: unknown) => error instanceof InboxSignalError,
    );
    assert.throws(
      () => handle.service.applySignal({
        kind: 'session.question',
        interaction_id: 'q-1',
        turn: 1,
        generation: 1,
        title: 'Missing session',
        summary: 'No target',
      }),
      (error: unknown) => error instanceof InboxSignalError,
    );
    assert.throws(
      () => handle.service.applySignal({
        kind: 'session.question.closed',
        interaction_id: 'q-1',
        session_id: 'sess-1',
        generation: 1,
        outcome: 'rejected',
        actor: 'user',
      }),
      (error: unknown) => error instanceof InboxSignalError,
    );
    assert.equal(rowCount(handle.db), 0);
    const created = mustItem(handle.service.applySignal({
      ...question('q-1'),
      command: 'rm -rf /',
      token: 'secret-token',
      payload: { raw: true },
    }));
    assert.equal(isInboxItemPublic(created), true);
    assert.equal('command' in created, false);
    assert.equal('token' in created, false);
    assert.equal('payload' in created, false);
    const stored = JSON.stringify(handle.db.prepare(
      'SELECT title, summary, target_json, display_json FROM inbox_items',
    ).get());
    assert.equal(stored.includes('command'), false);
    assert.equal(stored.includes('secret-token'), false);
    assert.equal(stored.includes('rm -rf'), false);
    const long = mustItem(handle.service.applySignal(question('q-long', 1, 'A'.repeat(200), 'B'.repeat(400))));
    assert.equal(Array.from(long.title).length, 120);
    assert.equal(Array.from(long.summary).length, 280);
  } finally {
    handle.close();
  }
});

test('claim is once per generation, survives restart, and unread does not rearm it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gian-inbox-restart-'));
  const db = openDatabase(dir);
  try {
    const first = new InboxService(db, {
      now: () => '2026-10-09T00:00:01.000Z',
      createId: () => 'item-restart',
    });
    const created = mustItem(first.applySignal(question('q-1')));
    assert.deepEqual(first.claimNotification(created.id, 1), { emit: true, reason: 'ok' });
    assert.equal(first.claimNotification(created.id, 1).emit, false);
    assert.equal(first.count().inbox_revision, 1);
    db.close();

    const reopened = openDatabase(dir);
    try {
      const second = new InboxService(reopened, {
        now: () => '2026-10-09T00:00:02.000Z',
        createId: () => 'unused',
      });
      const stored = reopened.prepare(
        'SELECT read_at, notified_generation FROM inbox_items WHERE id = ?',
      ).get('item-restart') as { read_at: string | null; notified_generation: number };
      assert.equal(stored.read_at, null);
      assert.equal(stored.notified_generation, 1);
      assert.equal(second.claimNotification('item-restart', 1).emit, false);
      second.markRead('item-restart', 1);
      second.markUnread('item-restart', 1);
      assert.equal(second.get('item-restart').unread, true);
      assert.equal(second.get('item-restart').status, 'pending');
      assert.equal(second.claimNotification('item-restart', 1).reason, 'notified');
      const fresh = mustItem(second.applySignal(question('q-1', 2, 'Next', 'Body')));
      assert.equal(fresh.read_at, null);
      assert.deepEqual(second.claimNotification(fresh.id, 2), { emit: true, reason: 'ok' });
      assert.equal(second.claimNotification(fresh.id, 2).emit, false);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('read before claim suppresses emission, and a disabled attention gate still stores inbox', () => {
  const handle = open();
  try {
    assert.equal(attentionKindEnabled({
      enabled: false,
      session_done: true,
      approval_needed: true,
      errors: true,
    }, 'question'), false);
    const created = mustItem(handle.service.applySignal(question('q-gated')));
    assert.equal(handle.service.count().pending_count, 1);
    handle.service.markRead(created.id, 1);
    assert.equal(handle.service.claimNotification(created.id, 1).reason, 'read');
    const repair = mustItem(handle.service.applySignal({
      kind: 'system.repair',
      scope: 'runtime',
      subject_id: 'claude',
      fault_generation: 4,
      title: 'Runtime missing',
      summary: 'Repair Claude',
    }));
    assert.equal(repair.generation, 4);
    assert.equal(repair.target.type, 'system_repair');
    const same = handle.service.applySignal({
      kind: 'system.repair',
      scope: 'runtime',
      subject_id: 'claude',
      fault_generation: 4,
      title: 'Runtime missing',
      summary: 'Repair Claude',
    });
    assert.equal(same.outcome, 'duplicate');
    assert.equal(same.item?.id, repair.id);
  } finally {
    handle.close();
  }
});

test('update identity is one row per product, skip blocks older versions, and phase does not unread', () => {
  const handle = open();
  try {
    const created = mustItem(handle.service.applySignal(update('1.2.2', 1)));
    assert.equal(created.generation, 1);
    assert.equal(created.target.type, 'update');
    const read = handle.service.markRead(created.id, 1);
    const phaseResult = handle.service.applySignal(update('1.2.2', 2, 'stable', 'downloaded'));
    assert.equal(phaseResult.outcome, 'updated');
    const phase = mustItem(phaseResult);
    assert.equal(phase.id, created.id);
    assert.equal(phase.generation, 1);
    assert.equal(phase.read_at, read.read_at);
    assert.equal(phase.unread, false);
    if (phase.display.kind === 'product.update') assert.equal(phase.display.phase, 'downloaded');
    assert.equal(handle.service.claimNotification(created.id, 1).emit, false);

    const higherResult = handle.service.applySignal(update('1.2.10', 3));
    assert.equal(higherResult.outcome, 'reopened');
    const higher = mustItem(higherResult);
    assert.equal(higher.id, created.id);
    assert.equal(higher.generation, 2);
    assert.equal(higher.unread, true);
    assert.equal(higher.status, 'pending');
    const downgrade = handle.service.applySignal(update('1.2.3', 4));
    assert.equal(downgrade.outcome, 'stale');
    const current = handle.service.get(created.id);
    assert.equal(current.generation, 2);
    assert.equal(current.unread, true);
    if (current.target.type === 'update') assert.equal(current.target.version, '1.2.10');
    if (current.display.kind === 'product.update') assert.equal(current.display.version, '1.2.10');

    handle.service.skipVersion(created.id, 2, '1.2.10');
    const skipped = handle.service.get(created.id);
    assert.equal(skipped.status, 'cancelled');
    assert.notEqual(skipped.read_at, null);
    assert.equal(handle.service.count().pending_count, 0);
    assert.equal(handle.service.applySignal(update('1.2.10', 5)).outcome, 'terminal');
    assert.equal(handle.service.applySignal(update('1.2.2', 6)).outcome, 'skipped');
    assert.equal(handle.service.get(created.id).status, 'cancelled');
    const next = mustItem(handle.service.applySignal(update('1.3.0', 7)));
    assert.equal(next.id, created.id);
    assert.equal(next.generation, 3);
    assert.equal(next.unread, true);
    assert.equal(next.status, 'pending');
    const otherChannel = mustItem(handle.service.applySignal(update('0.9.0', 8, 'beta')));
    assert.equal(otherChannel.id, created.id);
    assert.equal(otherChannel.unread, true);
    assert.equal(otherChannel.target.type === 'update' && otherChannel.target.channel, 'beta');

    const staleClose = handle.service.resolve({
      kind: 'product.update.closed',
      product: 'gian',
      target_id: 'gian',
      version: '1.3.0',
      channel: 'stable',
      generation: otherChannel.generation,
      epoch: 9,
      outcome: 'resolved',
      actor: 'system',
    });
    assert.equal(staleClose.outcome, 'stale');
    assert.equal(handle.service.get(created.id).status, 'pending');
    const installed = mustItem(handle.service.resolve({
      kind: 'product.update.closed',
      product: 'gian',
      target_id: 'gian',
      version: '0.9.0',
      channel: 'beta',
      generation: otherChannel.generation,
      epoch: 8,
      outcome: 'resolved',
      actor: 'system',
    }));
    assert.equal(installed.status, 'resolved');
    assert.equal(installed.read_at, null);

    const integration = mustItem(handle.service.applySignal(update('2.0.0', 1, 'stable', 'available', 'io.gian.example')));
    assert.notEqual(integration.id, created.id);
    const moved = mustItem(handle.service.applySignal(update('2.1.0', 2, 'stable', 'available', 'io.gian.example')));
    assert.equal(moved.id, integration.id);
    assert.throws(
      () => handle.service.applySignal({ ...update('1.0.0', 1), phase: 'installed' }),
      (error: unknown) => error instanceof InboxSignalError,
    );
    assert.throws(
      () => handle.service.applySignal({ ...update('1.0.0', 1), target_id: 'desktop' }),
      (error: unknown) => error instanceof InboxSignalError,
    );
    const failed = mustItem(handle.service.applySignal(update('3.0.0', 1, 'stable', 'failed', 'io.gian.other')));
    assert.equal(failed.actions.includes('retry'), true);
    assert.equal(failed.actions.includes('skip_version'), true);
    assert.equal(failed.actions.includes('approve'), false);
  } finally {
    handle.close();
  }
});

test('an untouched page cursor returns the remaining rows once', () => {
  const handle = open(1);
  try {
    mustItem(handle.service.applySignal(question('q-1')));
    mustItem(handle.service.applySignal(question('q-2')));
    mustItem(handle.service.applySignal(question('q-3')));
    const page = handle.service.list({ limit: 2 });
    assert.deepEqual(page.items.map(item => item.id), ['item-03', 'item-02']);
    assert.equal(page.pending_count, 3);
    assert.ok(page.next_cursor);
    const rest = handle.service.list({ limit: 2, cursor: page.next_cursor });
    assert.deepEqual(rest.items.map(item => item.id), ['item-01']);
    assert.equal(rest.next_cursor, null);
    const overlap = page.items.map(item => item.id).filter(id => rest.items.some(item => item.id === id));
    assert.deepEqual(overlap, []);
    const longForm = Buffer.from(JSON.stringify({
      updated_at: page.items[1]!.updated_at,
      id: page.items[1]!.id,
      revision: page.inbox_revision,
      status: 'pending',
    }), 'utf8').toString('base64url');
    const fromLong = handle.service.list({ limit: 10, cursor: longForm });
    assert.deepEqual(fromLong.items.map(item => item.id), ['item-01']);
    const raw = Buffer.from(JSON.stringify({
      updated_at: page.items[0]!.updated_at,
      id: page.items[0]!.id,
    }), 'utf8').toString('base64url');
    assert.throws(
      () => handle.service.list({ limit: 10, cursor: raw }),
      (error: unknown) => error instanceof InboxError && error.code === 'INVALID_ARGUMENT',
    );
    assert.throws(
      () => handle.service.list({ cursor: '%%%' }),
      (error: unknown) => error instanceof InboxError && error.code === 'INVALID_ARGUMENT',
    );
    assert.throws(
      () => handle.service.list({ status: 'closed', cursor: page.next_cursor }),
      (error: unknown) => error instanceof InboxError && error.code === 'STALE' && /status/.test(error.message),
    );
    assert.throws(
      () => handle.service.list({ status: 'all', cursor: page.next_cursor }),
      (error: unknown) => error instanceof InboxError && error.code === 'STALE' && /status/.test(error.message),
    );
    const snapshot = handle.service.syncSnapshot();
    assert.equal(isInboxSyncSnapshot(snapshot), true);
    assert.equal(snapshot.truncated, true);
    assert.equal(snapshot.items.length, 1);
    assert.equal(snapshot.pending_count, 3);
    assert.equal(snapshot.items[0]?.id, 'item-03');
    handle.service.resolve(closeQuestion('q-3', 1, 'cancelled', 'system'));
    assert.equal(handle.service.count().pending_count, 2);
    assert.equal(handle.service.list({ status: 'closed' }).items[0]?.id, 'item-03');
    assert.equal(handle.service.list({ status: 'closed' }).items[0]?.read_at, null);
  } finally {
    handle.close();
  }
});

test('session expiry strips the target without claiming a read, and attention sockets do not receive inbox', () => {
  const handle = open();
  try {
    const gone = mustItem(handle.service.applySignal({
      ...question('q-1', 1, 'Run this', 'rm -rf /secret-token'),
      session_id: 'sess-1',
    }));
    const kept = mustItem(handle.service.applySignal(question('q-2', 1, 'Stay', 'Keep', 'sess-2')));
    const expired = handle.service.expireSession('sess-1');
    assert.equal(expired.changed, 1);
    const closed = handle.service.get(gone.id);
    assert.equal(closed.status, 'expired');
    assert.equal(closed.read_at, null);
    assert.equal(closed.title, 'Session unavailable');
    assert.equal(closed.summary, 'This session is no longer available.');
    assert.deepEqual(closed.target, { type: 'unavailable', reason: 'missing' });
    assert.deepEqual(closed.actions, []);
    assert.equal(JSON.stringify(closed).includes('secret-token'), false);
    assert.equal(handle.service.get(kept.id).status, 'pending');
    assert.equal(handle.service.claimNotification(gone.id, gone.generation).reason, 'closed');

    const broadcaster = new WsBroadcaster();
    const attention: string[] = [];
    const full: string[] = [];
    const attentionWs = {
      send(value: string) { attention.push(value); },
      close() {},
    } as unknown as WSContext;
    const fullWs = {
      send(value: string) { full.push(value); },
      close() {},
    } as unknown as WSContext;
    broadcaster.add(attentionWs, 'attention');
    broadcaster.add(fullWs, 'full');
    const wired = new InboxService(handle.db, {
      now: () => '2026-10-09T03:00:00.000Z',
      createId: () => 'item-wire',
      broadcast: message => broadcaster.broadcast(message),
    });
    wired.applySignal(question('q-wire', 1, 'Wire', 'Body', 'sess-9'));
    assert.deepEqual(attention, []);
    assert.equal(JSON.parse(full[0]!).type, 'inbox:changed');
    assert.equal(full.some(frame => JSON.parse(frame).type === 'attention'), false);
  } finally {
    handle.close();
  }
});

test('pairing has its own target and repair generations share one subject row', () => {
  const handle = open();
  try {
    const pairing = mustItem(handle.service.applySignal({
      kind: 'system.pairing',
      request_id: 'pair-1',
      generation: 1,
      title: 'New device',
      summary: 'Authorize this device',
    }));
    assert.deepEqual(pairing.target, { type: 'pairing', request_id: 'pair-1' });
    assert.deepEqual(pairing.actions, ['open', 'approve', 'reject']);
    const repair = mustItem(handle.service.applySignal({
      kind: 'system.repair',
      scope: 'account',
      subject_id: 'acct-1',
      fault_generation: 1,
      title: 'Sign in again',
      summary: 'The account needs attention',
    }));
    const next = mustItem(handle.service.applySignal({
      kind: 'system.repair',
      scope: 'account',
      subject_id: 'acct-1',
      fault_generation: 2,
      title: 'Sign in again',
      summary: 'Still needs attention',
    }));
    assert.equal(next.id, repair.id);
    assert.equal(next.generation, 2);
    assert.equal(rowCount(handle.db), 2);
  } finally {
    handle.close();
  }
});

test('the same interaction id in two sessions stays isolated', () => {
  const handle = open();
  try {
    const left = mustItem(handle.service.applySignal(question('shared', 1, 'Left', 'L', 'sess-a')));
    const right = mustItem(handle.service.applySignal(question('shared', 1, 'Right', 'R', 'sess-b')));
    assert.notEqual(left.id, right.id);
    const keys = handle.db.prepare(
      'SELECT source_key FROM inbox_items ORDER BY source_key',
    ).all() as Array<{ source_key: string }>;
    assert.deepEqual(keys.map(row => row.source_key), [
      'session.question:6:sess-a6:shared',
      'session.question:6:sess-b6:shared',
    ]);
    assert.throws(
      () => handle.service.resolve({
        kind: 'session.question.closed',
        interaction_id: 'shared',
        generation: 1,
        outcome: 'resolved',
        actor: 'user',
      }),
      (error: unknown) => error instanceof InboxSignalError,
    );
    assert.equal(handle.service.get(left.id).status, 'pending');
    assert.equal(handle.service.get(right.id).status, 'pending');

    const read = handle.service.markRead(left.id, 1);
    assert.notEqual(read.read_at, null);
    assert.equal(handle.service.get(right.id).read_at, null);
    assert.equal(handle.service.get(right.id).unread, true);

    const closed = mustItem(handle.service.resolve(closeQuestion('shared', 1, 'resolved', 'user', 'sess-a')));
    assert.equal(closed.id, left.id);
    assert.equal(closed.status, 'resolved');
    assert.equal(handle.service.get(right.id).status, 'pending');
    assert.equal(handle.service.get(right.id).title, 'Right');

    const other = mustItem(handle.service.resolve(closeQuestion('shared', 1, 'cancelled', 'system', 'sess-b')));
    assert.equal(other.id, right.id);
    assert.equal(other.status, 'cancelled');
    assert.equal(handle.service.get(left.id).status, 'resolved');
    assert.equal(handle.service.get(left.id).read_at, read.read_at);

    const leftApproval = mustItem(handle.service.applySignal(approval('apr', 'plan', 'sess-a')));
    const rightApproval = mustItem(handle.service.applySignal(approval('apr', 'command', 'sess-b')));
    assert.notEqual(leftApproval.id, rightApproval.id);
    handle.service.resolve({
      kind: 'session.approval.closed',
      interaction_id: 'apr',
      session_id: 'sess-a',
      generation: 1,
      outcome: 'rejected',
      actor: 'user',
    });
    assert.equal(handle.service.get(leftApproval.id).status, 'rejected');
    const rightView = handle.service.get(rightApproval.id);
    assert.equal(rightView.status, 'pending');
    assert.equal(rightView.display.kind === 'session.approval' && rightView.display.category, 'command');
  } finally {
    handle.close();
  }
});

test('colon-bearing session and interaction ids do not share a question or approval row', () => {
  const handle = open();
  try {
    const leftQuestion = mustItem(handle.service.applySignal(question('c', 1, 'Left', 'L', 'a:b')));
    const rightQuestion = mustItem(handle.service.applySignal(question('b:c', 1, 'Right', 'R', 'a')));
    assert.notEqual(leftQuestion.id, rightQuestion.id);
    assert.equal(leftQuestion.target.type === 'session' && leftQuestion.target.interaction_id, 'c');
    assert.equal(rightQuestion.target.type === 'session' && rightQuestion.target.interaction_id, 'b:c');
    assert.equal(leftQuestion.display.kind === 'session.question' && leftQuestion.display.interaction_id, 'c');
    assert.equal(rightQuestion.display.kind === 'session.question' && rightQuestion.display.interaction_id, 'b:c');
    const leftApproval = mustItem(handle.service.applySignal(approval('c', 'plan', 'a:b')));
    const rightApproval = mustItem(handle.service.applySignal(approval('b:c', 'command', 'a')));
    assert.notEqual(leftApproval.id, rightApproval.id);
    assert.equal(leftApproval.display.kind === 'session.approval' && leftApproval.display.interaction_id, 'c');
    assert.equal(rightApproval.display.kind === 'session.approval' && rightApproval.display.interaction_id, 'b:c');
    const keys = handle.db.prepare(
      'SELECT source_key FROM inbox_items ORDER BY source_key',
    ).all() as Array<{ source_key: string }>;
    assert.deepEqual(keys.map(row => row.source_key), [
      'session.approval:1:a3:b:c',
      'session.approval:3:a:b1:c',
      'session.question:1:a3:b:c',
      'session.question:3:a:b1:c',
    ]);

    handle.service.markRead(leftQuestion.id, 1);
    assert.equal(handle.service.get(rightQuestion.id).read_at, null);
    const closedQuestion = mustItem(handle.service.resolve(closeQuestion('c', 1, 'resolved', 'user', 'a:b')));
    assert.equal(closedQuestion.id, leftQuestion.id);
    assert.equal(closedQuestion.status, 'resolved');
    assert.equal(handle.service.get(rightQuestion.id).status, 'pending');
    assert.equal(handle.service.get(rightQuestion.id).title, 'Right');

    handle.service.resolve({
      kind: 'session.approval.closed',
      interaction_id: 'c',
      session_id: 'a:b',
      generation: 1,
      outcome: 'rejected',
      actor: 'user',
    });
    assert.equal(handle.service.get(leftApproval.id).status, 'rejected');
    const rightView = handle.service.get(rightApproval.id);
    assert.equal(rightView.status, 'pending');
    assert.equal(rightView.display.kind === 'session.approval' && rightView.display.category, 'command');
    assert.equal(rightView.display.kind === 'session.approval' && rightView.display.interaction_id, 'b:c');
  } finally {
    handle.close();
  }
});

test('a terminal generation stays closed across a late open and a restart', () => {
  const handle = open();
  let restarted: Db | null = null;
  try {
    assert.throws(
      () => handle.service.resolve({
        kind: 'session.approval.closed',
        interaction_id: 'missing',
        session_id: 'sess-1',
        generation: 1,
        outcome: 'rejected',
        actor: 'user',
      }),
      (error: unknown) => error instanceof InboxError && error.code === 'INVALID_ARGUMENT',
    );
    assert.equal(rowCount(handle.db), 0);

    const early = mustItem(handle.service.resolve(closeQuestion('q-early', 2, 'cancelled', 'system')));
    assert.equal(early.status, 'cancelled');
    assert.equal(early.generation, 2);
    assert.equal(early.title, 'Closed');
    assert.equal(early.read_at, null);
    assert.deepEqual(early.target, {
      type: 'session',
      session_id: 'sess-1',
      turn: null,
      interaction_id: 'q-early',
    });
    const late = handle.service.applySignal(question('q-early', 2, 'Late', 'Should not open'));
    assert.equal(late.outcome, 'updated');
    assert.equal(late.item?.id, early.id);
    assert.equal(late.item?.status, 'cancelled');
    assert.equal(late.item?.generation, 2);
    assert.equal(late.item?.title, 'Late');
    assert.equal(late.item?.target.type === 'session' && late.item.target.turn, 2);
    assert.equal(readGeneration(handle.db, early.id), null);
    assert.equal(handle.service.claimNotification(early.id, 2).reason, 'closed');

    const existing = mustItem(handle.service.applySignal(question('q-gen', 1, 'Original', 'Body')));
    const advanced = mustItem(handle.service.resolve(closeQuestion('q-gen', 2, 'expired', 'system')));
    assert.equal(advanced.id, existing.id);
    assert.equal(advanced.generation, 2);
    assert.equal(advanced.status, 'expired');
    assert.equal(advanced.title, 'Closed');
    assert.equal(advanced.read_at, null);
    assert.equal(advanced.target.type === 'session' && advanced.target.turn, null);
    const lateOpen = handle.service.applySignal(question('q-gen', 2, 'Late', 'Open'));
    assert.equal(lateOpen.outcome, 'updated');
    assert.equal(lateOpen.item?.status, 'expired');
    assert.equal(lateOpen.item?.generation, 2);
    assert.equal(lateOpen.item?.title, 'Late');
    assert.equal(lateOpen.item?.target.type === 'session' && lateOpen.item.target.turn, 2);
    assert.equal(readGeneration(handle.db, existing.id), null);
    assert.equal(handle.service.claimNotification(existing.id, 2).emit, false);

    const updateClosed = mustItem(handle.service.resolve({
      kind: 'product.update.closed',
      product: 'integration',
      target_id: 'io.gian.early',
      version: '1.0.0',
      channel: 'stable',
      generation: 1,
      epoch: 2,
      outcome: 'cancelled',
      actor: 'system',
    }));
    assert.equal(updateClosed.status, 'cancelled');
    assert.equal(
      handle.service.applySignal(update('1.0.0', 2, 'stable', 'available', 'io.gian.early')).outcome,
      'terminal',
    );
    assert.equal(
      handle.service.applySignal(update('1.0.0', 9, 'stable', 'downloaded', 'io.gian.early')).outcome,
      'terminal',
    );
    assert.equal(handle.service.get(updateClosed.id).status, 'cancelled');

    handle.db.close();
    restarted = openDatabase(handle.dir);
    const second = new InboxService(restarted, {
      now: () => '2026-10-09T09:00:00.000Z',
      createId: () => 'unused',
    });
    const earlyAgain = second.applySignal(question('q-early', 2, 'Late', 'Open'));
    assert.equal(earlyAgain.outcome, 'terminal');
    assert.equal(earlyAgain.item?.status, 'cancelled');
    assert.equal(earlyAgain.item?.title, 'Late');
    assert.deepEqual(second.claimNotification(early.id, 2), { emit: false, reason: 'closed' });
    const genAgain = second.applySignal(question('q-gen', 2, 'Late', 'Open'));
    assert.equal(genAgain.outcome, 'terminal');
    assert.equal(genAgain.item?.status, 'expired');
    assert.equal(genAgain.item?.title, 'Late');
    assert.equal(genAgain.item?.target.type === 'session' && genAgain.item.target.turn, 2);
    assert.equal(readGeneration(restarted, existing.id), null);
    assert.equal(second.claimNotification(existing.id, 2).emit, false);
    assert.equal(sourceEpoch(restarted, updateClosed.id), 9);
    const updateAgain = second.applySignal(update('1.0.0', 4, 'stable', 'available', 'io.gian.early'));
    assert.equal(updateAgain.outcome, 'stale');
    assert.equal(updateAgain.item?.status, 'cancelled');
    assert.equal(sourceEpoch(restarted, updateClosed.id), 9);
    assert.equal(second.claimNotification(updateClosed.id, 1).emit, false);

    const newer = mustItem(second.applySignal(question('q-gen', 3, 'Newer', 'Matter')));
    assert.equal(newer.generation, 3);
    assert.equal(newer.status, 'pending');
    assert.deepEqual(second.claimNotification(newer.id, 3), { emit: true, reason: 'ok' });
    const newerUpdate = mustItem(second.applySignal(update('1.1.0', 10, 'stable', 'available', 'io.gian.early')));
    assert.equal(newerUpdate.id, updateClosed.id);
    assert.equal(newerUpdate.status, 'pending');
    assert.equal(second.get(early.id).status, 'cancelled');
  } finally {
    try {
      restarted?.close();
    } catch {
      // The restarted handle is absent when the test fails before reopen.
    }
    try {
      handle.db.close();
    } catch {
      // The first database is already closed before reopen.
    }
    rmSync(handle.dir, { recursive: true, force: true });
  }
});

test('a higher generation close uses a safe tombstone and a late open only fills that generation', () => {
  const handle = open();
  try {
    const opened = mustItem(handle.service.applySignal({
      ...question('q1', 1, 'Old question', 'Old body'),
      turn: 1,
    }));
    assert.equal(opened.target.type === 'session' && opened.target.turn, 1);
    const closed = mustItem(handle.service.resolve(closeQuestion('q1', 2, 'expired', 'user')));
    assert.equal(closed.id, opened.id);
    assert.equal(closed.generation, 2);
    assert.equal(closed.status, 'expired');
    assert.equal(closed.title, 'Closed');
    assert.equal(closed.summary, 'This item is already closed.');
    assert.deepEqual(closed.target, {
      type: 'session',
      session_id: 'sess-1',
      turn: null,
      interaction_id: 'q1',
    });
    assert.equal(readGeneration(handle.db, opened.id), 2);
    const readAt = closed.read_at;
    assert.notEqual(readAt, null);
    const beforeFill = handle.frames.length;

    const late = handle.service.applySignal({
      ...question('q1', 2, 'New question', 'New body'),
      turn: 2,
    });
    assert.equal(late.outcome, 'updated');
    assert.equal(handle.frames.length, beforeFill + 1);
    assert.equal(handle.frames.at(-1)?.type, 'inbox:changed');
    const filled = mustItem(late);
    assert.equal(filled.generation, 2);
    assert.equal(filled.status, 'expired');
    assert.equal(filled.title, 'New question');
    assert.equal(filled.summary, 'New body');
    assert.deepEqual(filled.target, {
      type: 'session',
      session_id: 'sess-1',
      turn: 2,
      interaction_id: 'q1',
    });
    assert.equal(readGeneration(handle.db, opened.id), 2);
    assert.equal(filled.read_at, readAt);
    assert.deepEqual(handle.service.claimNotification(opened.id, 2), { emit: false, reason: 'closed' });
    const beforeReplace = handle.frames.length;
    const replaced = handle.service.applySignal({
      ...question('q1', 2, 'Newer text', 'Should not replace'),
      turn: 3,
    });
    assert.equal(replaced.outcome, 'terminal');
    assert.equal(handle.frames.length, beforeReplace);
    assert.equal(replaced.item?.title, 'New question');
    assert.equal(replaced.item?.target.type === 'session' && replaced.item.target.turn, 2);
    assert.equal(readGeneration(handle.db, opened.id), 2);

    const known = mustItem(handle.service.applySignal({
      ...question('q-same', 1, 'Known', 'Body'),
      turn: 1,
    }));
    const sameClose = mustItem(handle.service.resolve(closeQuestion('q-same', 1, 'resolved', 'user')));
    assert.equal(sameClose.id, known.id);
    assert.equal(sameClose.generation, 1);
    assert.equal(sameClose.status, 'resolved');
    assert.equal(sameClose.title, 'Known');
    assert.equal(sameClose.summary, 'Body');
    assert.deepEqual(sameClose.target, {
      type: 'session',
      session_id: 'sess-1',
      turn: 1,
      interaction_id: 'q-same',
    });
    assert.equal(readGeneration(handle.db, known.id), 1);

    const plan = mustItem(handle.service.applySignal(approval('apr-gen', 'plan')));
    const closedApproval = mustItem(handle.service.resolve({
      kind: 'session.approval.closed',
      interaction_id: 'apr-gen',
      session_id: 'sess-1',
      generation: 2,
      outcome: 'rejected',
      actor: 'system',
    }));
    assert.equal(closedApproval.title, 'Closed');
    assert.equal(closedApproval.target.type === 'session' && closedApproval.target.turn, null);
    assert.equal(closedApproval.display.kind === 'session.approval' && closedApproval.display.category, 'plan');
    assert.equal(readGeneration(handle.db, plan.id), null);
    const filledApproval = handle.service.applySignal({
      ...approval('apr-gen', 'plan'),
      generation: 2,
      title: 'Filled approval',
    });
    assert.equal(filledApproval.outcome, 'updated');
    assert.equal(filledApproval.item?.status, 'rejected');
    assert.equal(filledApproval.item?.generation, 2);
    assert.equal(filledApproval.item?.title, 'Filled approval');
    assert.equal(filledApproval.item?.target.type === 'session' && filledApproval.item.target.turn, 4);
    assert.equal(
      filledApproval.item?.display.kind === 'session.approval' && filledApproval.item.display.category,
      'plan',
    );
    assert.equal(readGeneration(handle.db, plan.id), null);
    assert.deepEqual(handle.service.claimNotification(plan.id, 2), { emit: false, reason: 'closed' });

    const repair = mustItem(handle.service.applySignal({
      kind: 'system.repair',
      scope: 'runtime',
      subject_id: 'claude',
      fault_generation: 1,
      title: 'Old fault',
      summary: 'Missing binary',
    }));
    const closedRepair = mustItem(handle.service.resolve({
      kind: 'system.repair.closed',
      scope: 'runtime',
      subject_id: 'claude',
      fault_generation: 2,
      outcome: 'expired',
      actor: 'system',
    }));
    assert.equal(closedRepair.id, repair.id);
    assert.equal(closedRepair.generation, 2);
    assert.equal(closedRepair.title, 'Closed');
    assert.deepEqual(closedRepair.target, { type: 'system_repair', repair: 'runtime', subject_id: 'claude' });
    const filledRepair = handle.service.applySignal({
      kind: 'system.repair',
      scope: 'runtime',
      subject_id: 'claude',
      fault_generation: 2,
      title: 'New fault',
      summary: 'Still missing',
    });
    assert.equal(filledRepair.outcome, 'updated');
    assert.equal(filledRepair.item?.status, 'expired');
    assert.equal(filledRepair.item?.generation, 2);
    assert.equal(filledRepair.item?.title, 'New fault');
    assert.deepEqual(filledRepair.item?.target, { type: 'system_repair', repair: 'runtime', subject_id: 'claude' });
    assert.equal(readGeneration(handle.db, repair.id), null);
    assert.deepEqual(handle.service.claimNotification(repair.id, 2), { emit: false, reason: 'closed' });
  } finally {
    handle.close();
  }
});

test('update epoch keeps one row and ignores an older channel, phase, or close', () => {
  const handle = open();
  try {
    const first = mustItem(handle.service.applySignal(update('1.0.0', 1)));
    assert.equal(first.generation, 1);
    const beta = mustItem(handle.service.applySignal(update('2.0.0', 2, 'beta')));
    assert.equal(beta.id, first.id);
    assert.equal(beta.generation, 2);
    assert.equal(beta.target.type === 'update' && beta.target.channel, 'beta');
    const back = mustItem(handle.service.applySignal(update('1.0.0', 3)));
    assert.equal(back.id, first.id);
    assert.equal(back.generation, 3);
    assert.equal(back.target.type === 'update' && back.target.channel, 'stable');
    assert.equal(back.target.type === 'update' && back.target.version, '1.0.0');
    assert.equal(rowCount(handle.db), 1);

    const lateGeneration = handle.service.resolve({
      kind: 'product.update.closed',
      product: 'gian',
      target_id: 'gian',
      version: '1.0.0',
      channel: 'stable',
      generation: 1,
      epoch: 1,
      outcome: 'resolved',
      actor: 'system',
    });
    assert.equal(lateGeneration.outcome, 'stale');
    const lateEpoch = handle.service.resolve({
      kind: 'product.update.closed',
      product: 'gian',
      target_id: 'gian',
      version: '1.0.0',
      channel: 'stable',
      generation: 3,
      epoch: 1,
      outcome: 'resolved',
      actor: 'system',
    });
    assert.equal(lateEpoch.outcome, 'stale');
    assert.equal(handle.service.get(first.id).status, 'pending');
    assert.equal(handle.service.get(first.id).generation, 3);

    const oldChannel = handle.service.applySignal(update('2.0.0', 2, 'beta'));
    assert.equal(oldChannel.outcome, 'stale');
    const sameEpochChannel = handle.service.applySignal(update('2.0.0', 3, 'beta'));
    assert.equal(sameEpochChannel.outcome, 'stale');
    const still = handle.service.get(first.id);
    assert.equal(still.generation, 3);
    assert.equal(still.target.type === 'update' && still.target.channel, 'stable');
    assert.equal(still.target.type === 'update' && still.target.version, '1.0.0');

    const downloaded = mustItem(handle.service.applySignal(update('1.0.0', 4, 'stable', 'downloaded')));
    assert.equal(downloaded.generation, 3);
    assert.equal(downloaded.display.kind === 'product.update' && downloaded.display.phase, 'downloaded');
    const oldAvailable = handle.service.applySignal(update('1.0.0', 3, 'stable', 'available'));
    assert.equal(oldAvailable.outcome, 'stale');
    const sameEpochPhase = handle.service.applySignal(update('1.0.0', 4, 'stable', 'failed'));
    assert.equal(sameEpochPhase.outcome, 'stale');
    const oldClose = handle.service.resolve({
      kind: 'product.update.closed',
      product: 'gian',
      target_id: 'gian',
      version: '1.0.0',
      channel: 'stable',
      generation: 3,
      epoch: 3,
      outcome: 'resolved',
      actor: 'system',
    });
    assert.equal(oldClose.outcome, 'stale');
    const phase = handle.service.get(first.id);
    assert.equal(phase.generation, 3);
    assert.equal(phase.status, 'pending');
    assert.equal(phase.display.kind === 'product.update' && phase.display.phase, 'downloaded');
    const storedEpoch = handle.db.prepare(
      'SELECT source_epoch FROM inbox_items WHERE id = ?',
    ).get(first.id) as { source_epoch: number };
    assert.equal(storedEpoch.source_epoch, 4);

    const closed = mustItem(handle.service.resolve({
      kind: 'product.update.closed',
      product: 'gian',
      target_id: 'gian',
      version: '1.0.0',
      channel: 'stable',
      generation: 3,
      epoch: 4,
      outcome: 'resolved',
      actor: 'system',
    }));
    assert.equal(closed.status, 'resolved');
    assert.equal(closed.read_at, null);
    assert.equal(rowCount(handle.db), 1);
  } finally {
    handle.close();
  }
});

test('a higher ignored update epoch blocks a later older channel or phase after restart', () => {
  const handle = open();
  let restarted: Db | null = null;
  try {
    const terminal = mustItem(handle.service.applySignal(update('1.0.0', 10, 'stable', 'available', 'io.gian.term')));
    mustItem(handle.service.resolve({
      kind: 'product.update.closed',
      product: 'integration',
      target_id: 'io.gian.term',
      version: '1.0.0',
      channel: 'stable',
      generation: 1,
      epoch: 10,
      outcome: 'cancelled',
      actor: 'system',
    }));
    const skipped = mustItem(handle.service.applySignal(update('1.2.0', 5, 'stable', 'available', 'io.gian.skip')));
    handle.service.skipVersion(skipped.id, 1, '1.2.0');
    const lower = mustItem(handle.service.applySignal(update('2.0.0', 7, 'stable', 'available', 'io.gian.down')));
    const page = handle.service.list({ status: 'closed', limit: 1 });
    assert.ok(page.next_cursor);
    const cursor = page.next_cursor;
    const revision = handle.service.count().inbox_revision;
    const frames = handle.frames.length;
    const terminalStamp = itemStamp(handle.db, terminal.id);
    const skippedStamp = itemStamp(handle.db, skipped.id);
    const lowerStamp = itemStamp(handle.db, lower.id);

    const ignoredTerminal = handle.service.applySignal(update('1.0.0', 100, 'stable', 'available', 'io.gian.term'));
    assert.equal(ignoredTerminal.outcome, 'terminal');
    assert.equal(ignoredTerminal.item?.status, 'cancelled');
    assert.equal(ignoredTerminal.item?.generation, 1);
    assert.equal(Object.hasOwn(ignoredTerminal.item ?? {}, 'epoch'), false);
    assert.equal(Object.hasOwn(ignoredTerminal.item ?? {}, 'source_epoch'), false);
    assert.equal(sourceEpoch(handle.db, terminal.id), 100);
    assert.equal(itemStamp(handle.db, terminal.id).revision, terminalStamp.revision);
    assert.equal(itemStamp(handle.db, terminal.id).updated_at, terminalStamp.updated_at);
    assert.equal(itemStamp(handle.db, terminal.id).title, terminalStamp.title);
    assert.equal(handle.service.count().inbox_revision, revision);
    assert.equal(handle.frames.length, frames);
    const rest = handle.service.list({ status: 'closed', limit: 10, cursor });
    assert.equal(rest.items.length, 1);

    const lateChannel = handle.service.applySignal(update('2.0.0', 50, 'beta', 'available', 'io.gian.term'));
    assert.equal(lateChannel.outcome, 'stale');
    const latePhase = handle.service.applySignal(update('1.0.0', 80, 'stable', 'downloaded', 'io.gian.term'));
    assert.equal(latePhase.outcome, 'stale');
    const mismatchedClose = handle.service.resolve({
      kind: 'product.update.closed',
      product: 'integration',
      target_id: 'io.gian.term',
      version: '9.0.0',
      channel: 'stable',
      generation: 1,
      epoch: 150,
      outcome: 'cancelled',
      actor: 'system',
    });
    assert.equal(mismatchedClose.outcome, 'stale');
    const wrongGeneration = handle.service.resolve({
      kind: 'product.update.closed',
      product: 'integration',
      target_id: 'io.gian.term',
      version: '1.0.0',
      channel: 'stable',
      generation: 9,
      epoch: 160,
      outcome: 'cancelled',
      actor: 'system',
    });
    assert.equal(wrongGeneration.outcome, 'stale');
    const terminalNow = handle.service.get(terminal.id);
    assert.equal(terminalNow.status, 'cancelled');
    assert.equal(terminalNow.generation, 1);
    assert.equal(terminalNow.target.type === 'update' && terminalNow.target.version, '1.0.0');
    assert.equal(terminalNow.target.type === 'update' && terminalNow.target.channel, 'stable');
    assert.equal(terminalNow.display.kind === 'product.update' && terminalNow.display.phase, 'available');
    assert.equal(sourceEpoch(handle.db, terminal.id), 100);

    const ignoredSkip = handle.service.applySignal(update('1.0.0', 20, 'stable', 'available', 'io.gian.skip'));
    assert.equal(ignoredSkip.outcome, 'skipped');
    assert.equal(sourceEpoch(handle.db, skipped.id), 20);
    assert.equal(itemStamp(handle.db, skipped.id).revision, skippedStamp.revision);
    assert.equal(itemStamp(handle.db, skipped.id).updated_at, skippedStamp.updated_at);
    assert.equal(itemStamp(handle.db, skipped.id).status, 'cancelled');
    assert.equal(handle.service.applySignal(update('3.0.0', 12, 'beta', 'available', 'io.gian.skip')).outcome, 'stale');
    assert.equal(handle.service.applySignal(update('1.2.0', 15, 'stable', 'failed', 'io.gian.skip')).outcome, 'stale');
    const skippedNow = handle.service.get(skipped.id);
    assert.equal(skippedNow.status, 'cancelled');
    assert.equal(skippedNow.target.type === 'update' && skippedNow.target.version, '1.2.0');
    assert.equal(skippedNow.display.kind === 'product.update' && skippedNow.display.phase, 'available');
    assert.equal(sourceEpoch(handle.db, skipped.id), 20);

    const ignoredLower = handle.service.applySignal(update('1.0.0', 30, 'stable', 'downloaded', 'io.gian.down'));
    assert.equal(ignoredLower.outcome, 'stale');
    assert.equal(sourceEpoch(handle.db, lower.id), 30);
    assert.equal(itemStamp(handle.db, lower.id).revision, lowerStamp.revision);
    assert.equal(itemStamp(handle.db, lower.id).updated_at, lowerStamp.updated_at);
    assert.equal(itemStamp(handle.db, lower.id).generation, 1);
    assert.equal(itemStamp(handle.db, lower.id).status, 'pending');
    assert.equal(handle.service.applySignal(update('3.0.0', 20, 'beta', 'available', 'io.gian.down')).outcome, 'stale');
    assert.equal(handle.service.applySignal(update('1.5.0', 25, 'stable', 'failed', 'io.gian.down')).outcome, 'stale');
    const lowerNow = handle.service.get(lower.id);
    assert.equal(lowerNow.status, 'pending');
    assert.equal(lowerNow.generation, 1);
    assert.equal(lowerNow.target.type === 'update' && lowerNow.target.version, '2.0.0');
    assert.equal(lowerNow.display.kind === 'product.update' && lowerNow.display.phase, 'available');
    assert.equal(sourceEpoch(handle.db, lower.id), 30);
    assert.equal(handle.frames.length, frames);
    assert.equal(handle.service.count().inbox_revision, revision);

    handle.db.close();
    restarted = openDatabase(handle.dir);
    const second = new InboxService(restarted, {
      now: () => '2026-10-09T09:00:00.000Z',
      createId: () => 'unused',
    });
    assert.equal(sourceEpoch(restarted, terminal.id), 100);
    assert.equal(sourceEpoch(restarted, skipped.id), 20);
    assert.equal(sourceEpoch(restarted, lower.id), 30);
    assert.equal(second.applySignal(update('2.0.0', 60, 'beta', 'available', 'io.gian.term')).outcome, 'stale');
    assert.equal(second.applySignal(update('1.0.0', 18, 'stable', 'failed', 'io.gian.skip')).outcome, 'stale');
    assert.equal(second.applySignal(update('1.5.0', 29, 'stable', 'downloaded', 'io.gian.down')).outcome, 'stale');
    assert.equal(sourceEpoch(restarted, terminal.id), 100);
    assert.equal(sourceEpoch(restarted, skipped.id), 20);
    assert.equal(sourceEpoch(restarted, lower.id), 30);

    const reopened = mustItem(second.applySignal(update('2.0.0', 101, 'beta', 'available', 'io.gian.term')));
    assert.equal(reopened.id, terminal.id);
    assert.equal(reopened.status, 'pending');
    assert.equal(reopened.generation, 2);
    assert.equal(reopened.target.type === 'update' && reopened.target.channel, 'beta');
    assert.equal(reopened.target.type === 'update' && reopened.target.version, '2.0.0');
    assert.equal(sourceEpoch(restarted, terminal.id), 101);
    const skippedNext = mustItem(second.applySignal(update('1.3.0', 21, 'stable', 'available', 'io.gian.skip')));
    assert.equal(skippedNext.id, skipped.id);
    assert.equal(skippedNext.status, 'pending');
    assert.equal(skippedNext.generation, 2);
    assert.equal(sourceEpoch(restarted, skipped.id), 21);
    const lowerNext = mustItem(second.applySignal(update('3.0.0', 31, 'stable', 'available', 'io.gian.down')));
    assert.equal(lowerNext.id, lower.id);
    assert.equal(lowerNext.status, 'pending');
    assert.equal(lowerNext.generation, 2);
    assert.equal(lowerNext.target.type === 'update' && lowerNext.target.version, '3.0.0');
    assert.equal(sourceEpoch(restarted, lower.id), 31);
  } finally {
    try {
      restarted?.close();
    } catch {
      // The restarted handle is absent when the test fails before reopen.
    }
    try {
      handle.db.close();
    } catch {
      // The first database is already closed before reopen.
    }
    rmSync(handle.dir, { recursive: true, force: true });
  }
});

test('a page cursor is invalidated by read, generation, and terminal changes', () => {
  const handle = open();
  try {
    mustItem(handle.service.applySignal(question('q-1')));
    mustItem(handle.service.applySignal(question('q-2')));
    mustItem(handle.service.applySignal(question('q-3')));
    const first = handle.service.list({ limit: 2 });
    assert.deepEqual(first.items.map(item => item.id), ['item-03', 'item-02']);
    assert.ok(first.next_cursor);
    handle.service.markRead('item-01', 1);
    assert.throws(
      () => handle.service.list({ limit: 2, cursor: first.next_cursor }),
      (error: unknown) => error instanceof InboxError && error.code === 'STALE' && /stale/.test(error.message),
    );
    const afterRead = handle.service.list({ limit: 10 });
    assert.deepEqual(afterRead.items.map(item => item.id).sort(), ['item-01', 'item-02', 'item-03']);

    const readPage = handle.service.list({ limit: 1 });
    assert.equal(readPage.items[0]?.id, 'item-01');
    assert.ok(readPage.next_cursor);
    handle.service.markUnread('item-01', 1);
    assert.throws(
      () => handle.service.list({ limit: 1, cursor: readPage.next_cursor }),
      (error: unknown) => error instanceof InboxError && error.code === 'STALE',
    );
    const afterUnread = handle.service.list({ limit: 10 });
    assert.deepEqual(afterUnread.items.map(item => item.id).sort(), ['item-01', 'item-02', 'item-03']);

    const beforeGeneration = handle.service.list({ limit: 1 });
    assert.equal(beforeGeneration.items[0]?.id, 'item-01');
    assert.ok(beforeGeneration.next_cursor);
    const fresh = question('q-2', 2, 'Fresh', 'Again');
    const reopened = mustItem(handle.service.applySignal(fresh));
    assert.equal(reopened.id, 'item-02');
    assert.equal(reopened.generation, 2);
    assert.throws(
      () => handle.service.list({ limit: 1, cursor: beforeGeneration.next_cursor }),
      (error: unknown) => error instanceof InboxError && error.code === 'STALE',
    );
    const afterGeneration = handle.service.list({ limit: 10 });
    assert.deepEqual(afterGeneration.items.map(item => item.id).sort(), ['item-01', 'item-02', 'item-03']);
    assert.equal(afterGeneration.items.find(item => item.id === 'item-02')?.generation, 2);

    const replayPage = handle.service.list({ limit: 1 });
    assert.equal(replayPage.items[0]?.id, 'item-02');
    assert.ok(replayPage.next_cursor);
    assert.equal(handle.service.applySignal(fresh).outcome, 'duplicate');
    const replayRest = handle.service.list({ limit: 10, cursor: replayPage.next_cursor });
    assert.deepEqual(replayRest.items.map(item => item.id).sort(), ['item-01', 'item-03']);

    const beforeClose = handle.service.list({ limit: 1 });
    assert.equal(beforeClose.items[0]?.id, 'item-02');
    assert.ok(beforeClose.next_cursor);
    handle.service.resolve(closeQuestion('q-3', 1, 'cancelled', 'system'));
    assert.throws(
      () => handle.service.list({ limit: 1, cursor: beforeClose.next_cursor }),
      (error: unknown) => error instanceof InboxError && error.code === 'STALE',
    );
    const pending = handle.service.list({ status: 'pending', limit: 10 });
    const closed = handle.service.list({ status: 'closed', limit: 10 });
    assert.deepEqual(pending.items.map(item => item.id).sort(), ['item-01', 'item-02']);
    assert.deepEqual(closed.items.map(item => item.id), ['item-03']);
    assert.equal(closed.items[0]?.read_at, null);
    const seen = new Set([...pending.items, ...closed.items].map(item => item.id));
    assert.equal(seen.size, 3);
  } finally {
    handle.close();
  }
});

test('reconcile expires only a complete scope and leaves other sources pending', () => {
  const handle = open();
  try {
    const qLive = mustItem(handle.service.applySignal(question('q-live')));
    const qOther = mustItem(handle.service.applySignal(question('q-other')));
    const approved = mustItem(handle.service.applySignal(approval('apr-1')));
    const account = mustItem(handle.service.applySignal({
      kind: 'system.repair',
      scope: 'account',
      subject_id: 'acct',
      fault_generation: 1,
      title: 'Account',
      summary: 'Sign in',
    }));
    const runtime = mustItem(handle.service.applySignal({
      kind: 'system.repair',
      scope: 'runtime',
      subject_id: 'claude',
      fault_generation: 1,
      title: 'Runtime',
      summary: 'Missing',
    }));
    const pairing = mustItem(handle.service.applySignal({
      kind: 'system.pairing',
      request_id: 'pair-1',
      generation: 1,
      title: 'Device',
      summary: 'Authorize',
    }));
    const gian = mustItem(handle.service.applySignal(update('1.0.0', 1)));
    const integration = mustItem(handle.service.applySignal(update('2.0.0', 1, 'stable', 'available', 'io.gian.example')));

    const quiet = handle.service.count().inbox_revision;
    const partialEmpty = handle.service.reconcile({
      scope: 'session.question',
      mode: 'partial',
      snapshot_revision: handle.service.collectionRevision(),
      live: [],
    });
    assert.equal(partialEmpty.changed, 0);
    assert.equal(handle.service.count().inbox_revision, quiet);
    const schedule = handle.service.reconcile({
      scope: 'system.repair.schedule',
      mode: 'complete',
      snapshot_revision: handle.service.collectionRevision(),
      live: [],
    });
    assert.equal(schedule.changed, 0);
    assert.equal(handle.service.get(account.id).status, 'pending');
    assert.equal(handle.service.get(runtime.id).status, 'pending');

    const partial = handle.service.reconcile({
      scope: 'session.question',
      mode: 'partial',
      snapshot_revision: handle.service.collectionRevision(),
      live: [question('q-live', 1, 'Changed', 'Choose one')],
    });
    assert.equal(partial.changed, 1);
    assert.equal(handle.service.get(qLive.id).title, 'Changed');
    assert.equal(handle.service.get(qOther.id).status, 'pending');
    assert.equal(handle.service.get(approved.id).status, 'pending');

    const revision = handle.service.count().inbox_revision;
    assert.throws(
      () => handle.service.reconcile({
        scope: 'system.repair.runtime',
        mode: 'complete',
        snapshot_revision: handle.service.collectionRevision(),
        live: [{
          kind: 'system.repair',
          scope: 'account',
          subject_id: 'acct',
          fault_generation: 1,
          title: 'Account',
          summary: 'Sign in',
        }],
      }),
      (error: unknown) => error instanceof InboxError && error.code === 'INVALID_ARGUMENT',
    );
    assert.throws(
      () => (handle.service.reconcile as (value: unknown) => unknown)([]),
      (error: unknown) => error instanceof InboxError && error.code === 'INVALID_ARGUMENT',
    );
    assert.throws(
      () => handle.service.reconcile({
        scope: 'session.question',
        mode: 'unready' as 'complete',
        snapshot_revision: handle.service.collectionRevision(),
        live: [],
      }),
      (error: unknown) => error instanceof InboxError && error.code === 'INVALID_ARGUMENT',
    );
    assert.throws(
      () => handle.service.reconcile({
        scope: 'product.update' as 'product.update.gian',
        mode: 'complete',
        snapshot_revision: handle.service.collectionRevision(),
        live: [],
      }),
      (error: unknown) => error instanceof InboxError && error.code === 'INVALID_ARGUMENT',
    );
    assert.equal(handle.service.count().inbox_revision, revision);
    for (const item of [qLive, qOther, approved, account, runtime, pairing, gian, integration]) {
      assert.equal(handle.service.get(item.id).status, 'pending', item.id);
    }

    const questions = handle.service.reconcile({
      scope: 'session.question',
      mode: 'complete',
      snapshot_revision: handle.service.collectionRevision(),
      live: [question('q-live', 1, 'Changed', 'Choose one')],
    });
    assert.equal(questions.changed, 1);
    assert.equal(handle.service.get(qOther.id).status, 'expired');
    assert.equal(handle.service.get(qOther.id).read_at, null);
    for (const item of [qLive, approved, account, runtime, pairing, gian, integration]) {
      assert.equal(handle.service.get(item.id).status, 'pending', item.id);
    }

    const runtimeOnly = handle.service.reconcile({
      scope: 'system.repair.runtime',
      mode: 'complete',
      snapshot_revision: handle.service.collectionRevision(),
      live: [],
    });
    assert.equal(runtimeOnly.changed, 1);
    assert.equal(handle.service.get(runtime.id).status, 'expired');
    assert.equal(handle.service.get(runtime.id).read_at, null);
    assert.equal(handle.service.get(account.id).status, 'pending');

    const gianOnly = handle.service.reconcile({
      scope: 'product.update.gian',
      mode: 'complete',
      snapshot_revision: handle.service.collectionRevision(),
      live: [],
    });
    assert.equal(gianOnly.changed, 1);
    assert.equal(handle.service.get(gian.id).status, 'expired');
    assert.equal(handle.service.get(integration.id).status, 'pending');
    assert.equal(handle.service.get(pairing.id).status, 'pending');
    assert.equal(handle.service.get(approved.id).status, 'pending');
    assert.equal(handle.service.get(qLive.id).status, 'pending');
  } finally {
    handle.close();
  }
});

test('an old reconcile snapshot cannot expire or downgrade a newer same-scope item', () => {
  const handle = open();
  try {
    const first = mustItem(handle.service.applySignal(question('q-a', 1, 'First', 'Choose one')));
    const collected = handle.service.collectionRevision();
    const second = mustItem(handle.service.applySignal(question('q-b', 1, 'Second', 'Choose one')));
    assert.throws(
      () => handle.service.reconcile({
        scope: 'session.question',
        mode: 'complete',
        snapshot_revision: collected,
        live: [question('q-a', 1, 'First', 'Choose one')],
      }),
      (error: unknown) => error instanceof InboxError && error.code === 'STALE' && /snapshot is stale/.test(error.message),
    );
    assert.throws(
      () => handle.service.reconcile({
        scope: 'session.question',
        mode: 'complete',
        snapshot_revision: collected,
        live: [],
      }),
      (error: unknown) => error instanceof InboxError && error.code === 'STALE',
    );
    assert.equal(handle.service.get(first.id).status, 'pending');
    assert.equal(handle.service.get(second.id).status, 'pending');
    assert.equal(handle.service.get(first.id).title, 'First');

    const beforeReopen = handle.service.collectionRevision();
    const reopened = mustItem(handle.service.applySignal(question('q-a', 2, 'Second gen', 'Advanced')));
    assert.equal(reopened.generation, 2);
    assert.throws(
      () => handle.service.reconcile({
        scope: 'session.question',
        mode: 'complete',
        snapshot_revision: beforeReopen,
        live: [question('q-a', 1, 'First', 'Choose one')],
      }),
      (error: unknown) => error instanceof InboxError && error.code === 'STALE',
    );
    assert.throws(
      () => handle.service.reconcile({
        scope: 'session.question',
        mode: 'complete',
        snapshot_revision: beforeReopen,
        live: [],
      }),
      (error: unknown) => error instanceof InboxError && error.code === 'STALE',
    );
    assert.equal(handle.service.get(first.id).generation, 2);
    assert.equal(handle.service.get(first.id).title, 'Second gen');
    assert.equal(handle.service.get(first.id).status, 'pending');
    assert.equal(handle.service.get(second.id).status, 'pending');

    const beforePartial = handle.service.count().inbox_revision;
    assert.throws(
      () => handle.service.reconcile({
        scope: 'session.question',
        mode: 'partial',
        snapshot_revision: collected,
        live: [question('q-a', 1, 'First', 'Choose one')],
      }),
      (error: unknown) => error instanceof InboxError && error.code === 'STALE',
    );
    assert.equal(handle.service.get(first.id).generation, 2);
    assert.equal(handle.service.get(first.id).title, 'Second gen');
    assert.equal(handle.service.count().inbox_revision, beforePartial);

    const freshPartial = handle.service.reconcile({
      scope: 'session.question',
      mode: 'partial',
      snapshot_revision: handle.service.collectionRevision(),
      live: [question('q-a', 1, 'First', 'Choose one')],
    });
    assert.equal(freshPartial.changed, 0);
    assert.equal(handle.service.get(first.id).generation, 2);
    assert.equal(handle.service.get(first.id).title, 'Second gen');
    assert.equal(handle.service.get(first.id).status, 'pending');
    assert.equal(handle.service.count().inbox_revision, beforePartial);

    const readFence = handle.service.collectionRevision();
    handle.service.markRead(second.id, 1);
    assert.throws(
      () => handle.service.reconcile({
        scope: 'session.question',
        mode: 'partial',
        snapshot_revision: readFence,
        live: [question('q-b', 1, 'Second', 'Choose one')],
      }),
      (error: unknown) => error instanceof InboxError && error.code === 'STALE',
    );
    assert.equal(handle.service.get(second.id).status, 'pending');
    assert.equal(handle.service.get(second.id).title, 'Second');

    const missingRevision = handle.service.count().inbox_revision;
    assert.throws(
      () => (handle.service.reconcile as (value: unknown) => unknown)({
        scope: 'session.question',
        mode: 'complete',
        live: [],
      }),
      (error: unknown) => error instanceof InboxError && error.code === 'INVALID_ARGUMENT',
    );
    assert.throws(
      () => handle.service.reconcile({
        scope: 'session.question',
        mode: 'partial',
        snapshot_revision: -1,
        live: [],
      }),
      (error: unknown) => error instanceof InboxError && error.code === 'INVALID_ARGUMENT',
    );
    assert.throws(
      () => handle.service.reconcile({
        scope: 'session.question',
        mode: 'partial',
        snapshot_revision: 1.5,
        live: [],
      }),
      (error: unknown) => error instanceof InboxError && error.code === 'INVALID_ARGUMENT',
    );
    assert.equal(handle.service.get(first.id).status, 'pending');
    assert.equal(handle.service.get(second.id).status, 'pending');
    assert.equal(handle.service.count().inbox_revision, missingRevision);

    const freshEmpty = handle.service.reconcile({
      scope: 'session.question',
      mode: 'complete',
      snapshot_revision: handle.service.collectionRevision(),
      live: [],
    });
    assert.equal(freshEmpty.changed, 2);
    assert.equal(handle.service.get(first.id).status, 'expired');
    assert.equal(handle.service.get(second.id).status, 'expired');
    assert.equal(handle.service.get(first.id).read_at, null);
    assert.notEqual(handle.service.get(second.id).read_at, null);
    assert.equal(handle.service.get(first.id).generation, 2);
    assert.equal(handle.service.get(first.id).title, 'Second gen');
  } finally {
    handle.close();
  }
});

test('a matching duplicate update close records a higher epoch without a public write', () => {
  const handle = open();
  let restarted: Db | null = null;
  try {
    const pending = mustItem(handle.service.applySignal(update('1.0.0', 10)));
    const closed = mustItem(handle.service.resolve({
      kind: 'product.update.closed',
      product: 'gian',
      target_id: 'gian',
      version: '1.0.0',
      channel: 'stable',
      generation: 1,
      epoch: 20,
      outcome: 'resolved',
      actor: 'system',
    }));
    assert.equal(closed.id, pending.id);
    assert.equal(closed.status, 'resolved');
    assert.equal(closed.generation, 1);
    assert.equal(closed.read_at, null);
    assert.equal(sourceEpoch(handle.db, pending.id), 20);
    const revision = handle.service.count().inbox_revision;
    const fence = handle.service.collectionRevision();
    const frames = handle.frames.length;
    const stamp = itemStamp(handle.db, pending.id);

    const duplicate = handle.service.resolve({
      kind: 'product.update.closed',
      product: 'gian',
      target_id: 'gian',
      version: '1.0.0',
      channel: 'stable',
      generation: 1,
      epoch: 100,
      outcome: 'resolved',
      actor: 'system',
    });
    assert.equal(duplicate.outcome, 'duplicate');
    assert.equal(duplicate.item?.status, 'resolved');
    assert.equal(duplicate.item?.read_at, null);
    assert.equal(duplicate.item?.generation, 1);
    assert.equal(sourceEpoch(handle.db, pending.id), 100);
    assert.equal(handle.service.count().inbox_revision, revision);
    assert.equal(handle.service.collectionRevision(), fence + 1);
    assert.equal(handle.frames.length, frames);
    assert.equal(itemStamp(handle.db, pending.id).updated_at, stamp.updated_at);
    assert.equal(itemStamp(handle.db, pending.id).revision, stamp.revision);
    assert.equal(readGeneration(handle.db, pending.id), null);

    const lateBeta = handle.service.applySignal(update('2.0.0', 50, 'beta'));
    assert.equal(lateBeta.outcome, 'stale');
    assert.equal(handle.service.get(pending.id).status, 'resolved');
    assert.equal(handle.service.get(pending.id).target.type === 'update' && handle.service.get(pending.id).target.channel, 'stable');
    assert.equal(handle.service.get(pending.id).target.type === 'update' && handle.service.get(pending.id).target.version, '1.0.0');
    assert.equal(sourceEpoch(handle.db, pending.id), 100);
    assert.equal(handle.service.count().inbox_revision, revision);
    assert.equal(handle.frames.length, frames);

    const wrongGeneration = handle.service.resolve({
      kind: 'product.update.closed',
      product: 'gian',
      target_id: 'gian',
      version: '1.0.0',
      channel: 'stable',
      generation: 4,
      epoch: 180,
      outcome: 'resolved',
      actor: 'system',
    });
    assert.equal(wrongGeneration.outcome, 'stale');
    const wrongCandidate = handle.service.resolve({
      kind: 'product.update.closed',
      product: 'gian',
      target_id: 'gian',
      version: '9.0.0',
      channel: 'stable',
      generation: 1,
      epoch: 190,
      outcome: 'resolved',
      actor: 'system',
    });
    assert.equal(wrongCandidate.outcome, 'stale');
    assert.equal(sourceEpoch(handle.db, pending.id), 100);
    assert.equal(handle.service.collectionRevision(), fence + 1);

    handle.db.close();
    restarted = openDatabase(handle.dir);
    const second = new InboxService(restarted, {
      now: () => '2026-10-09T09:00:00.000Z',
      createId: () => 'unused',
    });
    assert.equal(sourceEpoch(restarted, pending.id), 100);
    assert.equal(second.applySignal(update('2.0.0', 50, 'beta')).outcome, 'stale');
    assert.equal(sourceEpoch(restarted, pending.id), 100);
    assert.equal(second.get(pending.id).status, 'resolved');
    const reopened = mustItem(second.applySignal(update('2.0.0', 101, 'beta')));
    assert.equal(reopened.id, pending.id);
    assert.equal(reopened.status, 'pending');
    assert.equal(reopened.generation, 2);
    assert.equal(reopened.target.type === 'update' && reopened.target.channel, 'beta');
    assert.equal(sourceEpoch(restarted, pending.id), 101);
  } finally {
    try {
      restarted?.close();
    } catch {
      // The restarted handle is absent when the test fails before reopen.
    }
    try {
      handle.db.close();
    } catch {
      // The first database is already closed before reopen.
    }
    rmSync(handle.dir, { recursive: true, force: true });
  }
});

test('a source high water moves the collection fence and leaves the list cursor valid', () => {
  const handle = open();
  try {
    const current = mustItem(handle.service.applySignal(update('2.0.0', 5)));
    mustItem(handle.service.applySignal(question('q-anchor')));
    const page = handle.service.list({ status: 'pending', limit: 1 });
    assert.ok(page.next_cursor);
    const cursor = page.next_cursor;
    const listRevision = handle.service.count().inbox_revision;
    const fence = handle.service.collectionRevision();
    assert.equal(fence, listRevision);
    const frames = handle.frames.length;
    const stamp = itemStamp(handle.db, current.id);

    const ignored = handle.service.applySignal(update('1.0.0', 40, 'stable', 'downloaded'));
    assert.equal(ignored.outcome, 'stale');
    assert.equal(sourceEpoch(handle.db, current.id), 40);
    assert.equal(handle.service.count().inbox_revision, listRevision);
    assert.equal(handle.service.collectionRevision(), fence + 1);
    assert.equal(handle.frames.length, frames);
    assert.equal(itemStamp(handle.db, current.id).revision, stamp.revision);
    assert.equal(itemStamp(handle.db, current.id).updated_at, stamp.updated_at);
    assert.equal(handle.service.get(current.id).target.type === 'update' && handle.service.get(current.id).target.version, '2.0.0');
    const rest = handle.service.list({ status: 'pending', limit: 10, cursor });
    assert.equal(rest.items.length, 1);

    assert.throws(
      () => handle.service.reconcile({
        scope: 'product.update.gian',
        mode: 'complete',
        snapshot_revision: fence,
        live: [update('2.0.0', 5)],
      }),
      (error: unknown) => error instanceof InboxError && error.code === 'STALE',
    );
    assert.throws(
      () => handle.service.reconcile({
        scope: 'product.update.gian',
        mode: 'complete',
        snapshot_revision: fence,
        live: [],
      }),
      (error: unknown) => error instanceof InboxError && error.code === 'STALE',
    );
    assert.throws(
      () => handle.service.reconcile({
        scope: 'product.update.gian',
        mode: 'partial',
        snapshot_revision: fence,
        live: [update('2.0.0', 5)],
      }),
      (error: unknown) => error instanceof InboxError && error.code === 'STALE',
    );
    assert.equal(handle.service.get(current.id).status, 'pending');
    assert.equal(sourceEpoch(handle.db, current.id), 40);
    assert.equal(handle.service.count().inbox_revision, listRevision);
    assert.equal(handle.frames.length, frames);

    const live = mustItem(handle.service.applySignal(update('3.0.0', 2, 'stable', 'available', 'io.gian.live')));
    const skipped = mustItem(handle.service.applySignal(update('1.2.0', 2, 'stable', 'available', 'io.gian.skip')));
    handle.service.skipVersion(skipped.id, 1, '1.2.0');
    const skipFence = handle.service.collectionRevision();
    const skipList = handle.service.count().inbox_revision;
    const skipFrames = handle.frames.length;
    const skippedStamp = itemStamp(handle.db, skipped.id);
    const ignoredSkip = handle.service.applySignal(update('1.0.0', 20, 'stable', 'available', 'io.gian.skip'));
    assert.equal(ignoredSkip.outcome, 'skipped');
    assert.equal(sourceEpoch(handle.db, skipped.id), 20);
    assert.equal(handle.service.count().inbox_revision, skipList);
    assert.equal(handle.service.collectionRevision(), skipFence + 1);
    assert.equal(handle.frames.length, skipFrames);
    assert.equal(itemStamp(handle.db, skipped.id).updated_at, skippedStamp.updated_at);
    assert.equal(itemStamp(handle.db, skipped.id).revision, skippedStamp.revision);
    assert.throws(
      () => handle.service.reconcile({
        scope: 'product.update.integration',
        mode: 'complete',
        snapshot_revision: skipFence,
        live: [update('3.0.0', 2, 'stable', 'available', 'io.gian.live')],
      }),
      (error: unknown) => error instanceof InboxError && error.code === 'STALE',
    );
    assert.throws(
      () => handle.service.reconcile({
        scope: 'product.update.integration',
        mode: 'complete',
        snapshot_revision: skipFence,
        live: [],
      }),
      (error: unknown) => error instanceof InboxError && error.code === 'STALE',
    );
    assert.throws(
      () => handle.service.reconcile({
        scope: 'product.update.integration',
        mode: 'partial',
        snapshot_revision: skipFence,
        live: [update('1.0.0', 8, 'stable', 'available', 'io.gian.live')],
      }),
      (error: unknown) => error instanceof InboxError && error.code === 'STALE',
    );
    assert.equal(handle.service.get(live.id).status, 'pending');
    assert.equal(handle.service.get(live.id).generation, 1);
    assert.equal(sourceEpoch(handle.db, live.id), 2);
    assert.equal(handle.service.get(skipped.id).status, 'cancelled');
    assert.equal(sourceEpoch(handle.db, skipped.id), 20);

    const fresh = handle.service.reconcile({
      scope: 'product.update.gian',
      mode: 'complete',
      snapshot_revision: handle.service.collectionRevision(),
      live: [],
    });
    assert.equal(fresh.changed, 1);
    assert.equal(handle.service.get(current.id).status, 'expired');
    assert.equal(handle.service.get(live.id).status, 'pending');

    const freshIntegration = handle.service.reconcile({
      scope: 'product.update.integration',
      mode: 'complete',
      snapshot_revision: handle.service.collectionRevision(),
      live: [],
    });
    assert.equal(freshIntegration.changed, 1);
    assert.equal(handle.service.get(live.id).status, 'expired');
    assert.equal(handle.service.get(skipped.id).status, 'cancelled');
  } finally {
    handle.close();
  }
});

test('placeholder text is not a tombstone and one fill cannot be replaced', () => {
  const handle = open();
  let restarted: Db | null = null;
  const placeholder = {
    title: 'Closed',
    summary: 'This item is already closed.',
  };
  try {
    const known = mustItem(handle.service.applySignal({
      ...question('q-copy', 1, placeholder.title, placeholder.summary),
      turn: null,
    }));
    const knownClosed = mustItem(handle.service.resolve(closeQuestion('q-copy', 1, 'resolved', 'user')));
    assert.equal(knownClosed.title, placeholder.title);
    assert.equal(knownClosed.summary, placeholder.summary);
    assert.equal(knownClosed.target.type === 'session' && knownClosed.target.turn, null);
    assert.equal(tombstoneFlag(handle.db, known.id), 0);
    assert.equal(readGeneration(handle.db, known.id), 1);
    const replaceKnown = handle.service.applySignal({
      ...question('q-copy', 1, 'Replaced', 'New'),
      turn: 4,
    });
    assert.equal(replaceKnown.outcome, 'terminal');
    assert.equal(replaceKnown.item?.title, placeholder.title);
    assert.equal(replaceKnown.item?.summary, placeholder.summary);
    assert.equal(replaceKnown.item?.target.type === 'session' && replaceKnown.item.target.turn, null);
    assert.equal(tombstoneFlag(handle.db, known.id), 0);
    assert.deepEqual(handle.service.claimNotification(known.id, 1), { emit: false, reason: 'closed' });

    const opened = mustItem(handle.service.applySignal(question('q-flag', 1, 'Real', 'Body')));
    const higher = mustItem(handle.service.resolve(closeQuestion('q-flag', 2, 'expired', 'system')));
    assert.equal(higher.generation, 2);
    assert.equal(higher.title, placeholder.title);
    assert.equal(higher.summary, placeholder.summary);
    assert.equal(higher.target.type === 'session' && higher.target.turn, null);
    assert.equal(tombstoneFlag(handle.db, opened.id), 1);
    assert.equal(readGeneration(handle.db, opened.id), null);
    const revision = handle.service.count().inbox_revision;
    const frames = handle.frames.length;
    const same = handle.service.applySignal({
      ...question('q-flag', 2, placeholder.title, placeholder.summary),
      turn: null,
    });
    assert.equal(same.outcome, 'duplicate');
    assert.equal(same.item?.status, 'expired');
    assert.equal(same.item?.generation, 2);
    assert.equal(same.item?.title, placeholder.title);
    assert.equal(same.item?.target.type === 'session' && same.item.target.turn, null);
    assert.equal(tombstoneFlag(handle.db, opened.id), 0);
    assert.equal(readGeneration(handle.db, opened.id), null);
    assert.equal(handle.service.count().inbox_revision, revision);
    assert.equal(handle.frames.length, frames);
    assert.deepEqual(handle.service.claimNotification(opened.id, 2), { emit: false, reason: 'closed' });
    const replaced = handle.service.applySignal({
      ...question('q-flag', 2, 'Should stay', 'No'),
      turn: 9,
    });
    assert.equal(replaced.outcome, 'terminal');
    assert.equal(replaced.item?.title, placeholder.title);
    assert.equal(replaced.item?.summary, placeholder.summary);
    assert.equal(replaced.item?.target.type === 'session' && replaced.item.target.turn, null);
    assert.equal(handle.frames.length, frames);
    assert.equal(tombstoneFlag(handle.db, opened.id), 0);

    handle.db.close();
    restarted = openDatabase(handle.dir);
    const second = new InboxService(restarted, {
      now: () => '2026-10-09T09:00:00.000Z',
      createId: () => 'unused',
    });
    const afterRestart = second.applySignal({
      ...question('q-flag', 2, 'After restart', 'Changed'),
      turn: 3,
    });
    assert.equal(afterRestart.outcome, 'terminal');
    assert.equal(afterRestart.item?.title, placeholder.title);
    assert.equal(afterRestart.item?.target.type === 'session' && afterRestart.item.target.turn, null);
    assert.equal(tombstoneFlag(restarted, opened.id), 0);
    assert.equal(readGeneration(restarted, opened.id), null);
    assert.deepEqual(second.claimNotification(opened.id, 2), { emit: false, reason: 'closed' });
    const knownAgain = second.applySignal({
      ...question('q-copy', 1, 'Replaced', 'New'),
      turn: 4,
    });
    assert.equal(knownAgain.outcome, 'terminal');
    assert.equal(knownAgain.item?.title, placeholder.title);
    assert.equal(knownAgain.item?.target.type === 'session' && knownAgain.item.target.turn, null);
    assert.equal(readGeneration(restarted, known.id), 1);
    assert.equal(tombstoneFlag(restarted, known.id), 0);
  } finally {
    try {
      restarted?.close();
    } catch {
      // The restarted handle is absent when the test fails before reopen.
    }
    try {
      handle.db.close();
    } catch {
      // The first database is already closed before reopen.
    }
    rmSync(handle.dir, { recursive: true, force: true });
  }
});

test('pending items with unknown or revoked targets have no executable action', () => {
  const handle = open();
  try {
    const unknown = mustItem(handle.service.applySignal(question('q-unknown')));
    handle.db.prepare('UPDATE inbox_items SET target_json = ? WHERE id = ?').run(
      JSON.stringify({ type: 'current' }),
      unknown.id,
    );
    const unknownItem = handle.service.get(unknown.id);
    assert.equal(unknownItem.status, 'pending');
    assert.equal(unknownItem.source_kind, 'session.question');
    assert.deepEqual(unknownItem.target, { type: 'unavailable', reason: 'unknown' });
    assert.deepEqual(unknownItem.actions, []);

    const revoked = mustItem(handle.service.applySignal(approval('apr-revoked')));
    handle.db.prepare('UPDATE inbox_items SET target_json = ? WHERE id = ?').run(
      JSON.stringify({ type: 'unavailable', reason: 'revoked' }),
      revoked.id,
    );
    const revokedItem = handle.service.get(revoked.id);
    assert.equal(revokedItem.status, 'pending');
    assert.equal(revokedItem.source_kind, 'session.approval');
    assert.deepEqual(revokedItem.actions, []);

    const failed = mustItem(handle.service.applySignal(update('9.0.0', 1, 'stable', 'failed')));
    handle.db.prepare('UPDATE inbox_items SET target_json = ? WHERE id = ?').run('not-json', failed.id);
    const failedItem = handle.service.get(failed.id);
    assert.equal(failedItem.status, 'pending');
    assert.deepEqual(failedItem.target, { type: 'unavailable', reason: 'unknown' });
    assert.deepEqual(failedItem.actions, []);

    const kept = mustItem(handle.service.applySignal(question('q-ok')));
    assert.deepEqual(kept.actions, ['open', 'answer', 'cancel']);
  } finally {
    handle.close();
  }
});
