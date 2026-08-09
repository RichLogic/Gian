import { act, render, screen } from '@testing-library/react';
import {
  useEffect,
  useRef,
  useState,
  type SetStateAction,
} from 'react';
import type { ClientToServerMessage, Session } from '@gian/shared';
import { describe, expect, it, vi } from 'vitest';
import { useAppSocket } from '../src/controllers/use-app-socket.js';
import { LocaleProvider } from '../src/i18n/index.js';
import { createOperationDispatcher, type OperationDispatcher } from '../src/operations/dispatcher.js';
import {
  createMessageEchoSink,
  dispatchMessageSend,
  wireMessageEchoSink,
} from '../src/operations/message.js';
import { createOperationStore, type OperationStore } from '../src/operations/store.js';
import { OperationDispatcherProvider, OperationStoreProvider } from '../src/operations/use-operations.js';
import { UserMessage } from '../src/transcript/items.js';
import type { PlanLifecycleState } from '../src/transcript/apply.js';
import type { TranscriptItem } from '../src/types.js';
import { GianWs } from '../src/ws.js';
import { sessionContractFixture, stateSyncFixture } from './fixtures/ws-contract.js';
import { getMockWebSockets } from './setup.js';

vi.mock('../src/api.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api.js')>('../src/api.js');
  return {
    ...actual,
    loadWorkspaces: vi.fn(async () => []),
    loadSessions: vi.fn(async () => []),
    loadTasks: vi.fn(async () => []),
    loadWorkingTrees: vi.fn(async () => []),
  };
});

function ignoreState<T>(_next: SetStateAction<T>): void {}

interface HarnessProps {
  ws: GianWs;
  store: OperationStore;
  ops: OperationDispatcher;
  initialSessions?: Session[];
  initialActiveSessionId?: string;
  pendingFirstMessage?: string | null;
  initialItemsBySession?: Record<string, TranscriptItem[]>;
  initialPlanStateBySession?: Record<string, PlanLifecycleState>;
}

function ClientReducerHarness({
  ws,
  store,
  ops,
  initialSessions = [],
  initialActiveSessionId = 'session-wire',
  pendingFirstMessage = null,
  initialItemsBySession = {},
  initialPlanStateBySession = {},
}: HarnessProps) {
  const [authed, setAuthed] = useState(false);
  const [itemsBySession, setItemsBySession] = useState<Record<string, TranscriptItem[]>>(initialItemsBySession);
  const [pendingBySession, setPendingBySession] = useState<Record<string, boolean>>({});
  const [planStateBySession, setPlanStateBySession] = useState<
    Record<string, PlanLifecycleState>
  >(initialPlanStateBySession);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(initialActiveSessionId);
  const sessionsRef = useRef<Session[]>(initialSessions);
  const itemsBySessionRef = useRef<Record<string, TranscriptItem[]>>(initialItemsBySession);
  itemsBySessionRef.current = itemsBySession;
  const activeSessionIdRef = useRef<string | null>(activeSessionId);
  activeSessionIdRef.current = activeSessionId;
  const pendingFirstMessageRef = useRef<string | null>(pendingFirstMessage);
  const setSessionsRef = (next: SetStateAction<Session[]>) => {
    sessionsRef.current = typeof next === 'function' ? next(sessionsRef.current) : next;
  };

  useEffect(() => {
    wireMessageEchoSink(createMessageEchoSink(setItemsBySession, setPendingBySession));
    return () => wireMessageEchoSink(null);
  }, []);

  useAppSocket({
    authStatus: 'authenticated',
    ws,
    sessionsRef,
    itemsBySessionRef,
    activeSessionIdRef,
    pendingFirstMessageRef,
    setWsState: ignoreState,
    setWsAttempt: ignoreState,
    setAuthed,
    setWorkspaces: ignoreState,
    setSessions: setSessionsRef,
    setTasks: ignoreState,
    setSystemConfig: ignoreState,
    setRunner: ignoreState,
    setActiveSessionId,
    setActiveTaskId: ignoreState,
    setActiveSubtaskId: ignoreState,
    setItemsBySession,
    setPendingBySession,
    setQueueBySession: ignoreState,
    setPlanStateBySession,
    markSessionHistoryLive: () => {},
    operationStore: store,
    ops,
  });

  return (
    <OperationStoreProvider store={store}>
      <OperationDispatcherProvider dispatcher={ops}>
        <LocaleProvider locale="en">
          <div data-testid="rendered-messages">
            {Object.entries(itemsBySession).flatMap(([sessionId, items]) =>
              items.map((item, index) => item.kind === 'user'
                ? <UserMessage key={`${sessionId}:${item.id}:${index}`} item={item} />
                : null))}
          </div>
          <pre data-testid="snapshot">
            {JSON.stringify({
              authed,
              activeSessionId,
              pendingFirstMessage: pendingFirstMessageRef.current,
              itemsBySession,
              pendingBySession,
              planStateBySession,
            })}
          </pre>
        </LocaleProvider>
      </OperationDispatcherProvider>
    </OperationStoreProvider>
  );
}

