import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientToServerMessage, ServerToClientMessage } from '@gian/shared';

import { createOperationDispatcher, type OperationTransport } from '../src/operations/dispatcher.js';
import { createOperationRegistry } from '../src/operations/registry.js';
import { createOperationStore, entityFieldKey } from '../src/operations/store.js';
import type { OperationDefinition, OperationRun } from '../src/operations/types.js';

/**
 * Phase 1 internal fixture registry — lives in the test file on purpose; no
 * fixture definitions are exported for product use (Phase 2/3 register the
 * real domain definitions).
 */
function fixtureRegistry() {
  const registry = createOperationRegistry();
  const rename: OperationDefinition<{ sessionId: string; name: string }> = {
    policy: 'optimistic',
    entityKey: input => `session:${input.sessionId}`,
    optimisticWrites: input => [{ field: 'name', value: input.name }],
    buildMessage: input => ({ type: 'session:rename', session_id: input.sessionId, name: input.name }),
    timeoutMs: 5000,
  };
  const stop: OperationDefinition<{ sessionId: string }> = {
    policy: 'pending',
    entityKey: input => `session:${input.sessionId}`,
    buildMessage: input => ({ type: 'session:stop', session_id: input.sessionId }),
    timeoutMs: 5000,
  };
  const merge: OperationDefinition<{ sessionId: string }, { ok: boolean }> = {
    policy: 'pending',
    entityKey: input => `session:${input.sessionId}`,
    execute: () => new Promise<{ ok: boolean }>(() => {}), // resolved by test override below
    timeoutMs: 5000,
  };
  const saveSettings: OperationDefinition<{ theme: string }> = {
    policy: 'optimistic',
    entityKey: () => 'settings:global',
    optimisticWrites: input => [{ field: 'theme', value: input.theme }],
    execute: () => new Promise<void>(() => {}),
    timeoutMs: 5000,
  };
  registry.register('session.rename', rename);
  registry.register('session.stop', stop);
  registry.register('session.merge', merge);
  registry.register('settings.save', saveSettings);
  return registry;
}

class FakeTransport implements OperationTransport {
  sent: ClientToServerMessage[] = [];
  sendError?: Error;
  private messageListeners = new Set<(msg: ServerToClientMessage) => void>();
  private stateListeners = new Set<(state: 'connecting' | 'open' | 'closed', attempt: number) => void>();
  private state: 'connecting' | 'open' | 'closed' = 'open';

  send(msg: ClientToServerMessage): void {
    this.sent.push(msg);
    if (this.sendError) throw this.sendError;
  }

