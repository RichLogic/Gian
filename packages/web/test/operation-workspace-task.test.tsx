/**
 * Phase 3a Task/Workspace-domain operations on the real product definitions
 * (`src/operations/task.ts`, `src/operations/workspace.ts`), proving the
 * proposal §8 contract per migrated operation class: synchronous feedback
 * before the transport settles, the duplicate pending destructive guard,
 * success absorption, owned-only rollback, timeout/disconnect unknown
 * outcome with the onUnresolved reload hook + reconcile, the §4.4
 * result/broadcast ordering contract, two rapid writes, REST no-broadcast
 * convergence via the reconcile sinks (inventory §4 note 7), and
 * overlay-merged rendering for both domains.
 */
import { act, renderHook } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import type { ClientToServerMessage, ServerToClientMessage, Session, Task, Workspace } from '@gian/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  completeSubtask,
  createSubtask,
  createWorkspace,
  deleteWorkspace,
  pickWorkspaceFolder,
  reorderWorkspaces,
  reopenSubtask,
  saveClaudeMd,
  updateWorkspace,
} from '../src/api.js';
import { __resetFeedback, getSnapshot } from '../src/feedback.js';
import { createOperationDispatcher, type OperationTransport } from '../src/operations/dispatcher.js';
// Side effects: register the product Task/Workspace definitions used below.
import { taskEntityKey, wireSubtaskCanonicalSink } from '../src/operations/task.js';
import {
  applyWorkspaceOrderOverlay,
  wireWorkspaceCanonicalSink,
  WORKSPACE_LIST_ENTITY_KEY,
  WORKSPACE_ORDER_FIELD,
  workspaceEntityKey,
  type WorkspaceCanonicalSink,
} from '../src/operations/workspace.js';
import '../src/operations/session.js';
import { createOperationStore, entityFieldKey } from '../src/operations/store.js';
import {
  OperationDispatcherProvider,
  OperationStoreProvider,
  useStoreTasksWithOverlays,
  useStoreWorkspacesWithOverlays,
} from '../src/operations/use-operations.js';

vi.mock('../src/api.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/api.js')>();
  return {
    ...actual,
    completeSubtask: vi.fn(),
    reopenSubtask: vi.fn(),
    createSubtask: vi.fn(),
    createWorkspace: vi.fn(),
    updateWorkspace: vi.fn(),
    reorderWorkspaces: vi.fn(),
    deleteWorkspace: vi.fn(),
    saveClaudeMd: vi.fn(),
    pickWorkspaceFolder: vi.fn(),
  };
});

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    name: 'Before',
    description: null,
    status: 'open',
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
    pinned_at: null,
    ...overrides,
  };
}

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'w1',
    name: 'Before',
    path: '/tmp/w1',
    sort_order: 0,
    hidden: 0,
    pinned: 0,
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
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
    this.emit({ type: 'operation:result', request_id: requestId, request_type: 'task:update', ok, error });
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

interface CanonicalState {
  tasks: Record<string, Task>;
  workspaces: Record<string, Workspace>;
  order: string[];
}

/** Canonical tasks/workspaces live OUTSIDE the operation layer; the mutable
 *  maps stand in for the Host-owned state the broadcasts/refetches update.
 *  Mirrors App's readCanonicalField wiring exactly. */
function setup(canonical: CanonicalState = { tasks: { t1: task() }, workspaces: { w1: workspace() }, order: ['w1'] }) {
  const store = createOperationStore();
  const transport = new FakeTransport();
  const unresolved: string[] = [];
  const dispatcher = createOperationDispatcher({
    store,
    transport,
    readCanonicalField: (entityKey, field) => {
      if (entityKey.startsWith('task:')) {
        return canonical.tasks[entityKey.slice('task:'.length)]?.[field as keyof Task];
      }
      if (entityKey === WORKSPACE_LIST_ENTITY_KEY) {
        return field === WORKSPACE_ORDER_FIELD ? canonical.order : undefined;
      }
      if (entityKey.startsWith('workspace:')) {
        const id = entityKey.slice('workspace:'.length).split(':')[0]!;
        return canonical.workspaces[id]?.[field as keyof Workspace];
      }
      return undefined;
    },
    onUnresolved: entityKey => unresolved.push(entityKey),
  });
  return { store, transport, dispatcher, canonical, unresolved };
}

