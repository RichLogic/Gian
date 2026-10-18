/**
 * Inbox read-model store (Issue #53 / 0.6.7): the badge counts PENDING work
 * (never unread), live `inbox:changed` frames adjust it by delta only when
 * the window is complete, and every writer is fenced — per-item by
 * (revision, generation), per-collection by inbox_revision, and
 * cross-transport by a latest-writer token so a late REST read can never
 * overwrite a newer snapshot/frame.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboxItemPublic } from '@gian/shared';
import {
  __resetInboxForTests,
  applyInboxItem,
  applyInboxItemChanged,
  applyInboxItemIfCurrent,
  applyInboxSyncSnapshot,
  getInboxSnapshot,
  inboxWriteEpoch,
  invalidateInbox,
  loadMorePending,
  markInboxItemRead,
  markInboxItemUnread,
  subscribeInbox,
} from '../src/controllers/inbox.js';
import { mockFetch } from './setup.js';
import { makeInboxItem, wireTestInboxOperations } from './inbox-fixtures.js';

function snapshot(items: InboxItemPublic[], pendingCount = items.length) {
  return {
    inbox_revision: 10,
    pending_count: pendingCount,
    items,
    truncated: false,
  };
}

interface PageSpec {
  items?: InboxItemPublic[];
  next_cursor?: string | null;
  pending_count?: number;
  inbox_revision?: number;
}

/** Fetch router over the pending list endpoint; records every call. */
function pendingListRouter(pages: PageSpec[] | ((url: string) => PageSpec | Response)) {
  const calls: string[] = [];
  let index = 0;
  mockFetch(async input => {
    const url = typeof input === 'string' ? input : input.url;
    calls.push(url);
    if (url.startsWith('/api/inbox?') || url === '/api/inbox') {
      if (typeof pages === 'function') {
        const result = pages(url);
        if (result instanceof Response) return result;
        return pageResponse(result);
      }
      return pageResponse(pages[Math.min(index++, pages.length - 1)] ?? {});
    }
    return Response.json({ error: 'not_found' }, { status: 404 });
  });
  return calls;
}

function pageResponse(spec: PageSpec): Response {
  const items = spec.items ?? [];
  return Response.json({
    items,
    next_cursor: spec.next_cursor ?? null,
    pending_count: spec.pending_count ?? items.length,
    inbox_revision: spec.inbox_revision ?? 10,
  });
}

