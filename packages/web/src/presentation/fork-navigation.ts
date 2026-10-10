export const FORK_NAVIGATION_STORAGE_KEY = 'gian.pending-fork-navigation';
const NAVIGATION_INTENT_CLOCK_KEY = 'gian.navigation-intent-clock';

/**
 * Shared order for fork remembers and later user navigation in one document.
 * The counter is also written to sessionStorage so a reloaded document does
 * not mint a smaller sequence than a fork this tab already stored. Superseding
 * that fork across reload does not use a second clock: the explicit navigation
 * removes the stored open intent, and the fork operation itself keeps running.
 */
let intentSequence = 0;

interface ForkNavigationIntent {
  sessionId: string;
  runId: string;
  /** `0` is a legacy record written before sequences existed. */
  sequence: number;
}

export function noteUserNavigationIntent(storage: Storage | null = browserStorage()): number {
  const clock = readClock(storage);
  if (clock > intentSequence) intentSequence = clock;
  intentSequence += 1;
  writeClock(storage, intentSequence);
  return intentSequence;
}

/** Fresh document: the module counter is zero until storage is read. */
export function rehydrateNavigationIntentClock(storage: Storage | null = browserStorage()): void {
  const intent = readIntent(storage);
  const sequenced = intent && intent.sequence > 0 ? intent.sequence : 0;
  intentSequence = Math.max(intentSequence, readClock(storage), sequenced);
  if (intentSequence > 0) writeClock(storage, intentSequence);
}

/** Drop the in-memory counter, then read storage the way a new page would. */
export function reloadNavigationIntentClock(storage: Storage | null = browserStorage()): void {
  intentSequence = 0;
  rehydrateNavigationIntentClock(storage);
}

export function resetNavigationIntentSequence(storage: Storage | null = browserStorage()): void {
  intentSequence = 0;
  try { storage?.removeItem(NAVIGATION_INTENT_CLOCK_KEY); } catch { /* non-fatal */ }
}

/**
 * A stored fork wins only when it is newer than user navigation in this
 * document. Legacy records have no sequence: they still restore on a fresh
 * document, and lose once this document records a choice.
 */
export function forkBeatsUserIntent(sequence: number, userSequence: number): boolean {
  if (sequence <= 0) return userSequence <= 0;
  return sequence > userSequence;
}

function browserStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function readClock(storage: Storage | null): number {
  if (!storage) return 0;
  try {
    const raw = Number(storage.getItem(NAVIGATION_INTENT_CLOCK_KEY));
    return Number.isInteger(raw) && raw > 0 ? raw : 0;
  } catch {
    return 0;
  }
}

function writeClock(storage: Storage | null, value: number): void {
  if (!storage || value <= 0) return;
  try { storage.setItem(NAVIGATION_INTENT_CLOCK_KEY, String(value)); } catch { /* non-fatal */ }
}

function readIntent(storage: Storage | null = browserStorage()): ForkNavigationIntent | null {
  if (!storage) return null;
  try {
    const parsed = JSON.parse(storage.getItem(FORK_NAVIGATION_STORAGE_KEY) ?? 'null') as Partial<ForkNavigationIntent> | null;
    if (!parsed || typeof parsed.sessionId !== 'string' || parsed.sessionId.length === 0) return null;
    if (typeof parsed.runId !== 'string' || parsed.runId.length === 0) return null;
    const sequence = typeof parsed.sequence === 'number'
      && Number.isInteger(parsed.sequence)
      && parsed.sequence > 0
      ? parsed.sequence
      : 0;
    return { sessionId: parsed.sessionId, runId: parsed.runId, sequence };
  } catch {
    try { storage.removeItem(FORK_NAVIGATION_STORAGE_KEY); } catch { /* unavailable storage stays non-fatal */ }
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
    const sequence = noteUserNavigationIntent(storage);
    storage.setItem(FORK_NAVIGATION_STORAGE_KEY, JSON.stringify({ sessionId, runId, sequence }));
  } catch {
    // Fork creation is still useful when tab-local navigation storage is unavailable.
  }
}

export function clearForkNavigationForRun(
  runId: string,
  storage: Storage | null = browserStorage(),
): void {
  if (!storage || readIntent(storage)?.runId !== runId) return;
  try { storage.removeItem(FORK_NAVIGATION_STORAGE_KEY); } catch { /* no-op */ }
}

/**
 * An explicit session open or page leave replaces a not-yet-delivered fork
 * open. Removing the record is what survives reload; the in-memory user
 * sequence starts again at zero and must not be asked to remember this.
 */
export function retireForkNavigationIntent(storage: Storage | null = browserStorage()): void {
  if (!storage) return;
  try { storage.removeItem(FORK_NAVIGATION_STORAGE_KEY); } catch { /* non-fatal */ }
}

export function consumeForkNavigation(
  sessionId: string,
  storage: Storage | null = browserStorage(),
): boolean {
  if (!storage || readIntent(storage)?.sessionId !== sessionId) return false;
  try { storage.removeItem(FORK_NAVIGATION_STORAGE_KEY); } catch { return false; }
  return true;
}

export function consumeAvailableForkNavigation(
  sessionIds: Iterable<string>,
  storage: Storage | null = browserStorage(),
): string | null {
  const intent = readIntent(storage);
  if (!intent || !new Set(sessionIds).has(intent.sessionId)) return null;
  try { storage?.removeItem(FORK_NAVIGATION_STORAGE_KEY); } catch { return null; }
  return intent.sessionId;
}

export function pendingForkNavigation(
  storage: Storage | null = browserStorage(),
): ForkNavigationIntent | null {
  return readIntent(storage);
}

/** Sequence recorded when this id was remembered, or null when it is not the stored fork. */
export function peekForkNavigationSequence(
  sessionId: string,
  storage: Storage | null = browserStorage(),
): number | null {
  const intent = readIntent(storage);
  return intent?.sessionId === sessionId ? intent.sequence : null;
}

rehydrateNavigationIntentClock();
