/**
 * Inbox panel behavior (Issue #53 / 0.6.7): opening the panel never marks
 * anything read; opening a specific item marks exactly its observed
 * generation read and shows the detail; domain actions are the
 * Host-advertised ones routed to the caller; Esc backs out of the detail
 * before closing; focus is restored; Pending pages forward and History is a
 * lazy closed-status REST read; failures render retry states, never a fake
 * empty list.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InboxPanel } from '../src/components/InboxPanel.js';
import {
  __resetInboxForTests,
  applyInboxItemChanged,
  applyInboxSyncSnapshot,
  getInboxSnapshot,
  invalidateInbox,
} from '../src/controllers/inbox.js';
import { mockFetch } from './setup.js';
import { makeInboxItem, wireTestInboxOperations } from './inbox-fixtures.js';

function seedPending() {
  applyInboxSyncSnapshot({
    inbox_revision: 10,
    pending_count: 2,
    items: [
      makeInboxItem({ id: 'a', title: 'Answer needed', generation: 3 }),
      makeInboxItem({ id: 'b', title: 'Approve deploy', unread: false, generation: 1 }),
    ],
    truncated: false,
  });
}

/** Default fetch router: records calls, serves read/unread and closed list. */
function panelFetchRouter(closedItems: ReturnType<typeof makeInboxItem>[] = []) {
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  mockFetch(async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init?.method ?? 'GET', url, body });
    const readMatch = /\/api\/inbox\/([^/]+)\/(read|unread)$/.exec(url);
    if (readMatch) {
      const [, id, action] = readMatch;
      const item = getInboxSnapshot().pendingItems.find(entry => entry.id === id)
        ?? closedItems.find(entry => entry.id === id);
      if (!item) throw new Error(`missing Inbox fixture ${id}`);
      return Response.json(makeInboxItem({
        ...item,
        id: id!,
        generation: (body as { generation: number }).generation,
        revision: item.revision + 1,
        unread: action === 'unread',
        read_at: action === 'read' ? '2026-10-12T06:00:00.000Z' : null,
      }));
    }
    if (url.startsWith('/api/inbox')) {
      return Response.json({
        items: closedItems,
        next_cursor: null,
        pending_count: 0,
        inbox_revision: 10,
      });
    }
    return Response.json({ error: 'not_found' }, { status: 404 });
  });
  return calls;
}

