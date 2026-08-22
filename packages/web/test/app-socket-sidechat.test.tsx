/**
 * Side Chat socket wiring (gian.proxy/2.0 proposal §10.5): the `state_sync`
 * `sidechats` field wholesale-replaces the app-level read-model set,
 * `sidechat:created`/`sidechat:updated` upsert/replace exactly one record by
 * id, and every snapshot's raw notifications + user inputs are projected
 * through the shared display pipeline into the per-Side-Chat item store —
 * with the PARENT session's executor — never into the parent's or a sibling
 * Side Chat's transcript (§10.5.1 route isolation). The Host never sends
 * `event` envelopes for Side Chat ids.
 */
import { act, renderHook } from '@testing-library/react';
import { useRef, useState } from 'react';
import type { ServerToClientMessage, Session, SideChatInfo } from '@gian/shared';
import { describe, expect, it, vi } from 'vitest';
import { useAppSocket } from '../src/controllers/use-app-socket.js';
import type { GianWs, WsListener, WsStateListener } from '../src/ws.js';
import type { OperationDispatcher } from '../src/operations/dispatcher.js';
import type { OperationStore } from '../src/operations/store.js';
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

const PARENT = {
  id: 'session-1',
  executor: 'codex',
  status: 'done',
} as unknown as Session;

function sideChat(
  id: string,
  status: SideChatInfo['status'] = 'open',
  overrides: Partial<SideChatInfo> = {},
): SideChatInfo {
  return {
    id,
    parent_session_id: 'session-1',
    stream_id: `stream-${id}`,
    state: status === 'unavailable' ? 'error' : status === 'closing' ? 'stale' : 'idle',
    status,
    anchor: { type: 'turn', turn_id: 't_parent', source_turn_id: 'provider-turn-parent' },
    session_config: {},
    last_error: status === 'unavailable' ? 'unavailable' : null,
    uncertain_turn_id: null,
    events: [],
    user_inputs: [],
    created_at: '2026-08-20T08:00:00.000Z',
    updated_at: '2026-08-20T08:00:00.000Z',
    ...overrides,
  };
}

/** A raw gian.proxy/2.0 notification as carried by snapshot.events. */
function rawNotification(
  sidechatId: string,
  method: string,
  data: Record<string, unknown>,
  turnId: string | null = 'pt-1',
  emittedAt = '2026-08-20T08:01:00.000Z',
): unknown {
  return {
    jsonrpc: '2.0',
    method,
    params: {
      sessionId: sidechatId,
      ...(turnId !== null ? { turnId } : {}),
      emittedAt,
      data,
    },
  };
}

function stateSync(sidechats?: SideChatInfo[]): ServerToClientMessage {
  return {
    type: 'state_sync',
    runner: {},
    sessions: [PARENT],
    workspaces: [],
    tasks: [],
    approvals: [],
    config: {},
    ...(sidechats ? { sidechats } : {}),
  } as unknown as ServerToClientMessage;
}

function setup() {
  const ws = new FakeWs();
  const operationStore = {
    absorbMatchingOverlays: vi.fn(),
  } as unknown as OperationStore;
  const ops = { dispatch: vi.fn() } as unknown as OperationDispatcher;

  const hook = renderHook(() => {
    const [sideChats, setSideChats] = useState<SideChatInfo[]>([]);
    const sideChatsRef = useRef<SideChatInfo[]>(sideChats);
    sideChatsRef.current = sideChats;
    const [itemsBySession, setItemsBySession] = useState<Record<string, TranscriptItem[]>>({});
    const [pendingBySession, setPendingBySession] = useState<Record<string, boolean>>({});
    const [itemsBySidechat, setItemsBySidechat] = useState<Record<string, TranscriptItem[]>>({});
    const [pendingBySidechat, setPendingBySidechat] = useState<Record<string, boolean>>({});
    useAppSocket({
      authStatus: 'authenticated',
      ws: ws as unknown as GianWs,
      sessionsRef: { current: [PARENT] },
      itemsBySessionRef: { current: {} },
      activeSessionIdRef: { current: null },
      pendingFirstMessageRef: { current: null },
      setWsState: vi.fn(),
      setWsAttempt: vi.fn(),
      setAuthed: vi.fn(),
      setWorkspaces: vi.fn(),
      setSessions: vi.fn(),
      setSideChats,
      sideChatsRef,
      setItemsBySidechat,
      setPendingBySidechat,
      setTasks: vi.fn(),
      setSystemConfig: vi.fn(),
      setRunner: vi.fn(),
      setActiveSessionId: vi.fn(),
      setActiveTaskId: vi.fn(),
      setActiveSubtaskId: vi.fn(),
      setItemsBySession,
      setPendingBySession,
      setQueueBySession: vi.fn(),
      setPlanStateBySession: vi.fn(),
      markSessionHistoryLive: vi.fn(),
      rebuildSessionHistory: vi.fn(),
      operationStore,
      ops,
    });
    return { sideChats, itemsBySession, pendingBySession, itemsBySidechat, pendingBySidechat };
  });
  return { ws, hook };
}

