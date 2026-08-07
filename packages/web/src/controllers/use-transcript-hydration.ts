import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { Executor, Session } from '@gian/shared';
import { loadEvents } from '../api.js';
import { applyEnvelope, applyPlanLifecycle, type PlanLifecycleState } from '../transcript/apply.js';
import type { TranscriptItem } from '../types.js';

interface TranscriptHydrationInput {
  activeSessionId: string | null;
  sessions: Session[];
  itemsBySession: Record<string, TranscriptItem[]>;
  setItemsBySession: Dispatch<SetStateAction<Record<string, TranscriptItem[]>>>;
  setPlanStateBySession: Dispatch<SetStateAction<Record<string, PlanLifecycleState>>>;
}

export interface TranscriptHistoryState {
  phase: 'unloaded' | 'live' | 'page' | 'complete';
  hasMore: boolean;
  loadingOlder: boolean;
  cursor: number | null;
}

interface TranscriptHydrationResult {
  historyBySession: Record<string, TranscriptHistoryState>;
  loadOlder: (sessionId: string, executor: Executor) => void;
  markLive: (sessionId: string) => void;
}

export function historyIsHydrated(state: TranscriptHistoryState | undefined): boolean {
  return state?.phase === 'page' || state?.phase === 'complete';
}

export function useTranscriptHydration({
  activeSessionId,
  sessions,
  itemsBySession,
  setItemsBySession,
  setPlanStateBySession,
}: TranscriptHydrationInput): TranscriptHydrationResult {
  const itemsRef = useRef(itemsBySession);
  itemsRef.current = itemsBySession;
  const [historyBySession, setHistoryBySession] = useState<Record<string, TranscriptHistoryState>>({});
  const historyRef = useRef(historyBySession);
  historyRef.current = historyBySession;
  const loadingRef = useRef(new Set<string>());
  const previousActiveRef = useRef<string | null>(null);

  const hydrate = useCallback((sessionId: string, executor: Executor) => {
    if (historyIsHydrated(historyRef.current[sessionId]) || loadingRef.current.has(sessionId)) return;
    loadingRef.current.add(sessionId);
    void loadEvents(sessionId).then(page => {
      const items = page.events.reduce<TranscriptItem[]>(
        (current, event) => applyEnvelope(current, event, executor),
        [],
      );
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
      setHistoryBySession(previous => ({
        ...previous,
        [sessionId]: {
          phase: page.hasMore ? 'page' : 'complete',
          hasMore: page.hasMore,
          loadingOlder: false,
          cursor: page.nextCursor,
        },
      }));
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
      [sessionId]: { ...previous[sessionId]!, loadingOlder: true },
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
          loadingOlder: false,
          cursor: page.nextCursor,
        },
      }));
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

  const markLive = useCallback((sessionId: string) => {
    setHistoryBySession(previous => {
      const current = previous[sessionId];
      if (historyIsHydrated(current) || current?.phase === 'live') return previous;
      return {
        ...previous,
        [sessionId]: {
          phase: 'live',
          hasMore: false,
          loadingOlder: false,
          cursor: null,
        },
      };
    });
  }, []);

  useEffect(() => {
    const previousActive = previousActiveRef.current;
    previousActiveRef.current = activeSessionId;
    if (!activeSessionId) return;
    const executor = sessions.find(session => session.id === activeSessionId)?.executor ?? 'claude';
    if (!historyIsHydrated(historyBySession[activeSessionId])) {
      hydrate(activeSessionId, executor);
      return;
    }
    if (previousActive === activeSessionId || loadingRef.current.has(activeSessionId)) return;
    loadingRef.current.add(activeSessionId);
    void loadEvents(activeSessionId).then(page => {
      const latest = page.events.reduce<TranscriptItem[]>(
        (current, event) => applyEnvelope(current, event, executor),
        [],
      );
      setItemsBySession(previous => ({
        ...previous,
        [activeSessionId]: mergeLatestItems(previous[activeSessionId] ?? [], latest),
      }));
    }).finally(() => loadingRef.current.delete(activeSessionId));
  }, [activeSessionId, historyBySession, hydrate, sessions, setItemsBySession]);

  return { historyBySession, loadOlder, markLive };
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
