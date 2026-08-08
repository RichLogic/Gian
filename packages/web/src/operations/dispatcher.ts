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
 * - Socket close: every in-flight WS run transitions to `timed-out` — a
 *   result is delivered only on the socket that received the request, so a
 *   reconnect means every old-socket WS run has an unknown outcome — and
 *   fires `onUnresolved` per affected entity. REST runs are independent of
 *   the socket and continue to settle from their HTTP promises.
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
  send(msg: ClientToServerMessage): void | 'sent' | 'queued' | 'dropped';
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
  /**
   * Resources owned by one in-flight run. Keeping timer, context and the
   * optional WS correlation together lets every terminal path release them
   * through the same idempotent function.
   */
  interface ActiveRun {
    context: OperationContext;
    timer?: ReturnType<typeof setTimeout>;
    requestId?: string;
  }
  const activeRuns = new Map<string, ActiveRun>();
  const disposers: Array<() => void> = [];

  type RunOutcome =
    | { type: 'result'; ok: boolean; error?: OperationError; result?: unknown }
    | { type: 'unknown' };

  if (deps.transport) {
    // One subscription for the dispatcher's lifetime; results are correlated
    // to runs by request_id (proposal §4.4).
    disposers.push(
      deps.transport.onMessage(msg => {
        if (msg.type !== 'operation:result') return;
        const runId = wsRuns.get(msg.request_id);
        if (!runId) return; // late result for a timed-out run — outcome already unknown
        finish(runId, { type: 'result', ok: msg.ok, error: msg.error });
      }),
    );
    disposers.push(
      deps.transport.onState(state => {
        // A result is delivered only on the socket that received the
        // request: on close, only runs sent over that socket are unknown.
        if (state !== 'closed') return;
        for (const runId of [...wsRuns.values()]) {
          finish(runId, { type: 'unknown' });
        }
      }),
    );
  }

  /**
   * The sole terminal path for result, timeout and socket close. Taking the
   * active record first makes it idempotent: late results, repeated close
   * events and timer races become no-ops and cannot fire hooks twice.
   */
  function finish(runId: string, outcome: RunOutcome): void {
    const active = activeRuns.get(runId);
    if (!active) return;

    activeRuns.delete(runId);
    if (active.timer !== undefined) clearTimer(active.timer);
    if (active.requestId !== undefined) wsRuns.delete(active.requestId);

    const run = store.getRun(runId);
    if (!run) return;

    if (outcome.type === 'unknown') {
      // Avoid a spurious reload if an external store write won a race before
      // dispatcher cleanup. Normally activeRuns and the store settle together.
      if (run.phase !== 'optimistic' && run.phase !== 'pending') return;
      store.markTimedOut(runId);
      deps.onUnresolved?.(run.entityKey);
      return;
    }

    // applyResult returns false when the store was already settled through an
    // external path; resources are still released, but escape hatches do not
    // fire a second time.
    if (!store.applyResult(runId, outcome.ok, outcome.error?.message, outcome.result)) return;
    const definition = registry.get(run.name);
    if (outcome.ok) {
      definition.reconcile?.(outcome.result, active.context);
    } else {
      definition.rollback?.(
        outcome.error ?? { code: 'UNKNOWN', message: 'operation failed' },
        active.context,
      );
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

      if (definition.buildMessage && !deps.transport) {
        throw new Error(`operation "${name}" is WS-backed but no transport was provided`);
      }

      const dev = Boolean(import.meta.env?.DEV);
      const run = store.startRun({ name, entityKey, policy: definition.policy });
      if (dev) performance.mark(`gian:op:${run.id}:dispatch`);

      const context: OperationContext = { runId: run.id, requestId: run.id, entityKey };
      const active: ActiveRun = { context };
      activeRuns.set(run.id, active);

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
      active.timer = setTimer(() => finish(run.id, { type: 'unknown' }), definition.timeoutMs);

      if (definition.buildMessage) {
        // WS executor — request_id correlates the operation:result.
        const requestId = globalThis.crypto?.randomUUID?.() ?? `${run.id}-req`;
        context.requestId = requestId;
        active.requestId = requestId;
        wsRuns.set(requestId, run.id);
        try {
          const disposition = deps.transport!.send({
            ...definition.buildMessage(input),
            request_id: requestId,
          });
          if (disposition === 'dropped') {
            // GianWs rejects unsafe mutations while it is not authoritative;
            // replaying them could duplicate side effects. Finish in a
            // microtask so domain helpers can first append their synchronous
            // optimistic UI (notably the message echo) and rollback can then
            // converge that exact state instead of racing ahead of it.
            void Promise.resolve().then(() => finish(run.id, {
              type: 'result',
              ok: false,
              error: {
                code: 'TRANSPORT_NOT_READY',
                message: 'Connection is not ready; the operation was not sent.',
              },
            }));
          }
        } catch (thrown) {
          finish(run.id, {
            type: 'result',
            ok: false,
            error: {
              code: 'SEND_FAILED',
              message: thrown instanceof Error ? thrown.message : String(thrown),
            },
          });
          throw thrown;
        }
      } else {
        // REST executor — the HTTP promise already identifies the request.
        let execution: Promise<unknown>;
        try {
          execution = definition.execute!(input, context);
        } catch (thrown) {
          finish(run.id, {
            type: 'result',
            ok: false,
            error: {
              code: 'EXECUTE_FAILED',
              message: thrown instanceof Error ? thrown.message : String(thrown),
            },
          });
          throw thrown;
        }
        execution.then(
          result => finish(run.id, { type: 'result', ok: true, result }),
          (thrown: unknown) => {
            finish(run.id, {
              type: 'result',
              ok: false,
              error: {
                code: 'EXECUTE_FAILED',
                message: thrown instanceof Error ? thrown.message : String(thrown),
              },
            });
          },
        );
      }

      return run;
    },

    dispose() {
      for (const dispose of disposers) dispose();
      disposers.length = 0;
      for (const active of activeRuns.values()) {
        if (active.timer !== undefined) clearTimer(active.timer);
      }
      activeRuns.clear();
      wsRuns.clear();
    },
  };
}
