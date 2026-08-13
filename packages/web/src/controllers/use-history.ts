/**
 * Git History — panel-3 view-state controller.
 *
 * The History inspector unmounts whenever the rail collapses or another rail
 * opens, but its state must survive both that and session/worktree switches:
 * loaded pages, cursor, filters, search, scroll position and the
 * "history changed" strip are keyed by {sessionId, workingTreeId} in this
 * module-level store. Git reads still target the working tree, while filters,
 * selection context, paging, and scroll never leak between Sessions that
 * share one workspace (Issue #46).
 *
 * Components read via `useHistoryState(workingTreeId)` (useSyncExternalStore)
 * and mutate through the actions below; all fetches go through the frozen
 * Web API client in `api.ts`.
 */
import { useCallback, useSyncExternalStore } from 'react';
import {
  GitHistoryRequestError,
  loadGitHistory,
  type GitHistoryAuthor,
  type GitHistoryCommit,
  type GitHistoryRef,
} from '../api.js';

export const HISTORY_PAGE_SIZE = 50;

export interface HistoryViewState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  /** First-page load failure message (retry via Refresh). */
  error: string | null;
  items: GitHistoryCommit[];
  nextCursor: string | null;
  availableRefs: GitHistoryRef[];
  availableAuthors: GitHistoryAuthor[];
  /** null = detached HEAD (the timeline then follows the detached commit). */
  currentRef: string | null;
  /** Actual HEAD commit; unlike snapshot this never follows the ref filter. */
  headSha: string | null;
  /** null only for an empty/unborn repo. */
  snapshot: string | null;
  query: string;
  /** Branch filter — the host's full ref value (`refs/heads/main`, …). */
  ref: string | null;
  /** Author filter — exact email. */
  author: string | null;
  scrollTop: number;
  /** "Fetch/cursor-stale changed this view" strip; dismissed per tree. */
  moved: boolean;
  /** Monotonic ref-snapshot change token. Unlike `moved`, this still advances
   *  when a second rewrite happens before the first banner is dismissed. */
  movementRevision: number;
  loadingMore: boolean;
  loadMoreError: string | null;
}

const DEFAULT_STATE: HistoryViewState = {
  status: 'idle',
  error: null,
  items: [],
  nextCursor: null,
  availableRefs: [],
  availableAuthors: [],
  currentRef: null,
  headSha: null,
  snapshot: null,
  query: '',
  ref: null,
  author: null,
  scrollTop: 0,
  moved: false,
  movementRevision: 0,
  loadingMore: false,
  loadMoreError: null,
};

function stateKey(workingTreeId: string, ownerSessionId?: string | null): string {
  return JSON.stringify([ownerSessionId ?? null, workingTreeId]);
}

