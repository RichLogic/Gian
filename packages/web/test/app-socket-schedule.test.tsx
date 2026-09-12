/**
 * Socket wiring for Schedules (Issue #51, contract L/N): `schedule:changed`
 * publishes a coarse invalidation on the sync bus, `schedule:confirmation`
 * upserts the persistent pending store, `state_sync` forces a resync, and
 * `auth_ok` re-hydrates pending confirmations on every (re)connect.
 */
import { act, renderHook } from '@testing-library/react';
import { useState } from 'react';
import type { ServerToClientMessage } from '@gian/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppSocket } from '../src/controllers/use-app-socket.js';
import type { GianWs, WsListener, WsStateListener } from '../src/ws.js';
import type { OperationDispatcher } from '../src/operations/dispatcher.js';
import { createOperationStore } from '../src/operations/store.js';
import { onScheduleChanged, onScheduleResync } from '../src/presentation/schedule-sync.js';
import {
  __resetScheduleConfirmations,
  pendingScheduleConfirmations,
} from '../src/controllers/schedule-confirmations.js';
import { mockFetch } from './setup.js';
import { createFetchRouter, jsonResponse, makeConfirmation } from './schedule-fixtures.js';

vi.mock('../src/api.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/api.js')>();
  return {
    ...actual,
    loadSessions: vi.fn(async () => []),
    loadTasks: vi.fn(async () => []),
    loadWorkspaces: vi.fn(async () => []),
  };
});

class FakeWs {
  private listeners = new Set<WsListener>();

  connect = vi.fn();
  disconnect = vi.fn();
  send = vi.fn();

  onMessage(listener: WsListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onState(listener: WsStateListener): () => void {
    listener('closed', 0);
    return () => {};
  }

  emit(message: ServerToClientMessage): void {
    for (const listener of this.listeners) listener(message);
  }
}

function setup() {
  const ws = new FakeWs();
  const operationStore = createOperationStore();
  const ops = { dispatch: vi.fn() } as unknown as OperationDispatcher;
  renderHook(() => {
    const [pendingBySession, setPendingBySession] = useState<Record<string, boolean>>({});
    useAppSocket({
      authStatus: 'authenticated',
      ws: ws as unknown as GianWs,
      sessionsRef: { current: [] },
      itemsBySessionRef: { current: {} },
      activeSessionIdRef: { current: null },
      pendingFirstMessageRef: { current: null },
      setWsState: vi.fn(),
      setWsAttempt: vi.fn(),
      setAuthed: vi.fn(),
      setWorkspaces: vi.fn(),
      setSessions: vi.fn(),
      setSideChats: vi.fn(),
      sideChatsRef: { current: [] },
      setItemsBySidechat: vi.fn(),
      setPendingBySidechat: vi.fn(),
      setTasks: vi.fn(),
      setSystemConfig: vi.fn(),
      setRunner: vi.fn(),
      setActiveSessionId: vi.fn(),
      setActiveTaskId: vi.fn(),
      setActiveSubtaskId: vi.fn(),
      setItemsBySession: vi.fn(),
      setPendingBySession,
      setQueueBySession: vi.fn(),
      setPlanStateBySession: vi.fn(),
      markSessionHistoryLive: vi.fn(),
      rebuildSessionHistory: vi.fn(),
      operationStore,
      ops,
    });
    return pendingBySession;
  });
  return { ws };
}

function stateSync(): ServerToClientMessage {
  return {
    type: 'state_sync',
    runner: {},
    sessions: [],
    workspaces: [],
    tasks: [],
    approvals: [],
    config: {},
  } as unknown as ServerToClientMessage;
}

describe('useAppSocket schedule wiring', () => {
  beforeEach(() => __resetScheduleConfirmations());
  afterEach(() => __resetScheduleConfirmations());

  it('publishes schedule:changed on the sync bus', () => {
    const { ws } = setup();
    const seen: string[] = [];
    const off = onScheduleChanged(message => seen.push(`${message.reason}:${message.schedule_id}`));

    act(() => ws.emit({
      type: 'schedule:changed',
      reason: 'state_changed',
      schedule_id: 'sch-1',
      revision: 4,
    }));
    expect(seen).toEqual(['state_changed:sch-1']);
    off();
  });

  it('upserts schedule:confirmation into the pending store', () => {
    const { ws } = setup();
    act(() => ws.emit({ type: 'schedule:confirmation', confirmation: makeConfirmation() }));
    expect(pendingScheduleConfirmations().map(c => c.id)).toEqual(['conf-1']);

    // A terminal upsert drops it from the pending queue.
    act(() => ws.emit({
      type: 'schedule:confirmation',
      confirmation: makeConfirmation({ status: 'rejected' }),
    }));
    expect(pendingScheduleConfirmations()).toHaveLength(0);
  });

  it('forces a schedule resync on state_sync (reconnect authority)', () => {
    const { ws } = setup();
    let resyncs = 0;
    const off = onScheduleResync(() => { resyncs += 1; });
    act(() => ws.emit(stateSync()));
    expect(resyncs).toBe(1);
    off();
  });

  it('hydrates pending confirmations on auth_ok', async () => {
    const router = createFetchRouter([{
      match: url => url.startsWith('/api/schedule-confirmations'),
      respond: () => jsonResponse({ confirmations: [makeConfirmation()] }),
    }]);
    mockFetch(router.handler);
    const { ws } = setup();
    act(() => ws.emit({ type: 'auth_ok', user: 'tester' }));
    await vi.waitFor(() => {
      expect(pendingScheduleConfirmations().map(c => c.id)).toEqual(['conf-1']);
    });
  });
});
