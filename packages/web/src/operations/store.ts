/**
 * UI Operation Layer — operation store + overlay reducer (Phase 1).
 * Implements proposal §4.3 (`docs/proposals/ui-operation-layer.md`) exactly:
 *
 * - Runs are keyed by run id with phases
 *   `optimistic | pending | confirmed | failed | timed-out`.
 * - Overlays are keyed by entity + field (`session:<id>:name`); each carries
 *   the owning `operationId`, the optimistic `value`, the recorded
 *   `previous` canonical value, and an `unresolved` flag.
 * - A repeated write to the same entity + field supersedes the previous
 *   overlay in place (newest wins); unrelated fields proceed concurrently.
 * - Success absorbs: the run's overlays are removed (Host guarantees the
 *   canonical broadcast precedes `operation:result`, §4.4, so result arrival
 *   is sufficient). Removal touches only overlays the run still owns.
 * - Failure rolls back ONLY overlays whose `operationId` still equals this
 *   run. Rollback removes the overlay, so the canonical value beneath — the
 *   recorded `previous` in the normal case — is restored. A newer run's
 *   overlay on the same field is never touched.
 * - Timeout/disconnect means the outcome is UNKNOWN, never failure: the run
 *   transitions to `timed-out`, its overlays are marked `unresolved`, and
 *   nothing is rolled back. `reconcileUnresolved` reconciles them against a
 *   targeted canonical reload: matching fields absorb, mismatches are
 *   dropped and reported so the UI can surface "change may not have been
 *   applied".
 * - `absorbMatchingOverlays` is the defensive path: when a canonical change
 *   already equals an overlay's value, the overlay is dropped immediately.
 *
 * The store never holds canonical entity state; rendering is always
 * `canonical + overlays` with the overlay winning.
 *
 * Snapshots handed to React (`getEntityOverlays`, `getOverlay`,
 * `getPendingRuns`) are referentially stable while nothing relevant changed,
 * so they can back `useSyncExternalStore` directly (see use-operations.ts).
 */
import type {
  FieldWrite,
  OperationName,
  OperationPolicy,
  OperationRun,
  OptimisticOverlay,
} from './types.js';

/** Canonical value lookup for one entity field, e.g. `field => session[field]`. */
export type CanonicalValueProvider = (field: string) => unknown;

export interface RecordedFieldWrite extends FieldWrite {
  /** Prior canonical value, read by the dispatcher at write time. */
  previous: unknown;
}

export interface ReconcileReport {
  /** Unresolved overlays whose value matched the canonical reload (absorbed). */
  absorbed: OptimisticOverlay[];
  /** Unresolved overlays whose value did NOT match; dropped and reported so
   *  the UI can surface a "change may not have been applied" notice. */
  dropped: Array<{ overlay: OptimisticOverlay; canonical: unknown }>;
}

export interface OperationStore {
  /** Create a run in its initial phase (`optimistic` or `pending`). */
  startRun(input: {
    id?: string;
    name: OperationName;
    entityKey: string;
    policy: OperationPolicy;
  }): OperationRun;
  /** Apply a run's optimistic writes as overlays, superseding same-field
   *  overlays in place. */
  writeOverlays(runId: string, writes: RecordedFieldWrite[]): void;
  /** Settle a run. `ok: true` absorbs the run's overlays; `ok: false` rolls
   *  back only the overlays it still owns and records the error. `result`
   *  (REST executor value) is recorded on the run on success so views can
   *  consume it. Returns true when this call actually settled the run (false
   *  for already-settled runs, e.g. a late result after timeout). */
  applyResult(runId: string, ok: boolean, error?: string, result?: unknown): boolean;
  /** Timeout/disconnect path: phase `timed-out`, overlays marked
   *  `unresolved`, NEVER rolled back. No-op for settled runs. */
  markTimedOut(runId: string): void;
  /** Socket-close path: every in-flight run transitions to `timed-out`.
   *  Returns the entity keys of the runs it transitioned (the dispatcher
   *  fires `onUnresolved` for each). */
  markAllInFlightTimedOut(): string[];
  /** Reconcile this entity's unresolved overlays against a canonical reload
   *  that is causally after the command: matches absorb, mismatches are
   *  dropped and reported. */
  reconcileUnresolved(
    entityKey: string,
    canonical: CanonicalValueProvider | Record<string, unknown>,
  ): ReconcileReport;
  /** Defensive absorption: drop this entity's overlays whose value already
   *  equals the canonical field. Returns the absorbed overlays. */
  absorbMatchingOverlays(
    entityKey: string,
    canonical: CanonicalValueProvider | Record<string, unknown>,
  ): OptimisticOverlay[];
  /** True while a run with this name + entityKey is in flight (optimistic or
   *  pending) — the duplicate pending destructive guard. */
  hasInFlightRun(name: OperationName, entityKey: string): boolean;

