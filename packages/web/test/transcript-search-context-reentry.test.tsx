/**
 * Global search opens a message by asking the transcript for one bounded
 * context window. App and CodingView pass a fresh focus object and a fresh
 * load callback on every render. The context route drops a response whose
 * navigation token is no longer current, so an effect that restarts on those
 * identities never applies the page and the transcript stays blank.
 */
import { useRef, useState } from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { EventEnvelope, Session } from '@gian/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadEvents, loadSearchContext } from '../src/api.js';
import { historyIsHydrated, useTranscriptHydration } from '../src/controllers/use-transcript-hydration.js';
import type { PlanLifecycleState } from '../src/transcript/apply.js';
import { Transcript } from '../src/transcript/Transcript.js';
import type { MsgItem, TranscriptItem } from '../src/types.js';

vi.mock('../src/api.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/api.js')>()),
  loadEvents: vi.fn(),
  loadSearchContext: vi.fn(),
}));

function userMsg(text: string): MsgItem {
  return { kind: 'user', id: 'u-1', text, exec: 'claude', ts: 500, turn: 1 };
}

function SearchContextHarness({ calls }: { calls: { n: number } }) {
  const tokenRef = useRef(0);
  const [items, setItems] = useState<TranscriptItem[]>([]);
  const [, setTick] = useState(0);
  const focus = {
    messageId: '1:user:u-1',
    turn: 1,
    nonce: 1,
    turnId: 'turn-1',
    documentId: 'doc-1',
    textRevision: 'rev-1',
  };
  return (
    <Transcript
      items={items}
      pending={false}
      onApprove={() => {}}
      messageFocus={focus}
      onLoadMessageContext={async () => {
        calls.n += 1;
        const token = ++tokenRef.current;
        setTick(tick => tick + 1);
        await new Promise(resolve => setTimeout(resolve, 40));
        if (token !== tokenRef.current) return false;
        setItems([userMsg('span.ri-title in the old window')]);
        return true;
      }}
    />
  );
}

describe('search context re-entry', () => {
  it('applies one bounded context page when the parent rebuilds focus every render', async () => {
    const calls = { n: 0 };
    render(<SearchContextHarness calls={calls} />);
    expect(await screen.findByText('span.ri-title in the old window')).toBeTruthy();
    await waitFor(() => expect(calls.n).toBeGreaterThan(0));
    expect(calls.n).toBeLessThanOrEqual(2);
  });
});

const session = { id: 's1', executor: 'codex' } as Session;

interface FocusRequest {
  messageId: string;
  turn: number;
  nonce: number;
  turnId: string;
  documentId: string;
  textRevision: string;
}

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

function contextPage(events: EventEnvelope[], fromTurn: number, toTurn: number) {
  return {
    session: { id: 's1', name: 'Test', archived: 0 as const, read_only: false, workspace_id: null, task_id: null },
    events,
    window: { turn_id: `t-${toTurn}`, turn: toTurn, before: 2, after: 2, from_turn: fromTurn, to_turn: toTurn },
    history_complete: true,
  };
}

function HydratedTranscript({
  focus,
  onConsume,
}: {
  focus: FocusRequest | null;
  onConsume: () => void;
}) {
  const [itemsBySession, setItemsBySession] = useState<Record<string, TranscriptItem[]>>({});
  const [plans, setPlans] = useState<Record<string, PlanLifecycleState>>({});
  const hydration = useTranscriptHydration({
    activeSessionId: 's1',
    connectionReady: true,
    sessions: [session],
    itemsBySession,
    setItemsBySession,
    setPlanStateBySession: setPlans,
  });
  const history = hydration.historyBySession.s1;
  return (
    <Transcript
      items={itemsBySession.s1 ?? []}
      pending={false}
      onApprove={() => {}}
      hydrated={historyIsHydrated(history)}
      historyError={history?.error ?? null}
      onRetryHistory={() => { hydration.retry('s1', 'codex'); }}
      messageFocus={focus}
      onConsumeMessageFocus={onConsume}
      returnToLatestGeneration={history?.returnToLatestGeneration ?? 0}
      onLoadMessageContext={request => hydration.loadContextWindow('s1', 'codex', request)}
    />
  );
}

