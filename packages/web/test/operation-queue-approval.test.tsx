/**
 * Phase 2b Queue/Approval operations on the real product definitions
 * (`src/operations/queue.ts`, `src/operations/approval.ts`), proving the
 * proposal §8 contract: synchronous whole-array overlay feedback, rollback
 * on failure, absorption on the canonical queue:updated + operation:result
 * pair (§4.4 ordering), the sendNow duplicate guard, and the approval card's
 * immediate disabled+resolving state with re-enable on failure.
 */
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import type { ClientToServerMessage, ServerToClientMessage } from '@gian/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '../src/i18n/index.js';
import { createOperationDispatcher, type OperationTransport } from '../src/operations/dispatcher.js';
// Side effects: register the product Queue/Approval definitions used below.
import { QUEUE_OVERLAY_FIELD, wireCanonicalQueueReader } from '../src/operations/queue.js';
import '../src/operations/approval.js';
import { sessionEntityKey } from '../src/operations/session.js';
import { createOperationStore, entityFieldKey } from '../src/operations/store.js';
import {
  OperationDispatcherProvider,
  OperationStoreProvider,
  useQueueWithOverlays,
} from '../src/operations/use-operations.js';
import { ApprovalCard } from '../src/transcript/approval-cards.js';
import type { ApprovalItem, QueueEntry } from '../src/types.js';

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
    this.emit({ type: 'operation:result', request_id: requestId, request_type: 'queue:add', ok, error });
  }
}

function requestIdOf(msg: ClientToServerMessage | undefined): string {
  const id = (msg as { request_id?: string } | undefined)?.request_id;
  expect(id).toBeTruthy();
  return id!;
}

function queueEntry(id: string, text: string): QueueEntry {
  return { id, text };
}

/** Canonical queues live OUTSIDE the operation layer; the mutable map stands
 *  in for the Host-owned `queueBySession` state the broadcasts update. The
 *  injected canonical reader mirrors App's wiring exactly: rendered queue =
 *  canonical + any in-flight queue overlay, so rapid edits compose. */
function setup(canonicalQueues: Record<string, QueueEntry[]> = { s1: [] }) {
  const store = createOperationStore();
  const transport = new FakeTransport();
  const dispatcher = createOperationDispatcher({
    store,
    transport,
    readCanonicalField: (entityKey, field) => {
      if (!entityKey.startsWith('session:')) return undefined;
      if (field === QUEUE_OVERLAY_FIELD) {
        return canonicalQueues[entityKey.slice('session:'.length)] ?? [];
      }
      return undefined;
    },
  });
  wireCanonicalQueueReader(sessionId => {
    const overlay = store.getOverlay(entityFieldKey(sessionEntityKey(sessionId), QUEUE_OVERLAY_FIELD));
    return overlay ? (overlay.value as QueueEntry[]) : (canonicalQueues[sessionId] ?? []);
  });
  return { store, transport, dispatcher, canonical: canonicalQueues };
}

const queueOverlayKey = entityFieldKey('session:s1', QUEUE_OVERLAY_FIELD);

function wrapperFor(store: ReturnType<typeof createOperationStore>, dispatcher: ReturnType<typeof createOperationDispatcher>) {
  return ({ children }: { children: ReactNode }) => (
    <LocaleProvider locale="en">
      <OperationStoreProvider store={store}>
        <OperationDispatcherProvider dispatcher={dispatcher}>
          {children}
        </OperationDispatcherProvider>
      </OperationStoreProvider>
    </LocaleProvider>
  );
}