describe('inbox store', () => {
  let disposeOperations: () => void;
  beforeEach(() => { __resetInboxForTests(); disposeOperations = wireTestInboxOperations(); });
  afterEach(() => { disposeOperations(); __resetInboxForTests(); });

  it('seeds from the state_sync snapshot; the badge counts pending, not unread', () => {
    const readPending = makeInboxItem({ id: 'a', unread: false, read_at: '2026-10-12T02:00:00.000Z' });
    applyInboxSyncSnapshot(snapshot([makeInboxItem({ id: 'a' }), makeInboxItem({ id: 'b' })], 2));
    expect(getInboxSnapshot().pendingCount).toBe(2);
    expect(getInboxSnapshot().hydrated).toBe(true);

    applyInboxSyncSnapshot(snapshot([readPending], 1));
    expect(getInboxSnapshot().pendingCount).toBe(1);
    expect(getInboxSnapshot().pendingItems[0]!.unread).toBe(false);
  });

  it('applies one-row changed frames as count deltas, idempotently, on a complete window', () => {
    applyInboxSyncSnapshot(snapshot([makeInboxItem({ id: 'a' })], 1));

    applyInboxItemChanged(makeInboxItem({ id: 'b' }), 11);
    expect(getInboxSnapshot().pendingCount).toBe(2);
    expect(getInboxSnapshot().pendingItems.map(item => item.id)).toEqual(['b', 'a']);
    expect(getInboxSnapshot().inboxRevision).toBe(11);

    applyInboxItemChanged(makeInboxItem({ id: 'b' }), 12);
    expect(getInboxSnapshot().pendingCount).toBe(2);

    applyInboxItemChanged(makeInboxItem({ id: 'b', status: 'resolved', revision: 2, closed_at: '2026-10-12T03:00:00.000Z' }), 13);
    expect(getInboxSnapshot().pendingCount).toBe(1);
    expect(getInboxSnapshot().pendingItems.map(item => item.id)).toEqual(['a']);

    applyInboxItemChanged(makeInboxItem({ id: 'zz', status: 'expired' }), 14);
    expect(getInboxSnapshot().pendingCount).toBe(1);
  });

  it('read/unread flips never change the pending count', () => {
    applyInboxSyncSnapshot(snapshot([makeInboxItem({ id: 'a' })], 1));
    applyInboxItemChanged(makeInboxItem({ id: 'a', unread: false, revision: 2, read_at: '2026-10-12T02:00:00.000Z' }), 11);
    expect(getInboxSnapshot().pendingCount).toBe(1);
    expect(getInboxSnapshot().pendingItems[0]!.unread).toBe(false);
  });

  it('drops stale frames (older collection revision) wholesale', () => {
    applyInboxSyncSnapshot(snapshot([makeInboxItem({ id: 'a' })], 1));
    applyInboxItemChanged(makeInboxItem({ id: 'b' }), 9);
    expect(getInboxSnapshot().pendingCount).toBe(1);
    expect(getInboxSnapshot().pendingItems.map(item => item.id)).toEqual(['a']);
  });

  it('never rolls a row back to an older generation from a late mutation response', async () => {
    applyInboxSyncSnapshot(snapshot([makeInboxItem({ id: 'a', generation: 1, revision: 5 })]));
    // The item moved to generation 2 (newer revision) via a live frame.
    applyInboxItemChanged(makeInboxItem({ id: 'a', generation: 2, revision: 6 }), 11);
    // The gen-1 read response lands late and must not resurrect gen 1.
    mockFetch(async () => Response.json(
      makeInboxItem({ id: 'a', generation: 1, revision: 5, unread: false, read_at: '2026-10-12T04:00:00.000Z' }),
    ));
    const result = await markInboxItemRead(makeInboxItem({ id: 'a', generation: 1, revision: 5 }));
    expect(result).toBe('ok');
    const row = getInboxSnapshot().pendingItems[0]!;
    expect(row.generation).toBe(2);
    expect(row.unread).toBe(true);
    // The mutation response carries no collection revision — it must not move one.
    expect(getInboxSnapshot().inboxRevision).toBe(11);
  });

  it('notifies subscribers on every committed state', () => {
    const seen: number[] = [];
    const off = subscribeInbox(() => seen.push(getInboxSnapshot().pendingCount));
    applyInboxSyncSnapshot(snapshot([makeInboxItem({ id: 'a' })], 1));
    applyInboxItemChanged(makeInboxItem({ id: 'b' }), 11);
    off();
    expect(seen).toEqual([1, 2]);
  });

  it('invalidation re-pulls count and rows from ONE list transaction', async () => {
    const calls = pendingListRouter([{
      items: [makeInboxItem({ id: 'x' }), makeInboxItem({ id: 'y' })],
      pending_count: 3,
      inbox_revision: 42,
      next_cursor: 'cursor-2',
    }]);
    invalidateInbox();
    await vi.waitFor(() => expect(getInboxSnapshot().hydrated).toBe(true));
    expect(getInboxSnapshot().pendingCount).toBe(3);
    expect(getInboxSnapshot().inboxRevision).toBe(42);
    expect(getInboxSnapshot().truncated).toBe(true);
    expect(getInboxSnapshot().pendingNextCursor).toBe('cursor-2');
    expect(calls).toEqual(['/api/inbox?status=pending&limit=50']);
  });

  it('a changed frame before any snapshot falls back to a canonical pull', async () => {
    pendingListRouter([{ items: [makeInboxItem({ id: 'a' })], pending_count: 1, inbox_revision: 7 }]);
    applyInboxItemChanged(makeInboxItem({ id: 'a' }), 7);
    await vi.waitFor(() => expect(getInboxSnapshot().hydrated).toBe(true));
    expect(getInboxSnapshot().pendingCount).toBe(1);
  });

  it('an unknown id on a truncated window refreshes the count instead of guessing', async () => {
    applyInboxSyncSnapshot({
      inbox_revision: 10,
      pending_count: 60,
      items: [makeInboxItem({ id: 'a' })],
      truncated: true,
    });
    const calls = pendingListRouter([{
      items: [makeInboxItem({ id: 'a' }), makeInboxItem({ id: 'unloaded' })],
      pending_count: 59,
      inbox_revision: 20,
    }]);
    // A pending row we never loaded updates: do NOT +1 over the truncated remainder.
    applyInboxItemChanged(makeInboxItem({ id: 'unloaded', title: 'Unloaded row' }), 11);
    await vi.waitFor(() => expect(getInboxSnapshot().inboxRevision).toBe(20));
    expect(getInboxSnapshot().pendingCount).toBe(59);
    expect(calls.length).toBe(1);
  });

  it('an unknown terminal row on a truncated window also refreshes the count', async () => {
    applyInboxSyncSnapshot({
      inbox_revision: 10,
      pending_count: 60,
      items: [makeInboxItem({ id: 'a' })],
      truncated: true,
    });
    pendingListRouter([{ items: [makeInboxItem({ id: 'a' })], pending_count: 58, inbox_revision: 21 }]);
    applyInboxItemChanged(makeInboxItem({ id: 'unloaded', status: 'expired', revision: 9 }), 11);
    await vi.waitFor(() => expect(getInboxSnapshot().inboxRevision).toBe(21));
    expect(getInboxSnapshot().pendingCount).toBe(58);
  });

  it('a newer snapshot invalidates an in-flight refresh', async () => {
    let resolvePage: ((response: Response) => void) | null = null;
    mockFetch(async () => new Promise<Response>(resolve => { resolvePage = resolve; }));
    invalidateInbox();
    await vi.waitFor(() => expect(getInboxSnapshot().refreshing).toBe(true));
    // While REST is in flight, a reconnect snapshot lands with newer state.
    applyInboxSyncSnapshot({
      inbox_revision: 30,
      pending_count: 5,
      items: [makeInboxItem({ id: 'live' })],
      truncated: false,
    });
    resolvePage!(pageResponse({
      items: [makeInboxItem({ id: 'stale' })],
      pending_count: 1,
      inbox_revision: 12,
    }));
    await vi.waitFor(() => expect(getInboxSnapshot().refreshing).toBe(false));
    expect(getInboxSnapshot().pendingCount).toBe(5);
    expect(getInboxSnapshot().inboxRevision).toBe(30);
    expect(getInboxSnapshot().pendingItems.map(item => item.id)).toEqual(['live']);
  });

  it('load-more pages the pending window to its last page', async () => {
    pendingListRouter([
      { items: [makeInboxItem({ id: 'p1' })], next_cursor: 'cursor-2', pending_count: 2, inbox_revision: 10 },
      { items: [makeInboxItem({ id: 'p2' })], next_cursor: null, pending_count: 2, inbox_revision: 10 },
    ]);
    invalidateInbox();
    await vi.waitFor(() => expect(getInboxSnapshot().truncated).toBe(true));
    await loadMorePending();
    expect(getInboxSnapshot().pendingItems.map(item => item.id)).toEqual(['p1', 'p2']);
    expect(getInboxSnapshot().truncated).toBe(false);
    expect(getInboxSnapshot().pendingNextCursor).toBeNull();
  });

  it('a stale load-more cursor re-pulls from the top instead of failing the list', async () => {
    let topCalls = 0;
    const calls = pendingListRouter(url => {
      if (url.includes('cursor=cursor-2')) {
        return Response.json({ error: 'stale', message: 'cursor expired' }, { status: 409 });
      }
      topCalls += 1;
      return {
        items: [makeInboxItem({ id: 'p1' })],
        next_cursor: 'cursor-2',
        pending_count: 60,
        inbox_revision: 10 + topCalls,
      };
    });
    invalidateInbox();
    await vi.waitFor(() => expect(getInboxSnapshot().truncated).toBe(true));
    await loadMorePending();
    // The 409 discarded the window and restarted from the first page.
    await vi.waitFor(() => expect(topCalls).toBe(2));
    expect(getInboxSnapshot().pendingItems.map(item => item.id)).toEqual(['p1']);
    expect(getInboxSnapshot().error).toBe(false);
    expect(calls.some(url => url.includes('cursor=cursor-2'))).toBe(true);
  });

  it('a failed first pull is an error with retry state, not a fake empty list', async () => {
    pendingListRouter(() => Response.json({ error: 'boom' }, { status: 500 }));
    invalidateInbox();
    await vi.waitFor(() => expect(getInboxSnapshot().error).toBe(true));
    expect(getInboxSnapshot().hydrated).toBe(false);
    expect(getInboxSnapshot().pendingItems).toEqual([]);

    pendingListRouter([{ items: [makeInboxItem({ id: 'a' })], pending_count: 1, inbox_revision: 9 }]);
    invalidateInbox();
    await vi.waitFor(() => expect(getInboxSnapshot().hydrated).toBe(true));
    expect(getInboxSnapshot().error).toBe(false);
    expect(getInboxSnapshot().pendingCount).toBe(1);
  });

  it('a frame superseding an in-flight refresh retires its busy flags and wins', async () => {
    applyInboxSyncSnapshot(snapshot([makeInboxItem({ id: 'a', revision: 1 })], 1));
    let resolvePage: ((response: Response) => void) | null = null;
    mockFetch(async () => new Promise<Response>(resolve => { resolvePage = resolve; }));
    invalidateInbox();
    await vi.waitFor(() => expect(getInboxSnapshot().refreshing).toBe(true));
    // A live frame lands mid-refresh: it is the newer fact. The in-flight
    // read is invalidated and its busy flag retired with it.
    applyInboxItemChanged(makeInboxItem({ id: 'b', revision: 1 }), 11);
    expect(getInboxSnapshot().refreshing).toBe(false);
    expect(getInboxSnapshot().pendingCount).toBe(2);
    resolvePage!(pageResponse({
      items: [makeInboxItem({ id: 'a' })],
      pending_count: 1,
      inbox_revision: 10,
    }));
    await vi.waitFor(() => expect(getInboxSnapshot().loadingMore).toBe(false));
    expect(getInboxSnapshot().pendingItems.map(item => item.id)).toEqual(['b', 'a']);
    expect(getInboxSnapshot().inboxRevision).toBe(11);
  });

  it('a mutation result supersedes an older in-flight refresh', async () => {
    applyInboxSyncSnapshot(snapshot([makeInboxItem({ id: 'a', generation: 1, revision: 1 })]));
    let resolvePage: ((response: Response) => void) | null = null;
    let resolveRead: ((response: Response) => void) | null = null;
    mockFetch(async input => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.endsWith('/read')) return new Promise<Response>(resolve => { resolveRead = resolve; });
      return new Promise<Response>(resolve => { resolvePage = resolve; });
    });
    invalidateInbox();
    await vi.waitFor(() => expect(getInboxSnapshot().refreshing).toBe(true));
    const readPromise = markInboxItemRead(makeInboxItem({ id: 'a', generation: 1, revision: 1 }));
    resolveRead!(Response.json(makeInboxItem({
      id: 'a', generation: 1, revision: 2, unread: false, read_at: '2026-10-12T04:00:00.000Z',
    })));
    expect(await readPromise).toBe('ok');
    expect(getInboxSnapshot().pendingItems[0]!.unread).toBe(false);
    expect(getInboxSnapshot().refreshing).toBe(false);
    // The older refresh now resolves and must not paint over the read state.
    resolvePage!(pageResponse({
      items: [makeInboxItem({ id: 'a', generation: 1, revision: 1 })],
      pending_count: 1,
      inbox_revision: 10,
    }));
    await Promise.resolve();
    expect(getInboxSnapshot().pendingItems[0]!.unread).toBe(false);
  });

  it('a late older-generation mutation response is fenced even after a snapshot dropped the row', async () => {
    applyInboxSyncSnapshot(snapshot([makeInboxItem({ id: 'a', generation: 1, revision: 5 })]));
    applyInboxItemChanged(makeInboxItem({ id: 'a', generation: 2, revision: 6 }), 11);
    // A reconnect snapshot no longer contains the row (it resolved elsewhere).
    applyInboxSyncSnapshot({ inbox_revision: 20, pending_count: 0, items: [], truncated: false });
    mockFetch(async () => Response.json(makeInboxItem({
      id: 'a', generation: 1, revision: 5, unread: false, read_at: '2026-10-12T04:00:00.000Z',
    })));
    const result = await markInboxItemRead(makeInboxItem({ id: 'a', generation: 1, revision: 5 }));
    expect(result).toBe('ok');
    // The stale row is NOT resurrected by the high-water fence surviving
    // snapshot replacement.
    expect(getInboxSnapshot().pendingItems).toEqual([]);
    expect(getInboxSnapshot().pendingCount).toBe(0);
  });

  it('drops a stale snapshot wholesale and never lowers the per-item fence', () => {
    applyInboxSyncSnapshot(snapshot([makeInboxItem({ id: 'a', generation: 1, revision: 5 })], 1));
    applyInboxItemChanged(makeInboxItem({ id: 'a', generation: 2, revision: 6 }), 11);
    // A snapshot with an older collection revision is stale — dropped whole.
    applyInboxSyncSnapshot({
      inbox_revision: 9,
      pending_count: 7,
      items: [makeInboxItem({ id: 'zz' })],
      truncated: false,
    });
    expect(getInboxSnapshot().inboxRevision).toBe(11);
    expect(getInboxSnapshot().pendingItems.map(item => item.id)).toEqual(['a']);
    expect(getInboxSnapshot().pendingItems[0]!.generation).toBe(2);
    // A fresh snapshot that re-lists the row at the older generation is
    // canonical for the collection, but must not lower the fence: a late
    // gen-1 write is still fenced off.
    applyInboxSyncSnapshot({
      inbox_revision: 20,
      pending_count: 1,
      items: [makeInboxItem({ id: 'a', generation: 1, revision: 5 })],
      truncated: false,
    });
    applyInboxItem(makeInboxItem({ id: 'a', generation: 1, revision: 5, unread: false, read_at: '2026-10-12T04:00:00.000Z' }));
    expect(getInboxSnapshot().pendingItems[0]!.unread).toBe(true);
  });

  it('discards a mutation response whose epoch an authoritative snapshot moved (no close WS)', async () => {
    applyInboxSyncSnapshot(snapshot([makeInboxItem({ id: 'a', generation: 1, revision: 1 })], 1));
    let resolveRead: ((response: Response) => void) | null = null;
    const calls: string[] = [];
    mockFetch(async input => {
      const url = typeof input === 'string' ? input : input.url;
      calls.push(url);
      if (url.endsWith('/read')) return new Promise<Response>(resolve => { resolveRead = resolve; });
      return pageResponse({ items: [], pending_count: 0, inbox_revision: 21 });
    });
    const pending = markInboxItemRead(makeInboxItem({ id: 'a', generation: 1, revision: 1 }));
    // The authoritative snapshot advances while the read is in flight — the
    // close WS frame was missed, so only the snapshot marks the item gone.
    applyInboxSyncSnapshot({ inbox_revision: 21, pending_count: 0, items: [], truncated: false });
    // The late response is even a HIGHER item revision — revision alone
    // cannot prove it is newer than the snapshot; the epoch fence discards
    // it and re-pulls canonically instead of resurrecting the pending row.
    resolveRead!(Response.json(makeInboxItem({
      id: 'a', generation: 1, revision: 2, unread: false, read_at: '2026-10-12T04:00:00.000Z',
    })));
    const result = await pending;
    expect(result).toBe('stale');
    await vi.waitFor(() => expect(getInboxSnapshot().inboxRevision).toBe(21));
    expect(getInboxSnapshot().pendingItems).toEqual([]);
    expect(getInboxSnapshot().pendingCount).toBe(0);
    expect(calls.some(url => url.startsWith('/api/inbox?'))).toBe(true);
  });

  it('a snapshot contradicting an accepted mutation reconciles the row and re-pulls', async () => {
    applyInboxSyncSnapshot(snapshot([makeInboxItem({ id: 'a', generation: 1, revision: 1 })], 1));
    const calls: string[] = [];
    mockFetch(async input => {
      const url = typeof input === 'string' ? input : input.url;
      calls.push(url);
      if (url.endsWith('/read')) {
        return Response.json(makeInboxItem({ id: 'a', generation: 1, revision: 2, unread: false, read_at: '2026-10-12T04:00:00.000Z' }));
      }
      return pageResponse({
        items: [makeInboxItem({ id: 'a', generation: 1, revision: 2, unread: false, read_at: '2026-10-12T04:00:00.000Z' })],
        pending_count: 1,
        inbox_revision: 10,
      });
    });
    expect(await markInboxItemRead(makeInboxItem({ id: 'a', generation: 1, revision: 1 }))).toBe('ok');
    expect(getInboxSnapshot().pendingItems[0]!.unread).toBe(false);
    // A state_sync built BEFORE the read lands late at the SAME collection
    // revision — past the revision gate, but the accepted rev2 evidence wins
    // the row and a canonical re-pull follows.
    applyInboxSyncSnapshot({
      inbox_revision: 10,
      pending_count: 1,
      items: [makeInboxItem({ id: 'a', generation: 1, revision: 1 })],
      truncated: false,
    });
    expect(getInboxSnapshot().pendingItems[0]!.unread).toBe(false);
    expect(getInboxSnapshot().pendingItems[0]!.revision).toBe(2);
    await vi.waitFor(() => expect(getInboxSnapshot().refreshing).toBe(false));
    expect(calls.some(url => url.startsWith('/api/inbox?'))).toBe(true);
  });

  it('a fenced mutation/detail application is reported, never applied', () => {
    applyInboxSyncSnapshot(snapshot([makeInboxItem({ id: 'a', generation: 2, revision: 6 })]));
    const epoch = inboxWriteEpoch();
    const result = applyInboxItemIfCurrent(makeInboxItem({ id: 'a', generation: 1, revision: 5, unread: false }), epoch);
    expect(result).toBe('fenced');
    expect(getInboxSnapshot().pendingItems[0]!.generation).toBe(2);
    expect(getInboxSnapshot().pendingItems[0]!.unread).toBe(true);
  });

  it('a snapshot row closed by newer evidence never re-enters pending; a re-pull repairs the count', async () => {
    applyInboxSyncSnapshot(snapshot([makeInboxItem({ id: 'a', generation: 1, revision: 1 })], 1));
    // The close frame lands: 'a' leaves pending (fence knows rev2 terminal).
    applyInboxItemChanged(
      makeInboxItem({ id: 'a', status: 'resolved', revision: 2, closed_at: '2026-10-12T05:00:00.000Z' }),
      11,
    );
    expect(getInboxSnapshot().pendingItems).toEqual([]);
    expect(getInboxSnapshot().pendingCount).toBe(0);
    // A state_sync built BEFORE the close lands late at the same revision.
    const calls = pendingListRouter([{ items: [], pending_count: 0, inbox_revision: 11 }]);
    applyInboxSyncSnapshot({
      inbox_revision: 11,
      pending_count: 1,
      items: [makeInboxItem({ id: 'a', generation: 1, revision: 1 })],
      truncated: false,
    });
    // Terminal evidence wins: the row never re-renders as pending; the
    // snapshot's stale count holds only until the re-pull repairs it.
    expect(getInboxSnapshot().pendingItems).toEqual([]);
    expect(getInboxSnapshot().pendingCount).toBe(1);
    await vi.waitFor(() => expect(getInboxSnapshot().pendingCount).toBe(0));
    expect(calls.length).toBeGreaterThan(0);
  });

  it('marks exactly the observed generation read and applies the response', async () => {
    applyInboxSyncSnapshot(snapshot([makeInboxItem({ id: 'a', generation: 3 })]));
    const seen: Array<{ id: string; body: { generation?: number } }> = [];
    mockFetch(async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      const readMatch = /\/api\/inbox\/([^/]+)\/read$/.exec(url);
      if (readMatch) {
        seen.push({ id: readMatch[1]!, body: JSON.parse(String(init?.body)) });
        return Response.json(makeInboxItem({ id: readMatch[1]!, generation: 3, revision: 2, unread: false, read_at: '2026-10-12T04:00:00.000Z' }));
      }
      return Response.json({ error: 'not_found' }, { status: 404 });
    });
    const result = await markInboxItemRead(makeInboxItem({ id: 'a', generation: 3 }));
    expect(result).toBe('ok');
    expect(seen).toEqual([{ id: 'a', body: { generation: 3 } }]);
    expect(getInboxSnapshot().pendingItems[0]!.unread).toBe(false);
    expect(getInboxSnapshot().pendingCount).toBe(1);
  });

  it('the WS echo of the same read arriving first is an idempotent ok, not a stale (issue #2)', async () => {
    applyInboxSyncSnapshot(snapshot([makeInboxItem({ id: 'a', generation: 3 })], 1));
    let resolveRead: ((response: Response) => void) | null = null;
    mockFetch(async input => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.endsWith('/read')) return new Promise<Response>(resolve => { resolveRead = resolve; });
      return pageResponse({ items: [], pending_count: 0, inbox_revision: 11 });
    });
    const pending = markInboxItemRead(makeInboxItem({ id: 'a', generation: 3 }));
    // The WS echo of this very read lands BEFORE the REST response — the
    // write token moved, but the generation did not.
    applyInboxItemChanged(
      makeInboxItem({ id: 'a', generation: 3, revision: 2, unread: false, read_at: '2026-10-12T06:00:00.000Z' }),
      11,
    );
    resolveRead!(Response.json(
      makeInboxItem({ id: 'a', generation: 3, revision: 2, unread: false, read_at: '2026-10-12T06:00:00.000Z' }),
    ));
    const result = await pending;
    expect(result).toBe('ok');
    expect(getInboxSnapshot().pendingItems[0]!.unread).toBe(false);
    expect(getInboxSnapshot().pendingCount).toBe(1);
  });

  it('a moved generation during the read flight is still stale (the strict fence stands)', async () => {
    applyInboxSyncSnapshot(snapshot([makeInboxItem({ id: 'a', generation: 3 })], 1));
    let resolveRead: ((response: Response) => void) | null = null;
    mockFetch(async input => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.endsWith('/read')) return new Promise<Response>(resolve => { resolveRead = resolve; });
      return pageResponse({
        items: [makeInboxItem({ id: 'a', generation: 4, revision: 3 })],
        pending_count: 1,
        inbox_revision: 20,
      });
    });
    const pending = markInboxItemRead(makeInboxItem({ id: 'a', generation: 3 }));
    // The item's occurrence moved (gen 4) while the read was in flight.
    applyInboxItemChanged(makeInboxItem({ id: 'a', generation: 4, revision: 3 }), 20);
    resolveRead!(Response.json(
      makeInboxItem({ id: 'a', generation: 3, revision: 2, unread: false, read_at: '2026-10-12T06:00:00.000Z' }),
    ));
    const result = await pending;
    expect(result).toBe('stale');
    await vi.waitFor(() => expect(getInboxSnapshot().inboxRevision).toBe(20));
    expect(getInboxSnapshot().pendingItems[0]!.generation).toBe(4);
  });

  it('a terminal close during the read flight reports stale, never ok', async () => {
    applyInboxSyncSnapshot(snapshot([makeInboxItem({ id: 'a', generation: 3 })], 1));
    let resolveRead: ((response: Response) => void) | null = null;
    mockFetch(async input => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.endsWith('/read')) return new Promise<Response>(resolve => { resolveRead = resolve; });
      return pageResponse({ items: [], pending_count: 0, inbox_revision: 21 });
    });
    const pending = markInboxItemRead(makeInboxItem({ id: 'a', generation: 3 }));
    applyInboxItemChanged(
      makeInboxItem({ id: 'a', status: 'resolved', revision: 2, closed_at: '2026-10-12T06:30:00.000Z' }),
      21,
    );
    resolveRead!(Response.json(
      makeInboxItem({ id: 'a', generation: 3, revision: 2, unread: false, read_at: '2026-10-12T06:00:00.000Z' }),
    ));
    const result = await pending;
    expect(result).toBe('stale');
    expect(getInboxSnapshot().pendingItems).toEqual([]);
  });

  it('a stale generation refreshes canonical state and never retries the old generation', async () => {
    applyInboxSyncSnapshot(snapshot([makeInboxItem({ id: 'a', generation: 3 })]));
    let readPosts = 0;
    mockFetch(async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.endsWith('/read')) {
        readPosts += 1;
        return Response.json({ error: 'stale', message: 'generation moved' }, { status: 409 });
      }
      if (url.startsWith('/api/inbox')) {
        return pageResponse({
          items: [makeInboxItem({ id: 'a', generation: 4, revision: 2 })],
          pending_count: 1,
          inbox_revision: 20,
        });
      }
      void init;
      return Response.json({ error: 'not_found' }, { status: 404 });
    });
    const result = await markInboxItemRead(makeInboxItem({ id: 'a', generation: 3 }));
    expect(result).toBe('stale');
    expect(readPosts).toBe(1);
    await vi.waitFor(() => expect(getInboxSnapshot().inboxRevision).toBe(20));
    expect(getInboxSnapshot().pendingItems[0]!.generation).toBe(4);
  });

  it('marks unread through the same exact-generation fence', async () => {
    applyInboxSyncSnapshot(snapshot([makeInboxItem({ id: 'a', generation: 2, unread: false, read_at: '2026-10-12T02:00:00.000Z' })]));
    const seen: unknown[] = [];
    mockFetch(async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.endsWith('/unread')) {
        seen.push(JSON.parse(String(init?.body)));
        return Response.json(makeInboxItem({ id: 'a', generation: 2, revision: 2, unread: true, read_at: null }));
      }
      return Response.json({ error: 'not_found' }, { status: 404 });
    });
    const result = await markInboxItemUnread(makeInboxItem({ id: 'a', generation: 2, unread: false }));
    expect(result).toBe('ok');
    expect(seen).toEqual([{ generation: 2 }]);
    expect(getInboxSnapshot().pendingItems[0]!.unread).toBe(true);
  });

  it('a closed-row read loses to a newer-generation WS frame mid-flight (never swaps onto the new occurrence)', async () => {
    // The row is closed at gen1 (a History row); a NEW pending occurrence of
    // the same id (gen2) lands while the read REST call is in flight. The
    // late gen1 body is fenced and MUST report stale — an ok here lets the
    // caller open a detail the live lookup would swap onto the gen2 item.
    applyInboxSyncSnapshot(snapshot([], 0));
    let resolveRead: ((response: Response) => void) | null = null;
    mockFetch(async input => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.endsWith('/read')) return new Promise<Response>(resolve => { resolveRead = resolve; });
      return pageResponse({
        items: [makeInboxItem({ id: 'a', generation: 2, revision: 3 })],
        pending_count: 1,
        inbox_revision: 12,
      });
    });
    const pendingRead = markInboxItemRead(makeInboxItem({
      id: 'a', status: 'resolved', generation: 1, revision: 1, unread: true,
      closed_at: '2026-10-12T03:00:00.000Z',
    }));
    applyInboxItemChanged(makeInboxItem({ id: 'a', generation: 2, revision: 3 }), 12);
    resolveRead!(Response.json(makeInboxItem({
      id: 'a', status: 'resolved', generation: 1, revision: 2, unread: false,
      read_at: '2026-10-12T06:00:00.000Z', closed_at: '2026-10-12T03:00:00.000Z',
    })));
    const result = await pendingRead;
    expect(result).toBe('stale');
    // The gen2 pending row stands; the fenced gen1 body never overwrote it.
    expect(getInboxSnapshot().pendingItems[0]!.generation).toBe(2);
    expect(getInboxSnapshot().pendingCount).toBe(1);
  });

  it('a same-generation WS echo of a closed-row read is an idempotent ok', async () => {
    // History rows have no pending membership; the echo of THIS exact read
    // (same id, same generation, same revision) must not false-positive as
    // stale — the strict epoch ceremony does not apply to closed rows.
    applyInboxSyncSnapshot(snapshot([], 0));
    let resolveRead: ((response: Response) => void) | null = null;
    mockFetch(async input => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.endsWith('/read')) return new Promise<Response>(resolve => { resolveRead = resolve; });
      return pageResponse({ items: [], pending_count: 0, inbox_revision: 11 });
    });
    const closed = makeInboxItem({
      id: 'old', status: 'resolved', generation: 1, revision: 1, unread: true,
      closed_at: '2026-10-12T03:00:00.000Z',
    });
    const pendingRead = markInboxItemRead(closed);
    applyInboxItemChanged(makeInboxItem({
      id: 'old', status: 'resolved', generation: 1, revision: 2, unread: false,
      read_at: '2026-10-12T06:00:00.000Z', closed_at: '2026-10-12T03:00:00.000Z',
    }), 11);
    resolveRead!(Response.json(makeInboxItem({
      id: 'old', status: 'resolved', generation: 1, revision: 2, unread: false,
      read_at: '2026-10-12T06:00:00.000Z', closed_at: '2026-10-12T03:00:00.000Z',
    })));
    expect(await pendingRead).toBe('ok');
    expect(getInboxSnapshot().pendingCount).toBe(0);
  });

  it('a closed-row unread loses to a newer-generation WS frame mid-flight', async () => {
    applyInboxSyncSnapshot(snapshot([], 0));
    let resolveUnread: ((response: Response) => void) | null = null;
    mockFetch(async input => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.endsWith('/unread')) return new Promise<Response>(resolve => { resolveUnread = resolve; });
      return pageResponse({
        items: [makeInboxItem({ id: 'a', generation: 2, revision: 3 })],
        pending_count: 1,
        inbox_revision: 12,
      });
    });
    const pendingUnread = markInboxItemUnread(makeInboxItem({
      id: 'a', status: 'resolved', generation: 1, revision: 1, unread: false,
      read_at: '2026-10-12T02:00:00.000Z', closed_at: '2026-10-12T03:00:00.000Z',
    }));
    applyInboxItemChanged(makeInboxItem({ id: 'a', generation: 2, revision: 3 }), 12);
    resolveUnread!(Response.json(makeInboxItem({
      id: 'a', status: 'resolved', generation: 1, revision: 2, unread: true,
      closed_at: '2026-10-12T03:00:00.000Z',
    })));
    expect(await pendingUnread).toBe('stale');
    expect(getInboxSnapshot().pendingItems[0]!.generation).toBe(2);
  });
});
