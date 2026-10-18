/**
 * Shared hard timeout for send-purpose translation requests. A hanging
 * translation provider must never gate the Host dispatch forever: after
 * SEND_TRANSLATE_TIMEOUT_MS the request is aborted and cancelled Host-side,
 * and the caller's failure path (failed send row / draft restore) takes over.
 */
export const SEND_TRANSLATE_TIMEOUT_MS = 45_000;

export interface SendTimeout {
  controller: AbortController;
  /** Stop the timer once the request settled or was abandoned. */
  clear(): void;
}

/** Start a timer that invokes `onTimeout` with a fresh AbortController after
 *  SEND_TRANSLATE_TIMEOUT_MS. The caller owns settling semantics — the helper
 *  never resolves or rejects anything itself. */
export function withSendTimeout(onTimeout: (controller: AbortController) => void): SendTimeout {
  const controller = new AbortController();
  const timer = setTimeout(() => onTimeout(controller), SEND_TRANSLATE_TIMEOUT_MS);
  return { controller, clear: () => clearTimeout(timer) };
}
