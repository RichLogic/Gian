// Pairing becomes an Inbox item only at pending_confirmation. NOT_RUN.
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PAIRING_TTL_MS } from '@gian/remote-protocol';
import { pairingInboxObserver } from '../src/inbox/pairing-producer.js';
import { InboxService } from '../src/inbox/service.js';
import { RemoteDeviceStore } from '../src/remote/device-store.js';
import { RemotePairingService } from '../src/remote/pairing.js';
import { openDatabase, type Db } from '../src/storage/db.js';

const STARTED = Date.parse('2026-08-18T00:00:00.000Z');

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'gian-pairing-inbox-'));
  const db = openDatabase(dir);
  let nowMs = STARTED;
  const inbox = new InboxService(db, { broadcast() {} });
  const pairings = new RemotePairingService(db, new RemoteDeviceStore(db), () => new Date(nowMs));
  pairings.setInboxObserver(pairingInboxObserver(db, inbox));
  return {
    dir,
    db,
    inbox,
    pairings,
    advance(ms: number) { nowMs += ms; },
    close() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function inboxRows(db: Db): Array<{
  source_kind: string;
  status: string;
  generation: number;
  title: string;
  summary: string;
  target_json: string;
  tombstone: number;
}> {
  return db.prepare(
    `SELECT source_kind, status, generation, title, summary, target_json, tombstone
       FROM inbox_items ORDER BY created_at, id`,
  ).all() as Array<{
    source_kind: string;
    status: string;
    generation: number;
    title: string;
    summary: string;
    target_json: string;
    tombstone: number;
  }>;
}

function claim(
  pairings: RemotePairingService,
  name: string,
  key: string,
): { id: string; code: string } {
  const created = pairings.create();
  const claimed = pairings.claim({
    code: created.pairing.code,
    publicKey: { kty: 'EC', crv: 'P-256', x: key, y: 'bb' },
    name,
    platform: 'ios',
    userAgent: 'pairing-test',
  });
  return { id: claimed.id, code: created.pairing.code };
}

test('pending confirmation opens one pairing item and confirm closes it', () => {
  const context = setup();
  try {
    const created = context.pairings.create();
    assert.equal(inboxRows(context.db).length, 0);
    const claimed = context.pairings.claim({
      code: created.pairing.code,
      publicKey: { kty: 'EC', crv: 'P-256', x: 'aa', y: 'bb' },
      name: 'Kitchen',
      platform: 'ios',
      userAgent: 'pairing-test',
    });
    const opened = inboxRows(context.db);
    assert.equal(opened.length, 1);
    assert.equal(opened[0]?.source_kind, 'system.pairing');
    assert.equal(opened[0]?.status, 'pending');
    assert.equal(opened[0]?.generation, 1);
    assert.equal(opened[0]?.title, 'Confirm pairing');
    assert.equal(opened[0]?.summary, 'Confirm Kitchen');
    assert.equal(JSON.parse(opened[0]?.target_json ?? '{}').type, 'pairing');
    assert.equal(JSON.parse(opened[0]?.target_json ?? '{}').request_id, claimed.id);
    assert.equal(JSON.stringify(opened).includes(created.pairing.code), false);
    assert.equal(JSON.stringify(opened).includes(created.pairing.grantNonce), false);

    context.pairings.confirm(claimed.id);
    const closed = inboxRows(context.db);
    assert.equal(closed.length, 1);
    assert.equal(closed[0]?.status, 'resolved');
    assert.equal(closed[0]?.generation, 1);
  } finally {
    context.close();
  }
});

test('rejecting a code before confirmation does not create an inbox item', () => {
  const context = setup();
  try {
    const created = context.pairings.create();
    context.pairings.reject(created.pairing.id);
    assert.equal(inboxRows(context.db).length, 0);

    const pending = claim(context.pairings, 'Desk', 'cc');
    context.pairings.reject(pending.id);
    const rows = inboxRows(context.db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.status, 'rejected');
    assert.equal(JSON.stringify(rows).includes(pending.code), false);
  } finally {
    context.close();
  }
});

test('expiry closes a confirmation and does not open a claim that only expired', () => {
  const context = setup();
  try {
    const pending = claim(context.pairings, 'Phone', 'dd');
    const unclaimed = context.pairings.create();
    context.advance(PAIRING_TTL_MS + 1);
    context.pairings.listPending();
    const rows = inboxRows(context.db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.status, 'expired');
    assert.equal(JSON.parse(rows[0]?.target_json ?? '{}').request_id, pending.id);
    assert.equal(JSON.stringify(rows).includes(unclaimed.pairing.code), false);
  } finally {
    context.close();
  }
});

test('startup reconciliation reopens current confirmations and does not tombstone unseen pairings', () => {
  const context = setup();
  try {
    const stalled = claim(context.pairings, 'Stalled', 'ee');
    context.pairings.setInboxObserver(null);
    context.pairings.confirm(stalled.id);
    const waiting = claim(context.pairings, 'Waiting', 'ff');
    const unseen = claim(context.pairings, 'Unseen', 'gg');
    context.pairings.confirm(unseen.id);
    context.pairings.setInboxObserver(pairingInboxObserver(context.db, context.inbox));
    context.pairings.reconcileInbox();
    const rows = inboxRows(context.db);
    const byRequest = new Map(rows.map(row => {
      const target = JSON.parse(row.target_json) as { request_id?: string };
      return [target.request_id, row] as const;
    }));
    assert.equal(byRequest.get(stalled.id)?.status, 'resolved');
    assert.equal(byRequest.get(stalled.id)?.generation, 1);
    assert.equal(byRequest.get(waiting.id)?.status, 'pending');
    assert.equal(byRequest.get(unseen.id), undefined);
    assert.equal(rows.length, 2);
    assert.equal(rows.some(row => row.tombstone === 1), false);
  } finally {
    context.close();
  }
});
