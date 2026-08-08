/**
 * UI Operation Layer — React hooks over the operation store (Phase 1).
 *
 * All hooks read the store through `useSyncExternalStore`; the store's
 * snapshots (`getEntityOverlays`, `getOverlay`, `getPendingRuns`) are
 * referentially stable while nothing relevant changed, so components do not
 * re-render on unrelated operation activity.
 *
 * Phase 2a wires this into product code: App mounts the providers with the
 * dispatcher bound to the real `GianWs`, controllers dispatch through
 * `useOperationDispatch` (or a dispatcher prop), and session rendering merges
 * `canonical + overlays` via `useSessionsWithOverlays`. Phase 2b adds the
 * queue render merge (`useQueueWithOverlays` — the queue overlay carries the
 * full expected array, see operations/queue.ts), the arbitrary-entity pending
 * hook (`useOperationPending`, e.g. `approval:<id>`), the run lookup
 * (`useOperationRun`, driving the send echo's unknown-outcome state), and
 * the optional-dispatch variant for components that also render standalone
 * in tests. The `useStore*` variants take the store explicitly for
 * components mounted ABOVE the provider (the App root itself). Phase 3a adds
 * the Task and Workspace render merges (`useStoreTasksWithOverlays`,
 * `useStoreWorkspacesWithOverlays` — the workspace merge also applies the
 * whole-list order overlay, see operations/workspace.ts). Phase 3b adds the
 * SystemConfig render merge (`useStoreSettingsWithOverlays`) and
 * `waitForRunSettle` for views that sequence operations promise-style
 * (Settings agent flows, onboarding's save-then-complete chain).
 */
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import type { Session, SystemConfig, Task, Workspace } from '@gian/shared';

import type { OperationDispatcher } from './dispatcher.js';
import { QUEUE_OVERLAY_FIELD } from './queue.js';
import { applySettingsOverlays, SETTINGS_ENTITY_KEY } from './settings.js';
import { entityFieldKey, type OperationStore } from './store.js';
import { applySessionOverlays, sessionEntityKey } from './session.js';
import { applyTaskOverlays, taskEntityKey } from './task.js';
import {
  applyWorkspaceOrderOverlay,
  applyWorkspaceOverlays,
  WORKSPACE_LIST_ENTITY_KEY,
  WORKSPACE_ORDER_FIELD,
  workspaceEntityKey,
} from './workspace.js';
import type { OperationName, OperationRun, OptimisticOverlay } from './types.js';
import type { QueueEntry } from '../types.js';

const OperationStoreContext = createContext<OperationStore | null>(null);
const OperationDispatcherContext = createContext<OperationDispatcher | null>(null);

/** Mount once near the app root with the dispatcher's store. */
export function OperationStoreProvider(props: { store: OperationStore; children: ReactNode }) {
  return createElement(OperationStoreContext.Provider, { value: props.store }, props.children);
}

/** Mount once near the app root with the dispatcher (views dispatch through
 *  `useOperationDispatch`; controllers receive the dispatcher as a prop). */
export function OperationDispatcherProvider(props: { dispatcher: OperationDispatcher; children: ReactNode }) {
  return createElement(OperationDispatcherContext.Provider, { value: props.dispatcher }, props.children);
}

/** The operation store from the nearest `OperationStoreProvider`. */
export function useOperationStore(): OperationStore {
  const store = useContext(OperationStoreContext);
  if (!store) {
    throw new Error('useOperationStore requires an <OperationStoreProvider>');
  }
  return store;
}

/** Store or null — read-only pending hooks tolerate an absent provider
 *  (no store mounted means no operations are in flight by definition). */
function useOperationStoreOptional(): OperationStore | null {
  return useContext(OperationStoreContext);
}

/** Dispatch a registered operation — the single entry point for user-
 *  triggered side effects in views (proposal §2/§4.1). */
export function useOperationDispatch(): OperationDispatcher['dispatch'] {
  const dispatcher = useContext(OperationDispatcherContext);
  if (!dispatcher) {
    throw new Error('useOperationDispatch requires an <OperationDispatcherProvider>');
  }
  return dispatcher.dispatch;
}

