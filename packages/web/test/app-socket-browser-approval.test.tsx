import { act, renderHook } from '@testing-library/react';
import { useRef, useState } from 'react';
import type { ServerToClientMessage, Session } from '@gian/shared';
import { describe, expect, it, vi } from 'vitest';
import { useAppSocket } from '../src/controllers/use-app-socket.js';
import type { GianWs, WsListener, WsStateListener } from '../src/ws.js';
import type { OperationDispatcher } from '../src/operations/dispatcher.js';
import { createOperationStore } from '../src/operations/store.js';
import type { TranscriptItem } from '../src/types.js';

vi.mock('../src/api.js', () => ({
  loadSessions: vi.fn(async () => []),
  loadTasks: vi.fn(async () => []),
  loadWorkspaces: vi.fn(async () => []),
}));

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

const SESSION = { id: 'session-1', executor: 'codex', status: 'running' } as unknown as Session;

function setup() {
  const ws = new FakeWs();
  const hook = renderHook(() => {
    const [items, setItems] = useState<Record<string, TranscriptItem[]>>({});
    const itemsRef = useRef(items);
    itemsRef.current = items;
    useAppSocket({
      authStatus: 'authenticated',
      ws: ws as unknown as GianWs,
      sessionsRef: { current: [SESSION] },
      itemsBySessionRef: itemsRef,
      activeSessionIdRef: { current: 'session-1' },
      pendingFirstMessageRef: { current: null },
      setWsState: vi.fn(), setWsAttempt: vi.fn(), setAuthed: vi.fn(),
      setWorkspaces: vi.fn(), setSessions: vi.fn(), setSideChats: vi.fn(),
      sideChatsRef: { current: [] }, setItemsBySidechat: vi.fn(), setPendingBySidechat: vi.fn(),
      setTasks: vi.fn(), setSystemConfig: vi.fn(), setRunner: vi.fn(),
      setActiveSessionId: vi.fn(), setActiveTaskId: vi.fn(), setActiveSubtaskId: vi.fn(),
      setItemsBySession: setItems, setPendingBySession: vi.fn(), setQueueBySession: vi.fn(),
      setPlanStateBySession: vi.fn(), markSessionHistoryLive: vi.fn(), rebuildSessionHistory: vi.fn(),
      operationStore: createOperationStore(),
      ops: { dispatch: vi.fn() } as unknown as OperationDispatcher,
    });
    return items;
  });
  return { ws, hook };
}

describe('Browser capture approval socket projection', () => {
  it('renders a live local approval and resolves it in place', () => {
    const { ws, hook } = setup();
    act(() => ws.emit({
      type: 'approval:created',
      approval: {
        id: 'browser-approval-1',
        session_id: 'session-1',
        category: 'browser_capture',
        description: 'Allow this Session to capture Browser tab tab-1?',
        status: 'pending',
        turn_number: 3,
      },
    }));
    const pending = hook.result.current['session-1']?.[0];
    expect(pending).toMatchObject({
      kind: 'approval',
      approvalId: 'browser-approval-1',
      status: 'pending',
      title: 'Browser screenshot',
      turn: 3,
    });

    act(() => ws.emit({
      type: 'approval:updated',
      approval: {
        id: 'browser-approval-1',
        status: 'approved',
        resolved_by: 'web',
        resolved_at: '2026-09-10T00:00:00.000Z',
        session_id: 'session-1',
        turn_number: 3,
        decision: 'allow_once',
      },
    }));
    expect(hook.result.current['session-1']?.[0]).toMatchObject({ status: 'approved-once' });
  });

  it('restores a pending local approval from state_sync', () => {
    const { ws, hook } = setup();
    act(() => ws.emit({
      type: 'state_sync',
      runner: {}, sessions: [SESSION], sidechats: [], workspaces: [], tasks: [], config: {},
      approvals: [{
        id: 'browser-approval-2',
        session_id: 'session-1',
        turn_id: 'turn-3',
        turn_number: 3,
        category: 'browser_capture',
        title: 'Allow Browser capture',
        command: 'tab-1',
        reason: null,
        status: 'pending',
        resolved_by: null,
        resolved_at: null,
        created_at: '2026-09-10T00:00:00.000Z',
      }],
    } as ServerToClientMessage));
    expect(hook.result.current['session-1']?.[0]).toMatchObject({
      approvalId: 'browser-approval-2', status: 'pending', turn: 3,
    });
  });
});
