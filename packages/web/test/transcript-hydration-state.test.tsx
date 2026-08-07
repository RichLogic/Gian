import { act, renderHook, waitFor } from '@testing-library/react';
import { useState } from 'react';
import type { Session } from '@gian/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadEvents } from '../src/api.js';
import {
  historyIsHydrated,
  useTranscriptHydration,
} from '../src/controllers/use-transcript-hydration.js';
import type { PlanLifecycleState } from '../src/transcript/apply.js';
import type { TranscriptItem } from '../src/types.js';

vi.mock('../src/api.js', () => ({ loadEvents: vi.fn() }));

const session = {
  id: 's1',
  executor: 'codex',
} as Session;

function useHarness() {
  const [items, setItems] = useState<Record<string, TranscriptItem[]>>({});
  const [, setPlans] = useState<Record<string, PlanLifecycleState>>({});
  const history = useTranscriptHydration({
    activeSessionId: 's1',
    sessions: [session],
    itemsBySession: items,
    setItemsBySession: setItems,
    setPlanStateBySession: setPlans,
  });
  return { ...history, items };
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
    expect(result.current.historyBySession.s1).toBeUndefined();
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
});