/** Dispatch or null — components that render both under the provider
 *  (product) and standalone (tests) degrade gracefully instead of throwing:
 *  operation affordances (echo retry, attachment upload) hide or no-op. */
export function useOperationDispatchOptional(): OperationDispatcher['dispatch'] | null {
  return useContext(OperationDispatcherContext)?.dispatch ?? null;
}

/** All overlays for one entity (`session:<id>`); render `canonical + overlays`. */
export function useEntityOverlays(entityKey: string): readonly OptimisticOverlay[] {
  const store = useOperationStore();
  const getSnapshot = useCallback(() => store.getEntityOverlays(entityKey), [store, entityKey]);
  return useSyncExternalStore(store.subscribe, getSnapshot);
}

/** The single overlay for one entity field, if any — its `value` wins over
 *  the canonical field beneath it. */
export function useOverlayField(entityKey: string, field: string): OptimisticOverlay | undefined {
  const store = useOperationStore();
  const getSnapshot = useCallback(
    () => store.getOverlay(entityFieldKey(entityKey, field)),
    [store, entityKey, field],
  );
  return useSyncExternalStore(store.subscribe, getSnapshot);
}

/** In-flight runs (optimistic or pending), optionally scoped to one entity —
 *  drives pending affordances and the duplicate-submission disabled state. */
export function usePendingOperations(entityKey?: string): readonly OperationRun[] {
  return useStorePendingOperations(useOperationStore(), entityKey);
}

/** Explicit-store variant of `usePendingOperations`, for components mounted
 *  above the provider (the App root derives its create/fork busy flags here). */
export function useStorePendingOperations(
  store: OperationStore,
  entityKey?: string,
): readonly OperationRun[] {
  const getSnapshot = useCallback(() => store.getPendingRuns(entityKey), [store, entityKey]);
  return useSyncExternalStore(store.subscribe, getSnapshot);
}

/** True while an operation with this name is in flight for `session:<id>`
 *  (drives "stopping"/"deleting" affordances). False when no operation
 *  store is mounted — nothing can be in flight then. */
export function useSessionOperationPending(sessionId: string, name: OperationName): boolean {
  return useOperationPending(sessionEntityKey(sessionId), name);
}

/** True while an operation with this name is in flight for an arbitrary
 *  entity key (approval cards key runs by `approval:<id>`). False when no
 *  operation store is mounted. */
export function useOperationPending(entityKey: string, name: OperationName): boolean {
  const store = useOperationStoreOptional();
  const getSnapshot = useCallback(
    () => (store ? store.getPendingRuns(entityKey) : NO_RUNS),
    [store, entityKey],
  );
  const runs = useSyncExternalStore(store?.subscribe ?? NOOP_SUBSCRIBE, getSnapshot);
  return runs.some(run => run.name === name);
}

/** The run with this id, reactive over the store — the send bubble derives
 *  its unknown-outcome state from the run's `timed-out` phase. Undefined
 *  when no store is mounted or the run is unknown. */
export function useOperationRun(runId: string | undefined): OperationRun | undefined {
  const store = useOperationStoreOptional();
  return useStoreOperationRun(store, runId);
}

/** Explicit-store variant for App, which owns the store above its provider. */
export function useStoreOperationRun(
  store: OperationStore | null,
  runId: string | undefined,
): OperationRun | undefined {
  const getSnapshot = useCallback(
    () => (store && runId ? store.getRun(runId) : undefined),
    [store, runId],
  );
  return useSyncExternalStore(store?.subscribe ?? NOOP_SUBSCRIBE, getSnapshot);
}

/**
 * Queue render merge (canonical + overlay, proposal §4.3): the queue overlay
 * carries the FULL expected array (see operations/queue.ts) and wins over
 * the canonical array while a queue operation is in flight. Returns the
 * canonical array untouched when no overlay applies (or no store is
 * mounted), keeping referential identity.
 */