describe('search context hydration and transcript focus', () => {
  beforeEach(() => {
    vi.mocked(loadEvents).mockReset();
    vi.mocked(loadSearchContext).mockReset();
  });

  it('a later focus replaces a deferred context load and a stale false does not consume it', async () => {
    let resolveFirst: (page: unknown) => void = () => {};
    let resolveSecond: (page: unknown) => void = () => {};
    vi.mocked(loadEvents).mockReturnValue(new Promise(() => {}));
    vi.mocked(loadSearchContext)
      .mockReturnValueOnce(new Promise(resolve => { resolveFirst = resolve; }))
      .mockReturnValueOnce(new Promise(resolve => { resolveSecond = resolve; }));
    const oldFocus: FocusRequest = {
      messageId: '2:user:u-2',
      turn: 2,
      nonce: 1,
      turnId: 'turn-2',
      documentId: 'doc-old',
      textRevision: 'rev-old',
    };
    const newFocus: FocusRequest = {
      messageId: '6:user:u-6',
      turn: 6,
      nonce: 2,
      turnId: 'turn-6',
      documentId: 'doc-new',
      textRevision: 'rev-new',
    };
    function SwitchFocus() {
      const [which, setWhich] = useState<'old' | 'new'>('old');
      const [consumed, setConsumed] = useState(0);
      return (
        <>
          <button type="button" onClick={() => setWhich('new')}>newer focus</button>
          <span data-testid="consumed">{consumed}</span>
          <HydratedTranscript
            focus={which === 'old' ? oldFocus : newFocus}
            onConsume={() => setConsumed(value => value + 1)}
          />
        </>
      );
    }
    const user = userEvent.setup();
    render(<SwitchFocus />);
    await waitFor(() => expect(vi.mocked(loadSearchContext).mock.calls.length).toBe(1));
    await user.click(screen.getByRole('button', { name: 'newer focus' }));
    await waitFor(() => expect(vi.mocked(loadSearchContext).mock.calls.length).toBe(2));
    await act(async () => {
      resolveFirst(contextPage([userEnvelope(2, 'stale window text')], 1, 2));
    });
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByText('stale window text')).toBeNull();
    expect(screen.getByTestId('consumed').textContent).toBe('0');
    await act(async () => {
      resolveSecond(contextPage([userEnvelope(6, 'fresh window text')], 5, 6));
    });
    expect(await screen.findByText('fresh window text')).toBeTruthy();
    expect(screen.queryByText('stale window text')).toBeNull();
    // Only the successful new target is consumed, never the stale response.
    expect(screen.getByTestId('consumed').textContent).toBe('1');
    expect(vi.mocked(loadSearchContext).mock.calls).toEqual([
      ['s1', { turnId: 'turn-2', turn: 2, documentId: 'doc-old', textRevision: 'rev-old' }],
      ['s1', { turnId: 'turn-6', turn: 6, documentId: 'doc-new', textRevision: 'rev-new' }],
    ]);
  });

  it('keeps one in-flight context load when the parent rerenders the same focus', async () => {
    let resolveContext: (page: unknown) => void = () => {};
    vi.mocked(loadEvents).mockReturnValue(new Promise(() => {}));
    vi.mocked(loadSearchContext).mockReturnValue(new Promise(resolve => { resolveContext = resolve; }));
    const focus: FocusRequest = {
      messageId: '4:user:u-4',
      turn: 4,
      nonce: 1,
      turnId: 'turn-4',
      documentId: 'doc-1',
      textRevision: 'rev-1',
    };
    function Parent() {
      const [tick, setTick] = useState(0);
      const [consumed, setConsumed] = useState(0);
      return (
        <>
          <button type="button" onClick={() => setTick(value => value + 1)}>parent tick</button>
          <span data-testid="parent-tick">{tick}</span>
          <span data-testid="consumed">{consumed}</span>
          <HydratedTranscript
            focus={{ ...focus }}
            onConsume={() => setConsumed(value => value + 1)}
          />
        </>
      );
    }
    const user = userEvent.setup();
    render(<Parent />);
    await waitFor(() => expect(vi.mocked(loadSearchContext).mock.calls.length).toBe(1));
    await user.click(screen.getByRole('button', { name: 'parent tick' }));
    await user.click(screen.getByRole('button', { name: 'parent tick' }));
    expect(screen.getByTestId('parent-tick').textContent).toBe('2');
    expect(vi.mocked(loadSearchContext).mock.calls.length).toBe(1);
    await act(async () => {
      resolveContext(contextPage([userEnvelope(4, 'stable focus target')], 3, 4));
    });
    expect(await screen.findByText('stable focus target')).toBeTruthy();
    expect(vi.mocked(loadSearchContext).mock.calls.length).toBe(1);
    expect(screen.getByTestId('consumed').textContent).toBe('1');
    await user.click(screen.getByRole('button', { name: 'parent tick' }));
    expect(screen.getByTestId('consumed').textContent).toBe('1');
  });

  it('lands the context target when the initial history page is still in flight', async () => {
    let resolveEvents: (page: unknown) => void = () => {};
    let resolveContext: (page: unknown) => void = () => {};
    vi.mocked(loadEvents).mockReturnValue(new Promise(resolve => { resolveEvents = resolve; }));
    vi.mocked(loadSearchContext).mockReturnValue(new Promise(resolve => { resolveContext = resolve; }));
    const focus: FocusRequest = {
      messageId: '4:user:u-4',
      turn: 4,
      nonce: 1,
      turnId: 'turn-4',
      documentId: 'doc-1',
      textRevision: 'rev-1',
    };
    function Race() {
      const [armed, setArmed] = useState(false);
      const [consumed, setConsumed] = useState(0);
      return (
        <>
          <button type="button" onClick={() => setArmed(true)}>focus target</button>
          <span data-testid="consumed">{consumed}</span>
          <HydratedTranscript
            focus={armed ? focus : null}
            onConsume={() => setConsumed(value => value + 1)}
          />
        </>
      );
    }
    const user = userEvent.setup();
    render(<Race />);
    await waitFor(() => expect(vi.mocked(loadEvents).mock.calls.length).toBe(1));
    expect(vi.mocked(loadSearchContext).mock.calls.length).toBe(0);
    await user.click(screen.getByRole('button', { name: 'focus target' }));
    await waitFor(() => expect(vi.mocked(loadSearchContext).mock.calls.length).toBe(1));
    await act(async () => {
      resolveContext(contextPage([userEnvelope(4, 'target landed')], 3, 4));
    });
    expect(await screen.findByText('target landed')).toBeTruthy();
    await act(async () => {
      resolveEvents({ events: [userEnvelope(9, 'latest tail')], nextCursor: null, hasMore: false });
    });
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText('target landed')).toBeTruthy();
    expect(screen.queryByText('latest tail')).toBeNull();
    expect(screen.getByTestId('consumed').textContent).toBe('1');
    expect(vi.mocked(loadEvents).mock.calls.length).toBe(1);
  });

  it('retries a failed context window with the same bounded query', async () => {
    vi.mocked(loadEvents).mockResolvedValue({ events: [], nextCursor: null, hasMore: false });
    vi.mocked(loadSearchContext)
      .mockRejectedValueOnce(new Error('text revision moved'))
      .mockResolvedValueOnce(contextPage([userEnvelope(4, 'landed target text')], 3, 4) as never);
    const focus: FocusRequest = {
      messageId: '4:user:u-4',
      turn: 4,
      nonce: 1,
      turnId: 'turn-4',
      documentId: 'doc-1',
      textRevision: 'rev-1',
    };
    function RetryFocus() {
      const [armed, setArmed] = useState(false);
      const [consumed, setConsumed] = useState(0);
      return (
        <>
          <button type="button" onClick={() => setArmed(true)}>focus target</button>
          <span data-testid="consumed">{consumed}</span>
          <HydratedTranscript
            focus={armed ? focus : null}
            onConsume={() => setConsumed(value => value + 1)}
          />
        </>
      );
    }
    const user = userEvent.setup();
    render(<RetryFocus />);
    await waitFor(() => expect(vi.mocked(loadEvents).mock.calls.length).toBeGreaterThan(0));
    await user.click(screen.getByRole('button', { name: 'focus target' }));
    expect(await screen.findByRole('button', { name: 'Retry history load' })).toBeTruthy();
    expect(screen.getByTestId('consumed').textContent).toBe('1');
    await user.click(screen.getByRole('button', { name: 'Retry history load' }));
    expect(await screen.findByText('landed target text')).toBeTruthy();
    expect(vi.mocked(loadSearchContext).mock.calls).toEqual([
      ['s1', { turnId: 'turn-4', turn: 4, documentId: 'doc-1', textRevision: 'rev-1' }],
      ['s1', { turnId: 'turn-4', turn: 4, documentId: 'doc-1', textRevision: 'rev-1' }],
    ]);
  });
});
