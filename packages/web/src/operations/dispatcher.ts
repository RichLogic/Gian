/**
 * UI Operation Layer — dispatcher (Phase 1).
 *
 * `dispatch(name, input)` is the single entry point for user-triggered side
 * effects (proposal §2): it enters exactly one policy during the same
 * JavaScript task — optimistic overlays / pending state are committed to the
 * store synchronously, before any network or Host work completes.
 *
 * Transport-agnostic run lifecycle:
 * - WS executor (definition declares `buildMessage`): mints `request_id`
 *   (crypto.randomUUID), sends the message through the socket, and settles
 *   the run from the correlated `operation:result` (proposal §4.4).
 * - REST executor (definition declares `execute`): the returned promise
 *   settles the run — resolve → confirmed, reject → failed.
 * - `timeoutMs` per definition: expiry transitions the run to `timed-out`
 *   (unknown outcome — never confirmed, never rolled back, §4.3) and fires
 *   the `onUnresolved` hook so the app can reload the entity's canonical
 *   state and reconcile the run's unresolved overlays (Phase 3a).
 * - Socket close: every in-flight run transitions to `timed-out` — a result
 *   is delivered only on the socket that received the request, so a
 *   reconnect means every old-socket run has an unknown outcome — and fires
 *   `onUnresolved` per affected entity.
 *
 * Duplicate pending destructive guard (proposal §4.3 "disable duplicate
 * pending destructive commands"): dispatching a `pending`-policy operation
 * for an entityKey that already has an in-flight run of the SAME operation
 * is IGNORED — the existing run is returned, no new run is created and no
 * transport is sent. Optimistic operations are not guarded (repeated writes
 * supersede in place per §4.3).
 *
 * Dev instrumentation: `performance.mark`/`measure` around
 * dispatch-to-first-store-commit, guarded by `import.meta.env.DEV`. The p95
 * < 50 ms target is a measured goal reported from development builds, not a
 * CI gate (proposal §2/§8).
 */
import type { ClientToServerMessage, ServerToClientMessage } from '@gian/shared';

import { registry as defaultRegistry, type OperationRegistry } from './registry.js';
import { createOperationStore, type OperationStore } from './store.js';
import type {
  OperationContext,
  OperationError,
  OperationName,
  OperationRun,
} from './types.js';

/**
 * Minimal socket surface the dispatcher needs — structurally satisfied by
 * `GianWs` (`packages/web/src/ws.ts`), so tests can substitute a fake
 * transport without constructing a real WebSocket.
 */
export interface OperationTransport {
  send(msg: ClientToServerMessage): void;
  onMessage(listener: (msg: ServerToClientMessage) => void): () => void;
  onState(listener: (state: 'connecting' | 'open' | 'closed', attempt: number) => void): () => void;
}

export interface OperationDispatcherDeps {
  store?: OperationStore;
  registry?: OperationRegistry;
  /** WS transport; required only when dispatching WS-backed operations. */
  transport?: OperationTransport;
  /** Reads the current canonical value of one entity field; used to record
   *  overlay `previous` for rollback. Return `undefined` when unknown. */
  readCanonicalField?: (entityKey: string, field: string) => unknown;
  /** Fired once per run when its outcome becomes UNKNOWN (timeout expiry or
   *  socket close, proposal §4.3). The app wires this to a targeted canonical
   *  reload of the affected entity followed by `store.reconcileUnresolved` —
   *  the unresolved-reload path (Phase 3a). */
  onUnresolved?: (entityKey: string) => void;
  /** Timer injection for tests. */
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
}

export interface OperationDispatcher {
  dispatch<Input>(name: OperationName, input: Input): OperationRun;
  readonly store: OperationStore;
  /** Remove transport subscriptions (tests, teardown). */
  dispose(): void;
}