export function useQueueWithOverlays(sessionId: string, canonical: QueueEntry[]): QueueEntry[] {
  const store = useOperationStoreOptional();
  const getSnapshot = useCallback(() => {
    const overlay = store?.getOverlay(entityFieldKey(sessionEntityKey(sessionId), QUEUE_OVERLAY_FIELD));
    return overlay ? (overlay.value as QueueEntry[]) : canonical;
  }, [store, sessionId, canonical]);
  return useSyncExternalStore(store?.subscribe ?? NOOP_SUBSCRIBE, getSnapshot);
}

const NO_RUNS: readonly OperationRun[] = Object.freeze([]) as readonly OperationRun[];
const NOOP_SUBSCRIBE = () => () => {};

// ─── Session rendering merge (canonical + overlays, proposal §4.3) ─────────

/**
 * Explicit-store merge of a canonical session list with its overlays. The
 * snapshot is referentially stable while neither the canonical list nor any
 * involved overlay changes, so it backs `useSyncExternalStore` directly and
 * unchanged sessions keep their object identity.
 */
export function useStoreSessionsWithOverlays(
  store: OperationStore,
  sessions: readonly Session[],
): Session[] {
  const getSnapshot = useCallback(() => {
    const overlayRefs = sessions.map(session => store.getEntityOverlays(sessionEntityKey(session.id)));
    const cached = snapshotCache;
    const clean = cached
      && cached.sessions === sessions
      && cached.overlayRefs.length === overlayRefs.length
      && overlayRefs.every((ref, index) => ref === cached.overlayRefs[index]);
    if (clean) return cached.result;
    const result = sessions.map((session, index) => applySessionOverlays(session, overlayRefs[index]!));
    snapshotCache = { sessions, overlayRefs, result };
    return result;
  }, [store, sessions]);
  return useSyncExternalStore(store.subscribe, getSnapshot);
}

let snapshotCache: {
  sessions: readonly Session[];
  overlayRefs: readonly (readonly OptimisticOverlay[])[];
  result: Session[];
} | null = null;

/** Context-based variant for components under the provider. */
export function useSessionsWithOverlays(sessions: readonly Session[]): Session[] {
  return useStoreSessionsWithOverlays(useOperationStore(), sessions);
}

// ─── Task rendering merge (canonical + overlays, Phase 3a) ─────────────────

/** Explicit-store merge of a canonical task list with its overlays (rename,
 *  done/undone, pin). Same snapshot-stability contract as
 *  `useStoreSessionsWithOverlays`. */
export function useStoreTasksWithOverlays(
  store: OperationStore,
  tasks: readonly Task[],
): Task[] {
  const getSnapshot = useCallback(() => {
    const overlayRefs = tasks.map(task => store.getEntityOverlays(taskEntityKey(task.id)));
    const cached = taskSnapshotCache;
    const clean = cached
      && cached.tasks === tasks
      && cached.overlayRefs.length === overlayRefs.length
      && overlayRefs.every((ref, index) => ref === cached.overlayRefs[index]);
    if (clean) return cached.result;
    const result = tasks.map((task, index) => applyTaskOverlays(task, overlayRefs[index]!));
    taskSnapshotCache = { tasks, overlayRefs, result };
    return result;
  }, [store, tasks]);
  return useSyncExternalStore(store.subscribe, getSnapshot);
}

let taskSnapshotCache: {
  tasks: readonly Task[];
  overlayRefs: readonly (readonly OptimisticOverlay[])[];
  result: Task[];
} | null = null;

/** Context-based variant for components under the provider. */
export function useTasksWithOverlays(tasks: readonly Task[]): Task[] {
  return useStoreTasksWithOverlays(useOperationStore(), tasks);
}

// ─── Workspace rendering merge (canonical + overlays, Phase 3a) ────────────

/** Explicit-store merge of a canonical workspace list with its per-entity
 *  overlays (rename, hide/show, pin) and the whole-list order overlay
 *  (`workspace:list:order`, see operations/workspace.ts). Same snapshot-
 *  stability contract as `useStoreSessionsWithOverlays`. */
