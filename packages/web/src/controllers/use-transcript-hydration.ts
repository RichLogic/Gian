import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
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

export function useTranscriptHydration({
  activeSessionId,
  sessions,
  itemsBySession,
  setItemsBySession,
  setPlanStateBySession,
}: TranscriptHydrationInput): (sessionId: string, executor: Executor) => void {
  const itemsRef = useRef(itemsBySession);
  itemsRef.current = itemsBySession;

  const hydrate = useCallback((sessionId: string, executor: Executor) => {
    if (itemsRef.current[sessionId] !== undefined) return;
    void loadEvents(sessionId).then(events => {
      const items = events.reduce<TranscriptItem[]>(
        (current, event) => applyEnvelope(current, event, executor),
        [],
      );
      setItemsBySession(previous => previous[sessionId] !== undefined
        ? previous
        : { ...previous, [sessionId]: items });
    });
  }, [setItemsBySession]);

  useEffect(() => {
    if (!activeSessionId || itemsBySession[activeSessionId] !== undefined) return;
    const executor = sessions.find(session => session.id === activeSessionId)?.executor ?? 'claude';
    void loadEvents(activeSessionId).then(events => {
      const items = events.reduce<TranscriptItem[]>(
        (current, event) => applyEnvelope(current, event, executor),
        [],
      );
      const plan = events.reduce<PlanLifecycleState>(
        (current, event) => applyPlanLifecycle(current, event),
        { completed: false },
      );
      setItemsBySession(previous => ({ ...previous, [activeSessionId]: items }));
      if (plan.text !== undefined) {
        setPlanStateBySession(previous => ({ ...previous, [activeSessionId]: plan }));
      }
    });
  }, [activeSessionId, itemsBySession, sessions, setItemsBySession, setPlanStateBySession]);

  return hydrate;
}
