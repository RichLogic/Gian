import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { Executor, Session } from '@gian/shared';
import {
  EventHistoryLoadError,
  loadEvents,
  loadSearchContext,
  type EventHistoryLoadErrorKind,
  type SearchContextQuery,
} from '../api.js';
import {
  applyEnvelope,
  applyPlanLifecycle,
  displayTypeForEnvelope,
  type PlanLifecycleState,
} from '../transcript/apply.js';
import type { TranscriptItem } from '../types.js';
import {
  transcriptItemMergeIdentity,
} from '../transcript/identity.js';

interface TranscriptHydrationInput {
  activeSessionId: string | null;
  connectionReady: boolean;
  sessions: Session[];
  itemsBySession: Record<string, TranscriptItem[]>;
  setItemsBySession: Dispatch<SetStateAction<Record<string, TranscriptItem[]>>>;
  setPlanStateBySession: Dispatch<SetStateAction<Record<string, PlanLifecycleState>>>;
}

export interface TranscriptHistoryState {
  phase: 'unloaded' | 'live' | 'page' | 'complete';
  hasMore: boolean;
  loading: boolean;
  loadingOlder: boolean;
  cursor: number | null;
  error: TranscriptHistoryError | null;
  /** True when the loaded window is a bounded context window around a search
   *  target instead of the live tail. Live events must not fold into it; the
   *  user returns to latest explicitly. */
  detachedFromLatest?: boolean;
  /** True when the Host reports this session's cold history as still
   *  incomplete (SearchContextPage.history_complete === false) — surfaces
   *  label it; from_turn never claims full-history coverage. */
  historyIncomplete?: boolean;
  /** Explicit Back-to-latest command identity. Increments only there, and
   *  stays on later tail updates so Find and Transcript can invalidate the
   *  locate request that was in flight. Detached-flag transitions are not
   *  this command. */
  returnToLatestGeneration?: number;
}

export type TranscriptHistoryLoadOperation = 'initial' | 'refresh' | 'rebuild' | 'older' | 'context';

export interface TranscriptHistoryError {
  kind: EventHistoryLoadErrorKind;
  status: number | null;
  operation: TranscriptHistoryLoadOperation;
  message: string;
}

interface TranscriptHydrationResult {
  historyBySession: Record<string, TranscriptHistoryState>;
  loadOlder: (sessionId: string, executor: Executor) => void;
  retry: (sessionId: string, executor: Executor) => void;
  markLive: (sessionId: string) => void;
  rebuild: (sessionId: string, executor: Executor) => void;
  /** Load one bounded context window around a search target (0.6.7 contract
   *  GET /api/sessions/:id/context). Replaces the loaded window and detaches
   *  from the live tail; never walks the whole history into the DOM. */
  loadContextWindow: (
    sessionId: string,
    executor: Executor,
    query: SearchContextQuery,
  ) => Promise<boolean>;
  /** Explicit return to the live tail: clears the detached window and
   *  rehydrates the latest page. */
  returnToLatest: (sessionId: string, executor: Executor) => void;
}

export function historyIsHydrated(state: TranscriptHistoryState | undefined): boolean {
  return state?.phase === 'page' || state?.phase === 'complete';
}

function unloadedHistoryState(): TranscriptHistoryState {
  return {
    phase: 'unloaded',
    hasMore: false,
    loading: false,
    loadingOlder: false,
    cursor: null,
    error: null,
  };
}

function structuredHistoryError(
  error: unknown,
  operation: TranscriptHistoryLoadOperation,
): TranscriptHistoryError {
  if (error instanceof EventHistoryLoadError) {
    return {
      kind: error.kind,
      status: error.status,
      operation,
      message: error.message,
    };
  }
  return {
    kind: 'invalid-response',
    status: null,
    operation,
    message: error instanceof Error ? error.message : 'Unknown event history error.',
  };
}

