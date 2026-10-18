/**
 * Native approval options for Inbox decisions (issue #1): the canonical
 * pending-approvals store keys on (session, approval id) — interaction ids
 * are unique only per session — and distinguishes "known record, no native
 * options" from "not synced". The intent→option mapping is an explicit
 * switch: allow_once→allow_once, decline→reject_once only; opaque ids and
 * multiple same-kind options are never guessed.
 */
import { act, renderHook } from '@testing-library/react';
import { useState } from 'react';
import type { Approval, NativeApprovalOption, ServerToClientMessage } from '@gian/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppSocket } from '../src/controllers/use-app-socket.js';
import {
  __resetPendingApprovals,
  peekPendingApproval,
  syncPendingApprovals,
  upsertPendingApproval,
} from '../src/controllers/pending-approvals.js';
import { nativeOptionForDecision } from '../src/operations/approval.js';
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

const OPTIONS: NativeApprovalOption[] = [
  { optionId: 'opt-allow', label: 'Yes', kind: 'allow_once' },
  { optionId: 'opt-always', label: 'Always', kind: 'allow_always' },
  { optionId: 'opt-reject', label: 'No', kind: 'reject_once' },
];

function makeApproval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: 'ap-1',
    session_id: 's-1',
    turn_id: 'turn-1',
    turn_number: 2,
    category: 'command',
    title: 'Write to /tmp/x',
    command: 'write /tmp/x',
    reason: null,
    status: 'pending',
    native_options: OPTIONS,
    resolved_by: null,
    resolved_at: null,
    created_at: '2026-10-12T01:00:00.000Z',
    ...overrides,
  };
}

describe('nativeOptionForDecision', () => {
  it('approve maps to the allow_once option, never allow_always, never opaque', () => {
    const option = nativeOptionForDecision(OPTIONS, 'allow_once')!;
    expect(option.optionId).toBe('opt-allow');
    expect(option.kind).toBe('allow_once');
  });

  it('decline maps to reject_once; every other decision maps to nothing', () => {
    expect(nativeOptionForDecision(OPTIONS, 'decline')!.optionId).toBe('opt-reject');
    expect(nativeOptionForDecision(OPTIONS, 'keep_planning')).toBeNull();
    expect(nativeOptionForDecision(OPTIONS, 'accept_with_ask')).toBeNull();
    expect(nativeOptionForDecision(OPTIONS, 'accept_with_auto')).toBeNull();
    expect(nativeOptionForDecision(OPTIONS, 'allow_session')).toBeNull();
  });

  it('no option list, empty list, opaque kinds, or duplicate kinds yield null (never a guess)', () => {
    expect(nativeOptionForDecision(undefined, 'allow_once')).toBeNull();
    expect(nativeOptionForDecision([], 'allow_once')).toBeNull();
    expect(nativeOptionForDecision(
      [{ optionId: 'opaque-1', label: 'Proceed', kind: 'proceed' }],
      'allow_once',
    )).toBeNull();
    expect(nativeOptionForDecision([
      { optionId: 'a1', label: 'Once A', kind: 'allow_once' },
      { optionId: 'a2', label: 'Once B', kind: 'allow_once' },
    ], 'allow_once')).toBeNull();
  });
});

describe('pending approvals store', () => {
  beforeEach(() => __resetPendingApprovals());
  afterEach(() => __resetPendingApprovals());

  it('keys by (session, id): two sessions with the same interaction id stay distinct', () => {
    syncPendingApprovals([
      makeApproval({ id: 'ap-1', session_id: 's-1' }),
      makeApproval({ id: 'ap-1', session_id: 's-2', native_options: undefined }),
      makeApproval({ id: 'ap-9', session_id: 's-3', status: 'approved' }),
    ]);
    expect(peekPendingApproval('s-1', 'ap-1')?.native_options).toEqual(OPTIONS);
    expect(peekPendingApproval('s-2', 'ap-1')?.native_options).toBeUndefined();
    expect(peekPendingApproval('s-3', 'ap-9')).toBeUndefined();
  });

  it('a record without native options is NOT "not synced"', () => {
    upsertPendingApproval(makeApproval({ native_options: undefined }));
    const record = peekPendingApproval('s-1', 'ap-1');
    expect(record).toBeDefined();
    expect(record?.native_options).toBeUndefined();
    expect(record?.status).toBe('pending');
  });

  it('leaving pending removes the record', () => {
    upsertPendingApproval(makeApproval());
    upsertPendingApproval(makeApproval({ status: 'rejected' }));
    expect(peekPendingApproval('s-1', 'ap-1')).toBeUndefined();
  });

  it('the composite key never collides across session/id boundaries', () => {
    // 'a'+'bc' vs 'ab'+'c' — plain concatenation would alias the two.
    upsertPendingApproval(makeApproval({ id: 'bc', session_id: 'a' }));
    expect(peekPendingApproval('a', 'bc')).toBeDefined();
    expect(peekPendingApproval('ab', 'c')).toBeUndefined();
  });
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

describe('pending approvals WS wiring', () => {
  beforeEach(() => __resetPendingApprovals());
  afterEach(() => __resetPendingApprovals());

  it('state_sync seeds, approval:created upserts, approval:updated removes', () => {
    const { ws } = setup();
    act(() => ws.emit({
      type: 'state_sync',
      runner: {},
      sessions: [],
      workspaces: [],
      tasks: [],
      approvals: [makeApproval()],
      config: {},
    } as unknown as ServerToClientMessage));
    expect(peekPendingApproval('s-1', 'ap-1')?.native_options).toEqual(OPTIONS);
    act(() => ws.emit({
      type: 'approval:created',
      approval: makeApproval({ id: 'ap-3', session_id: 's-2' }),
    }));
    expect(peekPendingApproval('s-2', 'ap-3')?.native_options).toEqual(OPTIONS);
    act(() => ws.emit({
      type: 'approval:updated',
      approval: makeApproval({ status: 'approved', resolved_by: 'web', resolved_at: '2026-10-12T02:00:00.000Z' }),
    }));
    expect(peekPendingApproval('s-1', 'ap-1')).toBeUndefined();
  });
});
