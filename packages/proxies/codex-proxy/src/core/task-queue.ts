/** Per-process dispatch queue for the codex-proxy CLI spawn loop.
 *
 *  Two traffic classes share one shared-process Host:
 *  - Session-scoped requests (everything except `customization.list` /
 *    `customization.detail`) are STRICTLY serialized: the next task starts
 *    only after the previous one has settled. That is what keeps the
 *    request-scoped notification capture slot from being clobbered by a
 *    concurrent session handler, and what preserves shutdown/sidechat
 *    ordering.
 *  - Customization scans dispatch concurrently and never wait on the session
 *    queue: a slow scan must not block live session traffic and session
 *    traffic must never block a scan.
 *
 *  Every dispatched task is tracked for EOF/shutdown drain. Tasks that reject
 *  (a dispatch or writer exception escaping its own error path) are cleaned
 *  up via `then(success, failure)`: no derived `finally` promise is left
 *  unhandled, the rejecting task is removed from the in-flight set, and the
 *  queue keeps serving subsequent tasks (a rejected task never poisons the
 *  chain).
 */
export interface TaskQueue {
  /** Enqueue a session-scoped task. Starts only after every previously
   *  enqueued session task has settled. */
  enqueueSession(task: () => Promise<void>): void;
  /** Dispatch a pipelined (customization) task immediately. It never waits
   *  on the session queue and never blocks session tasks. */
  enqueuePipelined(task: () => Promise<void>): void;
  /** Number of tracked tasks that have not yet settled (any outcome). */
  pendingCount(): number;
  /** Resolves once every tracked task has settled. */
  drain(): Promise<void>;
}

export function createTaskQueue(tag: string): TaskQueue {
  let sessionLock: Promise<void> = Promise.resolve();
  const inFlight = new Set<Promise<void>>();

  const track = (task: Promise<void>): void => {
    inFlight.add(task);
    task.then(
      () => inFlight.delete(task),
      (error) => {
        inFlight.delete(task);
        // A task that escapes its own error handling must never become an
        // unhandled rejection that kills the shared process mid-drain.
        console.error(`[${tag}:task]`, error instanceof Error ? error.message : String(error));
      },
    );
  };

  return {
    enqueueSession(task) {
      const queued = sessionLock.then(task);
      // Absorb the outcome so a rejecting task never poisons the chain, and
      // register exactly one continuation (the queued promise) for tracking.
      sessionLock = queued.then(
        () => undefined,
        () => undefined,
      );
      void queued;
      track(queued);
    },
    enqueuePipelined(task) {
      track(task());
    },
    pendingCount: () => inFlight.size,
    async drain() {
      while (inFlight.size > 0) {
        await Promise.allSettled([...inFlight]);
      }
    },
  };
}