/** Records the reconcile sink calls (App wires setWorkspaces/loadWorkspaces). */
function workspaceSink(): WorkspaceCanonicalSink & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    upsert: w => calls.push(`upsert:${w.id}:${w.name}`),
    remove: id => calls.push(`remove:${id}`),
    applyOrder: ids => calls.push(`order:${ids.join(',')}`),
    refetch: () => calls.push('refetch'),
  };
}

describe('task WS operations (proposal §8, product definitions)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetFeedback();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('commits optimistic rename/done feedback before the result arrives', () => {
    const { store, transport, dispatcher } = setup();

    const rename = dispatcher.dispatch('task.rename', { taskId: 't1', name: 'After' });
    expect(rename.phase).toBe('optimistic');
    expect(store.getOverlay(entityFieldKey('task:t1', 'name'))?.value).toBe('After');
    expect(store.getOverlay(entityFieldKey('task:t1', 'name'))?.previous).toBe('Before');

    dispatcher.dispatch('task.toggleDone', { taskId: 't1', status: 'done' });
    expect(store.getOverlay(entityFieldKey('task:t1', 'status'))?.value).toBe('done');

    expect(transport.sent[0]).toMatchObject({ type: 'task:update', task_id: 't1', name: 'After' });
    expect(transport.sent[1]).toMatchObject({ type: 'task:update', task_id: 't1', status: 'done' });
  });

  it('task.pin mirrors the pinned_at stamp semantics (ISO / null)', () => {
    const { store, transport, dispatcher } = setup();
    dispatcher.dispatch('task.pin', { taskId: 't1', pinned: true });
    expect(store.getOverlay(entityFieldKey('task:t1', 'pinned_at'))?.value).not.toBeNull();
    expect(transport.sent[0]).toMatchObject({ type: 'task:update', task_id: 't1', pinned: true });
  });

  it('task.create runs pending on a fresh pending key; task.delete blocks duplicates', () => {
    const { store, transport, dispatcher } = setup();

    const create = dispatcher.dispatch('task.create', { name: 'New' });
    expect(create.phase).toBe('pending');
    expect(create.entityKey.startsWith('pending:task.create:')).toBe(true);
    expect(transport.sent[0]).toMatchObject({ type: 'task:create', name: 'New' });

    const del = dispatcher.dispatch('task.delete', { taskId: 't1' });
    expect(dispatcher.dispatch('task.delete', { taskId: 't1' }).id).toBe(del.id);
    expect(transport.sent.filter(m => m.type === 'task:delete')).toHaveLength(1);
    expect(store.getPendingRuns('task:t1').map(r => r.name)).toEqual(['task.delete']);

    // After the result lands, the guard releases and a retry sends again.
    transport.emitResult(requestIdOf(transport.sent[1]), true);
    dispatcher.dispatch('task.delete', { taskId: 't1' });
    expect(transport.sent.filter(m => m.type === 'task:delete')).toHaveLength(2);
  });

  it('success absorbs the overlay and leaves canonical state to the broadcast', () => {
    const { store, transport, dispatcher, canonical } = setup();
    dispatcher.dispatch('task.rename', { taskId: 't1', name: 'After' });

    // Host ordering contract: task:updated broadcast first, then the result.
    canonical.tasks.t1 = { ...canonical.tasks.t1!, name: 'After' };
    store.absorbMatchingOverlays('task:t1', canonical.tasks.t1); // defensive path
    transport.emitResult(requestIdOf(transport.sent[0]), true);

    expect(store.getEntityOverlays('task:t1')).toHaveLength(0);
    expect(canonical.tasks.t1.name).toBe('After');
  });

  it('a result settles only overlays/run state — never writes canonical state (§4.4 ordering)', () => {
    const { store, transport, dispatcher, canonical } = setup();
    const run = dispatcher.dispatch('task.toggleDone', { taskId: 't1', status: 'done' });

    // Simulate the result arriving BEFORE its canonical broadcast (a host
    // contract violation): the run confirms and the overlay is absorbed, but
    // the canonical fixture is untouched.
    transport.emitResult(requestIdOf(transport.sent[0]), true);
    expect(store.getRun(run.id)?.phase).toBe('confirmed');
    expect(store.getEntityOverlays('task:t1')).toHaveLength(0);
    expect(canonical.tasks.t1?.status).toBe('open');
  });

  it('failure rolls back only owned overlays and surfaces the error', () => {
    const { store, transport, dispatcher } = setup();
    const run = dispatcher.dispatch('task.rename', { taskId: 't1', name: 'After' });

    transport.emitResult(requestIdOf(transport.sent[0]), false, { code: 'TASK_UPDATE_FAILED', message: 'rename rejected' });

    expect(store.getRun(run.id)).toMatchObject({ phase: 'failed', error: 'rename rejected' });
    expect(store.getEntityOverlays('task:t1')).toHaveLength(0);
  });

  it('two rapid writes are not reverted by an older result', () => {
    const { store, transport, dispatcher } = setup();
    dispatcher.dispatch('task.rename', { taskId: 't1', name: 'One' });
    dispatcher.dispatch('task.rename', { taskId: 't1', name: 'Two' });

    transport.emitResult(requestIdOf(transport.sent[0]), true);
    expect(store.getOverlay(entityFieldKey('task:t1', 'name'))?.value).toBe('Two');

    transport.emitResult(requestIdOf(transport.sent[1]), true);
    expect(store.getEntityOverlays('task:t1')).toHaveLength(0);
  });

  it('timeout marks the outcome unknown, fires onUnresolved, and reconcile absorbs a match', () => {
    const { store, transport, dispatcher, unresolved } = setup();
    const run = dispatcher.dispatch('task.rename', { taskId: 't1', name: 'After' });
    const requestId = requestIdOf(transport.sent[0]);

    vi.advanceTimersByTime(10_001);

    expect(store.getRun(run.id)?.phase).toBe('timed-out');
    expect(store.getOverlay(entityFieldKey('task:t1', 'name'))?.unresolved).toBe(true);
    // The unresolved-reload hook fired for the affected entity (Phase 3a).
    expect(unresolved).toEqual(['task:t1']);

    // A late result never confirms an unknown outcome.
    transport.emitResult(requestId, true);
    expect(store.getRun(run.id)?.phase).toBe('timed-out');

    // Reload says the change WAS applied → absorb silently.
    const applied = store.reconcileUnresolved('task:t1', { name: 'After' });
    expect(applied.absorbed).toHaveLength(1);
    expect(store.getEntityOverlays('task:t1')).toHaveLength(0);
  });

  it('timeout reconcile drops a mismatching overlay and reports it', () => {
    const { store, dispatcher } = setup();
    dispatcher.dispatch('task.toggleDone', { taskId: 't1', status: 'done' });
    vi.advanceTimersByTime(10_001);

    const report = store.reconcileUnresolved('task:t1', { status: 'open' });
    expect(report.absorbed).toHaveLength(0);
    expect(report.dropped).toHaveLength(1); // "change may not have been applied"
    expect(store.getEntityOverlays('task:t1')).toHaveLength(0);
  });

  it('socket close marks in-flight runs timed-out and fires onUnresolved per entity', () => {
    const { store, transport, dispatcher, unresolved } = setup();
    dispatcher.dispatch('task.rename', { taskId: 't1', name: 'After' });
    dispatcher.dispatch('task.delete', { taskId: 't1' });

    transport.disconnect();

    expect(store.getPendingRuns('task:t1')).toHaveLength(0);
    expect(store.getOverlay(entityFieldKey('task:t1', 'name'))?.unresolved).toBe(true);
    expect(unresolved).toEqual(['task:t1', 'task:t1']);
  });
});

