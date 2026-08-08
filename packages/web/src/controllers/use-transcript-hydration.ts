import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { Executor, Session } from '@gian/shared';
import {
  EventHistoryLoadError,
  loadEvents,
  type EventHistoryLoadErrorKind,
} from '../api.js';
import { applyEnvelope, applyPlanLifecycle, type PlanLifecycleState } from '../transcript/apply.js';
import type { TranscriptItem } from '../types.js';

interface TranscriptHydrationInput {
  activeSessionId: string | null;
  connectionReady: boolean;
  sessions: Session[];
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
}

export type TranscriptHistoryLoadOperation = 'initial' | 'refresh' | 'older';

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
  setItemsBySession,
  setPlanStateBySession,
}: TranscriptHydrationInput): TranscriptHydrationResult {
  const [historyBySession, setHistoryBySession] = useState<Record<string, TranscriptHistoryState>>({});
  const historyRef = useRef(historyBySession);
  historyRef.current = historyBySession;
  const loadingRef = useRef(new Set<string>());
  const previousActiveRef = useRef<string | null>(null);
  const previousConnectionReadyRef = useRef(connectionReady);

  const loadFirstPage = useCallback((
    sessionId: string,
    executor: Executor,
    operation: 'initial' | 'refresh',
  ) => {
    const existing = historyRef.current[sessionId];
    if (loadingRef.current.has(sessionId)
      || (operation === 'initial' && historyIsHydrated(existing))) return;
    loadingRef.current.add(sessionId);
    setHistoryBySession(previous => {
      const current = previous[sessionId] ?? unloadedHistoryState();
      return {
        ...previous,
        [sessionId]: { ...current, loading: true, error: null },
      };
    });
    void loadEvents(sessionId).then(page => {
      const items = page.events.reduce<TranscriptItem[]>(
        (current, event) => applyEnvelope(current, event, executor),
        [],
      );
      if (operation === 'initial') {
        const plan = page.events.reduce<PlanLifecycleState>(
          (current, event) => applyPlanLifecycle(current, event),
          { completed: false },
        );
        setItemsBySession(previous => ({
          ...previous,
          [sessionId]: mergeHydratedItems(items, previous[sessionId] ?? []),
        }));
        if (plan.text !== undefined) {
          setPlanStateBySession(previous => ({ ...previous, [sessionId]: plan }));
        }
      } else {
        setItemsBySession(previous => ({
          ...previous,
          [sessionId]: mergeLatestItems(previous[sessionId] ?? [], items),
        }));
      }
      setHistoryBySession(previous => ({
        ...previous,
        [sessionId]: operation === 'initial'
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
      loadingRef.current.delete(sessionId);
    });
  }, [setItemsBySession, setPlanStateBySession]);

  const loadOlder = useCallback((sessionId: string, executor: Executor) => {
    const state = historyRef.current[sessionId];
    if (!state?.hasMore || state.cursor == null || loadingRef.current.has(sessionId)) return;
    loadingRef.current.add(sessionId);
    setHistoryBySession(previous => ({
      ...previous,
      [sessionId]: { ...previous[sessionId]!, loadingOlder: true, error: null },
    }));
    void loadEvents(sessionId, state.cursor).then(page => {
      const olderItems = page.events.reduce<TranscriptItem[]>(
        (current, event) => applyEnvelope(current, event, executor),
        [],
      );
      setItemsBySession(previous => ({
        ...previous,
        [sessionId]: prependOlderItems(olderItems, previous[sessionId] ?? []),
      }));
      setHistoryBySession(previous => ({
        ...previous,
        [sessionId]: {
          phase: page.hasMore ? 'page' : 'complete',
          hasMore: page.hasMore,
          loading: false,
          loadingOlder: false,
          cursor: page.nextCursor,
          error: null,
        },
      }));
    }).catch(error => {
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
      loadingRef.current.delete(sessionId);
      setHistoryBySession(previous => {
        const current = previous[sessionId];
        return !current?.loadingOlder
          ? previous
          : { ...previous, [sessionId]: { ...current, loadingOlder: false } };
      });
    });
  }, [setItemsBySession]);

  const retry = useCallback((sessionId: string, executor: Executor) => {
    const state = historyRef.current[sessionId];
    if (!state?.error || loadingRef.current.has(sessionId)) return;
    if (state.error.operation === 'older') {
      loadOlder(sessionId, executor);
      return;
    }
    loadFirstPage(sessionId, executor, state.error.operation);
  }, [loadFirstPage, loadOlder]);

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
    loadFirstPage(activeSessionId, executor, 'refresh');
  }, [activeSessionId, connectionReady, historyBySession, loadFirstPage, retry, sessions]);

  return { historyBySession, loadOlder, retry, markLive };
}

function transcriptKey(item: TranscriptItem): string {
  return `${item.kind}:${item.id}`;
}

/** Historical first page arrives after live events in reconnect races. */
function mergeHydratedItems(history: TranscriptItem[], live: TranscriptItem[]): TranscriptItem[] {
  if (live.length === 0) return history;
  const next = history.slice();
  const index = new Map(next.map((item, position) => [transcriptKey(item), position]));
  for (const item of live) {
    const position = index.get(transcriptKey(item));
    if (position !== undefined) {
      next[position] = item;
      continue;
    }
    if (item.kind === 'user' && item.pending && next.some(candidate => (
      candidate.kind === 'user' && candidate.text === item.text
    ))) continue;
    index.set(transcriptKey(item), next.length);
    next.push(item);
  }
  return next;
}

function prependOlderItems(older: TranscriptItem[], current: TranscriptItem[]): TranscriptItem[] {
  const currentKeys = new Set(current.map(transcriptKey));
  return [...older.filter(item => !currentKeys.has(transcriptKey(item))), ...current];
}

function mergeLatestItems(current: TranscriptItem[], latest: TranscriptItem[]): TranscriptItem[] {
  const next = current.slice();
  const index = new Map(next.map((item, position) => [transcriptKey(item), position]));
  for (const item of latest) {
    const position = index.get(transcriptKey(item));
    if (position === undefined) {
      index.set(transcriptKey(item), next.length);
      next.push(item);
    } else {
      next[position] = item;
    }
  }
  return next;
}