describe('InboxPanel', () => {
  let disposeOperations: () => void;
  beforeEach(() => { __resetInboxForTests(); disposeOperations = wireTestInboxOperations(); });
  afterEach(() => { disposeOperations(); __resetInboxForTests(); });

  it('opening the panel does not mark anything read', async () => {
    seedPending();
    const calls = panelFetchRouter();
    render(<InboxPanel open onClose={vi.fn()} onAction={vi.fn()} />);
    expect(await screen.findByText('Answer needed')).toBeTruthy();
    expect(screen.getByText('Approve deploy')).toBeTruthy();
    expect(calls.filter(call => call.method === 'POST')).toEqual([]);
    // Unread styling is per-item, independent of the pending badge.
    expect(screen.getByTestId('inbox-item-a').getAttribute('data-unread')).toBe('true');
    expect(screen.getByTestId('inbox-item-b').getAttribute('data-unread')).toBeNull();
  });

  it('opening an item marks exactly its generation read and shows the detail', async () => {
    seedPending();
    const calls = panelFetchRouter();
    const user = userEvent.setup();
    render(<InboxPanel open onClose={vi.fn()} onAction={vi.fn()} />);
    await user.click(await screen.findByText('Answer needed'));
    expect(await screen.findByTestId('inbox-detail-a')).toBeTruthy();
    const read = calls.find(call => call.url === '/api/inbox/a/read');
    expect(read?.method).toBe('POST');
    expect(read?.body).toEqual({ generation: 3 });
    // Read, but still pending — the badge must not drop.
    expect(getInboxSnapshot().pendingCount).toBe(2);
    expect(getInboxSnapshot().pendingItems[0]!.unread).toBe(false);
  });

  it('renders only Host-advertised actions and routes them to the caller', async () => {
    applyInboxSyncSnapshot({
      inbox_revision: 10,
      pending_count: 1,
      items: [makeInboxItem({
        id: 'ap',
        title: 'Allow rm -rf?',
        source_kind: 'session.approval',
        display: { kind: 'session.approval', interaction_id: 'approval-9', category: 'command' },
        actions: ['open', 'approve', 'reject'],
      })],
      truncated: false,
    });
    panelFetchRouter();
    const onAction = vi.fn();
    const user = userEvent.setup();
    render(<InboxPanel open onClose={vi.fn()} onAction={onAction} />);
    await user.click(await screen.findByText('Allow rm -rf?'));
    await screen.findByTestId('inbox-detail-ap');
    expect(screen.queryByTestId('inbox-action-answer')).toBeNull();
    await user.click(screen.getByTestId('inbox-action-approve'));
    expect(onAction).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'ap' }),
      'approve',
      'allow_once',
    );
    await user.click(screen.getByTestId('inbox-action-open'));
    expect(onAction).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'ap' }), 'open', undefined);
  });

  it('plan-review items keep their three real decisions', async () => {
    applyInboxSyncSnapshot({
      inbox_revision: 10,
      pending_count: 1,
      items: [makeInboxItem({
        id: 'plan-1',
        title: 'Plan ready',
        source_kind: 'session.approval',
        display: { kind: 'session.approval', interaction_id: 'approval-p', category: 'plan' },
        actions: ['open', 'approve', 'reject'],
      })],
      truncated: false,
    });
    panelFetchRouter();
    const onAction = vi.fn();
    const user = userEvent.setup();
    render(<InboxPanel open onClose={vi.fn()} onAction={onAction} />);
    await user.click(await screen.findByText('Plan ready'));
    await screen.findByTestId('inbox-detail-plan-1');
    await user.click(screen.getByTestId('inbox-action-approve-ask'));
    expect(onAction).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'plan-1' }), 'approve', 'accept_with_ask');
    await user.click(screen.getByTestId('inbox-action-approve-auto'));
    expect(onAction).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'plan-1' }), 'approve', 'accept_with_auto');
    await user.click(screen.getByTestId('inbox-action-reject'));
    expect(onAction).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'plan-1' }), 'reject', 'keep_planning');
  });

  it('the detail closes back to the list when the item leaves pending', async () => {
    applyInboxSyncSnapshot({
      inbox_revision: 10,
      pending_count: 1,
      items: [makeInboxItem({ id: 'a', title: 'Answer needed', generation: 3 })],
      truncated: false,
    });
    panelFetchRouter();
    const user = userEvent.setup();
    render(<InboxPanel open onClose={vi.fn()} onAction={vi.fn()} />);
    await user.click(await screen.findByText('Answer needed'));
    await screen.findByTestId('inbox-detail-a');
    // An older occurrence cannot close the selected generation.
    expect(getInboxSnapshot().pendingItems[0]).toMatchObject({ generation: 3, revision: 2, unread: false });
    act(() => applyInboxItemChanged(
      makeInboxItem({ id: 'a', generation: 1, status: 'resolved', revision: 1 }),
      11,
    ));
    expect(screen.getByTestId('inbox-detail-a')).toBeTruthy();
    expect(getInboxSnapshot().pendingCount).toBe(1);
    // The Host closes the observed occurrence after the read's revision 2.
    act(() => applyInboxItemChanged(
      makeInboxItem({ id: 'a', generation: 3, status: 'resolved', revision: 3, closed_at: '2026-10-12T07:00:00.000Z' }),
      12,
    ));
    await waitFor(() => expect(screen.queryByTestId('inbox-detail-a')).toBeNull());
    expect(screen.getByTestId('inbox-tab-pending')).toBeTruthy();
    expect(getInboxSnapshot().pendingCount).toBe(0);
  });

  it('Esc in the detail returns to the list; Esc on the list closes', async () => {
    seedPending();
    panelFetchRouter();
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<InboxPanel open onClose={onClose} onAction={vi.fn()} />);
    await user.click(await screen.findByText('Answer needed'));
    await screen.findByTestId('inbox-detail-a');
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByTestId('inbox-detail-a')).toBeNull();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('toggles unread per item without touching the pending count', async () => {
    seedPending();
    const calls = panelFetchRouter();
    const user = userEvent.setup();
    render(<InboxPanel open onClose={vi.fn()} onAction={vi.fn()} />);
    await user.click(await screen.findByTestId('inbox-read-b'));
    const unread = calls.find(call => call.url === '/api/inbox/b/unread');
    expect(unread?.body).toEqual({ generation: 1 });
    await waitFor(() => expect(getInboxSnapshot().pendingItems[1]!.unread).toBe(true));
    expect(getInboxSnapshot().pendingCount).toBe(2);
  });

  it('closing restores focus to the invoking element', async () => {
    seedPending();
    panelFetchRouter();
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.focus();
    const { unmount } = render(<InboxPanel open onClose={vi.fn()} onAction={vi.fn()} />);
    expect(document.activeElement).not.toBe(outside);
    unmount();
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it('history tab loads closed items lazily and renders them', async () => {
    seedPending();
    const calls = panelFetchRouter([makeInboxItem({ id: 'old', title: 'Done thing', status: 'resolved', unread: false })]);
    const user = userEvent.setup();
    render(<InboxPanel open onClose={vi.fn()} onAction={vi.fn()} />);
    expect(calls.filter(call => call.url.includes('status=closed'))).toEqual([]);
    await user.click(screen.getByTestId('inbox-tab-history'));
    expect(await screen.findByText('Done thing')).toBeTruthy();
    expect(calls.some(call => call.url.includes('status=closed'))).toBe(true);
  });

  it('history failure offers a retry that re-pulls', async () => {
    seedPending();
    let fail = true;
    mockFetch(async input => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.startsWith('/api/inbox')) {
        if (fail) return Response.json({ error: 'boom' }, { status: 500 });
        return Response.json({
          items: [makeInboxItem({ id: 'old', title: 'Recovered', status: 'resolved', unread: false })],
          next_cursor: null,
          pending_count: 0,
          inbox_revision: 10,
        });
      }
      return Response.json({ error: 'not_found' }, { status: 404 });
    });
    const user = userEvent.setup();
    render(<InboxPanel open onClose={vi.fn()} onAction={vi.fn()} />);
    await user.click(screen.getByTestId('inbox-tab-history'));
    expect(await screen.findByText('Could not load the Inbox.')).toBeTruthy();
    fail = false;
    await user.click(screen.getByText('Retry'));
    expect(await screen.findByText('Recovered')).toBeTruthy();
  });

  it('a truncated pending window pages forward via load-more', async () => {
    applyInboxSyncSnapshot({
      inbox_revision: 10,
      pending_count: 60,
      items: [makeInboxItem({ id: 'p1', title: 'Page one' })],
      truncated: true,
    });
    // The sync snapshot has no cursor: the first load-more restarts via REST
    // and takes over the canonical page cursor.
    mockFetch(async input => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('cursor=c2')) {
        return Response.json({
          items: [makeInboxItem({ id: 'p2', title: 'Page two' })],
          next_cursor: null,
          pending_count: 2,
          inbox_revision: 11,
        });
      }
      if (url.startsWith('/api/inbox')) {
        return Response.json({
          items: [makeInboxItem({ id: 'p1', title: 'Page one' })],
          next_cursor: 'c2',
          pending_count: 2,
          inbox_revision: 10,
        });
      }
      return Response.json({ error: 'not_found' }, { status: 404 });
    });
    const user = userEvent.setup();
    render(<InboxPanel open onClose={vi.fn()} onAction={vi.fn()} />);
    const more = await screen.findByTestId('inbox-pending-more');
    await user.click(more);
    // First click restarted via REST (new cursor); second click pages forward.
    await user.click(await screen.findByTestId('inbox-pending-more'));
    expect(await screen.findByText('Page two')).toBeTruthy();
    expect(screen.queryByTestId('inbox-pending-more')).toBeNull();
  });

  it('a search deep link opens the exact item only when the generation matches', async () => {
    seedPending();
    const calls = panelFetchRouter();
    const { rerender } = render(
      <InboxPanel open onClose={vi.fn()} onAction={vi.fn()} focusItem={{ id: 'a', generation: 3, nonce: 1 }} />,
    );
    // Matching generation: the detail opens (and reads the exact generation).
    expect(await screen.findByTestId('inbox-detail-a')).toBeTruthy();
    expect(calls.find(call => call.url === '/api/inbox/a/read')?.body).toEqual({ generation: 3 });

    // A stale hit (generation moved) never auto-opens or marks read.
    applyInboxSyncSnapshot({
      inbox_revision: 11,
      pending_count: 2,
      items: [
        makeInboxItem({ id: 'a', title: 'Answer needed', generation: 4, revision: 2 }),
        makeInboxItem({ id: 'b', title: 'Approve deploy', unread: false, generation: 1 }),
      ],
      truncated: false,
    });
    rerender(
      <InboxPanel open onClose={vi.fn()} onAction={vi.fn()} focusItem={{ id: 'a', generation: 3, nonce: 2 }} />,
    );
    await waitFor(() => expect(screen.queryByTestId('inbox-detail-a')).toBeNull());
    expect(calls.filter(call => call.url === '/api/inbox/a/read')).toHaveLength(1);
  });

  it('schedule-confirmation items render approve/reject through the domain path', async () => {
    applyInboxSyncSnapshot({
      inbox_revision: 10,
      pending_count: 1,
      items: [makeInboxItem({
        id: 'sc-1',
        title: 'Approve nightly digest?',
        source_kind: 'schedule.confirmation' as never,
        target: { type: 'schedule_confirmation', confirmation_id: 'conf-9' } as never,
        display: { kind: 'schedule.confirmation', confirmation_id: 'conf-9', control_session_id: 's-1' } as never,
        actions: ['open', 'approve', 'reject'],
      })],
      truncated: false,
    });
    panelFetchRouter();
    const onAction = vi.fn();
    const user = userEvent.setup();
    render(<InboxPanel open onClose={vi.fn()} onAction={onAction} />);
    await user.click(await screen.findByText('Approve nightly digest?'));
    await screen.findByTestId('inbox-detail-sc-1');
    expect(screen.queryByTestId('inbox-action-answer')).toBeNull();
    await user.click(screen.getByTestId('inbox-action-approve'));
    expect(onAction).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'sc-1' }),
      'approve',
      'allow_once',
    );
  });

  it('first click opens the detail even when the WS echo of the read lands first (issue #2)', async () => {
    seedPending();
    const calls = panelFetchRouter();
    const user = userEvent.setup();
    render(<InboxPanel open onClose={vi.fn()} onAction={vi.fn()} />);
    await user.click(await screen.findByText('Answer needed'));
    // The WS echo of this very read races ahead of the REST response.
    applyInboxItemChanged(
      makeInboxItem({ id: 'a', title: 'Answer needed', generation: 3, revision: 2, unread: false, read_at: '2026-10-12T06:00:00.000Z' }),
      11,
    );
    expect(await screen.findByTestId('inbox-detail-a')).toBeTruthy();
    expect(calls.find(call => call.url === '/api/inbox/a/read')?.body).toEqual({ generation: 3 });
  });

  it('a newer click supersedes an in-flight detail read', async () => {
    seedPending();
    const canonical = new Map(getInboxSnapshot().pendingItems.map(item => [item.id, item] as const));
    const reads = new Map<string, (r: Response) => void>();
    let refreshes = 0;
    mockFetch(async input => {
      const url = typeof input === 'string' ? input : input.url;
      const match = /\/api\/inbox\/([^/]+)\/read$/.exec(url);
      if (match) return new Promise<Response>(resolve => { reads.set(match[1]!, resolve); });
      if (url.startsWith('/api/inbox')) {
        refreshes += 1;
        return Response.json({ items: [...canonical.values()], next_cursor: null, pending_count: canonical.size, inbox_revision: 10 });
      }
      return Response.json({ error: 'not_found' }, { status: 404 });
    });
    const user = userEvent.setup();
    const resolveRead = (id: string) => {
      const item = { ...canonical.get(id)!, revision: 2, unread: false, read_at: '2026-10-12T06:00:00.000Z' };
      canonical.set(id, item);
      reads.get(id)!(Response.json(item));
    };
    render(<InboxPanel open onClose={vi.fn()} onAction={vi.fn()} />);
    await user.click(await screen.findByText('Answer needed'));
    await user.click(screen.getByText('Approve deploy'));
    // A's response lands after B's click — B must own the detail.
    await act(async () => {
      resolveRead('a');
    });
    expect(screen.queryByTestId('inbox-detail-a')).toBeNull();
    await act(async () => { resolveRead('b'); });
    expect(await screen.findByTestId('inbox-detail-b')).toBeTruthy();
    expect(refreshes).toBeGreaterThan(0);
    expect(getInboxSnapshot().pendingCount).toBe(2);
    expect(screen.queryByTestId('inbox-detail-a')).toBeNull();
  });

  it('a deep link reads once and cannot reopen after Escape or a read echo', async () => {
    seedPending();
    let reads = 0;
    mockFetch(async input => {
      const url = typeof input === 'string' ? input : input.url;
      if (url === '/api/inbox/a/read') {
        reads += 1;
        // Bound the broken effect too: report a duplicate instead of letting
        // the regression itself spin until the worker runs out of memory.
        if (reads > 1) return Response.json({ error: 'duplicate_read' }, { status: 500 });
        return Response.json(makeInboxItem({
          id: 'a', generation: 3, revision: 2, unread: false, read_at: '2026-10-12T06:00:00.000Z',
        }));
      }
      return Response.json({ error: 'not_found' }, { status: 404 });
    });
    const user = userEvent.setup();
    const { rerender } = render(
      <InboxPanel open onClose={vi.fn()} onAction={vi.fn()} focusItem={{ id: 'a', generation: 3, nonce: 1 }} />,
    );
    await screen.findByTestId('inbox-detail-a');
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('inbox-detail-a')).toBeNull();
    act(() => applyInboxItemChanged(makeInboxItem({
      id: 'a', generation: 3, revision: 3, unread: false, read_at: '2026-10-12T06:00:00.000Z',
    }), 11));
    rerender(
      <InboxPanel open onClose={vi.fn()} onAction={vi.fn()} focusItem={{ id: 'a', generation: 3, nonce: 1 }} />,
    );
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByTestId('inbox-detail-a')).toBeNull();
    expect(reads).toBe(1);
  });

  it('a late deep-link detail fetch cannot supersede a newer row click', async () => {
    seedPending();
    let resolveDetail!: (response: Response) => void;
    const reads: string[] = [];
    mockFetch(async input => {
      const url = typeof input === 'string' ? input : input.url;
      if (url === '/api/inbox/old') return new Promise<Response>(resolve => { resolveDetail = resolve; });
      if (url.endsWith('/read')) {
        reads.push(url);
        return Response.json(makeInboxItem({
          id: 'b', generation: 1, revision: 2, unread: false, read_at: '2026-10-12T06:00:00.000Z',
        }));
      }
      return Response.json({ error: 'not_found' }, { status: 404 });
    });
    const user = userEvent.setup();
    render(<InboxPanel open onClose={vi.fn()} onAction={vi.fn()} focusItem={{ id: 'old', generation: 1, nonce: 1 }} />);
    await waitFor(() => expect(resolveDetail).toBeTypeOf('function'));
    await user.click(screen.getByText('Approve deploy'));
    await screen.findByTestId('inbox-detail-b');
    await act(async () => {
      resolveDetail(Response.json(makeInboxItem({ id: 'old', status: 'resolved' })));
    });
    expect(reads).toEqual(['/api/inbox/b/read']);
    expect(screen.getByTestId('inbox-detail-b')).toBeTruthy();
    expect(screen.queryByTestId('inbox-detail-old')).toBeNull();
  });

  it('a history (closed) row opens its read-only detail even though it is not in the pending window', async () => {
    seedPending();
    panelFetchRouter([makeInboxItem({ id: 'old', title: 'Done thing', status: 'resolved', unread: false })]);
    const user = userEvent.setup();
    render(<InboxPanel open onClose={vi.fn()} onAction={vi.fn()} />);
    await user.click(screen.getByTestId('inbox-tab-history'));
    await user.click(await screen.findByText('Done thing'));
    expect(await screen.findByTestId('inbox-detail-old')).toBeTruthy();
  });

  it('a history row opens on first click even when its same-generation WS echo lands first', async () => {
    seedPending();
    let resolveRead: ((response: Response) => void) | null = null;
    mockFetch(async input => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.endsWith('/read')) return new Promise<Response>(resolve => { resolveRead = resolve; });
      if (url.includes('status=closed')) {
        return Response.json({
          items: [makeInboxItem({ id: 'old', title: 'Done thing', status: 'resolved', generation: 1, unread: true, closed_at: '2026-10-12T03:00:00.000Z' })],
          next_cursor: null, pending_count: 2, inbox_revision: 10,
        });
      }
      if (url.startsWith('/api/inbox')) {
        return Response.json({ items: [], next_cursor: null, pending_count: 0, inbox_revision: 10 });
      }
      return Response.json({ error: 'not_found' }, { status: 404 });
    });
    const user = userEvent.setup();
    render(<InboxPanel open onClose={vi.fn()} onAction={vi.fn()} />);
    await user.click(screen.getByTestId('inbox-tab-history'));
    await user.click(await screen.findByText('Done thing'));
    // The WS echo of this exact read (same id, generation, revision) lands
    // before the REST response — an idempotent ok, not a stale.
    applyInboxItemChanged(makeInboxItem({
      id: 'old', status: 'resolved', generation: 1, revision: 2, unread: false,
      read_at: '2026-10-12T06:00:00.000Z', closed_at: '2026-10-12T03:00:00.000Z',
    }), 11);
    resolveRead!(Response.json(makeInboxItem({
      id: 'old', status: 'resolved', generation: 1, revision: 2, unread: false,
      read_at: '2026-10-12T06:00:00.000Z', closed_at: '2026-10-12T03:00:00.000Z',
    })));
    expect(await screen.findByTestId('inbox-detail-old')).toBeTruthy();
  });

  it('a history click never opens when a new generation of the item arrives mid-read', async () => {
    seedPending();
    let resolveRead: ((response: Response) => void) | null = null;
    mockFetch(async input => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.endsWith('/read')) return new Promise<Response>(resolve => { resolveRead = resolve; });
      if (url.includes('status=closed')) {
        return Response.json({
          items: [makeInboxItem({ id: 'old', title: 'Done thing', status: 'resolved', generation: 1, unread: true, closed_at: '2026-10-12T03:00:00.000Z' })],
          next_cursor: null, pending_count: 2, inbox_revision: 10,
        });
      }
      if (url.startsWith('/api/inbox')) {
        return Response.json({
          items: [makeInboxItem({ id: 'old', title: 'Done thing — reopened', generation: 2, revision: 3 })],
          next_cursor: null, pending_count: 3, inbox_revision: 12,
        });
      }
      return Response.json({ error: 'not_found' }, { status: 404 });
    });
    const user = userEvent.setup();
    render(<InboxPanel open onClose={vi.fn()} onAction={vi.fn()} />);
    await user.click(screen.getByTestId('inbox-tab-history'));
    await user.click(await screen.findByText('Done thing'));
    // A fresh pending occurrence of the same id lands before the read returns.
    applyInboxItemChanged(makeInboxItem({ id: 'old', title: 'Done thing — reopened', generation: 2, revision: 3 }), 12);
    resolveRead!(Response.json(makeInboxItem({
      id: 'old', status: 'resolved', generation: 1, revision: 2, unread: false,
      read_at: '2026-10-12T06:00:00.000Z', closed_at: '2026-10-12T03:00:00.000Z',
    })));
    await new Promise(resolve => setTimeout(resolve, 20));
    // The stale gen1 read must not open a detail — the live row is the gen2
    // pending occurrence, a different item than the one the user clicked.
    expect(screen.queryByTestId('inbox-detail-old')).toBeNull();
  });

  it('an open detail closes when the row moves to a new generation (never swaps onto it)', async () => {
    seedPending();
    panelFetchRouter();
    const user = userEvent.setup();
    render(<InboxPanel open onClose={vi.fn()} onAction={vi.fn()} />);
    await user.click(await screen.findByText('Answer needed'));
    await screen.findByTestId('inbox-detail-a');
    // The occurrence moved: a gen4 pending row lands while the gen3 detail is open.
    applyInboxItemChanged(makeInboxItem({ id: 'a', title: 'Answer needed', generation: 4, revision: 3 }), 12);
    await waitFor(() => expect(screen.queryByTestId('inbox-detail-a')).toBeNull());
    // Back on the list; the new occurrence is a row, not the open detail.
    expect(screen.getByTestId('inbox-item-a')).toBeTruthy();
  });

  it('switching tabs retires an in-flight detail open', async () => {
    seedPending();
    let resolveRead: ((response: Response) => void) | null = null;
    mockFetch(async input => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.endsWith('/read')) return new Promise<Response>(resolve => { resolveRead = resolve; });
      if (url.startsWith('/api/inbox')) {
        return Response.json({ items: [], next_cursor: null, pending_count: 0, inbox_revision: 10 });
      }
      return Response.json({ error: 'not_found' }, { status: 404 });
    });
    const user = userEvent.setup();
    render(<InboxPanel open onClose={vi.fn()} onAction={vi.fn()} />);
    await user.click(await screen.findByText('Answer needed'));
    // Before the read returns, the user switches to History.
    await user.click(screen.getByTestId('inbox-tab-history'));
    resolveRead!(Response.json(makeInboxItem({
      id: 'a', generation: 3, revision: 2, unread: false, read_at: '2026-10-12T06:00:00.000Z',
    })));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(screen.queryByTestId('inbox-detail-a')).toBeNull();
  });

  it('a failed pending refresh shows an error with retry, not a fake empty list', async () => {
    let fail = true;
    mockFetch(async input => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.startsWith('/api/inbox')) {
        if (fail) return Response.json({ error: 'boom' }, { status: 500 });
        return Response.json({
          items: [makeInboxItem({ id: 'a', title: 'Back online' })],
          next_cursor: null,
          pending_count: 1,
          inbox_revision: 10,
        });
      }
      return Response.json({ error: 'not_found' }, { status: 404 });
    });
    invalidateInbox();
    const user = userEvent.setup();
    render(<InboxPanel open onClose={vi.fn()} onAction={vi.fn()} />);
    expect(await screen.findByText('Could not load the Inbox.')).toBeTruthy();
    expect(screen.queryByText('Nothing needs your attention.')).toBeNull();
    fail = false;
    await user.click(screen.getByText('Retry'));
    expect(await screen.findByText('Back online')).toBeTruthy();
  });
});
