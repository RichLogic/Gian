import { act, renderHook } from '@testing-library/react';
import { useRef, useState } from 'react';
import type { ServerToClientMessage, Session, Task, Workspace } from '@gian/shared';
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

  it('keeps two windows converged and detaches only the window that closes', () => {
    const firstWs = new FakeWs();
    const secondWs = new FakeWs();
    const operationStore = {
      absorbMatchingOverlays: vi.fn(),
    } as unknown as OperationStore;
    const ops = { dispatch: vi.fn() } as unknown as OperationDispatcher;
    const session = { id: 'session-a', executor: 'codex', status: 'running' } as Session;
    const task = { id: 'task-a', title: 'Initial task' } as Task;
    const workspace = { id: 'workspace-a', name: 'Workspace A' } as Workspace;

    function useWindow(ws: FakeWs) {
      const [sessions, setSessions] = useState<Session[]>([]);
      const [tasks, setTasks] = useState<Task[]>([]);
      const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
      const [queueBySession, setQueueBySession] = useState<Record<string, never[]>>({});
      const [pendingBySession, setPendingBySession] = useState<Record<string, boolean>>({});
      const sessionsRef = useRef(sessions);
      sessionsRef.current = sessions;
      const itemsBySessionRef = useRef({});
      const noop = vi.fn();
      useAppSocket({
        authStatus: 'authenticated',
        ws: ws as unknown as GianWs,
        sessionsRef,
        itemsBySessionRef,
        activeSessionIdRef: { current: null },
        pendingFirstMessageRef: { current: null },
        setWsState: noop,
        setWsAttempt: noop,
        setAuthed: noop,
        setWorkspaces,
        setSessions,
        setTasks,
        setSystemConfig: noop,
        setRunner: noop,
        setActiveSessionId: noop,
        setActiveTaskId: noop,
        setActiveSubtaskId: noop,
        setItemsBySession: noop,
        setPendingBySession,
        setQueueBySession: setQueueBySession as never,
        setPlanStateBySession: noop,
        markSessionHistoryLive: noop,
        rebuildSessionHistory: noop,
        operationStore,
        ops,
      });
      return { sessions, tasks, workspaces, queueBySession, pendingBySession };
    }

    const first = renderHook(() => useWindow(firstWs));
    const second = renderHook(() => useWindow(secondWs));
    const sync = {
      type: 'state_sync',
      runner: {},
      sessions: [session],
      workspaces: [workspace],
      tasks: [task],
      approvals: [],
      config: {},
    } as unknown as ServerToClientMessage;
    act(() => {
      firstWs.emit(sync);
      secondWs.emit(sync);
    });
    expect(first.result.current.sessions).toEqual(second.result.current.sessions);
    expect(first.result.current.tasks).toEqual(second.result.current.tasks);
    expect(first.result.current.workspaces).toEqual(second.result.current.workspaces);

    act(() => {
      const messages = [
        { type: 'session:updated', session: { id: session.id, status: 'done' } },
        { type: 'task:updated', task: { id: task.id, title: 'Renamed task' } },
        { type: 'queue:updated', session_id: session.id, queue: [] },
      ] as unknown as ServerToClientMessage[];
      for (const message of messages) {
        firstWs.emit(message);
        secondWs.emit(message);
      }
    });
    expect(first.result.current.sessions).toEqual(second.result.current.sessions);
    expect(first.result.current.sessions[0]?.status).toBe('done');
    expect(first.result.current.tasks).toEqual(second.result.current.tasks);
    expect(first.result.current.tasks[0]?.title).toBe('Renamed task');
    expect(first.result.current.queueBySession).toEqual(second.result.current.queueBySession);
    expect(first.result.current.pendingBySession).toEqual(second.result.current.pendingBySession);

    first.unmount();
    expect(firstWs.disconnect).toHaveBeenCalledTimes(1);
    act(() => secondWs.emit({
      type: 'session:updated',
      session: { id: session.id, name: 'Still connected' },
    } as unknown as ServerToClientMessage));
    expect(second.result.current.sessions[0]?.name).toBe('Still connected');
    expect(firstWs.disconnect).toHaveBeenCalledTimes(1);
    second.unmount();
  });
});