export function useTranscriptHydration({
  activeSessionId,
  connectionReady,
  sessions,
  itemsBySession,
  setItemsBySession,
  setPlanStateBySession,
}: TranscriptHydrationInput): TranscriptHydrationResult {
  const [historyBySession, setHistoryBySession] = useState<Record<string, TranscriptHistoryState>>({});
  const historyRef = useRef(historyBySession);
  historyRef.current = historyBySession;
  const loadingRef = useRef(new Set<string>());
  const pendingRebuildRef = useRef(new Map<string, Executor>());
  const rebuildBaselineRef = useRef(new Map<string, Map<string, TranscriptItem>>());
  const previousActiveRef = useRef<string | null>(null);
  const previousConnectionReadyRef = useRef(connectionReady);
  /** Per-session navigation generation: a return-to-latest (or a newer
   *  window) supersedes an in-flight context load, whose late response is
   *  discarded and must not clear the newer load's busy marker. */
  const navTokenRef = useRef(new Map<string, number>());
  /** Last context locator per session, so a failed window load retries the
   *  SAME bounded query instead of falling through to a full-page reload. */
  const contextQueryRef = useRef(new Map<string, { executor: Executor; query: SearchContextQuery }>());
  /** Explicit return-to-latest identity. Independent of the nav token, which
   *  also moves for ordinary page and context loads. */
  const returnGenerationRef = useRef(new Map<string, number>());
  const [returnGenerationEpoch, setReturnGenerationEpoch] = useState(0);
  const bumpNavToken = (sessionId: string): number => {
    const next = (navTokenRef.current.get(sessionId) ?? 0) + 1;
    navTokenRef.current.set(sessionId, next);
    return next;
  };

  const loadFirstPage = useCallback((
    sessionId: string,
    executor: Executor,
    operation: 'initial' | 'refresh' | 'rebuild',
  ) => {
    const existing = historyRef.current[sessionId];
    if (loadingRef.current.has(sessionId)
      || (operation === 'initial' && historyIsHydrated(existing))) return;
    const rebuildBaseline = operation === 'rebuild'
      ? rebuildBaselineRef.current.get(sessionId)
      : undefined;
    const navToken = bumpNavToken(sessionId);
    loadingRef.current.add(sessionId);
    setHistoryBySession(previous => {
      const current = previous[sessionId] ?? unloadedHistoryState();
      return {
        ...previous,
        [sessionId]: { ...current, loading: true, error: null },
      };
    });
    void loadEvents(sessionId).then(page => {
      // A newer navigation intent (return-to-latest, context window, another
      // first page) supersedes this response entirely.
      if (navTokenRef.current.get(sessionId) !== navToken) return;
      const items = page.events.reduce<TranscriptItem[]>(
        (current, event) => applyEnvelope(current, event, executor),
        [],
      );
      const queuedBaseline = pendingRebuildRef.current.has(sessionId)
        ? rebuildBaselineRef.current.get(sessionId)
        : undefined;
      for (const item of items) {
        queuedBaseline?.set(transcriptItemMergeIdentity(item), item);
      }
      if (operation === 'initial' || operation === 'rebuild') {
        const plan = page.events.reduce<PlanLifecycleState>(
          (current, event) => applyPlanLifecycle(current, event),
          { completed: false },
        );
        setItemsBySession(previous => {
          const current = previous[sessionId] ?? [];
          const concurrentLive = operation === 'rebuild'
            ? current.filter(item => (
                rebuildBaseline?.get(transcriptItemMergeIdentity(item)) !== item
              ))
            : current;
          return {
            ...previous,
            [sessionId]: mergeHydratedItems(items, concurrentLive),
          };
        });
        if (
          operation === 'rebuild'
          && rebuildBaselineRef.current.get(sessionId) === rebuildBaseline
        ) {
          rebuildBaselineRef.current.delete(sessionId);
        }
        if (operation === 'rebuild' || plan.text !== undefined) {
          setPlanStateBySession(previous => ({ ...previous, [sessionId]: plan }));
        }
      } else {
        setItemsBySession(previous => ({
          ...previous,
          [sessionId]: mergeLatestItems(previous[sessionId] ?? [], items),
        }));
        // Refresh is authoritative for lifecycle frames too. Fold it over the
        // retained plan so a plan update just outside the latest page still
        // observes a newly fetched terminal event.
        setPlanStateBySession(previous => {
          const existing = previous[sessionId] ?? { completed: false };
          const plan = page.events
            .filter(event => {
              if (event.turn < (existing.turn ?? 0)) return false;
              const type = displayTypeForEnvelope(event);
              return type === 'state.turn-completed' || type === 'state.error';
            })
            .reduce<PlanLifecycleState>(
            (current, event) => applyPlanLifecycle(current, event),
            existing,
          );
          return plan === existing ? previous : { ...previous, [sessionId]: plan };
        });
      }
      setHistoryBySession(previous => ({
        ...previous,
        [sessionId]: operation === 'initial' || operation === 'rebuild'
          ? {
              phase: page.hasMore ? 'page' : 'complete',
              hasMore: page.hasMore,
              loading: false,
              loadingOlder: false,
              cursor: page.nextCursor,
              error: null,
            }
          : {
              ...(previous[sessionId] ?? unloadedHistoryState()),
              loading: false,
              error: null,
            },
      }));
    }).catch(error => {
      if (navTokenRef.current.get(sessionId) !== navToken) return;
      setHistoryBySession(previous => {
        const current = previous[sessionId] ?? unloadedHistoryState();
        return {
          ...previous,
          [sessionId]: {
            ...current,
            loading: false,
            error: structuredHistoryError(error, operation),
          },
        };
      });
    }).finally(() => {
      if (navTokenRef.current.get(sessionId) !== navToken) return;
      loadingRef.current.delete(sessionId);
      // The rebuild queue drains only into a live-tail window: a detached
      // context window (or a stale load) leaves it for the next tail load —
      // firing it now would replace the window with the tail.
      if (historyRef.current[sessionId]?.detachedFromLatest) return;
      const pendingRebuild = pendingRebuildRef.current.get(sessionId);
      if (pendingRebuild) {
        pendingRebuildRef.current.delete(sessionId);
        queueMicrotask(() => loadFirstPage(sessionId, pendingRebuild, 'rebuild'));
      }
    });
  }, [setItemsBySession, setPlanStateBySession]);

  const loadOlder = useCallback((sessionId: string, executor: Executor) => {
    const state = historyRef.current[sessionId];
    if (!state?.hasMore || state.cursor == null || loadingRef.current.has(sessionId)) return;
    // Captured, never bumped: older paging continues the current window. A
    // return-to-latest bumps the token and this late response is discarded.
    const navToken = navTokenRef.current.get(sessionId) ?? 0;
    loadingRef.current.add(sessionId);
    setHistoryBySession(previous => ({
      ...previous,
      [sessionId]: { ...previous[sessionId]!, loadingOlder: true, error: null },
    }));
    void loadEvents(sessionId, state.cursor).then(page => {
      // A newer navigation intent (return-to-latest, a fresh window) owns the
      // token; this late page must not prepend into it.
      if (navTokenRef.current.get(sessionId) !== navToken) return;
      const olderItems = page.events.reduce<TranscriptItem[]>(
        (current, event) => applyEnvelope(current, event, executor),
        [],
      );
      const queuedBaseline = pendingRebuildRef.current.has(sessionId)
        ? rebuildBaselineRef.current.get(sessionId)
        : undefined;
      for (const item of olderItems) {
        queuedBaseline?.set(transcriptItemMergeIdentity(item), item);
      }
      setItemsBySession(previous => ({
        ...previous,
        [sessionId]: prependOlderItems(olderItems, previous[sessionId] ?? []),
      }));
      setHistoryBySession(previous => ({
        ...previous,
        [sessionId]: {
          // Older paging from a detached context window stays detached —
          // dropping the flag would let the next live frame fold into a
          // non-contiguous window. The cold-history marker rides along too.
          ...(previous[sessionId]?.detachedFromLatest ? { detachedFromLatest: true as const } : {}),
          ...(previous[sessionId]?.historyIncomplete ? { historyIncomplete: true as const } : {}),
          phase: page.hasMore ? 'page' : 'complete',
          hasMore: page.hasMore,
          loading: false,
          loadingOlder: false,
          cursor: page.nextCursor,
          error: null,
        },
      }));
    }).catch(error => {
      if (navTokenRef.current.get(sessionId) !== navToken) return;
      setHistoryBySession(previous => {
        const current = previous[sessionId];
        if (!current) return previous;
        return {
          ...previous,
          [sessionId]: {
            ...current,
            loadingOlder: false,
            error: structuredHistoryError(error, 'older'),
          },
        };
      });
    }).finally(() => {
      if (navTokenRef.current.get(sessionId) !== navToken) return;
      loadingRef.current.delete(sessionId);
      setHistoryBySession(previous => {
        const current = previous[sessionId];
        return !current?.loadingOlder
          ? previous
          : { ...previous, [sessionId]: { ...current, loadingOlder: false } };
      });
      // Same deferred-rebuild rule as first pages: the queue drains only
      // into a live-tail window owned by this token.
      if (historyRef.current[sessionId]?.detachedFromLatest) return;
      const pendingRebuild = pendingRebuildRef.current.get(sessionId);
      if (pendingRebuild) {
        pendingRebuildRef.current.delete(sessionId);
        queueMicrotask(() => loadFirstPage(sessionId, pendingRebuild, 'rebuild'));
      }
    });
  }, [setItemsBySession]);

  const markLive = useCallback((sessionId: string) => {
    setHistoryBySession(previous => {
      const state = previous[sessionId];
      if (historyIsHydrated(state) || state?.phase === 'live') return previous;
      return {
        ...previous,
        [sessionId]: {
          ...(state ?? unloadedHistoryState()),
          phase: 'live',
          hasMore: false,
          cursor: null,
        },
      };
    });
  }, []);

  const rebuild = useCallback((sessionId: string, executor: Executor) => {
    rebuildBaselineRef.current.set(sessionId, new Map(
      (itemsBySession[sessionId] ?? []).map(item => [transcriptItemMergeIdentity(item), item]),
    ));
    if (loadingRef.current.has(sessionId)) {
      pendingRebuildRef.current.set(sessionId, executor);
      return;
    }
    loadFirstPage(sessionId, executor, 'rebuild');
  }, [itemsBySession, loadFirstPage]);

  const loadContextWindow = useCallback(async (
    sessionId: string,
    executor: Executor,
    query: SearchContextQuery,
  ): Promise<boolean> => {
    // A new context window supersedes ANY in-flight load for the session
    // (the older response is discarded by the token; its finally cannot
    // clear this load's busy marker).
    const navToken = bumpNavToken(sessionId);
    loadingRef.current.add(sessionId);
    contextQueryRef.current.set(sessionId, { executor, query });
    setHistoryBySession(previous => ({
      ...previous,
      [sessionId]: { ...(previous[sessionId] ?? unloadedHistoryState()), loading: true, error: null },
    }));
    try {
      const page = await loadSearchContext(sessionId, query);
      if (navTokenRef.current.get(sessionId) !== navToken) return false;
      const items = page.events.reduce<TranscriptItem[]>(
        (current, event) => applyEnvelope(current, event, executor),
        [],
      );
      // Replace the loaded window wholesale. Older paging continues before
      // the window's first turn; the live tail is rehydrated explicitly via
      // returnToLatest.
      setItemsBySession(previous => ({ ...previous, [sessionId]: items }));
      setHistoryBySession(previous => ({
        ...previous,
        [sessionId]: {
          phase: 'page',
          hasMore: page.window.from_turn > 1,
          loading: false,
          loadingOlder: false,
          cursor: page.window.from_turn > 1 ? page.window.from_turn : null,
          error: null,
          detachedFromLatest: true,
          ...(page.history_complete === false ? { historyIncomplete: true as const } : {}),
        },
      }));
      return true;
    } catch (error) {
      if (navTokenRef.current.get(sessionId) !== navToken) return false;
      setHistoryBySession(previous => {
        const current = previous[sessionId];
        if (!current) return previous;
        return {
          ...previous,
          [sessionId]: {
            ...current,
            loading: false,
            error: structuredHistoryError(error, 'context'),
          },
        };
      });
      return false;
    } finally {
      // Only the load that still owns the navigation token may release the
      // busy marker — a superseded late response must not clear the newer
      // load's flag.
      if (navTokenRef.current.get(sessionId) === navToken) {
        loadingRef.current.delete(sessionId);
      }
    }
  }, [setItemsBySession]);

  const returnToLatest = useCallback((sessionId: string, executor: Executor) => {
    // The user's return-to-latest wins over any in-flight load: a superseded
    // context response is discarded by the token, and its finally must not
    // touch the busy marker. Never swallowed by a busy marker.
    bumpNavToken(sessionId);
    const returnGeneration = (returnGenerationRef.current.get(sessionId) ?? 0) + 1;
    returnGenerationRef.current.set(sessionId, returnGeneration);
    setReturnGenerationEpoch(epoch => epoch + 1);
    contextQueryRef.current.delete(sessionId);
    loadingRef.current.delete(sessionId);
    // The detached window's items are not contiguous with the live tail —
    // clear both the window and its history state, then rehydrate. The ref
    // is updated synchronously: loadFirstPage's initial guard reads it.
    historyRef.current = { ...historyRef.current, [sessionId]: unloadedHistoryState() };
    setItemsBySession(previous => ({ ...previous, [sessionId]: [] }));
    setHistoryBySession(previous => ({
      ...previous,
      [sessionId]: unloadedHistoryState(),
    }));
    loadFirstPage(sessionId, executor, 'initial');
  }, [loadFirstPage, setItemsBySession]);

  const retry = useCallback((sessionId: string, executor: Executor) => {
    const state = historyRef.current[sessionId];
    if (!state?.error || loadingRef.current.has(sessionId)) return;
    if (state.error.operation === 'older') {
      loadOlder(sessionId, executor);
      return;
    }
    if (state.error.operation === 'context') {
      // A failed context window retries the SAME bounded locator; it is not
      // a first-page operation.
      const stored = contextQueryRef.current.get(sessionId);
      if (stored) {
        void loadContextWindow(sessionId, stored.executor, stored.query);
        return;
      }
      loadFirstPage(sessionId, executor, 'initial');
      return;
    }
    loadFirstPage(sessionId, executor, state.error.operation);
  }, [loadFirstPage, loadOlder, loadContextWindow]);

  useEffect(() => {
    const previousActive = previousActiveRef.current;
    previousActiveRef.current = activeSessionId;
    const wasConnectionReady = previousConnectionReadyRef.current;
    previousConnectionReadyRef.current = connectionReady;
    if (!activeSessionId) return;
    const reconnected = connectionReady && !wasConnectionReady;
    const executor = sessions.find(session => session.id === activeSessionId)?.executor ?? 'claude';
    const history = historyBySession[activeSessionId];
    const reentered = previousActive !== activeSessionId;
    if (history?.error && (reconnected || reentered)) {
      retry(activeSessionId, executor);
      return;
    }
    if (!historyIsHydrated(history)) {
      if (history?.loading || history?.error) return;
      loadFirstPage(activeSessionId, executor, 'initial');
      return;
    }
    if (!reentered || history?.loading) return;
    // A detached context window survives re-entry: refreshing the latest
    // page would merge non-contiguous items into it. The user returns to
    // the tail explicitly.
    if (history?.detachedFromLatest) return;
    loadFirstPage(activeSessionId, executor, 'refresh');
  }, [activeSessionId, connectionReady, historyBySession, loadFirstPage, retry, sessions]);

  const historyForView = useMemo(() => {
    let changed = false;
    const next: Record<string, TranscriptHistoryState> = {};
    for (const [sessionId, state] of Object.entries(historyBySession)) {
      const generation = returnGenerationRef.current.get(sessionId);
      if (generation !== undefined && state.returnToLatestGeneration !== generation) {
        next[sessionId] = { ...state, returnToLatestGeneration: generation };
        changed = true;
      } else {
        next[sessionId] = state;
      }
    }
    return changed ? next : historyBySession;
  }, [historyBySession, returnGenerationEpoch]);

  return {
    historyBySession: historyForView,
    loadOlder,
    retry,
    markLive,
    rebuild,
    loadContextWindow,
    returnToLatest,
  };
}