  onMessage(listener: (msg: ServerToClientMessage) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onState(listener: (state: 'connecting' | 'open' | 'closed', attempt: number) => void): () => void {
    this.stateListeners.add(listener);
    listener(this.state, 0); // GianWs contract: fires immediately
    return () => this.stateListeners.delete(listener);
  }

  emit(msg: ServerToClientMessage): void {
    for (const listener of this.messageListeners) listener(msg);
  }

  emitResult(requestId: string, ok: boolean, error?: { code: string; message: string }): void {
    this.emit({ type: 'operation:result', request_id: requestId, request_type: 'session:rename', ok, error });
  }

  disconnect(): void {
    this.state = 'closed';
    for (const listener of this.stateListeners) listener('closed', 0);
  }
}

function requestIdOf(msg: ClientToServerMessage | undefined): string {
  const id = (msg as { request_id?: string } | undefined)?.request_id;
  expect(id).toBeTruthy();
  return id!;
}

function setup(options: {
  canonical?: Record<string, unknown>;
  registry?: ReturnType<typeof fixtureRegistry>;
  onUnresolved?: (entityKey: string) => void;
  clearTimeout?: typeof clearTimeout;
} = {}) {
  const store = createOperationStore();
  const transport = new FakeTransport();
  const dispatcher = createOperationDispatcher({
    store,
    registry: options.registry ?? fixtureRegistry(),
    transport,
    readCanonicalField: (_entityKey, field) => options.canonical?.[field],
    onUnresolved: options.onUnresolved,
    clearTimeout: options.clearTimeout,
  });
  return { store, transport, dispatcher };
}

describe('operation dispatcher (proposal §4.3/§4.4)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('commits optimistic local feedback synchronously, before the transport result arrives', () => {
    const { store, transport, dispatcher } = setup({ canonical: { name: 'Before' } });

    const run = dispatcher.dispatch('session.rename', { sessionId: 's1', name: 'After' });

    // Same JavaScript task: overlay + run are visible before any result.
    expect(run.phase).toBe('optimistic');
    const overlay = store.getOverlay(entityFieldKey('session:s1', 'name'));
    expect(overlay?.value).toBe('After');
    expect(overlay?.previous).toBe('Before');
    expect(overlay?.operationId).toBe(run.id);

    // The WS message carries a minted request_id (§4.4).
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]).toMatchObject({ type: 'session:rename', session_id: 's1', name: 'After' });
    const requestId = requestIdOf(transport.sent[0]);

    // Success result absorbs the overlay and confirms the run.
    transport.emitResult(requestId, true);
    expect(store.getRun(run.id)?.phase).toBe('confirmed');
    expect(store.getEntityOverlays('session:s1')).toHaveLength(0);
  });

  it('reconnects result listeners after a StrictMode-style lifecycle cleanup', () => {
    const { store, transport, dispatcher } = setup({ canonical: { name: 'Before' } });

    dispatcher.dispose();
    dispatcher.connect();
    const run = dispatcher.dispatch('session.rename', { sessionId: 's1', name: 'After' });

    transport.emitResult(requestIdOf(transport.sent[0]), true);
    expect(store.getRun(run.id)?.phase).toBe('confirmed');
  });

  it('renders a stable pending state synchronously for pending-policy operations', () => {
    const { store, transport, dispatcher } = setup();

    const run = dispatcher.dispatch('session.stop', { sessionId: 's1' });
    expect(run.phase).toBe('pending');
    expect(store.getPendingRuns('session:s1').map(r => r.id)).toEqual([run.id]);
    expect(store.getEntityOverlays('session:s1')).toHaveLength(0); // no success claim

    transport.emitResult(requestIdOf(transport.sent[0]), true);
    expect(store.getRun(run.id)?.phase).toBe('confirmed');
    expect(store.getPendingRuns()).toHaveLength(0);
  });

  it('fails the run and rolls back owned overlays on operation:result ok:false', () => {
    const { store, transport, dispatcher } = setup({ canonical: { name: 'Before' } });
    const run = dispatcher.dispatch('session.rename', { sessionId: 's1', name: 'After' });

    transport.emitResult(requestIdOf(transport.sent[0]), false, { code: 'RENAME_FAILED', message: 'name taken' });

    expect(store.getRun(run.id)?.phase).toBe('failed');
    expect(store.getRun(run.id)?.error).toBe('name taken');
    expect(store.getEntityOverlays('session:s1')).toHaveLength(0); // rolled back to canonical
  });

  it('correlates two rapid same-type commands by request_id and settles out-of-order results on the right runs', () => {
    const { store, transport, dispatcher } = setup();

    const first = dispatcher.dispatch('session.rename', { sessionId: 's1', name: 'One' });
    const second = dispatcher.dispatch('session.rename', { sessionId: 's2', name: 'Two' });
    const firstRequest = requestIdOf(transport.sent[0]);
    const secondRequest = requestIdOf(transport.sent[1]);
    expect(firstRequest).not.toBe(secondRequest);

    // Second result arrives first — each run settles on its own request_id.
    transport.emitResult(secondRequest, true);
    expect(store.getRun(second.id)?.phase).toBe('confirmed');
    expect(store.getRun(first.id)?.phase).toBe('optimistic');

    transport.emitResult(firstRequest, false, { code: 'X', message: 'nope' });
    expect(store.getRun(first.id)?.phase).toBe('failed');
  });

  it('an older run\'s result cannot revert a newer run\'s overlay on the same field', () => {
    const { store, transport, dispatcher } = setup({ canonical: { name: 'A' } });
    const older = dispatcher.dispatch('session.rename', { sessionId: 's1', name: 'B' });
    dispatcher.dispatch('session.rename', { sessionId: 's1', name: 'C' });

    // Older command fails — the newer overlay (C) survives.
    transport.emitResult(requestIdOf(transport.sent[0]), false, { code: 'X', message: 'stale' });
    expect(store.getRun(older.id)?.phase).toBe('failed');
    expect(store.getOverlay(entityFieldKey('session:s1', 'name'))?.value).toBe('C');
  });

  it('blocks a duplicate pending destructive submission for the same entity (§4.3)', () => {
    const { store, transport, dispatcher } = setup();

    const first = dispatcher.dispatch('session.stop', { sessionId: 's1' });
    const second = dispatcher.dispatch('session.stop', { sessionId: 's1' });

    // Ignored: same in-flight run returned, no second run, no second send.
    expect(second.id).toBe(first.id);
    expect(store.getPendingRuns('session:s1')).toHaveLength(1);
    expect(transport.sent).toHaveLength(1);

    // A different entity, or a retry after the first settles, is allowed.
    dispatcher.dispatch('session.stop', { sessionId: 's2' });
    expect(transport.sent).toHaveLength(2);
    transport.emitResult(requestIdOf(transport.sent[0]), true);
    dispatcher.dispatch('session.stop', { sessionId: 's1' });
    expect(transport.sent).toHaveLength(3);
  });

  it('times out to an unknown outcome: no rollback, overlays unresolved, late results ignored', () => {
    const { store, transport, dispatcher } = setup({ canonical: { name: 'Before' } });
    const run = dispatcher.dispatch('session.rename', { sessionId: 's1', name: 'After' });
    const requestId = requestIdOf(transport.sent[0]);

    vi.advanceTimersByTime(5001);

    expect(store.getRun(run.id)?.phase).toBe('timed-out');
    const overlay = store.getOverlay(entityFieldKey('session:s1', 'name'));
    expect(overlay?.value).toBe('After'); // NOT rolled back
    expect(overlay?.unresolved).toBe(true);

    // A late result never silently confirms an unknown outcome.
    transport.emitResult(requestId, true);
    expect(store.getRun(run.id)?.phase).toBe('timed-out');
    expect(store.getOverlay(entityFieldKey('session:s1', 'name'))?.value).toBe('After');

    // Reconciliation after a targeted canonical reload: mismatch drops +
    // reports ("change may not have been applied").
    const report = store.reconcileUnresolved('session:s1', { name: 'Before' });
    expect(report.dropped).toHaveLength(1);
    expect(store.getEntityOverlays('session:s1')).toHaveLength(0);
  });

  it('transitions every in-flight run to timed-out on socket close and ignores later results', () => {
    const { store, transport, dispatcher } = setup({ canonical: { name: 'Before' } });
    const optimistic = dispatcher.dispatch('session.rename', { sessionId: 's1', name: 'After' });
    const pending = dispatcher.dispatch('session.stop', { sessionId: 's2' });
    const renameRequest = requestIdOf(transport.sent[0]);
    const stopRequest = requestIdOf(transport.sent[1]);

    transport.disconnect();

    expect(store.getRun(optimistic.id)?.phase).toBe('timed-out');
    expect(store.getRun(pending.id)?.phase).toBe('timed-out');
    expect(store.getOverlay(entityFieldKey('session:s1', 'name'))?.unresolved).toBe(true);

    // Results from the old socket never arrive on the new one — even if a
    // stale listener emits them, they must not confirm anything.
    transport.emitResult(renameRequest, true);
    transport.emitResult(stopRequest, false, { code: 'X', message: 'lost' });
    expect(store.getRun(optimistic.id)?.phase).toBe('timed-out');
    expect(store.getRun(pending.id)?.phase).toBe('timed-out');
  });

  it('keeps REST runs independent from socket close so queued success and later failure still settle', async () => {
    const registry = createOperationRegistry();
    let resolveRest!: (value: { ok: boolean }) => void;
    let rejectRest!: (reason: Error) => void;
    const reconcile = vi.fn();
    const rollback = vi.fn();

    registry.register('session.rename', {
      policy: 'optimistic',
      entityKey: input => `session:${(input as { sessionId: string }).sessionId}`,
      optimisticWrites: input => [{ field: 'name', value: (input as { name: string }).name }],
      buildMessage: input => ({
        type: 'session:rename',
        session_id: (input as { sessionId: string }).sessionId,
        name: (input as { name: string }).name,
      }),
      timeoutMs: 5000,
    });
    registry.register('session.merge', {
      policy: 'pending',
      entityKey: input => `session:${(input as { sessionId: string }).sessionId}`,
      execute: () => new Promise<{ ok: boolean }>(resolve => (resolveRest = resolve)),
      reconcile,
      timeoutMs: 5000,
    });
    registry.register('settings.save', {
      policy: 'optimistic',
      entityKey: () => 'settings:global',
      optimisticWrites: input => [{ field: 'theme', value: (input as { theme: string }).theme }],
      execute: () => new Promise<void>((_resolve, reject) => (rejectRest = reject)),
      rollback,
      timeoutMs: 5000,
    });

    const unresolved = vi.fn();
    const { store, transport, dispatcher } = setup({
      registry,
      canonical: { name: 'Before', theme: 'light' },
      onUnresolved: unresolved,
    });
    const wsRun = dispatcher.dispatch('session.rename', { sessionId: 'ws', name: 'After' });
    const successfulRestRun = dispatcher.dispatch('session.merge', { sessionId: 'rest-success' });
    const failedRestRun = dispatcher.dispatch('settings.save', { theme: 'dark' });

    // Resolve REST first but close the socket before its promise callback gets
    // a turn. Only the WS run becomes unknown during this race.
    resolveRest({ ok: true });
    transport.disconnect();

    expect(store.getRun(wsRun.id)?.phase).toBe('timed-out');
    expect(store.getRun(successfulRestRun.id)?.phase).toBe('pending');
    expect(store.getRun(failedRestRun.id)?.phase).toBe('optimistic');
    const restOverlay = store.getOverlay(entityFieldKey('settings:global', 'theme'));
    expect(restOverlay?.value).toBe('dark');
    expect(restOverlay?.unresolved).toBeUndefined();
    expect(unresolved).toHaveBeenCalledTimes(1);
    expect(unresolved).toHaveBeenCalledWith('session:ws');

    rejectRest(new Error('HTTP 500'));
    await Promise.resolve();

    expect(store.getRun(successfulRestRun.id)?.phase).toBe('confirmed');
    expect(store.getRun(failedRestRun.id)?.phase).toBe('failed');
    expect(reconcile).toHaveBeenCalledWith(
      { ok: true },
      expect.objectContaining({ runId: successfulRestRun.id }),
    );
    expect(rollback).toHaveBeenCalledWith(
      { code: 'EXECUTE_FAILED', message: 'HTTP 500' },
      expect.objectContaining({ runId: failedRestRun.id }),
    );
    expect(store.getOverlay(entityFieldKey('settings:global', 'theme'))).toBeUndefined();
    expect(unresolved).toHaveBeenCalledTimes(1);
  });

  it('finalizes WS result, timeout and close exactly once and ignores every late signal', () => {
    const unresolved = vi.fn();
    const clearTimer = vi.fn((timer: ReturnType<typeof setTimeout>) => clearTimeout(timer));
    const deleteSpy = vi.spyOn(Map.prototype, 'delete');
    const { store, transport, dispatcher } = setup({
      onUnresolved: unresolved,
      clearTimeout: clearTimer as typeof clearTimeout,
    });

    const resultRun = dispatcher.dispatch('session.rename', { sessionId: 'result', name: 'Done' });
    const resultRequest = requestIdOf(transport.sent.at(-1));
    transport.emitResult(resultRequest, true);

    const timeoutRun = dispatcher.dispatch('session.rename', { sessionId: 'timeout', name: 'Maybe' });
    const timeoutRequest = requestIdOf(transport.sent.at(-1));
    vi.advanceTimersByTime(5001);

    const closeRun = dispatcher.dispatch('session.rename', { sessionId: 'close', name: 'Maybe' });
    const closeRequest = requestIdOf(transport.sent.at(-1));
    transport.disconnect();

    // Duplicate close, expired timers and old-socket results are all no-ops.
    transport.disconnect();
    vi.advanceTimersByTime(10_000);
    transport.emitResult(timeoutRequest, true);
    transport.emitResult(closeRequest, true);

    expect(store.getRun(resultRun.id)?.phase).toBe('confirmed');
    expect(store.getRun(timeoutRun.id)?.phase).toBe('timed-out');
    expect(store.getRun(closeRun.id)?.phase).toBe('timed-out');
    expect(unresolved.mock.calls).toEqual([['session:timeout'], ['session:close']]);
    expect(clearTimer).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);

    // Unique run IDs are active context-record keys; request IDs are WS
    // correlation keys. Each is deleted once by the shared finish path.
    for (const key of [resultRun.id, timeoutRun.id, closeRun.id, resultRequest, timeoutRequest, closeRequest]) {
      expect(deleteSpy.mock.calls.filter(([deleted]) => deleted === key)).toHaveLength(1);
    }
  });

  it('keeps lifecycle maps bounded across repeated WS timeouts', () => {
    const unresolved = vi.fn();
    const clearTimer = vi.fn((timer: ReturnType<typeof setTimeout>) => clearTimeout(timer));
    const deleteSpy = vi.spyOn(Map.prototype, 'delete');
    const { transport, dispatcher } = setup({
      onUnresolved: unresolved,
      clearTimeout: clearTimer as typeof clearTimeout,
    });
    const runs: OperationRun[] = [];
    const requestIds: string[] = [];

    for (let index = 0; index < 32; index += 1) {
      runs.push(dispatcher.dispatch('session.rename', { sessionId: `repeat-${index}`, name: 'Maybe' }));
      requestIds.push(requestIdOf(transport.sent.at(-1)));
    }
    vi.advanceTimersByTime(5001);

    expect(unresolved).toHaveBeenCalledTimes(32);
    expect(clearTimer).toHaveBeenCalledTimes(32);
    expect(vi.getTimerCount()).toBe(0);
    for (const key of [...runs.map(run => run.id), ...requestIds]) {
      expect(deleteSpy.mock.calls.filter(([deleted]) => deleted === key)).toHaveLength(1);
    }

    // Neither another close nor all late results can rediscover ended runs.
    transport.disconnect();
    for (const requestId of requestIds) transport.emitResult(requestId, true);
    vi.advanceTimersByTime(5001);
    expect(unresolved).toHaveBeenCalledTimes(32);
    expect(clearTimer).toHaveBeenCalledTimes(32);
  });

  it('allocates nothing without a WS transport and releases a run when send throws synchronously', () => {
    const noTransportStore = createOperationStore();
    const noTransportDispatcher = createOperationDispatcher({
      store: noTransportStore,
      registry: fixtureRegistry(),
    });
    const notifications = vi.fn();
    noTransportStore.subscribe(notifications);

    expect(() => noTransportDispatcher.dispatch('session.rename', { sessionId: 'none', name: 'After' }))
      .toThrow(/no transport/);
    expect(noTransportStore.getPendingRuns()).toHaveLength(0);
    expect(notifications).not.toHaveBeenCalled();

    const clearTimer = vi.fn((timer: ReturnType<typeof setTimeout>) => clearTimeout(timer));
    const unresolved = vi.fn();
    const { store, transport, dispatcher } = setup({
      onUnresolved: unresolved,
      clearTimeout: clearTimer as typeof clearTimeout,
    });
    let failedRunId: string | undefined;
    store.subscribe(() => {
      failedRunId ??= store.getPendingRuns()[0]?.id;
    });
    transport.sendError = new Error('socket send failed');

    expect(() => dispatcher.dispatch('session.rename', { sessionId: 'throw', name: 'After' }))
      .toThrow('socket send failed');
    expect(failedRunId).toBeTruthy();
    expect(store.getRun(failedRunId!)?.phase).toBe('failed');
    expect(store.getRun(failedRunId!)?.error).toBe('socket send failed');
    expect(store.getEntityOverlays('session:throw')).toHaveLength(0);
    expect(clearTimer).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    transport.emitResult(requestIdOf(transport.sent[0]), true);
    transport.disconnect();
    expect(store.getRun(failedRunId!)?.phase).toBe('failed');
    expect(unresolved).not.toHaveBeenCalled();
  });

  it('settles REST operations from the execute() promise (confirmed on resolve)', async () => {
    const registry = createOperationRegistry();
    let resolveExecute!: (value: { ok: boolean }) => void;
    registry.register('session.merge', {
      policy: 'pending',
      entityKey: input => `session:${(input as { sessionId: string }).sessionId}`,
      execute: () => new Promise<{ ok: boolean }>(resolve => (resolveExecute = resolve)),
      timeoutMs: 5000,
    });
    const { store, transport, dispatcher } = setup({ registry });

    const run = dispatcher.dispatch('session.merge', { sessionId: 's1' });
    expect(run.phase).toBe('pending');
    expect(transport.sent).toHaveLength(0); // REST path never touches the socket

    resolveExecute({ ok: true });
    await vi.waitFor(() => expect(store.getRun(run.id)?.phase).toBe('confirmed'));
  });

  it('settles REST operations failed on reject and calls the rollback escape hatch', async () => {
    const registry = createOperationRegistry();
    const rollback = vi.fn();
    let rejectExecute!: (error: Error) => void;
    registry.register('settings.save', {
      policy: 'optimistic',
      entityKey: () => 'settings:global',
      optimisticWrites: input => [{ field: 'theme', value: (input as { theme: string }).theme }],
      execute: () => new Promise<void>((_resolve, reject) => (rejectExecute = reject)),
      rollback,
      timeoutMs: 5000,
    });
    const { store, dispatcher } = setup({ registry, canonical: { theme: 'light' } });

    const run = dispatcher.dispatch('settings.save', { theme: 'dark' });
    expect(store.getOverlay(entityFieldKey('settings:global', 'theme'))?.value).toBe('dark');

    rejectExecute(new Error('HTTP 500'));
    await vi.waitFor(() => expect(store.getRun(run.id)?.phase).toBe('failed'));

    expect(store.getRun(run.id)?.error).toBe('HTTP 500');
    expect(store.getOverlay(entityFieldKey('settings:global', 'theme'))).toBeUndefined();
    expect(rollback).toHaveBeenCalledWith(
      { code: 'EXECUTE_FAILED', message: 'HTTP 500' },
      expect.objectContaining({ runId: run.id }),
    );
  });
});

