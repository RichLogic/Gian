import { act, renderHook, waitFor } from '@testing-library/react';
import { useState } from 'react';
import type { EventEnvelope, Session } from '@gian/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventHistoryLoadError, loadEvents } from '../src/api.js';
import {
  historyIsHydrated,
  useTranscriptHydration,
} from '../src/controllers/use-transcript-hydration.js';
import { applyEnvelope, type PlanLifecycleState } from '../src/transcript/apply.js';
import type { TranscriptItem } from '../src/types.js';

vi.mock('../src/api.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/api.js')>()),
  loadEvents: vi.fn(),
}));

const session = {
  id: 's1',
  executor: 'codex',
} as Session;
const otherSession = {
  id: 's2',
  executor: 'claude',
} as Session;

function userEvent(id: string, turn: number, text: string) {
  return {
    session_id: 's1', turn, call_id: id, event: 'user_message' as const, ts: turn, data: { text },
  };
}

function userMessageEnvelope(sessionId = 's1'): EventEnvelope {
  return {
    session_id: sessionId,
    turn: 3,
    call_id: 'canonical-user-message',
    event: 'user_message',
    ts: 1_754_622_012_000,
    data: { text: '制定一个 issue 解决计划' },
  };
}

function useHarness({
  activeSessionId = 's1',
  connectionReady = true,
  initialItems = {},
}: {
  activeSessionId?: string | null;
  connectionReady?: boolean;
  initialItems?: Record<string, TranscriptItem[]>;
} = {}) {
  const [items, setItems] = useState<Record<string, TranscriptItem[]>>(initialItems);
  const [, setPlans] = useState<Record<string, PlanLifecycleState>>({});
  const history = useTranscriptHydration({
    activeSessionId,
    connectionReady,
    sessions: [session, otherSession],
    setItemsBySession: setItems,
    setPlanStateBySession: setPlans,
  });
  const applyLive = (event: EventEnvelope) => {
    setItems(previous => ({
      ...previous,
      [event.session_id]: applyEnvelope(
        previous[event.session_id] ?? [],
        event,
        'codex',
      ),
    }));
  };
  return { ...history, items, applyLive };
}

