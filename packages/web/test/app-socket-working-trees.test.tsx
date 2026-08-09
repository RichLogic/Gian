import { act, renderHook } from '@testing-library/react';
import type { ServerToClientMessage } from '@gian/shared';
import { describe, expect, it, vi } from 'vitest';
import { useAppSocket } from '../src/controllers/use-app-socket.js';
import type { GianWs, WsListener, WsStateListener } from '../src/ws.js';
import type { OperationDispatcher } from '../src/operations/dispatcher.js';
import type { OperationStore } from '../src/operations/store.js';

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

const stateSync = {
  type: 'state_sync',
  runner: {},
  sessions: [],
  workspaces: [],
  tasks: [],
  approvals: [],
  config: {},
} as unknown as ServerToClientMessage;

describe('useAppSocket working-tree refresh', () => {
  it('forces a refresh for state_sync reconnects and workspace git updates', () => {
    const ws = new FakeWs();
    const refreshWorkingTrees = vi.fn();
    const setter = vi.fn();
    const operationStore = {
      absorbMatchingOverlays: vi.fn(),
    } as unknown as OperationStore;
    const ops = { dispatch: vi.fn() } as unknown as OperationDispatcher;

    renderHook(() => useAppSocket({
      authStatus: 'authenticated',
      ws: ws as unknown as GianWs,
      sessionsRef: { current: [] },
      itemsBySessionRef: { current: {} },
      activeSessionIdRef: { current: null },
      pendingFirstMessageRef: { current: null },
      setWsState: setter,
      setWsAttempt: setter,
      setAuthed: setter,
      setWorkspaces: setter,
      refreshWorkingTrees,
      setSessions: setter,
      setTasks: setter,
      setSystemConfig: setter,
      setRunner: setter,
      setActiveSessionId: setter,
      setActiveTaskId: setter,
      setActiveSubtaskId: setter,
      setItemsBySession: setter,
      setPendingBySession: setter,
      setQueueBySession: setter,
      setPlanStateBySession: setter,
      markSessionHistoryLive: vi.fn(),
      operationStore,
      ops,
    }));

    act(() => ws.emit(stateSync));
    expect(refreshWorkingTrees).toHaveBeenCalledTimes(1);

    act(() => ws.emit(stateSync));
    expect(refreshWorkingTrees).toHaveBeenCalledTimes(2);

    act(() => ws.emit({
      type: 'workspace:git-updated',
      workspace_id: 'workspace-1',
      reason: 'worktree-detected',
    }));
    expect(refreshWorkingTrees).toHaveBeenCalledTimes(3);
  });
});