/** Historical first page arrives after live events in reconnect races. */
function mergeHydratedItems(history: TranscriptItem[], live: TranscriptItem[]): TranscriptItem[] {
  if (live.length === 0) return history;
  let next = history.slice();
  for (const item of live) {
    if (item.kind === 'user' && item.pending && next.some(candidate => (
      candidate.kind === 'user' && candidate.text === item.text
    ))) continue;
    next = upsertMergedItem(next, item);
  }
  return next;
}

function prependOlderItems(older: TranscriptItem[], current: TranscriptItem[]): TranscriptItem[] {
  const currentKeys = new Set(current.map(transcriptItemMergeIdentity));
  return [...older.filter(item => !currentKeys.has(transcriptItemMergeIdentity(item))), ...current];
}

function mergeLatestItems(current: TranscriptItem[], latest: TranscriptItem[]): TranscriptItem[] {
  let next = current.slice();
  for (const item of latest) {
    next = upsertMergedItem(next, item);
  }
  return next;
}

/** Replace every stale projection for a logical item while preserving the
 * first one's position. Exact identities cover ordinary rows; the merge
 * identity also reconciles generic/specialized tool-card projections. */
function upsertMergedItem(items: TranscriptItem[], item: TranscriptItem): TranscriptItem[] {
  const identity = transcriptItemMergeIdentity(item);
  const matches = items.flatMap((candidate, index) => (
    transcriptItemMergeIdentity(candidate) === identity ? [index] : []
  ));
  if (matches.length === 0) return [...items, item];
  const first = matches[0]!;
  const matchSet = new Set(matches);
  const next = items.filter((_candidate, index) => !matchSet.has(index));
  next.splice(first, 0, item);
  return next;
}
