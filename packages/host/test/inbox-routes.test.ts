// Inbox HTTP surface. Auth uses the real requireAuth seam. Producer writes
// are not routed. NOT_RUN in this session.

import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Hono } from 'hono';
import { openDatabase } from '../src/storage/db.js';
import { createSessionToken } from '../src/auth/tokens.js';
import { requireAuth } from '../src/auth/middleware.js';
import { InboxService } from '../src/inbox/service.js';
import { registerInboxRoutes } from '../src/web/routes/inbox.js';

function harness(required = false) {
  const dir = mkdtempSync(join(tmpdir(), 'gian-inbox-http-'));
  const db = openDatabase(dir);
  let tick = 0;
  let seq = 0;
  const service = new InboxService(db, {
    now: () => `2026-10-09T00:00:${String(++tick).padStart(2, '0')}.000Z`,
    createId: () => `item-${++seq}`,
  });
  const app = new Hono();
  if (required) app.use('*', requireAuth({ required: true }));
  registerInboxRoutes(app, service);
  return {
    app,
    db,
    service,
    close() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

const QUESTION = {
  kind: 'session.question',
  interaction_id: 'q-http',
  session_id: 'sess-http',
  turn: 1,
  generation: 1,
  title: 'Need a decision',
  summary: 'Choose one',
};

test('list, detail, read, unread, and skip validate boundaries', async () => {
  const handle = harness();
  try {
    const created = handle.service.applySignal(QUESTION);
    assert.ok(created.item);
    const list = await handle.app.request('http://127.0.0.1/api/inbox');
    assert.equal(list.status, 200);
    const listed = await bodyOf(list);
    const items = listed.items as Array<{ unread?: boolean }>;
    assert.equal(items.length, 1);
    assert.equal(items[0]?.unread, true);
    assert.equal(listed.pending_count, 1);

    const count = await handle.app.request('http://127.0.0.1/api/inbox/count');
    assert.equal(count.status, 200);
    assert.deepEqual(await bodyOf(count), { pending_count: 1, inbox_revision: listed.inbox_revision });

    const missing = await handle.app.request('http://127.0.0.1/api/inbox/missing');
    assert.equal(missing.status, 404);

    const detail = await handle.app.request('http://127.0.0.1/api/inbox/item-1');
    assert.equal(detail.status, 200);
    const detailBody = await bodyOf(detail);
    assert.equal(detailBody.id, 'item-1');
    assert.equal('command' in detailBody, false);

    for (const limit of ['0', '101', '1.5', 'abc', '-1']) {
      const response = await handle.app.request(`http://127.0.0.1/api/inbox?limit=${limit}`);
      assert.equal(response.status, 400, limit);
    }
    const badStatus = await handle.app.request('http://127.0.0.1/api/inbox?status=nope');
    assert.equal(badStatus.status, 400);
    const badCursor = await handle.app.request('http://127.0.0.1/api/inbox?cursor=%25%25%25');
    assert.equal(badCursor.status, 400);
    for (const key of ['account_id', 'device_id', 'user_id']) {
      const response = await handle.app.request(`http://127.0.0.1/api/inbox?${key}=other`);
      assert.equal(response.status, 400, key);
    }

    const read = await handle.app.request('http://127.0.0.1/api/inbox/item-1/read', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ generation: 1 }),
    });
    assert.equal(read.status, 200);
    const readBody = await bodyOf(read);
    assert.equal(readBody.unread, false);
    assert.equal(readBody.status, 'pending');
    const revision = handle.service.count().inbox_revision;
    const reread = await handle.app.request('http://127.0.0.1/api/inbox/item-1/read', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ generation: 1 }),
    });
    assert.equal(reread.status, 200);
    assert.equal(handle.service.count().inbox_revision, revision);

    const stale = await handle.app.request('http://127.0.0.1/api/inbox/item-1/read', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ generation: 9 }),
    });
    assert.equal(stale.status, 409);
    const extra = await handle.app.request('http://127.0.0.1/api/inbox/item-1/unread', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ generation: 1, source_kind: 'session.question' }),
    });
    assert.equal(extra.status, 400);
    const unread = await handle.app.request('http://127.0.0.1/api/inbox/item-1/unread', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ generation: 1 }),
    });
    assert.equal(unread.status, 200);
    const unreadBody = await bodyOf(unread);
    assert.equal(unreadBody.unread, true);
    assert.equal(unreadBody.status, 'pending');

    const update = handle.service.applySignal({
      kind: 'product.update',
      product: 'gian',
      target_id: 'gian',
      version: '1.4.0',
      channel: 'stable',
      epoch: 1,
      phase: 'available',
      title: 'Gian update',
      summary: '1.4.0 is available',
    });
    assert.ok(update.item);
    const skipped = await handle.app.request(`http://127.0.0.1/api/inbox/${update.item.id}/skip-version`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ generation: update.item.generation, version: '1.4.0' }),
    });
    assert.equal(skipped.status, 200);
    const skippedBody = await bodyOf(skipped);
    assert.equal(skippedBody.status, 'cancelled');
    assert.equal(skippedBody.unread, false);
    const skipRevision = handle.service.count().inbox_revision;
    const skipAgain = await handle.app.request(`http://127.0.0.1/api/inbox/${update.item.id}/skip-version`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ generation: update.item.generation, version: '1.4.0' }),
    });
    assert.equal(skipAgain.status, 200);
    assert.equal(handle.service.count().inbox_revision, skipRevision);
    const skipQuestion = await handle.app.request('http://127.0.0.1/api/inbox/item-1/skip-version', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ generation: 1, version: '1.4.0' }),
    });
    assert.equal(skipQuestion.status, 409);

    const forged = await handle.app.request('http://127.0.0.1/api/inbox', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(QUESTION),
    });
    assert.equal(forged.status, 404);
    const approve = await handle.app.request('http://127.0.0.1/api/inbox/item-1/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ generation: 1 }),
    });
    assert.equal(approve.status, 404);
    const retry = await handle.app.request(`http://127.0.0.1/api/inbox/${update.item.id}/retry`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(retry.status, 404);
    assert.equal(handle.service.get('item-1').status, 'pending');
  } finally {
    handle.close();
  }
});

