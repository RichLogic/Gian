/**
 * Bounded context-window hydration (Issue #168 / 0.6.7): jumping to an
 * unloaded find/search target loads ONLY the target's turn window, detaches
 * from the live tail, and pages older from the window's first turn; the
 * explicit return rehydrates the latest page. Failures surface an error
 * state, never a fake empty transcript.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { useState } from 'react';
import type { EventEnvelope, Session } from '@gian/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadEvents, loadSearchContext } from '../src/api.js';
import { useTranscriptHydration } from '../src/controllers/use-transcript-hydration.js';
import type { PlanLifecycleState } from '../src/transcript/apply.js';
import type { TranscriptItem } from '../src/types.js';

vi.mock('../src/api.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/api.js')>()),
  loadEvents: vi.fn(),
  loadSearchContext: vi.fn(),
}));

const session = { id: 's1', executor: 'codex' } as Session;

function userEnvelope(turn: number, text: string): EventEnvelope {
  return {
    session_id: 's1',
    turn,
    call_id: `u-${turn}`,
    event: 'user_message',
    ts: turn * 100,
    data: { text },
  };
}

function contextPage(events: EventEnvelope[], fromTurn: number, toTurn: number, historyComplete = true) {
  return {
    session: { id: 's1', name: 'Test', archived: 0 as const, read_only: false, workspace_id: null, task_id: null },
    events,
    window: { turn_id: `t-${toTurn}`, turn: toTurn, before: 2, after: 2, from_turn: fromTurn, to_turn: toTurn },
    history_complete: historyComplete,
  };
}

function useHarness(activeSessionId: string | null = 's1') {
  const [items, setItems] = useState<Record<string, TranscriptItem[]>>({});
  const [plans, setPlans] = useState<Record<string, PlanLifecycleState>>({});
  const history = useTranscriptHydration({
    activeSessionId,
    connectionReady: true,
    sessions: [session],
    itemsBySession: items,
    setItemsBySession: setItems,
    setPlanStateBySession: setPlans,
  });
  return { ...history, items };
}

describe('transcript context windows', () => {
  beforeEach(() => {
    vi.mocked(loadEvents).mockReset();
    vi.mocked(loadSearchContext).mockReset();
  });

  it('loads only the target window and detaches from the live tail', async () => {
    vi.mocked(loadEvents).mockResolvedValue({
      events: [userEnvelope(9, 'latest turn')],
      nextCursor: 9,
      hasMore: true,
    });
    const { result } = renderHook(() => useHarness());
    await waitFor(() => expect(result.current.historyBySession.s1?.phase).toBe('page'));
    expect(result.current.items.s1?.some(item => item.kind === 'user' && item.text === 'latest turn')).toBe(true);

    vi.mocked(loadSearchContext).mockResolvedValueOnce(contextPage(
      [userEnvelope(3, 'old target turn')],
      2,
      4,
    ) as never);
    let ok = false;
    await act(async () => {
      ok = await result.current.loadContextWindow('s1', 'codex', { turn: 4, documentId: 'doc-1' });
    });
    expect(ok).toBe(true);
    // The window REPLACES the loaded view — the latest tail is not walked in.
    expect(result.current.items.s1?.some(item => item.kind === 'user' && item.text === 'old target turn')).toBe(true);
    expect(result.current.items.s1?.some(item => item.kind === 'user' && item.text === 'latest turn')).toBe(false);
    expect(result.current.historyBySession.s1).toMatchObject({
      detachedFromLatest: true,
      hasMore: true,
      cursor: 2,
      loading: false,
    });
  });

  it('returnToLatest clears the detached window and rehydrates the tail', async () => {
    vi.mocked(loadEvents).mockResolvedValue({
      events: [userEnvelope(9, 'latest turn')],
      nextCursor: null,
      hasMore: false,
    });
    vi.mocked(loadSearchContext).mockResolvedValueOnce(contextPage([userEnvelope(3, 'old target turn')], 2, 4) as never);
    const { result } = renderHook(() => useHarness());
    await waitFor(() => expect(result.current.historyBySession.s1?.phase).toBe('complete'));
    await act(async () => {
      await result.current.loadContextWindow('s1', 'codex', { turn: 4, documentId: 'doc-1' });
    });
    expect(result.current.historyBySession.s1?.detachedFromLatest).toBe(true);
    act(() => result.current.returnToLatest('s1', 'codex'));
    await waitFor(() => expect(
      result.current.items.s1?.some(item => item.kind === 'user' && item.text === 'latest turn'),
    ).toBe(true));
    expect(result.current.historyBySession.s1?.detachedFromLatest).toBeUndefined();
    expect(result.current.historyBySession.s1?.phase).toBe('complete');
  });

  it('a failed context load returns false and keeps a retryable error state', async () => {
    vi.mocked(loadEvents).mockResolvedValue({ events: [], nextCursor: null, hasMore: false });
    vi.mocked(loadSearchContext).mockRejectedValueOnce(new Error('text revision moved'));
    const { result } = renderHook(() => useHarness());
    await waitFor(() => expect(result.current.historyBySession.s1?.phase).toBe('complete'));
    let ok = true;
    await act(async () => {
      ok = await result.current.loadContextWindow('s1', 'codex', { turn: 4 });
    });
    expect(ok).toBe(false);
    expect(result.current.historyBySession.s1?.error?.operation).toBe('context');
  });

  it('a context failure retries the SAME bounded locator', async () => {
    vi.mocked(loadEvents).mockResolvedValue({ events: [], nextCursor: null, hasMore: false });
    vi.mocked(loadSearchContext)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(contextPage([userEnvelope(3, 'old target turn')], 2, 4) as never);
    const { result } = renderHook(() => useHarness());
    await waitFor(() => expect(result.current.historyBySession.s1?.phase).toBe('complete'));
    await act(async () => {
      await result.current.loadContextWindow('s1', 'codex', { turn: 4, documentId: 'doc-1' });
    });
    expect(result.current.historyBySession.s1?.error?.operation).toBe('context');
    await act(async () => { result.current.retry('s1', 'codex'); });
    await waitFor(() => expect(result.current.historyBySession.s1?.detachedFromLatest).toBe(true));
    expect(vi.mocked(loadSearchContext).mock.calls).toEqual([
      ['s1', { turn: 4, documentId: 'doc-1' }],
      ['s1', { turn: 4, documentId: 'doc-1' }],
    ]);
  });

  it('older paging from a detached window stays detached', async () => {
    vi.mocked(loadEvents).mockResolvedValue({
      events: [userEnvelope(9, 'latest turn')],
      nextCursor: 9,
      hasMore: true,
    });
    const { result } = renderHook(() => useHarness());
    await waitFor(() => expect(result.current.historyBySession.s1?.phase).toBe('page'));
    vi.mocked(loadSearchContext).mockResolvedValueOnce(contextPage([userEnvelope(4, 'target')], 2, 4) as never);
    await act(async () => {
      await result.current.loadContextWindow('s1', 'codex', { turn: 4, documentId: 'doc-1' });
    });
    expect(result.current.historyBySession.s1?.detachedFromLatest).toBe(true);
    // Page older from the window's first turn.
    vi.mocked(loadEvents).mockResolvedValueOnce({
      events: [userEnvelope(1, 'older turn')],
      nextCursor: null,
      hasMore: false,
    });
    act(() => result.current.loadOlder('s1', 'codex'));
    await waitFor(() => expect(
      result.current.items.s1?.some(item => item.kind === 'user' && item.text === 'older turn'),
    ).toBe(true));
    expect(result.current.historyBySession.s1?.detachedFromLatest).toBe(true);
    expect(result.current.historyBySession.s1?.hasMore).toBe(false);
  });

  it('return-to-latest during a slow context load wins; the late window is discarded', async () => {
    vi.mocked(loadEvents).mockResolvedValue({
      events: [userEnvelope(9, 'latest turn')],
      nextCursor: null,
      hasMore: false,
    });
    let resolveContext!: (page: unknown) => void;
    vi.mocked(loadSearchContext).mockReturnValue(new Promise(resolve => { resolveContext = resolve; }));
    const { result } = renderHook(() => useHarness());
    await waitFor(() => expect(result.current.historyBySession.s1?.phase).toBe('complete'));
    let contextResult: Promise<boolean> | null = null;
    act(() => {
      contextResult = result.current.loadContextWindow('s1', 'codex', { turn: 4, documentId: 'doc-1' });
    });
    await waitFor(() => expect(result.current.historyBySession.s1?.loading).toBe(true));
    // The user returns to latest while the context load is in flight.
    act(() => result.current.returnToLatest('s1', 'codex'));
    await waitFor(() => expect(
      result.current.items.s1?.some(item => item.kind === 'user' && item.text === 'latest turn'),
    ).toBe(true));
    // The late context response is discarded — never overwrites the tail.
    await act(async () => {
      resolveContext(contextPage([userEnvelope(3, 'old target turn')], 2, 4));
    });
    expect(await contextResult!).toBe(false);
    expect(result.current.items.s1?.some(item => item.kind === 'user' && item.text === 'old target turn')).toBe(false);
    expect(result.current.historyBySession.s1?.detachedFromLatest).toBeUndefined();
    // …and the busy marker was not orphaned: a new context load still runs.
    vi.mocked(loadSearchContext).mockResolvedValueOnce(contextPage([userEnvelope(3, 'old target turn')], 2, 4) as never);
    let ok = false;
    await act(async () => {
      ok = await result.current.loadContextWindow('s1', 'codex', { turn: 4, documentId: 'doc-1' });
    });
    expect(ok).toBe(true);
    expect(result.current.historyBySession.s1?.detachedFromLatest).toBe(true);
  });

  it('re-entering a detached session does not merge the latest page into the window', async () => {
    vi.mocked(loadEvents).mockResolvedValue({
      events: [userEnvelope(9, 'latest turn')],
      nextCursor: 9,
      hasMore: true,
    });
    vi.mocked(loadSearchContext).mockResolvedValue(contextPage([userEnvelope(3, 'old target turn')], 2, 4) as never);
    const { result, rerender } = renderHook(
      ({ id }: { id: string | null }) => useHarness(id),
      { initialProps: { id: 's1' as string | null } },
    );
    await waitFor(() => expect(result.current.historyBySession.s1?.phase).toBe('page'));
    await act(async () => {
      await result.current.loadContextWindow('s1', 'codex', { turn: 4, documentId: 'doc-1' });
    });
    expect(result.current.historyBySession.s1?.detachedFromLatest).toBe(true);
    const callsBefore = vi.mocked(loadEvents).mock.calls.length;
    // Leave and come back: the detached window stays as-is.
    rerender({ id: null });
    rerender({ id: 's1' });
    await waitFor(() => expect(result.current.historyBySession.s1?.detachedFromLatest).toBe(true));
    expect(vi.mocked(loadEvents).mock.calls.length).toBe(callsBefore);
    expect(result.current.items.s1?.some(item => item.kind === 'user' && item.text === 'latest turn')).toBe(false);
    expect(result.current.items.s1?.some(item => item.kind === 'user' && item.text === 'old target turn')).toBe(true);
  });

  it('a slow older page is discarded when return-to-latest lands first', async () => {
    let resolveOlder!: (page: unknown) => void;
    vi.mocked(loadEvents)
      .mockResolvedValueOnce({ events: [userEnvelope(9, 'latest turn')], nextCursor: 9, hasMore: true })
      .mockReturnValueOnce(new Promise(resolve => { resolveOlder = resolve; }))
      .mockResolvedValueOnce({ events: [userEnvelope(9, 'latest turn')], nextCursor: null, hasMore: false });
    const { result } = renderHook(() => useHarness());
    await waitFor(() => expect(result.current.historyBySession.s1?.phase).toBe('page'));
    act(() => result.current.loadOlder('s1', 'codex'));
    await waitFor(() => expect(result.current.historyBySession.s1?.loadingOlder).toBe(true));
    act(() => result.current.returnToLatest('s1', 'codex'));
    await waitFor(() => expect(result.current.historyBySession.s1?.loadingOlder).toBe(false));
    await act(async () => {
      resolveOlder({ events: [userEnvelope(5, 'older turn')], nextCursor: 5, hasMore: true });
    });
    // The late older page never prepends into the rehydrated tail.
    expect(result.current.items.s1?.some(item => item.kind === 'user' && item.text === 'older turn')).toBe(false);
    expect(result.current.historyBySession.s1?.hasMore).toBe(false);
  });

  it('a newer context window supersedes an in-flight one', async () => {
    vi.mocked(loadEvents).mockResolvedValue({ events: [userEnvelope(9, 'latest turn')], nextCursor: null, hasMore: false });
    let resolveFirst!: (page: unknown) => void;
    let resolveSecond!: (page: unknown) => void;
    vi.mocked(loadSearchContext)
      .mockReturnValueOnce(new Promise(resolve => { resolveFirst = resolve; }))
      .mockReturnValueOnce(new Promise(resolve => { resolveSecond = resolve; }));
    const { result } = renderHook(() => useHarness());
    await waitFor(() => expect(result.current.historyBySession.s1?.phase).toBe('complete'));
    let firstResult: Promise<boolean> | null = null;
    await act(async () => {
      firstResult = result.current.loadContextWindow('s1', 'codex', { turn: 2, documentId: 'doc-old' });
    });
    let secondResult: Promise<boolean> | null = null;
    await act(async () => {
      secondResult = result.current.loadContextWindow('s1', 'codex', { turn: 6, documentId: 'doc-new' });
    });
    await act(async () => {
      resolveFirst(contextPage([userEnvelope(2, 'stale window')], 1, 2));
    });
    expect(await firstResult!).toBe(false);
    expect(result.current.items.s1?.some(item => item.kind === 'user' && item.text === 'stale window')).toBe(false);
    await act(async () => {
      resolveSecond(contextPage([userEnvelope(6, 'fresh window')], 5, 6));
    });
    expect(await secondResult!).toBe(true);
    expect(result.current.items.s1?.some(item => item.kind === 'user' && item.text === 'fresh window')).toBe(true);
  });

  it('a context window supersedes an in-flight initial page', async () => {
    let resolveInitial!: (page: unknown) => void;
    vi.mocked(loadEvents).mockReturnValueOnce(new Promise(resolve => { resolveInitial = resolve; }));
    vi.mocked(loadSearchContext).mockResolvedValueOnce(contextPage([userEnvelope(4, 'target')], 3, 4) as never);
    const { result } = renderHook(() => useHarness());
    await waitFor(() => expect(result.current.historyBySession.s1?.loading).toBe(true));
    let ok = false;
    await act(async () => {
      ok = await result.current.loadContextWindow('s1', 'codex', { turn: 4, documentId: 'doc-1' });
    });
    expect(ok).toBe(true);
    await act(async () => {
      resolveInitial({ events: [userEnvelope(9, 'latest turn')], nextCursor: null, hasMore: false });
    });
    // The initial page was superseded: the window stands, the tail never merged.
    expect(result.current.items.s1?.some(item => item.kind === 'user' && item.text === 'latest turn')).toBe(false);
    expect(result.current.items.s1?.some(item => item.kind === 'user' && item.text === 'target')).toBe(true);
    expect(result.current.historyBySession.s1?.detachedFromLatest).toBe(true);
  });

  it('a queued rebuild waits for the owner window — never fires from a stale finally', async () => {
    // Initial page with older history.
    let resolveOlder!: (page: unknown) => void;
    vi.mocked(loadEvents)
      .mockResolvedValueOnce({ events: [userEnvelope(9, 'latest turn')], nextCursor: 9, hasMore: true })
      .mockReturnValueOnce(new Promise(resolve => { resolveOlder = resolve; }))
      // returnToLatest rehydrate + the deferred rebuild.
      .mockResolvedValue({ events: [userEnvelope(9, 'latest turn')], nextCursor: null, hasMore: false });
    vi.mocked(loadSearchContext).mockResolvedValueOnce(contextPage([userEnvelope(4, 'target')], 3, 4) as never);
    const { result } = renderHook(() => useHarness());
    await waitFor(() => expect(result.current.historyBySession.s1?.phase).toBe('page'));
    // Start a slow older page, then queue a rebuild behind it.
    act(() => result.current.loadOlder('s1', 'codex'));
    await waitFor(() => expect(result.current.historyBySession.s1?.loadingOlder).toBe(true));
    act(() => result.current.rebuild('s1', 'codex'));
    const callsBeforeContext = vi.mocked(loadEvents).mock.calls.length;
    // A context window supersedes the slow older load.
    await act(async () => {
      await result.current.loadContextWindow('s1', 'codex', { turn: 4, documentId: 'doc-1' });
    });
    expect(result.current.historyBySession.s1?.detachedFromLatest).toBe(true);
    // The stale older response lands: no drain into the detached window.
    await act(async () => {
      resolveOlder({ events: [userEnvelope(5, 'older turn')], nextCursor: 5, hasMore: true });
    });
    expect(vi.mocked(loadEvents).mock.calls.length).toBe(callsBeforeContext);
    expect(result.current.items.s1?.some(item => item.kind === 'user' && item.text === 'latest turn')).toBe(false);
    // Return to latest: the owner's rehydrate drains the queued rebuild.
    act(() => result.current.returnToLatest('s1', 'codex'));
    await waitFor(() => expect(
      result.current.items.s1?.some(item => item.kind === 'user' && item.text === 'latest turn'),
    ).toBe(true));
    await vi.waitFor(() => expect(vi.mocked(loadEvents).mock.calls.length).toBeGreaterThan(callsBeforeContext + 1));
    expect(result.current.historyBySession.s1?.detachedFromLatest).toBeUndefined();
  });
});
