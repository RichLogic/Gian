/**
 * Inbox WS wiring (Issue #53 / 0.6.7): `state_sync.inbox` seeds the pending
 * read model on (re)connect, `inbox:changed` upserts one row, and
 * `inbox:invalidated` re-pulls canonical state via REST. A Host predating the
 * snapshot field falls back to the same REST pull.
 */
import { act, renderHook } from '@testing-library/react';
import { useState } from 'react';
import type { ServerToClientMessage } from '@gian/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppSocket } from '../src/controllers/use-app-socket.js';
import type { GianWs, WsListener, WsStateListener } from '../src/ws.js';
import type { OperationDispatcher } from '../src/operations/dispatcher.js';
import { createOperationStore } from '../src/operations/store.js';
import {
  __resetInboxForTests,
  getInboxSnapshot,
} from '../src/controllers/inbox.js';
import { mockFetch } from './setup.js';
import { makeInboxItem } from './inbox-fixtures.js';

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
    });
  });
  return { ws };
}

function stateSync(inbox?: unknown): ServerToClientMessage {
  return {
    type: 'state_sync',
    runner: {},
    sessions: [],
    workspaces: [],
    tasks: [],
    approvals: [],
    config: {},
    ...(inbox ? { inbox } : {}),
  } as unknown as ServerToClientMessage;
}

describe('useAppSocket inbox wiring', () => {
  beforeEach(() => __resetInboxForTests());
  afterEach(() => __resetInboxForTests());

  it('seeds the pending read model from state_sync.inbox', () => {
    const { ws } = setup();
    act(() => ws.emit(stateSync({
      inbox_revision: 9,
      pending_count: 2,
      items: [makeInboxItem({ id: 'a' }), makeInboxItem({ id: 'b', unread: false })],
      truncated: false,
    })));
    expect(getInboxSnapshot().hydrated).toBe(true);
    expect(getInboxSnapshot().pendingCount).toBe(2);
    expect(getInboxSnapshot().pendingItems.map(item => item.id)).toEqual(['a', 'b']);
  });

  it('upserts one row on inbox:changed', () => {
    const { ws } = setup();
    act(() => ws.emit(stateSync({
      inbox_revision: 9,
      pending_count: 1,
      items: [makeInboxItem({ id: 'a' })],
      truncated: false,
    })));
    act(() => ws.emit({
      type: 'inbox:changed',
      inbox_revision: 10,
      item: makeInboxItem({ id: 'b' }),
    }));
    expect(getInboxSnapshot().pendingCount).toBe(2);
    act(() => ws.emit({
      type: 'inbox:changed',
      inbox_revision: 11,
      item: makeInboxItem({ id: 'b', status: 'resolved', closed_at: '2026-10-12T05:00:00.000Z' }),
    }));
    expect(getInboxSnapshot().pendingCount).toBe(1);
    expect(getInboxSnapshot().pendingItems.map(item => item.id)).toEqual(['a']);
  });

  it('re-pulls canonical state on inbox:invalidated', async () => {
    const { ws } = setup();
    const calls: string[] = [];
    mockFetch(async input => {
      const url = typeof input === 'string' ? input : input.url;
      calls.push(url);
      if (url.startsWith('/api/inbox')) {
        return Response.json({
          items: [makeInboxItem({ id: 'x' })],
          next_cursor: null,
          pending_count: 4,
          inbox_revision: 30,
        });
      }
      return Response.json({ error: 'not_found' }, { status: 404 });
    });
    act(() => ws.emit({ type: 'inbox:invalidated', inbox_revision: 30 }));
    await vi.waitFor(() => expect(getInboxSnapshot().hydrated).toBe(true));
    expect(getInboxSnapshot().pendingCount).toBe(4);
    expect(getInboxSnapshot().inboxRevision).toBe(30);
    // Count and rows come from the single list transaction.
    expect(calls).toEqual(['/api/inbox?status=pending&limit=50']);
  });

  it('falls back to REST when state_sync predates the inbox field', async () => {
    const { ws } = setup();
    mockFetch(async input => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.startsWith('/api/inbox')) {
        return Response.json({
          items: [makeInboxItem({ id: 'legacy' })],
          next_cursor: null,
          pending_count: 1,
          inbox_revision: 5,
        });
      }
      return Response.json({ error: 'not_found' }, { status: 404 });
    });
    act(() => ws.emit(stateSync()));
    await vi.waitFor(() => expect(getInboxSnapshot().hydrated).toBe(true));
    expect(getInboxSnapshot().pendingCount).toBe(1);
    expect(getInboxSnapshot().pendingItems.map(item => item.id)).toEqual(['legacy']);
  });
});