describe('subtask REST operations (proposal §8, product definitions)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetFeedback();
  });
  afterEach(() => {
    wireSubtaskCanonicalSink(null);
    vi.useRealTimers();
  });

  it('task.createSubtask runs pending on a fresh key and carries the created session as its result', async () => {
    const { store, dispatcher } = setup();
    const session = { id: 'sub-new', task_id: 't1' } as Session;
    vi.mocked(createSubtask).mockResolvedValue(session);

    const run = dispatcher.dispatch('task.createSubtask', {
      taskId: 't1', workspaceId: 'w1', executor: 'codex', name: 'Sub', serviceTier: 'fast',
    });
    expect(run.phase).toBe('pending');
    expect(run.entityKey.startsWith('pending:task.createSubtask:')).toBe(true);
    expect(createSubtask).toHaveBeenCalledWith('t1', {
      workspace_id: 'w1', executor: 'codex', name: 'Sub', service_tier: 'fast',
    });

    await vi.waitFor(() => expect(store.getRun(run.id)?.phase).toBe('confirmed'));
    expect(store.getRun(run.id)?.result).toBe(session);
  });

  it('task.createSubtask omits Gian approval_mode for native executors including dsh', async () => {
    const { dispatcher } = setup();
    vi.mocked(createSubtask).mockResolvedValue({ id: 'sub-dsh', task_id: 't1' } as Session);

    dispatcher.dispatch('task.createSubtask', {
      taskId: 't1',
      workspaceId: 'w1',
      executor: 'dsh',
      approvalMode: 'ask',
    });

    expect(createSubtask).toHaveBeenCalledWith('t1', {
      workspace_id: 'w1',
      executor: 'dsh',
    });
  });

  it('task.createSubtask failure settles the run as failed (view toasts)', async () => {
    const { store, dispatcher } = setup();
    vi.mocked(createSubtask).mockResolvedValue(null);

    const run = dispatcher.dispatch('task.createSubtask', { taskId: 't1', workspaceId: 'w1', executor: 'codex' });
    await vi.waitFor(() => expect(store.getRun(run.id)?.phase).toBe('failed'));
    expect(store.getRun(run.id)?.error).toBe('create subtask failed');
  });

  it('complete/reopen are pending per session, block duplicates, and patch canonical state on success', async () => {
    const { store, dispatcher } = setup();
    const patched: Array<[string, Partial<Session>]> = [];
    wireSubtaskCanonicalSink((sessionId, partial) => patched.push([sessionId, partial]));
    vi.mocked(completeSubtask).mockResolvedValue(true);
    vi.mocked(reopenSubtask).mockResolvedValue(true);

    const complete = dispatcher.dispatch('task.completeSubtask', { sessionId: 'sub-1' });
    expect(complete.phase).toBe('pending');
    expect(complete.entityKey).toBe('session:sub-1');
    // Duplicate submission of the same command is blocked while in flight.
    expect(dispatcher.dispatch('task.completeSubtask', { sessionId: 'sub-1' }).id).toBe(complete.id);
    expect(completeSubtask).toHaveBeenCalledTimes(1);

    // REST no-broadcast-channel convergence (inventory §4 note 7): the
    // reconcile patches canonical session state directly — idempotent with
    // the host's session:updated broadcast.
    await vi.waitFor(() => expect(store.getRun(complete.id)?.phase).toBe('confirmed'));
    expect(patched[0]?.[0]).toBe('sub-1');
    expect(patched[0]?.[1].completed_at).not.toBeNull();

    const reopen = dispatcher.dispatch('task.reopenSubtask', { sessionId: 'sub-1' });
    await vi.waitFor(() => expect(store.getRun(reopen.id)?.phase).toBe('confirmed'));
    expect(patched[1]?.[1].completed_at).toBeNull();
  });

  it('complete failure rolls back nothing (pending) and toasts the error', async () => {
    const { store, dispatcher } = setup();
    vi.mocked(completeSubtask).mockResolvedValue(false);

    const run = dispatcher.dispatch('task.completeSubtask', { sessionId: 'sub-1' });
    await vi.waitFor(() => expect(store.getRun(run.id)?.phase).toBe('failed'));
    expect(getSnapshot().toasts.some(t => t.kind === 'error' && t.message === 'complete subtask failed')).toBe(true);
  });
});