describe('queue operations (proposal §8, product definitions)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    wireCanonicalQueueReader(null);
    vi.useRealTimers();
  });

  it('queue.add commits the whole-array overlay synchronously, before the result', () => {
    const { store, transport, dispatcher } = setup();

    const run = dispatcher.dispatch('queue.add', { sessionId: 's1', text: 'follow up' });

    expect(run.phase).toBe('optimistic');
    const overlay = store.getOverlay(queueOverlayKey);
    expect(overlay?.value).toHaveLength(1);
    expect((overlay?.value as QueueEntry[])[0]).toMatchObject({ text: 'follow up' });
    expect((overlay?.value as QueueEntry[])[0]!.id.startsWith('optimistic:queue:')).toBe(true);
    expect(transport.sent[0]).toMatchObject({ type: 'queue:add', session_id: 's1', text: 'follow up' });
  });

  it('two rapid adds compose — the second overlay builds on the first', () => {
    const { store, dispatcher } = setup();

    dispatcher.dispatch('queue.add', { sessionId: 's1', text: 'first' });
    dispatcher.dispatch('queue.add', { sessionId: 's1', text: 'second' });

    const value = store.getOverlay(queueOverlayKey)?.value as QueueEntry[];
    expect(value.map(entry => entry.text)).toEqual(['first', 'second']);
  });

  it('update/remove/clear reflect immediately as whole-array overlays', () => {
    const { store, dispatcher } = setup({
      s1: [queueEntry('q1', 'alpha'), queueEntry('q2', 'beta')],
    });

    dispatcher.dispatch('queue.update', { sessionId: 's1', queueId: 'q1', text: 'alpha edited' });
    expect((store.getOverlay(queueOverlayKey)?.value as QueueEntry[]).map(e => e.text))
      .toEqual(['alpha edited', 'beta']);

    dispatcher.dispatch('queue.remove', { sessionId: 's1', queueId: 'q2' });
    expect((store.getOverlay(queueOverlayKey)?.value as QueueEntry[]).map(e => e.id)).toEqual(['q1']);

    dispatcher.dispatch('queue.clear', { sessionId: 's1' });
    expect(store.getOverlay(queueOverlayKey)?.value).toEqual([]);
  });

  it('failure rolls back to the canonical array and records the error', () => {
    const { store, transport, dispatcher, canonical } = setup({ s1: [queueEntry('q1', 'alpha')] });
    const run = dispatcher.dispatch('queue.remove', { sessionId: 's1', queueId: 'q1' });
    expect(store.getOverlay(queueOverlayKey)?.value).toEqual([]);

    transport.emitResult(requestIdOf(transport.sent[0]), false, { code: 'QUEUE_REMOVE_FAILED', message: 'no such entry' });

    expect(store.getRun(run.id)?.phase).toBe('failed');
    expect(store.getRun(run.id)?.error).toBe('no such entry');
    // Overlay gone — rendering falls back to the untouched canonical array.
    expect(store.getEntityOverlays('session:s1')).toHaveLength(0);
    expect(canonical.s1).toEqual([queueEntry('q1', 'alpha')]);
  });

  it('canonical queue:updated + operation:result absorbs the overlay (§4.4 ordering)', () => {
    const { store, transport, dispatcher, canonical } = setup({ s1: [] });
    dispatcher.dispatch('queue.add', { sessionId: 's1', text: 'follow up' });
    expect(store.getOverlay(queueOverlayKey)).toBeDefined();

    // Host ordering contract: the queue:updated broadcast lands first and
    // updates canonical state, THEN the result arrives and absorbs.
    canonical.s1 = [queueEntry('q-real', 'follow up')];
    transport.emitResult(requestIdOf(transport.sent[0]), true);

    expect(store.getEntityOverlays('session:s1')).toHaveLength(0);
    expect(canonical.s1).toEqual([queueEntry('q-real', 'follow up')]);
  });

  it('queue.sendNow is pending and blocks duplicate submission (⌘Enter included)', () => {
    const { store, transport, dispatcher } = setup({ s1: [queueEntry('q1', 'alpha')] });

    const run = dispatcher.dispatch('queue.sendNow', { sessionId: 's1' });
    expect(run.phase).toBe('pending');
    expect(dispatcher.dispatch('queue.sendNow', { sessionId: 's1' }).id).toBe(run.id);
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]).toMatchObject({ type: 'queue:send_now', session_id: 's1' });

    // After the result lands, the guard releases and a retry sends again.
    transport.emitResult(requestIdOf(transport.sent[0]), true);
    dispatcher.dispatch('queue.sendNow', { sessionId: 's1' });
    expect(transport.sent).toHaveLength(2);
  });

  it('queue overlay rendering merges canonical + overlay, then settles on the result', () => {
    const { store, transport, dispatcher, canonical } = setup({ s1: [] });
    const { result } = renderHook(() => {
      const [canonicalQueue] = useState<QueueEntry[]>([]);
      return useQueueWithOverlays('s1', canonicalQueue);
    }, { wrapper: wrapperFor(store, dispatcher) });

    expect(result.current).toEqual([]);

    act(() => {
      dispatcher.dispatch('queue.add', { sessionId: 's1', text: 'follow up' });
    });
    // Immediate feedback: the overlay wins over the (empty) canonical array.
    expect(result.current.map(entry => entry.text)).toEqual(['follow up']);

    act(() => {
      // queue:updated broadcast first (canonical), then the result.
      canonical.s1 = [queueEntry('q-real', 'follow up')];
      transport.emitResult(requestIdOf(transport.sent[0]), true);
    });
    expect(store.getEntityOverlays('session:s1')).toHaveLength(0);
  });
});

