import { describe, expect, it } from 'vitest';

import { createOperationStore, entityFieldKey, type OperationStore } from '../src/operations/store.js';

/** Start an optimistic run with overlays in one call. */
function startOptimistic(
  store: OperationStore,
  entityKey: string,
  writes: Array<{ field: string; value: unknown; previous: unknown }>,
) {
  const run = store.startRun({ name: 'session.rename', entityKey, policy: 'optimistic' });
  store.writeOverlays(run.id, writes);
  return run;
}

describe('operation store (proposal §4.3)', () => {
  it('supersedes a repeated write to the same entity+field in place (newest wins)', () => {
    const store = createOperationStore();
    const first = startOptimistic(store, 'session:s1', [{ field: 'name', value: 'B', previous: 'A' }]);
    const second = startOptimistic(store, 'session:s1', [{ field: 'name', value: 'C', previous: 'A' }]);

    const key = entityFieldKey('session:s1', 'name');
    expect(store.getOverlay(key)?.value).toBe('C');
    expect(store.getOverlay(key)?.operationId).toBe(second.id);
    expect(store.getOverlay(key)?.previous).toBe('A');
    expect(store.getEntityOverlays('session:s1')).toHaveLength(1);
    expect(first.id).not.toBe(second.id);
  });

  it('lets unrelated fields of one entity mutate concurrently', () => {
    const store = createOperationStore();
    startOptimistic(store, 'session:s1', [{ field: 'name', value: 'B', previous: 'A' }]);
    const second = store.startRun({ name: 'session.setMode', entityKey: 'session:s1', policy: 'optimistic' });
    store.writeOverlays(second.id, [{ field: 'approval_mode', value: 'auto', previous: 'ask' }]);

    const overlays = store.getEntityOverlays('session:s1');
    expect(overlays).toHaveLength(2);
    expect(store.getOverlay(entityFieldKey('session:s1', 'name'))?.value).toBe('B');
    expect(store.getOverlay(entityFieldKey('session:s1', 'approval_mode'))?.value).toBe('auto');
  });

  it('rolls back only the overlays a failed run still owns — never a newer run\'s overlay', () => {
    const store = createOperationStore();
    const older = startOptimistic(store, 'session:s1', [{ field: 'name', value: 'B', previous: 'A' }]);
    const newer = startOptimistic(store, 'session:s1', [{ field: 'name', value: 'C', previous: 'A' }]);

    // Older run fails: the newer overlay on the same field must survive.
    store.applyResult(older.id, false, 'rename rejected');
    expect(store.getRun(older.id)?.phase).toBe('failed');
    expect(store.getRun(older.id)?.error).toBe('rename rejected');
    expect(store.getOverlay(entityFieldKey('session:s1', 'name'))?.value).toBe('C');

    // Newer run fails: it owns the overlay, so it is rolled back — the
    // canonical value beneath (the recorded `previous`) is restored.
    store.applyResult(newer.id, false, 'rename rejected');
    expect(store.getOverlay(entityFieldKey('session:s1', 'name'))).toBeUndefined();
  });

  it('absorbs the run\'s overlays on success (result arrival is sufficient)', () => {
    const store = createOperationStore();
    const run = startOptimistic(store, 'session:s1', [
      { field: 'name', value: 'B', previous: 'A' },
      { field: 'pinned', value: true, previous: false },
    ]);
    store.applyResult(run.id, true);
    expect(store.getRun(run.id)?.phase).toBe('confirmed');
    expect(store.getEntityOverlays('session:s1')).toHaveLength(0);
  });

  it('does not absorb a superseded overlay when an older run confirms', () => {
    const store = createOperationStore();
    const older = startOptimistic(store, 'session:s1', [{ field: 'name', value: 'B', previous: 'A' }]);
    startOptimistic(store, 'session:s1', [{ field: 'name', value: 'C', previous: 'A' }]);
    store.applyResult(older.id, true);
    expect(store.getOverlay(entityFieldKey('session:s1', 'name'))?.value).toBe('C');
  });

  it('defensively absorbs an overlay whose value already equals the canonical field', () => {
    const store = createOperationStore();
    startOptimistic(store, 'session:s1', [
      { field: 'name', value: 'B', previous: 'A' },
      { field: 'pinned', value: true, previous: false },
    ]);
    // Canonical broadcast arrives with name already applied but pinned stale.
    const absorbed = store.absorbMatchingOverlays('session:s1', { name: 'B', pinned: false });
    expect(absorbed.map(o => o.entityFieldKey)).toEqual([entityFieldKey('session:s1', 'name')]);
    expect(store.getOverlay(entityFieldKey('session:s1', 'name'))).toBeUndefined();
    expect(store.getOverlay(entityFieldKey('session:s1', 'pinned'))?.value).toBe(true);
  });

  it('timeout never rolls back: run is timed-out and overlays become unresolved', () => {
    const store = createOperationStore();
    const run = startOptimistic(store, 'session:s1', [{ field: 'name', value: 'B', previous: 'A' }]);
    store.markTimedOut(run.id);

    expect(store.getRun(run.id)?.phase).toBe('timed-out');
    const overlay = store.getOverlay(entityFieldKey('session:s1', 'name'));
    expect(overlay?.value).toBe('B'); // NOT rolled back
    expect(overlay?.unresolved).toBe(true);
  });

  it('reconcile-on-reload absorbs fields matching the canonical reload', () => {
    const store = createOperationStore();
    const run = startOptimistic(store, 'session:s1', [{ field: 'name', value: 'B', previous: 'A' }]);
    store.markTimedOut(run.id);

    const report = store.reconcileUnresolved('session:s1', { name: 'B' });
    expect(report.absorbed.map(o => o.entityFieldKey)).toEqual([entityFieldKey('session:s1', 'name')]);
    expect(report.dropped).toHaveLength(0);
    expect(store.getEntityOverlays('session:s1')).toHaveLength(0);
  });

  it('reconcile-on-reload drops mismatched fields and reports them', () => {
    const store = createOperationStore();
    const run = startOptimistic(store, 'session:s1', [{ field: 'name', value: 'B', previous: 'A' }]);
    store.markTimedOut(run.id);

    // Canonical reload says the change was never applied.
    const report = store.reconcileUnresolved('session:s1', { name: 'A' });
    expect(report.absorbed).toHaveLength(0);
    expect(report.dropped).toHaveLength(1);
    expect(report.dropped[0]?.overlay.value).toBe('B');
    expect(report.dropped[0]?.canonical).toBe('A');
    expect(store.getEntityOverlays('session:s1')).toHaveLength(0);
  });

  it('reconcile accepts a field provider as well as a record', () => {
    const store = createOperationStore();
    const run = startOptimistic(store, 'session:s1', [{ field: 'name', value: 'B', previous: 'A' }]);
    store.markTimedOut(run.id);
    const report = store.reconcileUnresolved('session:s1', field => (field === 'name' ? 'B' : undefined));
    expect(report.absorbed).toHaveLength(1);
  });

  it('disconnect transitions every in-flight run to timed-out without rollback', () => {
    const store = createOperationStore();
    const optimistic = startOptimistic(store, 'session:s1', [{ field: 'name', value: 'B', previous: 'A' }]);
    const pending = store.startRun({ name: 'session.stop', entityKey: 'session:s2', policy: 'pending' });
    const settled = startOptimistic(store, 'session:s3', [{ field: 'name', value: 'X', previous: 'W' }]);
    store.applyResult(settled.id, true);

    store.markAllInFlightTimedOut();

    expect(store.getRun(optimistic.id)?.phase).toBe('timed-out');
    expect(store.getRun(pending.id)?.phase).toBe('timed-out');
    expect(store.getRun(settled.id)?.phase).toBe('confirmed');
    expect(store.getOverlay(entityFieldKey('session:s1', 'name'))?.unresolved).toBe(true);
    expect(store.getPendingRuns()).toHaveLength(0);
  });

  it('a settled run ignores late results and duplicate timeouts', () => {
    const store = createOperationStore();
    const run = startOptimistic(store, 'session:s1', [{ field: 'name', value: 'B', previous: 'A' }]);
    expect(store.applyResult(run.id, true)).toBe(true);
    expect(store.applyResult(run.id, false, 'late')).toBe(false);
    store.markTimedOut(run.id);
    expect(store.getRun(run.id)?.phase).toBe('confirmed');
  });

  it('tracks in-flight runs per name + entity for the duplicate pending guard', () => {
    const store = createOperationStore();
    const run = store.startRun({ name: 'session.stop', entityKey: 'session:s1', policy: 'pending' });
    expect(store.hasInFlightRun('session.stop', 'session:s1')).toBe(true);
    expect(store.hasInFlightRun('session.stop', 'session:s2')).toBe(false);
    expect(store.hasInFlightRun('session.delete', 'session:s1')).toBe(false);
    store.applyResult(run.id, true);
    expect(store.hasInFlightRun('session.stop', 'session:s1')).toBe(false);
  });

  it('keeps snapshots referentially stable and notifies subscribers on change', () => {
    const store = createOperationStore();
    let notifications = 0;
    const unsubscribe = store.subscribe(() => notifications++);

    const before = store.getEntityOverlays('session:s1');
    expect(store.getEntityOverlays('session:s1')).toBe(before);

    const run = startOptimistic(store, 'session:s1', [{ field: 'name', value: 'B', previous: 'A' }]);
    const after = store.getEntityOverlays('session:s1');
    expect(after).not.toBe(before);
    expect(store.getEntityOverlays('session:s1')).toBe(after);
    // A write to an unrelated entity must not change this entity's snapshot.
    startOptimistic(store, 'session:other', [{ field: 'name', value: 'Z', previous: 'Y' }]);
    expect(store.getEntityOverlays('session:s1')).toBe(after);

    const pending = store.getPendingRuns('session:s1');
    expect(store.getPendingRuns('session:s1')).toBe(pending);
    store.applyResult(run.id, true);
    expect(store.getPendingRuns('session:s1')).not.toBe(pending);

    expect(notifications).toBeGreaterThan(0);
    unsubscribe();
    const seen = notifications;
    startOptimistic(store, 'session:s4', [{ field: 'name', value: 'Q', previous: 'P' }]);
    expect(notifications).toBe(seen);
  });
});
