/**
 * Phase 2a Session-domain operations on the real product definitions
 * (`src/operations/session.ts`), proving the proposal §8 contract per
 * migrated operation class: synchronous feedback, duplicate pending guard,
 * success absorption, owned-only rollback, timeout/disconnect unknown
 * outcome, the §4.4 result/broadcast ordering contract, and overlay-merged
 * rendering.
 */
import { act, renderHook } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import type { ClientToServerMessage, ServerToClientMessage, Session } from '@gian/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOperationDispatcher, type OperationTransport } from '../src/operations/dispatcher.js';
// Side effect: registers the product Session definitions used below.
import '../src/operations/session.js';
import { createOperationStore, entityFieldKey } from '../src/operations/store.js';
import {
  OperationDispatcherProvider,
  OperationStoreProvider,
  useSessionsWithOverlays,
} from '../src/operations/use-operations.js';

function fixture(overrides: Partial<Session> = {}): Session {
  return {
    id: 's1',
    name: 'Before',
    type: 'coding',
    task_id: null,
    workspace_id: 'workspace-1',
    executor: 'codex',
    model: null,
    approval_mode: 'ask',
    executor_config: { schemaVersion: 1, values: {} },
    native_config_options: [],
    thinking_effort: null,
    service_tier: null,
    active_channel: 'web',
    status: 'done',
    archived: 0,
    pinned_at: null,
    unread: 0,
    worktree_path: null,
    branch: null,
    base_branch: null,
    worktree_outcome: null,
    detected_worktree_path: null,
    completed_at: null,
    native_session_id: 'native-1',
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
    last_accessed_at: null,
    context_tokens_used: null,
    context_window_tokens: null,
    context_usage_updated_at: null,
    conversation_input_tokens: null,
    conversation_output_tokens: null,
    conversation_cached_input_tokens: null,
    conversation_total_tokens: null,
    conversation_usage_complete: 0,
    ...overrides,
  };
}

class FakeTransport implements OperationTransport {
  sent: ClientToServerMessage[] = [];
  private messageListeners = new Set<(msg: ServerToClientMessage) => void>();
  private stateListeners = new Set<(state: 'connecting' | 'open' | 'closed', attempt: number) => void>();

  send(msg: ClientToServerMessage): void {
    this.sent.push(msg);
  }