describe('workspace REST operations (proposal §8, product definitions)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetFeedback();
  });
  afterEach(() => {
    wireWorkspaceCanonicalSink(null);
    vi.useRealTimers();
  });

  it('rename/hidden/pin commit optimistic overlays synchronously, before the REST promise settles', () => {
    const { store, dispatcher } = setup();
    vi.mocked(updateWorkspace).mockReturnValue(new Promise(() => {}));

    const rename = dispatcher.dispatch('workspace.rename', { workspaceId: 'w1', name: 'After' });
    expect(rename.phase).toBe('optimistic');
    expect(store.getOverlay(entityFieldKey('workspace:w1', 'name'))?.value).toBe('After');
    expect(store.getOverlay(entityFieldKey('workspace:w1', 'name'))?.previous).toBe('Before');
    expect(updateWorkspace).toHaveBeenCalledWith('w1', { name: 'After' });

    dispatcher.dispatch('workspace.setHidden', { workspaceId: 'w1', hidden: true });
    expect(store.getOverlay(entityFieldKey('workspace:w1', 'hidden'))?.value).toBe(1);

    dispatcher.dispatch('workspace.pin', { workspaceId: 'w1', pinned: true });
    expect(store.getOverlay(entityFieldKey('workspace:w1', 'pinned'))?.value).toBe(1);
  });

  it('REST no-broadcast convergence: the response entity patches canonical state + refetch, overlay absorbs', async () => {
    const { store, dispatcher, canonical } = setup();
    const sink = workspaceSink();
    wireWorkspaceCanonicalSink(sink);
    const updated = workspace({ name: 'After' });
    vi.mocked(updateWorkspace).mockResolvedValue(updated);

    const run = dispatcher.dispatch('workspace.rename', { workspaceId: 'w1', name: 'After' });
    expect(store.getOverlay(entityFieldKey('workspace:w1', 'name'))?.value).toBe('After');

    await vi.waitFor(() => expect(store.getRun(run.id)?.phase).toBe('confirmed'));
    // The host does NOT broadcast workspace PATCH (inventory §4 note 7):
    // reconcile upserts the response entity into canonical state and
    // refetches — the pre-migration onChange() semantics.
    expect(sink.calls).toEqual(['upsert:w1:After', 'refetch']);
    expect(store.getEntityOverlays('workspace:w1')).toHaveLength(0);
    canonical.workspaces.w1 = updated; // what App's upsert would do
    expect(canonical.workspaces.w1.name).toBe('After');
  });

  it('reorder carries the full ordered id array as a whole-list overlay and converges via applyOrder + refetch', async () => {
    const { store, dispatcher } = setup({
      tasks: {},
      workspaces: { w1: workspace(), w2: workspace({ id: 'w2', name: 'Two', sort_order: 1 }) },
      order: ['w1', 'w2'],
    });
    const sink = workspaceSink();
    wireWorkspaceCanonicalSink(sink);
    vi.mocked(reorderWorkspaces).mockResolvedValue(undefined);

    const overlayKey = entityFieldKey(WORKSPACE_LIST_ENTITY_KEY, WORKSPACE_ORDER_FIELD);
    const run = dispatcher.dispatch('workspace.reorder', { ids: ['w2', 'w1'] });
    expect(run.entityKey).toBe(WORKSPACE_LIST_ENTITY_KEY);
    const overlay = store.getOverlay(overlayKey);
    expect(overlay?.value).toEqual(['w2', 'w1']);
    expect(overlay?.previous).toEqual(['w1', 'w2']);

    await vi.waitFor(() => expect(store.getRun(run.id)?.phase).toBe('confirmed'));
    expect(sink.calls).toEqual(['order:w2,w1', 'refetch']);
    expect(store.getOverlay(overlayKey)).toBeUndefined();
  });

  it('metadata failure rolls back the overlay, keeps the newer write, and toasts', async () => {
    const { store, dispatcher } = setup();
    vi.mocked(updateWorkspace)
      .mockRejectedValueOnce(new Error('patch failed'))
      .mockReturnValueOnce(new Promise(() => {}));

    dispatcher.dispatch('workspace.rename', { workspaceId: 'w1', name: 'One' });
    dispatcher.dispatch('workspace.rename', { workspaceId: 'w1', name: 'Two' });

    // The OLDER failure must not roll back the newer overlay on the field.
    await vi.waitFor(() => {
      expect(getSnapshot().toasts.some(t => t.kind === 'error' && t.message === 'patch failed')).toBe(true);
    });
    expect(store.getOverlay(entityFieldKey('workspace:w1', 'name'))?.value).toBe('Two');
  });

  it('workspace.delete is pending with the duplicate guard; failure surfaces on the run', async () => {
    const { store, dispatcher } = setup();
    vi.mocked(deleteWorkspace).mockResolvedValue({ ok: false, error: 'still has sessions' });

    const first = dispatcher.dispatch('workspace.delete', { workspaceId: 'w1' });
    expect(first.phase).toBe('pending');
    // The duplicate destructive guard: the in-flight run is returned.
    expect(dispatcher.dispatch('workspace.delete', { workspaceId: 'w1' }).id).toBe(first.id);
    expect(deleteWorkspace).toHaveBeenCalledTimes(1);

    await vi.waitFor(() => expect(store.getRun(first.id)?.phase).toBe('failed'));
    expect(store.getRun(first.id)?.error).toBe('still has sessions');

    // Success path: canonical remove + refetch via the reconcile sink.
    const sink = workspaceSink();
    wireWorkspaceCanonicalSink(sink);
    vi.mocked(deleteWorkspace).mockResolvedValue({ ok: true });
    const second = dispatcher.dispatch('workspace.delete', { workspaceId: 'w1' });
    await vi.waitFor(() => expect(store.getRun(second.id)?.phase).toBe('confirmed'));
    expect(sink.calls).toEqual(['remove:w1', 'refetch']);
  });

  it('workspace.create runs pending on a fresh key; the workspace is the run result; failure keeps the form error', async () => {
    const { store, dispatcher } = setup();
    const sink = workspaceSink();
    wireWorkspaceCanonicalSink(sink);
    const created = workspace({ id: 'w-new', name: 'New' });
    vi.mocked(createWorkspace).mockResolvedValue({ workspace: created, notes: [] });

    const run = dispatcher.dispatch('workspace.create', { name: 'New', gitRemote: 'git@x:y.git' });
    expect(run.phase).toBe('pending');
    expect(run.entityKey.startsWith('pending:workspace.create:')).toBe(true);
    expect(createWorkspace).toHaveBeenCalledWith('New', { gitRemote: 'git@x:y.git' });

    await vi.waitFor(() => expect(store.getRun(run.id)?.phase).toBe('confirmed'));
    expect(store.getRun(run.id)?.result).toBe(created);
    expect(sink.calls).toEqual(['upsert:w-new:New', 'refetch']);

    // Adopt-path variant + failure: the run fails with the host's error.
    vi.mocked(createWorkspace).mockResolvedValue({ workspace: null, notes: [], error: 'path already registered' });
    const adopt = dispatcher.dispatch('workspace.create', { name: 'Adopt', path: '/tmp/adopt' });
    expect(createWorkspace).toHaveBeenCalledWith('Adopt', { path: '/tmp/adopt' });
    await vi.waitFor(() => expect(store.getRun(adopt.id)?.phase).toBe('failed'));
    expect(store.getRun(adopt.id)?.error).toBe('path already registered');
  });

  it('workspace.saveClaudeMd is pending on a distinct entity key', async () => {
    const { store, dispatcher } = setup();
    vi.mocked(saveClaudeMd).mockResolvedValue(true);

    const run = dispatcher.dispatch('workspace.saveClaudeMd', { workspaceId: 'w1', content: '# notes' });
    expect(run.phase).toBe('pending');
    expect(run.entityKey).toBe('workspace:w1:claude-md');
    await vi.waitFor(() => expect(store.getRun(run.id)?.phase).toBe('confirmed'));

    vi.mocked(saveClaudeMd).mockResolvedValue(false);
    const failed = dispatcher.dispatch('workspace.saveClaudeMd', { workspaceId: 'w1', content: '# notes' });
    await vi.waitFor(() => expect(store.getRun(failed.id)?.phase).toBe('failed'));
  });

  it('workspace.pickFolder: a cancel is a confirmed no-op, never a failure', async () => {
    const { store, dispatcher } = setup();
    vi.mocked(pickWorkspaceFolder).mockResolvedValue({ canceled: true });

    const run = dispatcher.dispatch('workspace.pickFolder', {});
    expect(run.phase).toBe('pending');
    expect(run.entityKey.startsWith('pending:workspace.pickFolder:')).toBe(true);
    await vi.waitFor(() => expect(store.getRun(run.id)?.phase).toBe('confirmed'));
    expect(store.getRun(run.id)?.result).toEqual({ canceled: true });

    // A picker error IS a failure.
    vi.mocked(pickWorkspaceFolder).mockResolvedValue({ error: 'unsupported platform' });
    const failed = dispatcher.dispatch('workspace.pickFolder', {});
    await vi.waitFor(() => expect(store.getRun(failed.id)?.phase).toBe('failed'));
    expect(store.getRun(failed.id)?.error).toBe('unsupported platform');
  });

  it('REST timeout marks the outcome unknown (no rollback) and fires onUnresolved; reload reconcile decides', async () => {
    const { store, dispatcher, unresolved } = setup();
    vi.mocked(updateWorkspace).mockReturnValue(new Promise(() => {})); // never settles

    const run = dispatcher.dispatch('workspace.setHidden', { workspaceId: 'w1', hidden: true });
    vi.advanceTimersByTime(10_001);

    expect(store.getRun(run.id)?.phase).toBe('timed-out');
    const overlay = store.getOverlay(entityFieldKey('workspace:w1', 'hidden'));
    expect(overlay?.value).toBe(1); // NOT rolled back
    expect(overlay?.unresolved).toBe(true);
    expect(unresolved).toEqual(['workspace:w1']);

    // Reload says hidden is still 0 → drop and report ("may not have been applied").
    const report = store.reconcileUnresolved('workspace:w1', { hidden: 0 });
    expect(report.dropped).toHaveLength(1);
    expect(store.getEntityOverlays('workspace:w1')).toHaveLength(0);
  });

  it('two rapid REST writes are not reverted by an older success', async () => {
    const { store, dispatcher } = setup();
    let resolveFirst!: (w: Workspace) => void;
    vi.mocked(updateWorkspace)
      .mockImplementationOnce(() => new Promise<Workspace>(resolve => { resolveFirst = resolve; }))
      .mockResolvedValueOnce(workspace({ name: 'Two' }));

    dispatcher.dispatch('workspace.rename', { workspaceId: 'w1', name: 'One' });
    const second = dispatcher.dispatch('workspace.rename', { workspaceId: 'w1', name: 'Two' });

    // The newer run settles first; the older success must not resurrect 'One'.
    await vi.waitFor(() => expect(store.getRun(second.id)?.phase).toBe('confirmed'));
    expect(store.getEntityOverlays('workspace:w1')).toHaveLength(0);
    resolveFirst(workspace({ name: 'One' }));
    await Promise.resolve();
    expect(store.getOverlay(entityFieldKey('workspace:w1', 'name'))).toBeUndefined();
  });
});