export function useStoreWorkspacesWithOverlays(
  store: OperationStore,
  workspaces: readonly Workspace[],
): Workspace[] {
  const getSnapshot = useCallback(() => {
    const overlayRefs = workspaces.map(workspace => store.getEntityOverlays(workspaceEntityKey(workspace.id)));
    const orderRef = store.getOverlay(entityFieldKey(WORKSPACE_LIST_ENTITY_KEY, WORKSPACE_ORDER_FIELD));
    const cached = workspaceSnapshotCache;
    const clean = cached
      && cached.workspaces === workspaces
      && cached.orderRef === orderRef
      && cached.overlayRefs.length === overlayRefs.length
      && overlayRefs.every((ref, index) => ref === cached.overlayRefs[index]);
    if (clean) return cached.result;
    const merged = workspaces.map((workspace, index) => applyWorkspaceOverlays(workspace, overlayRefs[index]!));
    const result = orderRef
      ? applyWorkspaceOrderOverlay(merged, orderRef.value as string[])
      : merged;
    workspaceSnapshotCache = { workspaces, overlayRefs, orderRef, result };
    return result;
  }, [store, workspaces]);
  return useSyncExternalStore(store.subscribe, getSnapshot);
}

let workspaceSnapshotCache: {
  workspaces: readonly Workspace[];
  overlayRefs: readonly (readonly OptimisticOverlay[])[];
  orderRef: OptimisticOverlay | undefined;
  result: Workspace[];
} | null = null;

/** Context-based variant for components under the provider. */
export function useWorkspacesWithOverlays(workspaces: readonly Workspace[]): Workspace[] {
  return useStoreWorkspacesWithOverlays(useOperationStore(), workspaces);
}

// ─── Settings rendering merge (canonical + overlays, Phase 3b) ─────────────

/** Explicit-store merge of the canonical SystemConfig with its overlays
 *  (`settings.save` field writes on `settings:system`). Null-safe: no config
 *  loaded yet renders as-is. Same snapshot-stability contract as
 *  `useStoreSessionsWithOverlays`. */
export function useStoreSettingsWithOverlays(
  store: OperationStore,
  config: SystemConfig | null,
): SystemConfig | null {
  const getSnapshot = useCallback(() => {
    const overlayRef = store.getEntityOverlays(SETTINGS_ENTITY_KEY);
    const cached = settingsSnapshotCache;
    if (cached && cached.config === config && cached.overlayRef === overlayRef) return cached.result;
    const result = applySettingsOverlays(config, overlayRef);
    settingsSnapshotCache = { config, overlayRef, result };
    return result;
  }, [store, config]);
  return useSyncExternalStore(store.subscribe, getSnapshot);
}

let settingsSnapshotCache: {
  config: SystemConfig | null;
  overlayRef: readonly OptimisticOverlay[];
  result: SystemConfig | null;
} | null = null;

/** Context-based variant for components under the provider. */
export function useSettingsWithOverlays(config: SystemConfig | null): SystemConfig | null {
  return useStoreSettingsWithOverlays(useOperationStore(), config);
}

/**
 * Promise-style settle wait (Phase 3b): resolves with the run once it leaves
 * its in-flight phase (`confirmed` / `failed` / `timed-out`). For views that
 * sequence operations (`onboarding.saveProjectRoot` → `onboarding.complete`)
 * or need the settled result/phase in a promise contract (the Settings agent
 * flows' success boolean). UI busy states should derive from
 * `useOperationRun`/`usePendingOperations` instead — this helper is for
 * control flow, not rendering.
 */
export function waitForRunSettle(store: OperationStore, runId: string): Promise<OperationRun> {
  const current = store.getRun(runId);
  if (current && current.phase !== 'pending' && current.phase !== 'optimistic') {
    return Promise.resolve(current);
  }
  return new Promise(resolve => {
    const off = store.subscribe(() => {
      const run = store.getRun(runId);
      if (!run || run.phase === 'pending' || run.phase === 'optimistic') return;
      off();
      resolve(run);
    });
  });
}