  onMessage(listener: (msg: ServerToClientMessage) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onState(listener: (state: 'connecting' | 'open' | 'closed', attempt: number) => void): () => void {
    this.stateListeners.add(listener);
    listener('open', 0); // GianWs contract: fires immediately
    return () => this.stateListeners.delete(listener);
  }

  emit(msg: ServerToClientMessage): void {
    for (const listener of this.messageListeners) listener(msg);
  }

  emitResult(requestId: string, ok: boolean, error?: { code: string; message: string }): void {
    this.emit({ type: 'operation:result', request_id: requestId, request_type: 'session:rename', ok, error });
  }

  disconnect(): void {
    for (const listener of this.stateListeners) listener('closed', 0);
  }
}

function requestIdOf(msg: ClientToServerMessage | undefined): string {
  const id = (msg as { request_id?: string } | undefined)?.request_id;
  expect(id).toBeTruthy();
  return id!;
}

/** Canonical sessions live OUTSIDE the operation layer; the mutable map
 *  stands in for the Host-owned state the broadcasts update. */
function setup(canonicalSessions: Record<string, Session> = { s1: fixture() }) {
  const store = createOperationStore();
  const transport = new FakeTransport();
  const dispatcher = createOperationDispatcher({
    store,
    transport,
    readCanonicalField: (entityKey, field) => {
      if (!entityKey.startsWith('session:')) return undefined;
      return canonicalSessions[entityKey.slice('session:'.length)]?.[field as keyof Session];
    },
  });
  return { store, transport, dispatcher, canonical: canonicalSessions };
}

describe('session operations (proposal §8, product definitions)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('commits optimistic feedback before the transport result arrives', () => {
    const { store, transport, dispatcher } = setup();

    const run = dispatcher.dispatch('session.rename', { sessionId: 's1', name: 'After' });

    expect(run.phase).toBe('optimistic');
    const overlay = store.getOverlay(entityFieldKey('session:s1', 'name'));
    expect(overlay?.value).toBe('After');
    expect(overlay?.previous).toBe('Before');
    expect(transport.sent).toHaveLength(1);
  });

  it('moves a session into a task with the matching semantic overlays and wire message', () => {
    const { store, transport, dispatcher } = setup();

    const run = dispatcher.dispatch('session.assignTask', {
      sessionId: 's1',
      taskId: 'task-1',
    });

    expect(run.phase).toBe('optimistic');
    expect(store.getOverlay(entityFieldKey('session:s1', 'type'))?.value).toBe('subtask');
    expect(store.getOverlay(entityFieldKey('session:s1', 'task_id'))?.value).toBe('task-1');
    expect(transport.sent[0]).toMatchObject({
      type: 'session:assign_task',
      session_id: 's1',
      task_id: 'task-1',
    });

    transport.emitResult(requestIdOf(transport.sent[0]), false, {
      code: 'SESSION_ASSIGN_TASK_FAILED',
      message: 'task is no longer open',
    });
    expect(store.getRun(run.id)?.phase).toBe('failed');
    expect(store.getEntityOverlays('session:s1')).toHaveLength(0);
  });

  it('blocks duplicate pending submissions (stop/delete) while one is in flight', () => {
    const { store, transport, dispatcher } = setup();

    const stop = dispatcher.dispatch('session.stop', { sessionId: 's1' });
    expect(dispatcher.dispatch('session.stop', { sessionId: 's1' }).id).toBe(stop.id);
    dispatcher.dispatch('session.delete', { sessionId: 's1' });
    dispatcher.dispatch('session.delete', { sessionId: 's1' });
    expect(transport.sent).toHaveLength(2);
    expect(store.getPendingRuns('session:s1').map(run => run.name)).toEqual(['session.stop', 'session.delete']);

    // After the result lands, the guard releases and a retry sends again.
    transport.emitResult(requestIdOf(transport.sent[0]), true);
    dispatcher.dispatch('session.stop', { sessionId: 's1' });
    expect(transport.sent).toHaveLength(3);
  });

  it('session.create/fork run pending on a fresh pending entity key and send session:create', () => {
    const { store, transport, dispatcher } = setup();

    const create = dispatcher.dispatch('session.create', {
      workspaceId: 'w1', executor: 'codex', name: 'New', serviceTier: 'fast',
    });
    const fork = dispatcher.dispatch('session.fork', {
      workspaceId: 'w1', executor: 'claude', approvalMode: 'ask', name: 'New copy',
    });

    expect(create.phase).toBe('pending');
    expect(create.entityKey.startsWith('pending:session.create:')).toBe(true);
    expect(fork.entityKey.startsWith('pending:session.fork:')).toBe(true);
    // Distinct keys: concurrent creates are not duplicate submissions.
    expect(store.getPendingRuns()).toHaveLength(2);
    expect(transport.sent[0]).toMatchObject({
      type: 'session:create', workspace_id: 'w1', executor: 'codex', name: 'New', service_tier: 'fast',
    });
    expect(transport.sent[1]).toMatchObject({
      type: 'session:create', workspace_id: 'w1', executor: 'claude', name: 'New copy', approval_mode: 'ask',
    });

    // The pending phase ends on operation:result (the session:created
    // broadcast precedes it host-side and populates canonical state).
    transport.emitResult(requestIdOf(transport.sent[0]), true);
    expect(store.getRun(create.id)?.phase).toBe('confirmed');
    expect(store.getRun(fork.id)?.phase).toBe('pending');
  });

  it('session.create timeout remains an unknown outcome after the fake-timer deadline', () => {
    const { store, transport, dispatcher } = setup();
    const create = dispatcher.dispatch('session.create', {
      workspaceId: 'w1', executor: 'codex', name: 'Maybe created',
    });
    const requestId = requestIdOf(transport.sent[0]);

    vi.advanceTimersByTime(30_001);

    expect(store.getRun(create.id)?.phase).toBe('timed-out');
    expect(store.getPendingRuns()).toHaveLength(0);
    transport.emitResult(requestId, true);
    expect(store.getRun(create.id)?.phase).toBe('timed-out');
  });

  it('success absorbs the overlay and leaves canonical state to the broadcast', () => {
    const { store, transport, dispatcher, canonical } = setup();
    const run = dispatcher.dispatch('session.pin', { sessionId: 's1', pinned: true });
    expect(store.getOverlay(entityFieldKey('session:s1', 'pinned_at'))?.value).not.toBeNull();

    // Host ordering contract: canonical broadcast first, then the result.
    canonical.s1 = { ...canonical.s1!, pinned_at: store.getOverlay(entityFieldKey('session:s1', 'pinned_at'))!.value as string };
    store.absorbMatchingOverlays('session:s1', canonical.s1); // defensive path
    transport.emitResult(requestIdOf(transport.sent[0]), true);

    expect(store.getRun(run.id)?.phase).toBe('confirmed');
    expect(store.getEntityOverlays('session:s1')).toHaveLength(0);
    expect(canonical.s1.pinned_at).not.toBeNull();
  });

  it('failure rolls back only owned overlays and surfaces the error', () => {
    const { store, transport, dispatcher } = setup();
    const run = dispatcher.dispatch('session.setMode', { sessionId: 's1', approvalMode: 'auto' });
    expect(store.getOverlay(entityFieldKey('session:s1', 'approval_mode'))?.value).toBe('auto');

    transport.emitResult(requestIdOf(transport.sent[0]), false, { code: 'MODE_FAILED', message: 'mode rejected' });

    expect(store.getRun(run.id)?.phase).toBe('failed');
    expect(store.getRun(run.id)?.error).toBe('mode rejected');
    // Overlay rolled back — rendering falls back to the canonical value.
    expect(store.getEntityOverlays('session:s1')).toHaveLength(0);
  });

  it('an older failure cannot roll back a newer run\'s overlay on the same field', () => {
    const { store, transport, dispatcher } = setup();
    dispatcher.dispatch('session.setModel', { sessionId: 's1', model: 'model-a' });
    dispatcher.dispatch('session.setModel', { sessionId: 's1', model: 'model-b' });

    transport.emitResult(requestIdOf(transport.sent[0]), false, { code: 'X', message: 'stale write' });
    expect(store.getOverlay(entityFieldKey('session:s1', 'model'))?.value).toBe('model-b');
  });

  it('timeout marks the outcome unknown: no rollback, reconcile on canonical reload', () => {
    const { store, transport, dispatcher } = setup();
    const run = dispatcher.dispatch('session.rename', { sessionId: 's1', name: 'After' });
    const requestId = requestIdOf(transport.sent[0]);

    vi.advanceTimersByTime(10_001);

    expect(store.getRun(run.id)?.phase).toBe('timed-out');
    const overlay = store.getOverlay(entityFieldKey('session:s1', 'name'));
    expect(overlay?.value).toBe('After'); // NOT rolled back
    expect(overlay?.unresolved).toBe(true);

    // A late result never confirms an unknown outcome.
    transport.emitResult(requestId, true);
    expect(store.getRun(run.id)?.phase).toBe('timed-out');

    // Targeted reload says the change WAS applied → absorb silently.
    const applied = store.reconcileUnresolved('session:s1', { name: 'After' });
    expect(applied.absorbed).toHaveLength(1);
    expect(store.getEntityOverlays('session:s1')).toHaveLength(0);
  });

  it('timeout reconcile drops a mismatching overlay and reports it', () => {
    const { store, dispatcher } = setup();
    dispatcher.dispatch('session.setUnread', { sessionId: 's1', unread: true });
    vi.advanceTimersByTime(10_001);

    const report = store.reconcileUnresolved('session:s1', { unread: 0 });
    expect(report.absorbed).toHaveLength(0);
    expect(report.dropped).toHaveLength(1); // "change may not have been applied"
    expect(store.getEntityOverlays('session:s1')).toHaveLength(0);
  });

  it('a result settles only overlays/run state — never writes canonical state (§4.4 ordering)', () => {
    const { store, transport, dispatcher, canonical } = setup();
    const run = dispatcher.dispatch('session.rename', { sessionId: 's1', name: 'After' });

    // Simulate the result arriving BEFORE its canonical broadcast (a host
    // contract violation): the run confirms and the overlay is absorbed, but
    // the canonical fixture is untouched — the operation layer has no path
    // that fabricates canonical state, so an early result can at worst
    // re-expose the pre-change canonical value until the broadcast lands.
    transport.emitResult(requestIdOf(transport.sent[0]), true);
    expect(store.getRun(run.id)?.phase).toBe('confirmed');
    expect(store.getEntityOverlays('session:s1')).toHaveLength(0);
    expect(canonical.s1?.name).toBe('Before');

    // The broadcast then converges rendering with no overlay involvement.
    canonical.s1 = { ...canonical.s1!, name: 'After' };
    expect(store.absorbMatchingOverlays('session:s1', canonical.s1)).toHaveLength(0);
    expect(canonical.s1.name).toBe('After');
  });

  it('two rapid writes are not reverted by an older result', () => {
    const { store, transport, dispatcher } = setup();
    dispatcher.dispatch('session.rename', { sessionId: 's1', name: 'One' });
    dispatcher.dispatch('session.rename', { sessionId: 's1', name: 'Two' });

    // Older result succeeds — the newer overlay supersedes in place.
    transport.emitResult(requestIdOf(transport.sent[0]), true);
    expect(store.getOverlay(entityFieldKey('session:s1', 'name'))?.value).toBe('Two');

    transport.emitResult(requestIdOf(transport.sent[1]), true);
    expect(store.getEntityOverlays('session:s1')).toHaveLength(0);
  });

  it('disconnect marks in-flight runs timed-out; later results never confirm them', () => {
    const { store, transport, dispatcher } = setup();
    const rename = dispatcher.dispatch('session.rename', { sessionId: 's1', name: 'After' });
    const stop = dispatcher.dispatch('session.stop', { sessionId: 's1' });
    const renameRequest = requestIdOf(transport.sent[0]);
    const stopRequest = requestIdOf(transport.sent[1]);

    transport.disconnect();

    expect(store.getRun(rename.id)?.phase).toBe('timed-out');
    expect(store.getRun(stop.id)?.phase).toBe('timed-out');
    expect(store.getOverlay(entityFieldKey('session:s1', 'name'))?.unresolved).toBe(true);

    transport.emitResult(renameRequest, true);
    transport.emitResult(stopRequest, true);
    expect(store.getRun(rename.id)?.phase).toBe('timed-out');
    expect(store.getRun(stop.id)?.phase).toBe('timed-out');
  });

  it('session.setNativeConfig is pending and keyed per config option', () => {
    const { store, transport, dispatcher } = setup();
    dispatcher.dispatch('session.setNativeConfig', { sessionId: 's1', configId: 'mode', value: 'code' });
    // A different option of the same session is NOT a duplicate.
    dispatcher.dispatch('session.setNativeConfig', { sessionId: 's1', configId: 'model', value: 'k2' });
    // The same option twice IS a duplicate.
    dispatcher.dispatch('session.setNativeConfig', { sessionId: 's1', configId: 'mode', value: 'plan' });

    expect(transport.sent).toHaveLength(2);
    expect(store.getPendingRuns()).toHaveLength(2);
    expect(store.getEntityOverlays('session:s1')).toHaveLength(0); // no overlay — pending
  });
});