describe('task/workspace overlay rendering (canonical + overlays)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    wireWorkspaceCanonicalSink(null);
    vi.useRealTimers();
  });

  it('renders task overlays above canonical, then the confirmed canonical value', () => {
    const canonical: CanonicalState = { tasks: { t1: task() }, workspaces: {}, order: [] };
    const { store, transport, dispatcher } = setup(canonical);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <OperationStoreProvider store={store}>
        <OperationDispatcherProvider dispatcher={dispatcher}>
          {children}
        </OperationDispatcherProvider>
      </OperationStoreProvider>
    );
    const { result } = renderHook(() => {
      const [tasks, setTasks] = useState<Task[]>([canonical.tasks.t1!]);
      return { merged: useStoreTasksWithOverlays(store, tasks), setTasks };
    }, { wrapper });

    expect(result.current.merged[0]?.name).toBe('Before');

    act(() => {
      dispatcher.dispatch('task.rename', { taskId: 't1', name: 'After' });
    });
    expect(result.current.merged[0]?.name).toBe('After');

    act(() => {
      // Canonical broadcast first (host ordering contract), then the result.
      canonical.tasks.t1 = { ...canonical.tasks.t1!, name: 'After' };
      result.current.setTasks([canonical.tasks.t1]);
      store.absorbMatchingOverlays('task:t1', canonical.tasks.t1);
      transport.emitResult(requestIdOf(transport.sent[0]), true);
    });
    expect(result.current.merged[0]?.name).toBe('After');
    expect(store.getEntityOverlays('task:t1')).toHaveLength(0);
  });

  it('renders workspace field overlays and the whole-list order overlay above canonical', () => {
    const w1 = workspace();
    const w2 = workspace({ id: 'w2', name: 'Two', sort_order: 1 });
    const canonical: CanonicalState = { tasks: {}, workspaces: { w1, w2 }, order: ['w1', 'w2'] };
    const { store, dispatcher } = setup(canonical);
    vi.mocked(updateWorkspace).mockReturnValue(new Promise(() => {}));
    vi.mocked(reorderWorkspaces).mockReturnValue(new Promise(() => {}));
    const wrapper = ({ children }: { children: ReactNode }) => (
      <OperationStoreProvider store={store}>
        <OperationDispatcherProvider dispatcher={dispatcher}>
          {children}
        </OperationDispatcherProvider>
      </OperationStoreProvider>
    );
    const { result } = renderHook(() => {
      const [workspaces] = useState<Workspace[]>([w1, w2]);
      return useStoreWorkspacesWithOverlays(store, workspaces);
    }, { wrapper });

    expect(result.current.map(w => w.id)).toEqual(['w1', 'w2']);

    act(() => {
      dispatcher.dispatch('workspace.rename', { workspaceId: 'w1', name: 'After' });
      dispatcher.dispatch('workspace.reorder', { ids: ['w2', 'w1'] });
    });
    // Immediate feedback: field overlay wins, whole-list order wins.
    expect(result.current.map(w => w.id)).toEqual(['w2', 'w1']);
    expect(result.current.find(w => w.id === 'w1')?.name).toBe('After');
  });

  it('applyWorkspaceOrderOverlay keeps unknown rows at the end and identity when already ordered', () => {
    const w1 = workspace();
    const w2 = workspace({ id: 'w2', name: 'Two', sort_order: 1 });
    const list = [w1, w2];
    expect(applyWorkspaceOrderOverlay(list, ['w2', 'w1']).map(w => w.id)).toEqual(['w2', 'w1']);
    expect(applyWorkspaceOrderOverlay(list, ['w2', 'missing', 'w1']).map(w => w.id)).toEqual(['w2', 'w1']);
    expect(applyWorkspaceOrderOverlay(list, ['w1', 'w2'])).toBe(list);
  });
});