  getRun(runId: string): OperationRun | undefined;
  /** All overlays for one entity; stable reference until they change. */
  getEntityOverlays(entityKey: string): readonly OptimisticOverlay[];
  /** The single overlay for one entity + field, if any. */
  getOverlay(entityFieldKey: string): OptimisticOverlay | undefined;
  /** In-flight runs, optionally scoped to one entity; stable reference until
   *  the relevant set changes. */
  getPendingRuns(entityKey?: string): readonly OperationRun[];

  /** useSyncExternalStore-compatible subscription. */
  subscribe(listener: () => void): () => void;
}

/** Overlay key for one entity field: `session:<id>` + `name` → `session:<id>:name`. */
export function entityFieldKey(entityKey: string, field: string): string {
  return `${entityKey}:${field}`;
}

function toProvider(canonical: CanonicalValueProvider | Record<string, unknown>): CanonicalValueProvider {
  return typeof canonical === 'function' ? canonical : field => canonical[field];
}

function newRunId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `run-${Math.random().toString(36).slice(2)}`;
}

export function createOperationStore(now: () => number = () => Date.now()): OperationStore {
  interface RunEntry {
    run: OperationRun;
    /** entityFieldKeys this run wrote, in write order. */
    overlayKeys: string[];
  }

  const runs = new Map<string, RunEntry>();
  const overlays = new Map<string, OptimisticOverlay>();
  const listeners = new Set<() => void>();

  // Snapshot caches — invalidated per entity so unrelated snapshots keep
  // their identity (useSyncExternalStore stability).
  const entityOverlayCache = new Map<string, readonly OptimisticOverlay[]>();
  const pendingRunCache = new Map<string, readonly OperationRun[]>();
  const ALL_ENTITIES = '*';

  function notify(): void {
    for (const fn of listeners) fn();
  }

  function entityOf(entityKeyOfField: string): string {
    // entityFieldKey = `${entityKey}:${field}`; entity keys never contain
    // ':' except as the kind separator... entity keys DO contain ':' (e.g.
    // "session:<id>"), so strip only the trailing ":<field>".
    return entityKeyOfField.slice(0, entityKeyOfField.lastIndexOf(':'));
  }

  function invalidateEntity(entityKey: string): void {
    entityOverlayCache.delete(entityKey);
  }

  function invalidateRuns(): void {
    pendingRunCache.clear();
  }

  function setRun(entry: RunEntry, run: OperationRun): void {
    entry.run = run;
    invalidateRuns();
  }

  function isInFlight(run: OperationRun): boolean {
    return run.phase === 'optimistic' || run.phase === 'pending';
  }

  function removeOverlayIfOwned(key: string, runId: string): boolean {
    const overlay = overlays.get(key);
    if (!overlay || overlay.operationId !== runId) return false;
    overlays.delete(key);
    invalidateEntity(entityOf(key));
    return true;
  }

  function markTimedOutImpl(runId: string): void {
    const entry = runs.get(runId);
    if (!entry || !isInFlight(entry.run)) return;
    setRun(entry, { ...entry.run, phase: 'timed-out' });
    // Unknown outcome — mark, never roll back (the command may already
    // have been applied by Host).
    const touched = new Set<string>();
    for (const key of entry.overlayKeys) {
      const overlay = overlays.get(key);
      if (!overlay || overlay.operationId !== runId) continue;
      overlays.set(key, { ...overlay, unresolved: true });
      touched.add(entityOf(key));
    }
    for (const entityKey of touched) invalidateEntity(entityKey);
    notify();
  }

  return {
    startRun({ id, name, entityKey, policy }) {
      const run: OperationRun = {
        id: id ?? newRunId(),
        name,
        entityKey,
        phase: policy === 'optimistic' ? 'optimistic' : 'pending',
        startedAt: now(),
      };
      runs.set(run.id, { run, overlayKeys: [] });
      invalidateRuns();
      notify();
      return run;
    },

    writeOverlays(runId, writes) {
      const entry = runs.get(runId);
      if (!entry || !isInFlight(entry.run)) return;
      const touched = new Set<string>();
      for (const write of writes) {
        const key = entityFieldKey(entry.run.entityKey, write.field);
        // Newest wins: a repeated write to the same entity+field supersedes
        // the previous overlay in place; `previous` is always the canonical
        // value recorded at write time, never the superseded overlay.
        overlays.set(key, {
          entityFieldKey: key,
          operationId: runId,
          value: write.value,
          previous: write.previous,
        });
        if (!entry.overlayKeys.includes(key)) entry.overlayKeys.push(key);
        touched.add(entityOf(key));
      }
      for (const entityKey of touched) invalidateEntity(entityKey);
      notify();
    },

    applyResult(runId, ok, error, result) {
      const entry = runs.get(runId);
      if (!entry || !isInFlight(entry.run)) return false;
      setRun(entry, ok
        ? { ...entry.run, phase: 'confirmed', ...(result !== undefined ? { result } : {}) }
        : { ...entry.run, phase: 'failed', error });
      // Ownership check on every key: a newer run's overlay on the same
      // field is never removed or rolled back by this run's result.
      for (const key of entry.overlayKeys) removeOverlayIfOwned(key, runId);
      notify();
      return true;
    },

    markTimedOut: markTimedOutImpl,

    markAllInFlightTimedOut() {
      const timedOut: string[] = [];
      for (const entry of runs.values()) {
        if (!isInFlight(entry.run)) continue;
        timedOut.push(entry.run.entityKey);
        markTimedOutImpl(entry.run.id);
      }
      return timedOut;
    },

    reconcileUnresolved(entityKey, canonical) {
      const provider = toProvider(canonical);
      const report: ReconcileReport = { absorbed: [], dropped: [] };
      let touched = false;
      for (const [key, overlay] of [...overlays]) {
        if (entityOf(key) !== entityKey || !overlay.unresolved) continue;
        const field = overlay.entityFieldKey.slice(entityKey.length + 1);
        const value = provider(field);
        overlays.delete(key);
        touched = true;
        if (Object.is(value, overlay.value)) {
          report.absorbed.push(overlay);
        } else {
          report.dropped.push({ overlay, canonical: value });
        }
      }
      if (touched) {
        invalidateEntity(entityKey);
        notify();
      }
      return report;
    },

    absorbMatchingOverlays(entityKey, canonical) {
      const provider = toProvider(canonical);
      const absorbed: OptimisticOverlay[] = [];
      let touched = false;
      for (const [key, overlay] of [...overlays]) {
        if (entityOf(key) !== entityKey) continue;
        const field = overlay.entityFieldKey.slice(entityKey.length + 1);
        if (!Object.is(provider(field), overlay.value)) continue;
        overlays.delete(key);
        absorbed.push(overlay);
        touched = true;
      }
      if (touched) {
        invalidateEntity(entityKey);
        notify();
      }
      return absorbed;
    },

    hasInFlightRun(name, entityKey) {
      for (const entry of runs.values()) {
        if (entry.run.name === name && entry.run.entityKey === entityKey && isInFlight(entry.run)) {
          return true;
        }
      }
      return false;
    },

    getRun(runId) {
      return runs.get(runId)?.run;
    },

    getEntityOverlays(entityKey) {
      let snapshot = entityOverlayCache.get(entityKey);
      if (!snapshot) {
        const prefix = `${entityKey}:`;
        const list: OptimisticOverlay[] = [];
        for (const [key, overlay] of overlays) {
          if (key.startsWith(prefix)) list.push(overlay);
        }
        snapshot = Object.freeze(list);
        entityOverlayCache.set(entityKey, snapshot);
      }
      return snapshot;
    },

    getOverlay(key) {
      return overlays.get(key);
    },

    getPendingRuns(entityKey) {
      const cacheKey = entityKey ?? ALL_ENTITIES;
      let snapshot = pendingRunCache.get(cacheKey);
      if (!snapshot) {
        const list: OperationRun[] = [];
        for (const entry of runs.values()) {
          if (!isInFlight(entry.run)) continue;
          if (entityKey !== undefined && entry.run.entityKey !== entityKey) continue;
          list.push(entry.run);
        }
        snapshot = Object.freeze(list);
        pendingRunCache.set(cacheKey, snapshot);
      }
      return snapshot;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
