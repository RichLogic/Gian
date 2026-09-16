import { act, renderHook } from '@testing-library/react';
import { useState } from 'react';
import type { AttentionMessage, ServerToClientMessage } from '@gian/shared';
import { describe, expect, it, vi } from 'vitest';
import { useAppSocket } from '../src/controllers/use-app-socket.js';
import type { GianWs, WsListener, WsStateListener } from '../src/ws.js';
import type { OperationDispatcher } from '../src/operations/dispatcher.js';
import { createOperationStore } from '../src/operations/store.js';

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

function attention(overrides: Partial<AttentionMessage> = {}): AttentionMessage {
  return {
    type: 'attention',
    id: 'gian:attention:xyz',
    session_id: 'sess-1',
    turn: 2,
    kind: 'turn-completed',
    timestamp: Date.now(),
    title: 'Turn completed',
    body: 'The agent finished turn 2.',
    provider: 'codex',
    ...overrides,
  };
}

function setup(onAttention?: (message: AttentionMessage) => void) {
  const ws = new FakeWs();
  const operationStore = createOperationStore();
  const ops = { dispatch: vi.fn() } as unknown as OperationDispatcher;
  renderHook(() => {
    const [, setPendingBySession] = useState<Record<string, boolean>>({});
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
      ...(onAttention ? { onAttention } : {}),
    });
  });
  return { ws };
}

describe('useAppSocket attention dispatch', () => {
  it('forwards attention messages to the App-level handler untouched', () => {
    const seen: AttentionMessage[] = [];
    const { ws } = setup(message => seen.push(message));

    const message = attention({
      kind: 'error',
      title: 'Scheduled run failed',
      schedule: { schedule_id: 'sch-1', run_id: 'run-1' },
    });
    act(() => ws.emit(message));

    // The socket layer must not filter, suppress, or reshape the signal —
    // suppression and delivery live in the App callback.
    expect(seen).toEqual([message]);
  });

  it('tolerates consumers without an attention handler', () => {
    const { ws } = setup();
    expect(() => act(() => ws.emit(attention()))).not.toThrow();
  });
});