interface Snapshot {
  authed: boolean;
  activeSessionId: string | null;
  pendingFirstMessage: string | null;
  itemsBySession: Record<string, Array<{
    kind?: TranscriptItem['kind'];
    id?: string;
    turn?: number;
    sendRunId?: string;
    sendCanonical?: boolean;
    sendRetry?: { sessionId: string; text: string };
    pending?: boolean;
    failed?: boolean;
  }>>;
  pendingBySession: Record<string, boolean>;
  planStateBySession: Record<string, PlanLifecycleState>;
}

function snapshot(): Snapshot {
  return JSON.parse(screen.getByTestId('snapshot').textContent ?? '{}') as Snapshot;
}

describe('WS-003: Host dispatch failure through the real Web client chain', () => {
  it('closes the latest in-memory turn once when only a terminal session update arrives', async () => {
    const ws = new GianWs('ws://test.invalid/ws', () => 'token');
    const store = createOperationStore();
    const ops = createOperationDispatcher({ store, transport: ws });
    const session = sessionContractFixture({
      id: 'session-wire', status: 'running', executor: 'kimi',
    });
    const view = render(
      <ClientReducerHarness
        ws={ws}
        store={store}
        ops={ops}
        initialSessions={[session]}
        initialItemsBySession={{
          'session-wire': [
            {
              kind: 'reasoning', id: 'shared-turn-id', variant: 'full',
              text: 'still visible', ts: 1_000, turn: 7,
            },
          ],
        }}
      />,
    );

    try {
      const socket = getMockWebSockets()[0]!;
      await act(async () => {
        socket.fakeOpen();
        await Promise.resolve();
        await Promise.resolve();
      });
      act(() => socket.fakeMessage({ type: 'auth_ok', user: 'dev' }));
      act(() => socket.fakeMessage({ ...stateSyncFixture(), sessions: [session] }));

      const terminalUpdate = {
        type: 'session:updated' as const,
        session: {
          id: 'session-wire', status: 'done' as const,
          updated_at: '2026-08-09T02:12:25.000Z',
        },
      };
      act(() => socket.fakeMessage(terminalUpdate));
      expect(snapshot().pendingBySession['session-wire']).toBe(false);
      expect(snapshot().itemsBySession['session-wire']?.filter(item => item.kind === 'turn-end'))
        .toMatchObject([{ turn: 7 }]);

      // A duplicate session update and a late real event converge on the same
      // turn boundary instead of creating multiple TurnSum triggers.
      act(() => socket.fakeMessage(terminalUpdate));
      act(() => socket.fakeMessage({
        type: 'event',
        session_id: 'session-wire',
        turn: 7,
        call_id: 'provider-turn-complete',
        event: 'turn_completed',
        ts: Date.parse('2026-08-09T02:12:25.000Z'),
        data: {},
      }));
      expect(snapshot().itemsBySession['session-wire']?.filter(item => item.kind === 'turn-end'))
        .toMatchObject([{ id: 'provider-turn-complete', turn: 7 }]);
    } finally {
      view.unmount();
      ops.dispose();
      ws.disconnect();
    }
  });

  it('uses same-task state_sync status when a terminal update immediately follows reconnect', async () => {
    const ws = new GianWs('ws://test.invalid/ws', () => 'token');
    const store = createOperationStore();
    const ops = createOperationDispatcher({ store, transport: ws });
    const done = sessionContractFixture({ id: 'session-wire', status: 'done', executor: 'kimi' });
    const running = { ...done, status: 'running' as const };
    const view = render(
      <ClientReducerHarness
        ws={ws}
        store={store}
        ops={ops}
        initialSessions={[done]}
        initialItemsBySession={{
          'session-wire': [{
            kind: 'reasoning', id: 'r7', variant: 'full', text: 'live', ts: 700, turn: 7,
          }],
        }}
      />,
    );

    try {
      const socket = getMockWebSockets()[0]!;
      await act(async () => {
        socket.fakeOpen();
        await Promise.resolve();
        await Promise.resolve();
      });
      act(() => socket.fakeMessage({ type: 'auth_ok', user: 'dev' }));
      act(() => {
        socket.fakeMessage({ ...stateSyncFixture(), sessions: [running] });
        socket.fakeMessage({
          type: 'session:updated',
          session: { id: running.id, status: 'done', updated_at: '2026-08-09T02:12:25.000Z' },
        });
      });

      expect(snapshot().itemsBySession['session-wire']?.filter(item => item.kind === 'turn-end'))
        .toMatchObject([{ turn: 7 }]);
    } finally {
      view.unmount();
      ops.dispose();
      ws.disconnect();
    }
  });

  it('finalizes an active plan from session lifecycle alone using the latest transcript turn', async () => {
    const ws = new GianWs('ws://test.invalid/ws', () => 'token');
    const store = createOperationStore();
    const ops = createOperationDispatcher({ store, transport: ws });
    const running = sessionContractFixture({
      id: 'session-wire', status: 'running', executor: 'kimi',
    });
    const view = render(
      <ClientReducerHarness
        ws={ws}
        store={store}
        ops={ops}
        initialSessions={[running]}
        initialItemsBySession={{
          'session-wire': [{
            kind: 'assistant', id: 'a7', text: 'finished', exec: 'kimi', ts: 700, turn: 7,
          }],
        }}
        initialPlanStateBySession={{
          'session-wire': {
            text: '- [x] inspect\n- [x] test', completed: false, status: 'active', turn: 5,
          },
        }}
      />,
    );

    try {
      const socket = getMockWebSockets()[0]!;
      await act(async () => {
        socket.fakeOpen();
        await Promise.resolve();
        await Promise.resolve();
      });
      act(() => socket.fakeMessage({ type: 'auth_ok', user: 'dev' }));
      act(() => socket.fakeMessage({ ...stateSyncFixture(), sessions: [running] }));
      act(() => socket.fakeMessage({
        type: 'session:updated',
        session: { id: running.id, status: 'done', updated_at: '2026-08-09T02:12:25.000Z' },
      }));

      expect(snapshot().planStateBySession['session-wire']).toMatchObject({
        completed: true,
        status: 'completed',
        turn: 7,
      });
    } finally {
      view.unmount();
      ops.dispose();
      ws.disconnect();
    }
  });

  it('skips native adoption in both delivery orders but lets a known ordinary create consume', async () => {
    const wsFirstAdopted = sessionContractFixture({
      id: 'session-adopted-ws-first', name: 'Adopted before HTTP',
    });
    const httpFirstAdopted = sessionContractFixture({
      id: 'session-adopted-http-first', name: 'Adopted over HTTP',
    });
    const nextCreated = sessionContractFixture({ id: 'session-next-create', name: 'Next create' });
    const ws = new GianWs('ws://test.invalid/ws', () => 'token');
    const store = createOperationStore();
    const ops = createOperationDispatcher({ store, transport: ws });
    const view = render(
      <ClientReducerHarness
        ws={ws}
        store={store}
        ops={ops}
        initialActiveSessionId="session-user-selected"
        pendingFirstMessage="first message for the next create"
      />,
    );

    try {
      const socket = getMockWebSockets()[0]!;
      await act(async () => {
        socket.fakeOpen();
        await Promise.resolve();
        await Promise.resolve();
      });
      act(() => socket.fakeMessage({ type: 'auth_ok', user: 'dev' }));
      act(() => socket.fakeMessage({
        ...stateSyncFixture(),
        sessions: [httpFirstAdopted, nextCreated],
      }));

      // WS-first: the adopted id is not in sessionsRef yet.
      act(() => socket.fakeMessage({
        type: 'session:created', session: wsFirstAdopted, origin: 'native-adopt',
      }));
      expect(snapshot()).toMatchObject({
        activeSessionId: 'session-user-selected',
        pendingFirstMessage: 'first message for the next create',
      });

      // HTTP-first: the adopted id is already canonical.
      act(() => socket.fakeMessage({
        type: 'session:created', session: httpFirstAdopted, origin: 'native-adopt',
      }));
      expect(snapshot()).toMatchObject({
        activeSessionId: 'session-user-selected',
        pendingFirstMessage: 'first message for the next create',
      });
      expect(socket.parsedSent<ClientToServerMessage>()
        .filter(frame => frame.type === 'message:send')).toHaveLength(0);

      // An ordinary create stays backward compatible when origin is absent,
      // and must consume its pending first message even though state_sync has
      // already made the session known.
      act(() => socket.fakeMessage({ type: 'session:created', session: nextCreated }));
      expect(snapshot()).toMatchObject({
        activeSessionId: nextCreated.id,
        pendingFirstMessage: null,
      });
      expect(socket.parsedSent<ClientToServerMessage>()).toContainEqual(expect.objectContaining({
        type: 'message:send',
        session_id: nextCreated.id,
        text: 'first message for the next create',
      }));
    } finally {
      view.unmount();
      ops.dispose();
      ws.disconnect();
      wireMessageEchoSink(null);
    }
  });

  it('error clears session pending and correlated operation:result marks that send echo failed', async () => {
    const ws = new GianWs('ws://test.invalid/ws', () => 'token');
    const store = createOperationStore();
    const ops = createOperationDispatcher({ store, transport: ws });
    const view = render(<ClientReducerHarness ws={ws} store={store} ops={ops} />);

    try {
      const socket = getMockWebSockets()[0]!;
      await act(async () => {
        socket.fakeOpen();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(socket.parsedSent<{ type: string }>().map(frame => frame.type)).toEqual(['auth']);

      act(() => socket.fakeMessage({ type: 'auth_ok', user: 'dev' }));
      expect(snapshot().authed).toBe(true);
      // events:subscribe is held until the authoritative snapshot is reduced.
      expect(socket.parsedSent<{ type: string }>().map(frame => frame.type)).toEqual(['auth']);
      act(() => socket.fakeMessage(stateSyncFixture()));
      expect(socket.parsedSent<{ type: string }>().map(frame => frame.type)).toEqual([
        'auth', 'events:subscribe',
      ]);

      let runId = '';
      act(() => {
        runId = dispatchMessageSend(ops.dispatch, {
          sessionId: 'session-wire',
          text: 'please fail precisely',
          exec: 'codex',
        }).id;
      });
      expect(snapshot().pendingBySession['session-wire']).toBe(true);
      expect(snapshot().itemsBySession['session-wire']?.[0]).toMatchObject({
        sendRunId: runId,
        pending: true,
      });

      const sendFrame = socket.parsedSent<ClientToServerMessage>()
        .find(frame => frame.type === 'message:send');
      const requestId = (sendFrame as { request_id?: string } | undefined)?.request_id;
      expect(requestId).toBeTruthy();

      // Real Host ordering: it publishes running + canonical user_message
      // before awaiting executor startTurn. Correlation/retry metadata must
      // survive this swap until the following operation result settles.
      act(() => socket.fakeMessage({
        type: 'session:updated',
        session: { id: 'session-wire', status: 'running' },
      }));
      act(() => socket.fakeMessage({
        type: 'event',
        session_id: 'session-wire',
        turn: 1,
        call_id: 'canonical-user-failed',
        event: 'user_message',
        ts: Date.now(),
        data: { text: 'please fail precisely' },
      }));
      expect(snapshot().itemsBySession['session-wire']?.[0]).toMatchObject({
        id: 'canonical-user-failed',
        sendRunId: runId,
        sendRetry: { sessionId: 'session-wire', text: 'please fail precisely' },
        pending: true,
        sendCanonical: true,
      });

      // This is the first frame emitted by the real Host catch path. The
      // actual useAppSocket reducer clears the session spinner immediately;
      // correlated echo selection remains the dispatcher's responsibility.
      act(() => socket.fakeMessage({
        type: 'error',
        session_id: 'session-wire',
        request_id: requestId,
        request_type: 'message:send',
        // Executors may surface a more specific code. request_type, not one
        // hard-coded fallback code, identifies this as a send failure.
        code: 'AUTH_REQUIRED',
        message: 'executor authentication required',
      }));
      expect(snapshot().pendingBySession['session-wire']).toBe(false);
      expect(snapshot().itemsBySession['session-wire']?.[0]).toMatchObject({
        id: 'canonical-user-failed',
        sendRunId: runId,
      });
      expect(snapshot().itemsBySession['session-wire']?.[0]?.failed).toBeUndefined();

      // The immediately-following correlated result traverses GianWs → the
      // real operation dispatcher → the product message rollback/sink.
      act(() => socket.fakeMessage({
        type: 'operation:result',
        request_id: requestId,
        request_type: 'message:send',
        ok: false,
        error: { code: 'AUTH_REQUIRED', message: 'executor authentication required' },
      }));
      expect(store.getRun(runId)?.phase).toBe('failed');
      expect(snapshot().itemsBySession['session-wire']?.[0]).toMatchObject({
        id: 'canonical-user-failed',
        sendRunId: runId,
        pending: false,
        failed: true,
        sendRetry: { sessionId: 'session-wire', text: 'please fail precisely' },
      });
      expect(snapshot().pendingBySession['session-wire']).toBe(false);
    } finally {
      view.unmount();
      ops.dispose();
      wireMessageEchoSink(null);
    }
  });

  it('clears transient correlation after canonical user_message is confirmed', async () => {
    const ws = new GianWs('ws://test.invalid/ws', () => 'token');
    const store = createOperationStore();
    const ops = createOperationDispatcher({ store, transport: ws });
    const view = render(<ClientReducerHarness ws={ws} store={store} ops={ops} />);

    try {
      const socket = getMockWebSockets()[0]!;
      await act(async () => {
        socket.fakeOpen();
        await Promise.resolve();
        await Promise.resolve();
      });
      act(() => socket.fakeMessage({ type: 'auth_ok', user: 'dev' }));
      act(() => socket.fakeMessage(stateSyncFixture()));

      let runId = '';
      act(() => {
        runId = dispatchMessageSend(ops.dispatch, {
          sessionId: 'session-wire',
          text: 'confirm and release metadata',
          exec: 'claude',
        }).id;
      });
      const sendFrame = socket.parsedSent<ClientToServerMessage>()
        .find(frame => frame.type === 'message:send');
      const requestId = (sendFrame as { request_id?: string } | undefined)?.request_id;
      expect(requestId).toBeTruthy();

      act(() => socket.fakeMessage({
        type: 'session:updated',
        session: { id: 'session-wire', status: 'running' },
      }));
      act(() => socket.fakeMessage({
        type: 'event',
        session_id: 'session-wire',
        turn: 1,
        call_id: 'canonical-user-success',
        event: 'user_message',
        ts: Date.now(),
        data: { text: 'confirm and release metadata' },
      }));
      expect(snapshot().itemsBySession['session-wire']?.[0]).toMatchObject({
        id: 'canonical-user-success',
        sendRunId: runId,
        pending: true,
        sendCanonical: true,
      });

      act(() => socket.fakeMessage({
        type: 'operation:result',
        request_id: requestId,
        request_type: 'message:send',
        ok: true,
      }));
      expect(store.getRun(runId)?.phase).toBe('confirmed');
      expect(snapshot().itemsBySession['session-wire']?.[0]).toMatchObject({
        id: 'canonical-user-success',
      });
      expect(snapshot().itemsBySession['session-wire']?.[0]?.sendRunId).toBeUndefined();
      expect(snapshot().itemsBySession['session-wire']?.[0]?.sendRetry).toBeUndefined();
      expect(snapshot().itemsBySession['session-wire']?.[0]?.sendCanonical).toBeUndefined();
      expect(snapshot().itemsBySession['session-wire']?.[0]?.pending).toBeUndefined();
      expect(snapshot().itemsBySession['session-wire']?.[0]?.failed).toBeUndefined();
    } finally {
      view.unmount();
      ops.dispose();
      wireMessageEchoSink(null);
    }
  });

  it('fails a known-unsent offline message immediately and never replays its one-shot bypass', async () => {
    const ws = new GianWs('ws://test.invalid/ws', () => 'token');
    const store = createOperationStore();
    const ops = createOperationDispatcher({ store, transport: ws });
    const view = render(<ClientReducerHarness ws={ws} store={store} ops={ops} />);

    try {
      const socket = getMockWebSockets()[0]!;
      let runId = '';
      act(() => {
        runId = dispatchMessageSend(ops.dispatch, {
          sessionId: 'session-wire',
          text: 'do not silently lose this turn',
          exec: 'claude',
          oneShotBypass: true,
        }).id;
      });

      await act(async () => { await Promise.resolve(); });
      expect(store.getRun(runId)?.phase).toBe('failed');
      expect(snapshot().itemsBySession['session-wire']?.[0]).toMatchObject({
        sendRunId: runId,
        pending: false,
        failed: true,
      });
      expect(snapshot().pendingBySession['session-wire']).toBe(false);

      await act(async () => {
        socket.fakeOpen();
        await Promise.resolve();
        await Promise.resolve();
      });
      act(() => socket.fakeMessage({ type: 'auth_ok', user: 'dev' }));
      act(() => socket.fakeMessage(stateSyncFixture()));

      const frames = socket.parsedSent<ClientToServerMessage>();
      expect(frames.map(frame => frame.type)).toEqual(['auth', 'events:subscribe']);
      expect(frames.some(frame => frame.type === 'message:send')).toBe(false);
    } finally {
      view.unmount();
      ops.dispose();
      wireMessageEchoSink(null);
    }
  });

  it('correlates identical concurrent sends FIFO and settles their canonical bubbles independently', async () => {
    const ws = new GianWs('ws://test.invalid/ws', () => 'token');
    const store = createOperationStore();
    const ops = createOperationDispatcher({ store, transport: ws });
    const view = render(<ClientReducerHarness ws={ws} store={store} ops={ops} />);

    try {
      const socket = getMockWebSockets()[0]!;
      await act(async () => {
        socket.fakeOpen();
        await Promise.resolve();
        await Promise.resolve();
      });
      act(() => socket.fakeMessage({ type: 'auth_ok', user: 'dev' }));
      act(() => socket.fakeMessage(stateSyncFixture()));

      let firstRunId = '';
      let secondRunId = '';
      act(() => {
        firstRunId = dispatchMessageSend(ops.dispatch, {
          sessionId: 'session-wire', text: 'same visible text', exec: 'claude',
        }).id;
        secondRunId = dispatchMessageSend(ops.dispatch, {
          sessionId: 'session-wire', text: 'same visible text', exec: 'claude',
        }).id;
      });
      const initial = snapshot().itemsBySession['session-wire']!;
      expect(initial).toHaveLength(2);
      expect(initial[0]?.id).not.toBe(initial[1]?.id);
      expect(initial.map(item => item.sendRunId)).toEqual([firstRunId, secondRunId]);

      const sends = socket.parsedSent<ClientToServerMessage>()
        .filter(frame => frame.type === 'message:send');
      const firstRequestId = (sends[0] as { request_id?: string }).request_id!;
      const secondRequestId = (sends[1] as { request_id?: string }).request_id!;
      expect(firstRequestId).toBeTruthy();
      expect(secondRequestId).toBeTruthy();

      act(() => {
        socket.fakeMessage({
          type: 'event', session_id: 'session-wire', turn: 1,
          call_id: 'canonical-first', event: 'user_message', ts: Date.now(),
          data: { text: 'same visible text' },
        });
        socket.fakeMessage({
          type: 'event', session_id: 'session-wire', turn: 2,
          call_id: 'canonical-second', event: 'user_message', ts: Date.now() + 1,
          data: { text: 'same visible text' },
        });
      });
      expect(snapshot().itemsBySession['session-wire']).toEqual([
        expect.objectContaining({
          id: 'canonical-first', sendRunId: firstRunId, pending: true, sendCanonical: true,
        }),
        expect.objectContaining({
          id: 'canonical-second', sendRunId: secondRunId, pending: true, sendCanonical: true,
        }),
      ]);

      act(() => socket.fakeMessage({
        type: 'operation:result', request_id: firstRequestId,
        request_type: 'message:send', ok: true,
      }));
      expect(snapshot().itemsBySession['session-wire']?.[0]).toMatchObject({ id: 'canonical-first' });
      expect(snapshot().itemsBySession['session-wire']?.[0]?.sendRunId).toBeUndefined();
      expect(snapshot().itemsBySession['session-wire']?.[0]?.pending).toBeUndefined();
      expect(snapshot().itemsBySession['session-wire']?.[1]).toMatchObject({
        id: 'canonical-second', sendRunId: secondRunId, pending: true,
      });

      act(() => socket.fakeMessage({
        type: 'operation:result', request_id: secondRequestId,
        request_type: 'message:send', ok: false,
        error: { code: 'MESSAGE_SEND_FAILED', message: 'second send rejected' },
      }));
      expect(snapshot().itemsBySession['session-wire']?.[0]).toMatchObject({
        id: 'canonical-first',
      });
      expect(snapshot().itemsBySession['session-wire']?.[0]?.failed).toBeUndefined();
      expect(snapshot().itemsBySession['session-wire']?.[1]).toMatchObject({
        id: 'canonical-second', sendRunId: secondRunId, pending: false, failed: true,
        sendRetry: { sessionId: 'session-wire', text: 'same visible text' },
      });
    } finally {
      view.unmount();
      ops.dispose();
      wireMessageEchoSink(null);
    }
  });

  it('keeps a canonical send visibly unknown when its result times out', async () => {
    vi.useFakeTimers();
    const ws = new GianWs('ws://test.invalid/ws', () => 'token');
    const store = createOperationStore();
    const ops = createOperationDispatcher({ store, transport: ws });
    const view = render(<ClientReducerHarness ws={ws} store={store} ops={ops} />);

    try {
      const socket = getMockWebSockets()[0]!;
      await act(async () => {
        socket.fakeOpen();
        await Promise.resolve();
        await Promise.resolve();
      });
      act(() => socket.fakeMessage({ type: 'auth_ok', user: 'dev' }));
      act(() => socket.fakeMessage(stateSyncFixture()));

      let runId = '';
      act(() => {
        runId = dispatchMessageSend(ops.dispatch, {
          sessionId: 'session-wire', text: 'timeout after canonical', exec: 'codex',
        }).id;
      });
      act(() => socket.fakeMessage({
        type: 'event', session_id: 'session-wire', turn: 1,
        call_id: 'canonical-timeout', event: 'user_message', ts: Date.now(),
        data: { text: 'timeout after canonical' },
      }));

      act(() => vi.advanceTimersByTime(10_001));
      expect(store.getRun(runId)?.phase).toBe('timed-out');
      expect(snapshot().itemsBySession['session-wire']?.[0]).toMatchObject({
        id: 'canonical-timeout', sendRunId: runId, pending: true, sendCanonical: true,
        sendRetry: { sessionId: 'session-wire', text: 'timeout after canonical' },
      });
      expect(screen.getByText('may not have been sent')).toBeInTheDocument();
    } finally {
      view.unmount();
      ops.dispose();
      ws.disconnect();
      wireMessageEchoSink(null);
      vi.useRealTimers();
    }
  });

  it('keeps a canonical send visibly unknown when its socket disconnects before result', async () => {
    vi.useFakeTimers();
    const ws = new GianWs('ws://test.invalid/ws', () => 'token');
    const store = createOperationStore();
    const ops = createOperationDispatcher({ store, transport: ws });
    const view = render(<ClientReducerHarness ws={ws} store={store} ops={ops} />);

    try {
      const socket = getMockWebSockets()[0]!;
      await act(async () => {
        socket.fakeOpen();
        await Promise.resolve();
        await Promise.resolve();
      });
      act(() => socket.fakeMessage({ type: 'auth_ok', user: 'dev' }));
      act(() => socket.fakeMessage(stateSyncFixture()));

      let runId = '';
      act(() => {
        runId = dispatchMessageSend(ops.dispatch, {
          sessionId: 'session-wire', text: 'disconnect after canonical', exec: 'claude',
        }).id;
      });
      act(() => socket.fakeMessage({
        type: 'event', session_id: 'session-wire', turn: 1,
        call_id: 'canonical-disconnect', event: 'user_message', ts: Date.now(),
        data: { text: 'disconnect after canonical' },
      }));
      act(() => socket.close(1006, 'ack lost'));

      expect(store.getRun(runId)?.phase).toBe('timed-out');
      expect(snapshot().itemsBySession['session-wire']?.[0]).toMatchObject({
        id: 'canonical-disconnect', sendRunId: runId, pending: true, sendCanonical: true,
      });
      expect(screen.getByText('may not have been sent')).toBeInTheDocument();
    } finally {
      view.unmount();
      ops.dispose();
      ws.disconnect();
      wireMessageEchoSink(null);
      vi.useRealTimers();
    }
  });
});