describe('operation registry machinery (proposal §4.2)', () => {
  it('rejects a definition whose policy disagrees with OPERATION_POLICIES', () => {
    const registry = createOperationRegistry();
    expect(() =>
      registry.register('session.rename', {
        policy: 'pending', // OPERATION_POLICIES says optimistic
        entityKey: () => 'session:s1',
        buildMessage: () => ({ type: 'session:rename', session_id: 's1', name: 'x' }),
        timeoutMs: 1000,
      }),
    ).toThrow(/policy "pending" does not match/);
  });

  it('rejects definitions without exactly one transport and duplicate names', () => {
    const registry = createOperationRegistry();
    const base = { policy: 'pending' as const, entityKey: () => 'session:s1', timeoutMs: 1000 };
    expect(() => registry.register('session.stop', { ...base })).toThrow(/exactly one transport/);
    expect(() =>
      registry.register('session.stop', {
        ...base,
        buildMessage: () => ({ type: 'session:stop', session_id: 's1' }),
        execute: () => Promise.resolve(),
      }),
    ).toThrow(/exactly one transport/);
    registry.register('session.stop', { ...base, buildMessage: () => ({ type: 'session:stop', session_id: 's1' }) });
    expect(() =>
      registry.register('session.stop', { ...base, buildMessage: () => ({ type: 'session:stop', session_id: 's1' }) }),
    ).toThrow(/already registered/);
  });

  it('rejects optimistic operations without optimisticWrites', () => {
    const registry = createOperationRegistry();
    expect(() =>
      registry.register('session.rename', {
        policy: 'optimistic',
        entityKey: () => 'session:s1',
        buildMessage: () => ({ type: 'session:rename', session_id: 's1', name: 'x' }),
        timeoutMs: 1000,
      }),
    ).toThrow(/optimisticWrites/);
  });

  it('assertComplete fails while any OperationName lacks a definition', () => {
    const registry = createOperationRegistry();
    expect(() => registry.assertComplete()).toThrow(/registry incomplete/);
  });

  it('dispatching an unregistered operation fails loudly', () => {
    const { dispatcher } = setup();
    expect(() => dispatcher.dispatch('task.delete', { taskId: 't1' })).toThrow(/not registered/);
  });
});