export function createOperationDispatcher(deps: OperationDispatcherDeps = {}): OperationDispatcher {
  const store = deps.store ?? createOperationStore();
  const registry = deps.registry ?? defaultRegistry;
  const setTimer = deps.setTimeout ?? setTimeout;
  const clearTimer = deps.clearTimeout ?? clearTimeout;

  /** request_id → in-flight WS run. */
  const wsRuns = new Map<string, string>();
  /** run id → timeout handle. */
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** run id → per-dispatch context handed to reconcile/rollback. */
  const contexts = new Map<string, OperationContext>();
  const disposers: Array<() => void> = [];

  if (deps.transport) {
    // One subscription for the dispatcher's lifetime; results are correlated
    // to runs by request_id (proposal §4.4).
    disposers.push(
      deps.transport.onMessage(msg => {
        if (msg.type !== 'operation:result') return;
        const runId = wsRuns.get(msg.request_id);
        if (!runId) return; // late result for a timed-out run — outcome already unknown
        wsRuns.delete(msg.request_id);
        settle(runId, msg.ok, msg.error);
      }),
    );
    disposers.push(
      deps.transport.onState(state => {
        // A result is delivered only on the socket that received the
        // request: on close, every in-flight run's outcome is unknown.
        if (state !== 'closed') return;
        for (const entityKey of store.markAllInFlightTimedOut()) {
          deps.onUnresolved?.(entityKey);
        }
      }),
    );
  }

  function clearTimerFor(runId: string): void {
    const timer = timers.get(runId);
    if (timer !== undefined) {
      clearTimer(timer);
      timers.delete(runId);
    }
  }

  function settle(runId: string, ok: boolean, error?: OperationError, result?: unknown): void {
    clearTimerFor(runId);
    const context = contexts.get(runId);
    contexts.delete(runId);
    // applyResult returns false when the run already settled (e.g. a late
    // result after timeout) — the escape hatches must not fire then either.
    if (!store.applyResult(runId, ok, error?.message, result)) return;
    const run = store.getRun(runId);
    if (!run || !context) return;
    const definition = registry.get(run.name);
    if (ok) {
      definition.reconcile?.(result, context);
    } else {
      definition.rollback?.(error ?? { code: 'UNKNOWN', message: 'operation failed' }, context);
    }
  }

  return {
    store,

    dispatch(name, input) {
      const definition = registry.get(name);
      const entityKey = definition.entityKey(input);

      // Duplicate pending destructive guard (proposal §4.3): a second
      // submission of the same pending operation for the same entity while
      // one is in flight is ignored — the in-flight run is returned.
      if (definition.policy === 'pending' && store.hasInFlightRun(name, entityKey)) {
        const existing = store.getPendingRuns(entityKey).find(r => r.name === name);
        if (existing) return existing;
      }

      const dev = Boolean(import.meta.env?.DEV);
      const run = store.startRun({ name, entityKey, policy: definition.policy });
      if (dev) performance.mark(`gian:op:${run.id}:dispatch`);

      const context: OperationContext = { runId: run.id, requestId: run.id };
      contexts.set(run.id, context);

      if (definition.policy === 'optimistic') {
        const writes = (definition.optimisticWrites?.(input) ?? []).map(write => ({
          field: write.field,
          value: write.value,
          previous: deps.readCanonicalField?.(entityKey, write.field),
        }));
        store.writeOverlays(run.id, writes);
      }
      if (dev) {
        performance.mark(`gian:op:${run.id}:first-commit`);
        performance.measure(
          `gian:op:${run.id}:dispatch-to-first-commit`,
          `gian:op:${run.id}:dispatch`,
          `gian:op:${run.id}:first-commit`,
        );
      }

      // Unknown-outcome path: timeout is never a failure (proposal §4.3).
      timers.set(
        run.id,
        setTimer(() => {
          timers.delete(run.id);
          contexts.delete(run.id);
          store.markTimedOut(run.id);
          deps.onUnresolved?.(run.entityKey);
        }, definition.timeoutMs),
      );

      if (definition.buildMessage) {
        // WS executor — request_id correlates the operation:result.
        if (!deps.transport) {
          throw new Error(`operation "${name}" is WS-backed but no transport was provided`);
        }
        const requestId = globalThis.crypto?.randomUUID?.() ?? `${run.id}-req`;
        context.requestId = requestId;
        wsRuns.set(requestId, run.id);
        deps.transport.send({ ...definition.buildMessage(input), request_id: requestId });
      } else {
        // REST executor — the HTTP promise already identifies the request.
        definition.execute!(input, context).then(
          result => settle(run.id, true, undefined, result),
          (thrown: unknown) => {
            settle(run.id, false, {
              code: 'EXECUTE_FAILED',
              message: thrown instanceof Error ? thrown.message : String(thrown),
            });
          },
        );
      }

      return run;
    },

    dispose() {
      for (const dispose of disposers) dispose();
      disposers.length = 0;
      for (const timer of timers.values()) clearTimer(timer);
      timers.clear();
      wsRuns.clear();
      contexts.clear();
    },
  };
}