describe('approval.resolve (proposal §8, product definition)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    wireCanonicalQueueReader(null);
    vi.useRealTimers();
  });

  it('runs pending keyed by approval id — different approvals proceed concurrently', () => {
    const { store, transport, dispatcher } = setup();

    const first = dispatcher.dispatch('approval.resolve', { sessionId: 's1', approvalId: 'a1', decision: 'allow_once' });
    const second = dispatcher.dispatch('approval.resolve', { sessionId: 's1', approvalId: 'a2', decision: 'decline' });
    // Same approval twice IS a duplicate submission — blocked.
    const duplicate = dispatcher.dispatch('approval.resolve', { sessionId: 's1', approvalId: 'a1', decision: 'allow_session' });

    expect(first.phase).toBe('pending');
    expect(first.entityKey).toBe('approval:a1');
    expect(second.entityKey).toBe('approval:a2');
    expect(duplicate.id).toBe(first.id);
    expect(transport.sent).toHaveLength(2);
    expect(transport.sent[0]).toMatchObject({
      type: 'approval:resolve', session_id: 's1', approval_id: 'a1', decision: 'allow_once',
    });
    expect(store.getPendingRuns('approval:a1')).toHaveLength(1);
  });

  it('approval card disables and labels resolving immediately; failure re-enables and surfaces the error', () => {
    const { store, transport, dispatcher } = setup();
    const runs: Array<{ id: string }> = [];
    const item: ApprovalItem = {
      kind: 'approval',
      id: 'item-1',
      approvalId: 'a1',
      title: 'Run command',
      reason: 'wants to run a command',
      cmd: 'pnpm test',
      risk: 'medium',
      status: 'pending',
      ts: 1,
      turn: 1,
    };
    render(
      <ApprovalCard
        item={item}
        onApprove={approvalId => {
          runs.push(dispatcher.dispatch('approval.resolve', { sessionId: 's1', approvalId, decision: 'allow_once' }));
        }}
      />,
      { wrapper: wrapperFor(store, dispatcher) },
    );

    const allowButton = screen.getByRole('button', { name: 'Allow once' });
    expect(allowButton).toBeEnabled();

    // Local feedback exists before the transport result resolves.
    fireEvent.click(allowButton);
    expect(allowButton).toBeDisabled();
    expect(screen.getByText('Resolving…')).toBeInTheDocument();
    expect(transport.sent[0]).toMatchObject({ type: 'approval:resolve', approval_id: 'a1' });

    // The canonical settle is the approval:updated broadcast (no transcript
    // routing here); the operation:result then ends the pending phase.
    act(() => {
      transport.emit({ type: 'approval:updated', approval: {
        id: 'a1', status: 'approved', resolved_by: 'web', resolved_at: '2026-08-06T00:00:00Z',
      } });
      transport.emitResult(requestIdOf(transport.sent[0]), true);
    });
    expect(store.getPendingRuns('approval:a1')).toHaveLength(0);

    // A failed resolve re-enables the card and records the error.
    fireEvent.click(screen.getByRole('button', { name: 'Allow once' }));
    expect(screen.getByRole('button', { name: 'Allow once' })).toBeDisabled();
    act(() => {
      transport.emitResult(requestIdOf(transport.sent[1]), false, { code: 'APPROVAL_FAILED', message: 'approval expired' });
    });
    expect(screen.getByRole('button', { name: 'Allow once' })).toBeEnabled();
    expect(screen.queryByText('Resolving…')).toBeNull();
    expect(store.getRun(runs[1]!.id)).toMatchObject({ phase: 'failed', error: 'approval expired' });
    expect(transport.sent).toHaveLength(2);
  });
});