describe('useAppSocket side-chat read model (proposal §10.5)', () => {
  it('applies the state_sync sidechats set, wholesale-replacing prior records', () => {
    const { ws, hook } = setup();

    act(() => ws.emit(stateSync([sideChat('sc-1'), sideChat('sc-2')])));
    expect(hook.result.current.sideChats.map(entry => entry.id)).toEqual(['sc-1', 'sc-2']);

    // The next authoritative sync replaces the whole set — not a merge.
    act(() => ws.emit(stateSync([sideChat('sc-3')])));
    expect(hook.result.current.sideChats.map(entry => entry.id)).toEqual(['sc-3']);

    // Hosts predating the amendment omit the field → the set clears.
    act(() => ws.emit(stateSync()));
    expect(hook.result.current.sideChats).toEqual([]);
  });

  it('upserts sidechat:created/updated records and replaces them wholesale', () => {
    const { ws, hook } = setup();

    act(() => ws.emit(stateSync([sideChat('sc-1')])));
    act(() => ws.emit({ type: 'sidechat:created', sidechat: sideChat('sc-2') }));
    expect(hook.result.current.sideChats.map(entry => entry.id)).toEqual(['sc-1', 'sc-2']);

    const replacement = { ...sideChat('sc-2', 'unavailable'), anchor: { type: 'empty' } as const };
    act(() => ws.emit({ type: 'sidechat:updated', sidechat: replacement }));
    expect(hook.result.current.sideChats).toHaveLength(2);
    expect(hook.result.current.sideChats.find(entry => entry.id === 'sc-2')).toEqual(replacement);
  });

  it('sidechat:closed removes the read model and transient event state', () => {
    const { ws, hook } = setup();
    act(() => ws.emit(stateSync([sideChat('sc-1', 'open', {
      events: [rawNotification('sc-1', 'content.delta', { contentId: 'c-1', kind: 'text', delta: 'temporary' })],
    })])));
    expect(hook.result.current.itemsBySidechat['sc-1']).toHaveLength(1);

    act(() => ws.emit({
      type: 'sidechat:closed',
      sidechat_id: 'sc-1',
      parent_session_id: 'session-1',
      provider_data_deleted: false,
    }));

    expect(hook.result.current.sideChats).toEqual([]);
    expect(hook.result.current.itemsBySidechat['sc-1']).toBeUndefined();
    expect(hook.result.current.pendingBySidechat['sc-1']).toBeUndefined();
  });
});