describe('transcript history load state', () => {
  beforeEach(() => {
    vi.mocked(loadEvents).mockReset();
  });

  it('keeps live-only events distinct from first-page and complete hydration', async () => {
    let resolveFirst!: (page: Awaited<ReturnType<typeof loadEvents>>) => void;
    vi.mocked(loadEvents)
      .mockReturnValueOnce(new Promise(resolve => { resolveFirst = resolve; }))
      .mockResolvedValueOnce({ events: [], nextCursor: null, hasMore: false });

    const { result } = renderHook(() => useHarness());
    expect(result.current.historyBySession.s1).toMatchObject({
      phase: 'unloaded', loading: true, error: null,
    });
    expect(historyIsHydrated(result.current.historyBySession.s1)).toBe(false);

    act(() => result.current.markLive('s1'));
    expect(result.current.historyBySession.s1?.phase).toBe('live');
    expect(historyIsHydrated(result.current.historyBySession.s1)).toBe(false);

    await act(async () => {
      resolveFirst({ events: [], nextCursor: 7, hasMore: true });
    });
    await waitFor(() => expect(result.current.historyBySession.s1?.phase).toBe('page'));
    expect(historyIsHydrated(result.current.historyBySession.s1)).toBe(true);

    act(() => result.current.loadOlder('s1', 'codex'));
    await waitFor(() => expect(result.current.historyBySession.s1?.phase).toBe('complete'));
    expect(result.current.historyBySession.s1?.hasMore).toBe(false);
  });

  it('hydrates REST history while the WebSocket connection is not ready', async () => {
    vi.mocked(loadEvents).mockResolvedValueOnce({
      events: [userEvent('history-offline-ws', 1, 'loaded over HTTP')],
      nextCursor: null,
      hasMore: false,
    });

    const { result } = renderHook(() => useHarness({ connectionReady: false }));

    await waitFor(() => expect(result.current.historyBySession.s1?.phase).toBe('complete'));
    expect(result.current.items.s1?.map(item => item.id)).toEqual(['history-offline-ws']);
    expect(loadEvents).toHaveBeenCalledTimes(1);
  });

  it('keeps a same-session 500 failure stable and preserves live transcript items', async () => {
    let rejectFirst!: (error: Error) => void;
    vi.mocked(loadEvents).mockReturnValueOnce(new Promise((_resolve, reject) => { rejectFirst = reject; }));
    const liveItem = {
      kind: 'user', id: 'live-1', text: 'still here', exec: 'codex', ts: 10, turn: 10,
    } as TranscriptItem;

    const { result } = renderHook(() => useHarness({ initialItems: { s1: [liveItem] } }));
    act(() => result.current.markLive('s1'));
    await act(async () => {
      rejectFirst(new EventHistoryLoadError('http', 'server failed', { status: 500 }));
    });

    await waitFor(() => expect(result.current.historyBySession.s1?.error?.status).toBe(500));
    expect(result.current.historyBySession.s1).toMatchObject({
      phase: 'live', loading: false, error: { kind: 'http', operation: 'initial' },
    });
    expect(result.current.items.s1).toEqual([liveItem]);
    await act(async () => { await Promise.resolve(); });
    expect(loadEvents).toHaveBeenCalledTimes(1);
  });

  it('exposes 401 and network rejects without marking history complete', async () => {
    vi.mocked(loadEvents).mockRejectedValueOnce(
      new EventHistoryLoadError('http', 'unauthorized', { status: 401 }),
    );
    const first = renderHook(() => useHarness());
    await waitFor(() => expect(first.result.current.historyBySession.s1?.error?.status).toBe(401));
    expect(first.result.current.historyBySession.s1?.phase).not.toBe('complete');
    first.unmount();

    vi.mocked(loadEvents).mockRejectedValueOnce(
      new EventHistoryLoadError('network', 'offline'),
    );
    const second = renderHook(() => useHarness());
    await waitFor(() => expect(second.result.current.historyBySession.s1?.error?.kind).toBe('network'));
    expect(second.result.current.historyBySession.s1?.phase).not.toBe('complete');
  });

  it('recovers through explicit retry after an initial failure', async () => {
    vi.mocked(loadEvents)
      .mockRejectedValueOnce(new EventHistoryLoadError('network', 'offline'))
      .mockResolvedValueOnce({
        events: [userEvent('history-1', 1, 'recovered')], nextCursor: null, hasMore: false,
      });
    const { result } = renderHook(() => useHarness());
    await waitFor(() => expect(result.current.historyBySession.s1?.error?.kind).toBe('network'));

    act(() => result.current.retry('s1', 'codex'));

    await waitFor(() => expect(result.current.historyBySession.s1?.phase).toBe('complete'));
    expect(result.current.historyBySession.s1?.error).toBeNull();
    expect(result.current.items.s1?.map(item => item.id)).toEqual(['history-1']);
    expect(loadEvents).toHaveBeenCalledTimes(2);
  });

  it('preserves page cursor and items when loading older history fails', async () => {
    vi.mocked(loadEvents)
      .mockResolvedValueOnce({
        events: [userEvent('current-2', 2, 'current')], nextCursor: 2, hasMore: true,
      })
      .mockRejectedValueOnce(new EventHistoryLoadError('http', 'server failed', { status: 500 }))
      .mockResolvedValueOnce({
        events: [userEvent('older-1', 1, 'older')], nextCursor: null, hasMore: false,
      });
    const { result } = renderHook(() => useHarness());
    await waitFor(() => expect(result.current.historyBySession.s1?.phase).toBe('page'));
    const currentItems = result.current.items.s1;

    act(() => result.current.loadOlder('s1', 'codex'));

    await waitFor(() => expect(result.current.historyBySession.s1?.error?.operation).toBe('older'));
    expect(result.current.historyBySession.s1).toMatchObject({
      phase: 'page', hasMore: true, cursor: 2, loadingOlder: false,
      error: { kind: 'http', status: 500 },
    });
    expect(result.current.items.s1).toEqual(currentItems);

    act(() => result.current.retry('s1', 'codex'));
    await waitFor(() => expect(result.current.historyBySession.s1?.phase).toBe('complete'));
    expect(result.current.items.s1?.map(item => item.id)).toEqual(['older-1', 'current-2']);
  });

  it('retries an errored active session after a real connection-ready edge', async () => {
    vi.mocked(loadEvents)
      .mockRejectedValueOnce(new EventHistoryLoadError('network', 'offline'))
      .mockResolvedValueOnce({ events: [], nextCursor: null, hasMore: false });
    const { result, rerender } = renderHook(
      ({ connectionReady }) => useHarness({ connectionReady }),
      { initialProps: { connectionReady: true } },
    );
    await waitFor(() => expect(result.current.historyBySession.s1?.error).not.toBeNull());

    rerender({ connectionReady: false });
    rerender({ connectionReady: true });

    await waitFor(() => expect(result.current.historyBySession.s1?.phase).toBe('complete'));
    expect(loadEvents).toHaveBeenCalledTimes(2);
  });

  it('retries an errored session when the user leaves and re-enters it', async () => {
    vi.mocked(loadEvents)
      .mockRejectedValueOnce(new EventHistoryLoadError('network', 'offline'))
      .mockResolvedValueOnce({ events: [], nextCursor: null, hasMore: false });
    const { result, rerender } = renderHook(
      ({ activeSessionId }) => useHarness({ activeSessionId }),
      { initialProps: { activeSessionId: 's1' as string | null } },
    );
    await waitFor(() => expect(result.current.historyBySession.s1?.error).not.toBeNull());

    rerender({ activeSessionId: null });
    rerender({ activeSessionId: 's1' });

    await waitFor(() => expect(result.current.historyBySession.s1?.phase).toBe('complete'));
    expect(loadEvents).toHaveBeenCalledTimes(2);
  });

  it('does not duplicate a live canonical user message when the first history page arrives', async () => {
    const canonical = userMessageEnvelope();
    let resolveFirst!: (page: Awaited<ReturnType<typeof loadEvents>>) => void;
    vi.mocked(loadEvents).mockReturnValueOnce(new Promise(resolve => { resolveFirst = resolve; }));

    const liveItems = applyEnvelope([], canonical, 'codex');
    const { result } = renderHook(() => useHarness({ initialItems: { s1: liveItems } }));
    expect(result.current.items.s1).toHaveLength(1);

    await act(async () => {
      resolveFirst({ events: [{ ...canonical }], nextCursor: null, hasMore: false });
    });

    await waitFor(() => expect(result.current.historyBySession.s1?.phase).toBe('complete'));
    expect(result.current.items.s1).toHaveLength(1);
    expect(result.current.items.s1?.[0]).toMatchObject({
      kind: 'user',
      id: canonical.call_id,
      text: canonical.data.text,
    });
    expect(result.current.items.s1?.[0]).not.toHaveProperty('pending');
  });

  it('does not duplicate a historical user message when the matching live event arrives later', async () => {
    const canonical = userMessageEnvelope();
    const live = { ...canonical, ts: canonical.ts + 250 };
    vi.mocked(loadEvents).mockResolvedValueOnce({
      events: [canonical],
      nextCursor: null,
      hasMore: false,
    });

    const { result } = renderHook(() => useHarness());
    await waitFor(() => expect(result.current.historyBySession.s1?.phase).toBe('complete'));
    expect(result.current.items.s1).toHaveLength(1);

    act(() => result.current.applyLive(live));

    expect(result.current.items.s1).toHaveLength(1);
    expect(result.current.items.s1?.[0]).toMatchObject({
      kind: 'user',
      id: canonical.call_id,
      text: canonical.data.text,
      ts: live.ts,
    });
  });

  it('does not duplicate a hydrated user message when switching back refreshes the latest page', async () => {
    const canonical = userMessageEnvelope();
    const refreshed = { ...canonical, ts: canonical.ts + 500 };
    vi.mocked(loadEvents)
      .mockResolvedValueOnce({ events: [canonical], nextCursor: null, hasMore: false })
      .mockResolvedValueOnce({ events: [], nextCursor: null, hasMore: false })
      .mockResolvedValueOnce({ events: [refreshed], nextCursor: null, hasMore: false });

    const { result, rerender } = renderHook(
      ({ activeSessionId }) => useHarness({ activeSessionId }),
      { initialProps: { activeSessionId: 's1' as string | null } },
    );
    await waitFor(() => expect(result.current.historyBySession.s1?.phase).toBe('complete'));
    expect(result.current.items.s1).toHaveLength(1);

    rerender({ activeSessionId: 's2' });
    await waitFor(() => expect(result.current.historyBySession.s2?.phase).toBe('complete'));

    rerender({ activeSessionId: 's1' });
    await waitFor(() => expect(loadEvents).toHaveBeenNthCalledWith(3, 's1'));
    await waitFor(() => expect(result.current.items.s1?.[0]?.ts).toBe(refreshed.ts));
    expect(result.current.items.s1).toHaveLength(1);
    expect(result.current.items.s1?.[0]).toMatchObject({
      kind: 'user',
      id: canonical.call_id,
      text: canonical.data.text,
    });
  });
});
