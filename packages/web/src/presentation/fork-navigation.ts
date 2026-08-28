const FORK_NAVIGATION_KEY = 'gian.pending-fork-navigation';

interface ForkNavigationIntent {
  sessionId: string;
  runId: string;
}

function browserStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function readIntent(storage: Storage | null = browserStorage()): ForkNavigationIntent | null {
  if (!storage) return null;
  try {
    const parsed = JSON.parse(storage.getItem(FORK_NAVIGATION_KEY) ?? 'null') as Partial<ForkNavigationIntent> | null;
    return parsed
      && typeof parsed.sessionId === 'string'
      && parsed.sessionId.length > 0
      && typeof parsed.runId === 'string'
      && parsed.runId.length > 0
      ? { sessionId: parsed.sessionId, runId: parsed.runId }
      : null;
  } catch {
    try { storage.removeItem(FORK_NAVIGATION_KEY); } catch { /* unavailable storage stays non-fatal */ }
    return null;
  }
}

export function rememberForkNavigation(
  sessionId: string,
  runId: string,
  storage: Storage | null = browserStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(FORK_NAVIGATION_KEY, JSON.stringify({ sessionId, runId }));
  } catch {
    // Fork creation is still useful when tab-local navigation storage is unavailable.
  }
}

export function clearForkNavigationForRun(
  runId: string,
  storage: Storage | null = browserStorage(),
): void {
  if (!storage || readIntent(storage)?.runId !== runId) return;
  try { storage.removeItem(FORK_NAVIGATION_KEY); } catch { /* no-op */ }
}

export function consumeForkNavigation(
  sessionId: string,
  storage: Storage | null = browserStorage(),
): boolean {
  if (!storage || readIntent(storage)?.sessionId !== sessionId) return false;
  try { storage.removeItem(FORK_NAVIGATION_KEY); } catch { return false; }
  return true;
}

export function consumeAvailableForkNavigation(
  sessionIds: Iterable<string>,
  storage: Storage | null = browserStorage(),
): string | null {
  const intent = readIntent(storage);
  if (!intent || !new Set(sessionIds).has(intent.sessionId)) return null;
  try { storage?.removeItem(FORK_NAVIGATION_KEY); } catch { return null; }
  return intent.sessionId;
}

export function pendingForkNavigation(
  storage: Storage | null = browserStorage(),
): ForkNavigationIntent | null {
  return readIntent(storage);
}