const states = new Map<string, HistoryViewState>();
const owners = new Map<string, { workingTreeId: string; ownerSessionId: string | null }>();
/** Monotonic request sequence per tree — late responses lose. */
const requestSeq = new Map<string, number>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function subscribeHistory(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getHistoryState(
  workingTreeId: string,
  ownerSessionId?: string | null,
): HistoryViewState {
  const key = stateKey(workingTreeId, ownerSessionId);
  owners.set(key, { workingTreeId, ownerSessionId: ownerSessionId ?? null });
  return states.get(key) ?? DEFAULT_STATE;
}

function patch(
  workingTreeId: string,
  partial: Partial<HistoryViewState>,
  ownerSessionId?: string | null,
): void {
  const key = stateKey(workingTreeId, ownerSessionId);
  owners.set(key, { workingTreeId, ownerSessionId: ownerSessionId ?? null });
  states.set(key, { ...getHistoryState(workingTreeId, ownerSessionId), ...partial });
  emit();
}

/** React binding — one subscription for every Session/tree owner. */
export function useHistoryState(
  workingTreeId: string | null,
  ownerSessionId?: string | null,
): HistoryViewState {
  const getSnapshot = useCallback(
    () => (workingTreeId
      ? getHistoryState(workingTreeId, ownerSessionId)
      : DEFAULT_STATE),
    [workingTreeId, ownerSessionId],
  );
  return useSyncExternalStore(subscribeHistory, getSnapshot);
}

/** Narrow revision snapshot for App-level orphan revalidation. A boolean is
 *  insufficient: repeated force-pushes must revalidate even while the first
 *  "history changed" banner remains visible. */
export function useHistoryMovementRevision(
  workingTreeId: string | null,
  ownerSessionId?: string | null,
): number {
  const getSnapshot = useCallback(
    () => (workingTreeId
      ? getHistoryState(workingTreeId, ownerSessionId).movementRevision
      : 0),
    [workingTreeId, ownerSessionId],
  );
  return useSyncExternalStore(subscribeHistory, getSnapshot);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** First page with the state's current filters. Drops the cursor (and any
 *  previously loaded pages) — the only way to re-read a moving DAG. */
export async function reloadHistory(
  workingTreeId: string,
  ownerSessionId?: string | null,
): Promise<void> {
  const key = stateKey(workingTreeId, ownerSessionId);
  const state = getHistoryState(workingTreeId, ownerSessionId);
  const seq = (requestSeq.get(key) ?? 0) + 1;
  requestSeq.set(key, seq);
  patch(
    workingTreeId,
    { status: 'loading', error: null, loadMoreError: null, loadingMore: false },
    ownerSessionId,
  );
  try {
    const page = await loadGitHistory(workingTreeId, {
      limit: HISTORY_PAGE_SIZE,
      q: state.query || undefined,
      ref: state.ref,
      author: state.author,
    });
    if (requestSeq.get(key) !== seq) return;
    patch(workingTreeId, {
      status: 'ready',
      items: page.items,
      nextCursor: page.nextCursor,
      availableRefs: page.availableRefs,
      // Every reload is a first page, so [] is authoritative too (unborn or
      // a ref whose reachable history has no parsed authors).
      availableAuthors: page.availableAuthors,
      currentRef: page.currentRef,
      headSha: page.headSha,
      snapshot: page.snapshot,
    }, ownerSessionId);
  } catch (err) {
    if (requestSeq.get(key) !== seq) return;
    patch(workingTreeId, { status: 'error', error: errorMessage(err) }, ownerSessionId);
  }
}

/** Lazy entry: load the first page only when this tree has never loaded. */
export function ensureHistoryLoaded(
  workingTreeId: string,
  ownerSessionId?: string | null,
): void {
  const state = getHistoryState(workingTreeId, ownerSessionId);
  if (state.status !== 'idle') return;
  void reloadHistory(workingTreeId, ownerSessionId);
}

/** Refresh — re-read local history (no network), keeps filters and scroll. */
export function refreshHistory(
  workingTreeId: string,
  ownerSessionId?: string | null,
): void {
  void reloadHistory(workingTreeId, ownerSessionId);
}

/** Next cursor page. A stale cursor (ref moved since page 1) is NOT an error
 *  surface: drop the pages, reload the first page, raise the moved strip. */
export async function loadMoreHistory(
  workingTreeId: string,
  ownerSessionId?: string | null,
): Promise<void> {
  const key = stateKey(workingTreeId, ownerSessionId);
  const state = getHistoryState(workingTreeId, ownerSessionId);
  if (state.status !== 'ready' || !state.nextCursor || state.loadingMore) return;
  const seq = (requestSeq.get(key) ?? 0) + 1;
  requestSeq.set(key, seq);
  patch(workingTreeId, { loadingMore: true, loadMoreError: null }, ownerSessionId);
  try {
    const page = await loadGitHistory(workingTreeId, {
      limit: HISTORY_PAGE_SIZE,
      cursor: state.nextCursor,
      q: state.query || undefined,
      ref: state.ref,
      author: state.author,
    });
    if (requestSeq.get(key) !== seq) return;
    patch(workingTreeId, {
      items: [...getHistoryState(workingTreeId, ownerSessionId).items, ...page.items],
      nextCursor: page.nextCursor,
      availableRefs: page.availableRefs.length > 0 ? page.availableRefs : state.availableRefs,
      loadingMore: false,
    }, ownerSessionId);
  } catch (err) {
    if (requestSeq.get(key) !== seq) return;
    if (err instanceof GitHistoryRequestError && err.code === 'history_cursor_stale') {
      const current = getHistoryState(workingTreeId, ownerSessionId);
      patch(workingTreeId, {
        loadingMore: false,
        moved: true,
        movementRevision: current.movementRevision + 1,
      }, ownerSessionId);
      void reloadHistory(workingTreeId, ownerSessionId);
      return;
    }
    patch(
      workingTreeId,
      { loadingMore: false, loadMoreError: errorMessage(err) },
      ownerSessionId,
    );
  }
}

export function setHistoryQuery(
  workingTreeId: string,
  query: string,
  ownerSessionId?: string | null,
): void {
  if (getHistoryState(workingTreeId, ownerSessionId).query === query) return;
  patch(workingTreeId, { query }, ownerSessionId);
  void reloadHistory(workingTreeId, ownerSessionId);
}

export function setHistoryRef(
  workingTreeId: string,
  ref: string | null,
  ownerSessionId?: string | null,
): void {
  patch(workingTreeId, { ref }, ownerSessionId);
  void reloadHistory(workingTreeId, ownerSessionId);
}

export function setHistoryAuthor(
  workingTreeId: string,
  author: string | null,
  ownerSessionId?: string | null,
): void {
  patch(workingTreeId, { author }, ownerSessionId);
  void reloadHistory(workingTreeId, ownerSessionId);
}

export function clearHistoryFilters(
  workingTreeId: string,
  ownerSessionId?: string | null,
): void {
  patch(workingTreeId, { query: '', ref: null, author: null }, ownerSessionId);
  void reloadHistory(workingTreeId, ownerSessionId);
}

/** Every Fetch invalidates cursor paging and reloads page 1. Only an observed
 *  ref change (or an unknown outcome) raises the moved strip/revision. */
export function reconcileHistoryAfterFetch(workingTreeId: string, refsChanged: boolean): void {
  const matching = [...owners.values()].filter(owner => owner.workingTreeId === workingTreeId);
  // Backward-compatible fallback for callers/tests that have not mounted a
  // Session-owned view yet.
  if (matching.length === 0) matching.push({ workingTreeId, ownerSessionId: null });
  for (const owner of matching) {
    if (refsChanged) {
      const current = getHistoryState(workingTreeId, owner.ownerSessionId);
      patch(workingTreeId, {
        moved: true,
        movementRevision: current.movementRevision + 1,
      }, owner.ownerSessionId);
    }
    void reloadHistory(workingTreeId, owner.ownerSessionId);
  }
}

export function dismissHistoryMoved(
  workingTreeId: string,
  ownerSessionId?: string | null,
): void {
  patch(workingTreeId, { moved: false }, ownerSessionId);
}

export function saveHistoryScroll(
  workingTreeId: string,
  scrollTop: number,
  ownerSessionId?: string | null,
): void {
  // Scroll is read at restore time only — patching without emit keeps the
  // store quiet during scroll (no re-render per frame).
  const key = stateKey(workingTreeId, ownerSessionId);
  owners.set(key, { workingTreeId, ownerSessionId: ownerSessionId ?? null });
  states.set(key, { ...getHistoryState(workingTreeId, ownerSessionId), scrollTop });
}