test('missing auth is rejected before a scope query, and a bearer token lists this Host only', async () => {
  const handle = harness(true);
  try {
    handle.service.applySignal(QUESTION);
    const anonymous = await handle.app.request('http://127.0.0.1/api/inbox?account_id=other');
    assert.equal(anonymous.status, 401);
    assert.deepEqual(await bodyOf(anonymous), { error: 'unauthorized' });
    const token = await createSessionToken('owner');
    const accepted = await handle.app.request('http://127.0.0.1/api/inbox', {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(accepted.status, 200);
    const scoped = await handle.app.request('http://127.0.0.1/api/inbox?device_id=other', {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(scoped.status, 400);
  } finally {
    handle.close();
  }
});

test('a cursor without a revision is rejected, and a stale or cross-status cursor is 409', async () => {
  const handle = harness();
  try {
    handle.service.applySignal(QUESTION);
    handle.service.applySignal({ ...QUESTION, interaction_id: 'q-http-2' });
    const first = await handle.app.request('http://127.0.0.1/api/inbox?limit=1');
    assert.equal(first.status, 200);
    const page = await bodyOf(first);
    const cursor = page.next_cursor;
    assert.equal(typeof cursor, 'string');
    const unbound = Buffer.from(JSON.stringify({
      updated_at: '2026-10-09T00:00:02.000Z',
      id: 'item-2',
    }), 'utf8').toString('base64url');
    const missingBound = await handle.app.request(
      `http://127.0.0.1/api/inbox?cursor=${encodeURIComponent(unbound)}`,
    );
    assert.equal(missingBound.status, 400);
    const otherStatus = await handle.app.request(
      `http://127.0.0.1/api/inbox?status=closed&cursor=${encodeURIComponent(String(cursor))}`,
    );
    assert.equal(otherStatus.status, 409);
    handle.service.markRead('item-1', 1);
    const stale = await handle.app.request(
      `http://127.0.0.1/api/inbox?cursor=${encodeURIComponent(String(cursor))}`,
    );
    assert.equal(stale.status, 409);
    const again = await handle.app.request('http://127.0.0.1/api/inbox?limit=10');
    assert.equal(again.status, 200);
    const refetched = await bodyOf(again);
    const ids = (refetched.items as Array<{ id: string }>).map(item => item.id).sort();
    assert.deepEqual(ids, ['item-1', 'item-2']);
  } finally {
    handle.close();
  }
});