describe('session overlay rendering (canonical + overlays)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the overlay above canonical, then the confirmed canonical value', () => {
    const canonical = { s1: fixture() };
    const { store, transport, dispatcher } = setup(canonical);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <OperationStoreProvider store={store}>
        <OperationDispatcherProvider dispatcher={dispatcher}>
          {children}
        </OperationDispatcherProvider>
      </OperationStoreProvider>
    );
    const { result } = renderHook(() => {
      const [sessions, setSessions] = useState<Session[]>([canonical.s1!]);
      return { merged: useSessionsWithOverlays(sessions), setSessions };
    }, { wrapper });

    expect(result.current.merged[0]?.name).toBe('Before');

    act(() => {
      dispatcher.dispatch('session.rename', { sessionId: 's1', name: 'After' });
    });
    // Immediate feedback: overlay wins over the canonical field beneath it.
    expect(result.current.merged[0]?.name).toBe('After');

    act(() => {
      // Canonical broadcast first (host ordering contract), then the result.
      canonical.s1 = { ...canonical.s1!, name: 'After' };
      result.current.setSessions([canonical.s1]);
      store.absorbMatchingOverlays('session:s1', canonical.s1);
      transport.emitResult(requestIdOf(transport.sent[0]), true);
    });
    expect(result.current.merged[0]?.name).toBe('After');
    expect(store.getEntityOverlays('session:s1')).toHaveLength(0);
  });

  it('a failed operation re-renders the canonical value', () => {
    const { store, transport, dispatcher } = setup();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <OperationStoreProvider store={store}>
        <OperationDispatcherProvider dispatcher={dispatcher}>
          {children}
        </OperationDispatcherProvider>
      </OperationStoreProvider>
    );
    const { result } = renderHook(() => {
      const [sessions] = useState<Session[]>([fixture()]);
      return useSessionsWithOverlays(sessions);
    }, { wrapper });

    act(() => {
      dispatcher.dispatch('session.archive', { sessionId: 's1', archived: true });
    });
    expect(result.current[0]?.archived).toBe(1);

    act(() => {
      transport.emitResult(requestIdOf(transport.sent[0]), false, { code: 'X', message: 'archive failed' });
    });
    expect(result.current[0]?.archived).toBe(0);
  });
});
