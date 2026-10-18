import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboxItemPublic } from '@gian/shared';
import {
  __resetInboxForTests, applyInboxItemChanged, applyInboxSyncSnapshot, getInboxSnapshot,
  invalidateInbox, markInboxItemRead, markInboxItemUnread, skipInboxItemVersion,
} from '../src/controllers/inbox.js';
import { createOperationDispatcher, type OperationDispatcher } from '../src/operations/dispatcher.js';
import { wireInboxOperations } from '../src/operations/inbox.js';
import { makeInboxItem } from './inbox-fixtures.js';
import { mockFetch } from './setup.js';

function seed(item: InboxItemPublic): void {
  applyInboxSyncSnapshot({ inbox_revision: 10, pending_count: 1, items: [item], truncated: false });
}

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>(done => { resolve = done; });
  return { promise, resolve };
}

describe('Inbox mutations use real registered operations', () => {
  let dispatcher: OperationDispatcher;
  let unwire: () => void;
  beforeEach(() => {
    __resetInboxForTests();
    dispatcher = createOperationDispatcher();
    unwire = wireInboxOperations(dispatcher, invalidateInbox);
  });
  afterEach(() => {
    unwire();
    dispatcher.dispose();
    vi.useRealTimers();
    __resetInboxForTests();
  });

  it.each(['read', 'unread', 'skip-version'] as const)('routes %s through a pending run with the exact occurrence and version', async action => {
    const item = makeInboxItem({
      id: 'update/item', generation: 7, source_kind: 'product.update',
      target: { type: 'update', product: 'gian', target_id: 'app', version: '0.6.7', channel: 'stable' },
      display: { kind: 'product.update', product: 'gian', target_id: 'app', version: '0.6.7', channel: 'stable', phase: 'available', skipped_version: null },
    });
    seed(item);
    const response = deferredResponse();
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    mockFetch(async (input, init) => {
      calls.push({ url: String(input), init });
      return response.promise;
    });
    const result = action === 'read' ? markInboxItemRead(item)
      : action === 'unread' ? markInboxItemUnread(item) : skipInboxItemVersion(item);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`/api/inbox/update%2Fitem/${action}`);
    expect(calls[0]!.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ generation: 7, ...(action === 'skip-version' ? { version: '0.6.7' } : {}) });
    const [run] = dispatcher.store.getPendingRuns();
    expect(run?.name).toBe(action === 'read' ? 'inbox.markRead' : action === 'unread' ? 'inbox.markUnread' : 'inbox.skipVersion');
    expect(run?.phase).toBe('pending');
    response.resolve(Response.json({ ...item, revision: 2, unread: action !== 'read', read_at: action === 'read' ? item.updated_at : null }));
    expect(await result).toBe('ok');
    expect(dispatcher.store.getRun(run!.id)?.phase).toBe('confirmed');
    expect(getInboxSnapshot().pendingCount).toBe(1);
  });

  it('joins duplicate pending calls instead of issuing another POST or leaving a caller unresolved', async () => {
    const item = makeInboxItem();
    seed(item);
    const response = deferredResponse();
    const post = vi.fn(async () => response.promise);
    mockFetch(post);
    const first = markInboxItemRead(item);
    const second = markInboxItemRead(item);
    expect(post).toHaveBeenCalledTimes(1);
    expect(dispatcher.store.getPendingRuns()).toHaveLength(1);
    response.resolve(Response.json({ ...item, revision: 2, unread: false, read_at: item.updated_at }));
    expect(await Promise.all([first, second])).toEqual(['ok', 'ok']);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('preserves the occurrence/write-epoch fence when a WS echo advances generation: %s', async advances => {
    const item = makeInboxItem();
    seed(item);
    const response = deferredResponse();
    mockFetch(async () => response.promise);
    const result = markInboxItemRead(item);
    const canonical = { ...item, revision: 3, generation: advances ? 2 : 1, unread: advances, read_at: advances ? null : item.updated_at };
    applyInboxItemChanged(canonical, 11);
    response.resolve(Response.json({ ...item, revision: 2, unread: false, read_at: item.updated_at }));
    expect(await result).toBe(advances ? 'stale' : 'ok');
    expect(getInboxSnapshot().pendingItems).toEqual([canonical]);
    expect(getInboxSnapshot().inboxRevision).toBe(11);
  });

  it('preserves stale error codes, refreshes canonical state and never retries the old occurrence', async () => {
    const item = makeInboxItem();
    seed(item);
    const calls: string[] = [];
    mockFetch(async (input, init) => {
      calls.push(`${init?.method ?? 'GET'} ${String(input)}`);
      return init?.method === 'POST'
        ? Response.json({ error: 'stale', message: 'Occurrence changed.' }, { status: 409 })
        : Response.json({ items: [], next_cursor: null, pending_count: 0, inbox_revision: 11 });
    });
    const result = markInboxItemRead(item);
    const [run] = dispatcher.store.getPendingRuns();
    expect(await result).toBe('stale');
    const failed = dispatcher.store.getRun(run!.id);
    expect(failed?.phase).toBe('failed');
    expect(failed?.errorCode).toBe('stale');
    expect(calls.filter(call => call.startsWith('POST '))).toHaveLength(1);
    expect(calls.some(call => call.startsWith('GET /api/inbox'))).toBe(true);
  });

  it('leaves a timeout unknown, refreshes and ignores a late REST body without another mutation', async () => {
    vi.useFakeTimers();
    const item = makeInboxItem();
    seed(item);
    const response = deferredResponse();
    const posts = vi.fn();
    mockFetch(async (_input, init) => {
      if (init?.method === 'POST') { posts(); return response.promise; }
      return Response.json({ items: [item], next_cursor: null, pending_count: 1, inbox_revision: 11 });
    });
    const result = markInboxItemRead(item);
    const [run] = dispatcher.store.getPendingRuns();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await result).toBe('error');
    expect(dispatcher.store.getRun(run!.id)?.phase).toBe('timed-out');
    response.resolve(Response.json({ ...item, revision: 2, unread: false, read_at: item.updated_at }));
    await vi.advanceTimersByTimeAsync(0);
    expect(dispatcher.store.getRun(run!.id)?.phase).toBe('timed-out');
    expect(getInboxSnapshot().pendingItems[0]!.unread).toBe(true);
    expect(posts).toHaveBeenCalledTimes(1);
  });
});