describe('useAppSocket side-chat snapshot projection (proposal §10.5.2)', () => {
  const withTranscript = (id: string) => sideChat(id, 'open', {
    user_inputs: [{
      turn_id: 'pt-1',
      input: [{ type: 'text', text: 'question from user' }],
      created_at: '2026-08-20T08:00:30.000Z',
    }],
    events: [
      rawNotification(id, 'turn.started', {}, 'pt-1', '2026-08-20T08:00:31.000Z'),
      rawNotification(id, 'content.delta', { contentId: 'c-1', kind: 'text', delta: 'hello from B' }, 'pt-1', '2026-08-20T08:01:00.000Z'),
      rawNotification(id, 'activity.updated', {
        activityId: 'a-1',
        status: 'succeeded',
        title: 'Read',
        presentation: { type: 'file', data: { operation: 'read', path: '/tmp/a.ts' } },
      }, 'pt-1', '2026-08-20T08:01:30.000Z'),
    ],
  });

  it('projects snapshot user_inputs + events into the Side Chat store with the PARENT executor — never the parent or a sibling', () => {
    const { ws, hook } = setup();
    act(() => ws.emit(stateSync([sideChat('sc-a'), withTranscript('sc-b')])));

    const current = hook.result.current;
    const itemsB = current.itemsBySidechat['sc-b'] ?? [];
    expect(itemsB.map(item => item.kind)).toEqual(['user', 'assistant', 'file-read']);
    expect(itemsB[0]).toMatchObject({ kind: 'user', text: 'question from user', exec: 'codex' });
    expect(itemsB[1]).toMatchObject({ kind: 'assistant', text: 'hello from B', exec: 'codex' });
    // Isolation: neither the sibling Side Chat nor the parent Session got it.
    expect(current.itemsBySidechat['sc-a'] ?? []).toEqual([]);
    expect(current.itemsBySession['session-1'] ?? []).toEqual([]);
    expect(current.itemsBySession['sc-b']).toBeUndefined();
  });

  it('re-projects on sidechat:updated — live notifications grow the transcript', () => {
    const { ws, hook } = setup();
    act(() => ws.emit(stateSync([sideChat('sc-1')])));
    expect(hook.result.current.itemsBySidechat['sc-1'] ?? []).toEqual([]);

    act(() => ws.emit({ type: 'sidechat:updated', sidechat: withTranscript('sc-1') }));
    expect((hook.result.current.itemsBySidechat['sc-1'] ?? []).map(item => item.kind))
      .toEqual(['user', 'assistant', 'file-read']);

    // A later snapshot with one more event re-projects wholesale (bounded,
    // idempotent — no duplication of the earlier items).
    const grown = withTranscript('sc-1');
    grown.events = [
      ...grown.events,
      rawNotification('sc-1', 'content.completed', { contentId: 'c-1', kind: 'text', content: 'hello from B' }, 'pt-1', '2026-08-20T08:02:00.000Z'),
      rawNotification('sc-1', 'turn.completed', {}, 'pt-1', '2026-08-20T08:02:30.000Z'),
    ];
    act(() => ws.emit({ type: 'sidechat:updated', sidechat: grown }));
    const items = hook.result.current.itemsBySidechat['sc-1'] ?? [];
    expect(items.filter(item => item.kind === 'assistant')).toHaveLength(1);
    expect(items.filter(item => item.kind === 'user')).toHaveLength(1);
  });

  it('shows a crash-interrupted uncertain turn as failed/interrupted, never silently live (§10.5.3)', () => {
    const { ws, hook } = setup();
    act(() => ws.emit(stateSync([sideChat('sc-1', 'open', {
      uncertain_turn_id: 'pt-1',
      user_inputs: [{
        turn_id: 'pt-1',
        input: [{ type: 'text', text: 'will it finish?' }],
        created_at: '2026-08-20T08:00:30.000Z',
      }],
      events: [rawNotification('sc-1', 'turn.started', {}, 'pt-1', '2026-08-20T08:00:31.000Z')],
    })])));

    const items = hook.result.current.itemsBySidechat['sc-1'] ?? [];
    expect(items.some(item => item.kind === 'error' || (item.kind === 'status' && 'text' in item))).toBe(true);
  });

  it('prunes Side Chat items when state_sync no longer carries the record (permanent delete, §10.5.4)', () => {
    const { ws, hook } = setup();
    act(() => ws.emit(stateSync([withTranscript('sc-a'), sideChat('sc-b')])));
    expect(Object.keys(hook.result.current.itemsBySidechat)).toEqual(['sc-a', 'sc-b']);

    // sc-b was permanently closed — its transient state must vanish too.
    act(() => ws.emit(stateSync([withTranscript('sc-a')])));
    expect(Object.keys(hook.result.current.itemsBySidechat)).toEqual(['sc-a']);
    expect(hook.result.current.pendingBySidechat['sc-b']).toBeUndefined();
  });

  it('a send-failure error frame for a Side Chat id never touches the session stores', () => {
    const { ws, hook } = setup();
    act(() => ws.emit(stateSync([withTranscript('sc-a')])));
    const itemsBefore = hook.result.current.itemsBySidechat['sc-a'];

    act(() => ws.emit({
      type: 'error',
      session_id: 'sc-a',
      request_type: 'message:send',
      request_id: 'req-1',
      code: 'MESSAGE_SEND_FAILED',
      message: 'send failed',
    } as unknown as ServerToClientMessage));
    expect(hook.result.current.pendingBySession['sc-a']).toBeUndefined();
    expect(hook.result.current.itemsBySession['sc-a']).toBeUndefined();
    // The Side Chat transcript itself is snapshot-driven — untouched.
    expect(hook.result.current.itemsBySidechat['sc-a']).toBe(itemsBefore);
  });
});
