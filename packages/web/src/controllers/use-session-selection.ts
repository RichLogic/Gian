import { useCallback, useEffect } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { Session } from '@gian/shared';
import type { Mode } from '../components/Topbar.js';
import type { OperationDispatcher } from '../operations/dispatcher.js';

interface UseSessionSelectionInput {
  mode: Mode;
  activeSubtaskId: string | null;
  sessionsRef: RefObject<Session[]>;
  activeSessionIdRef: RefObject<string | null>;
  setActiveSessionId: Dispatch<SetStateAction<string | null>>;
  restoreChatPanelForSession: (sessionId: string | null) => void;
  ops: OperationDispatcher;
}

export function useSessionSelection({
  mode,
  activeSubtaskId,
  sessionsRef,
  activeSessionIdRef,
  setActiveSessionId,
  restoreChatPanelForSession,
  ops,
}: UseSessionSelectionInput): (sessionId: string) => void {
  // Mark-viewed routes through the operation layer (Phase 2a): the unread
  // dot clears immediately via the overlay instead of waiting for the Host
  // broadcast.
  const markSessionViewed = useCallback((sessionId: string) => {
    const session = sessionsRef.current?.find(candidate => candidate.id === sessionId);
    if (session?.unread === 1) {
      ops.dispatch('session.setUnread', { sessionId, unread: false });
    }
  }, [ops, sessionsRef]);

  const selectSession = useCallback((sessionId: string) => {
    restoreChatPanelForSession(sessionId);
    setActiveSessionId(sessionId);
    markSessionViewed(sessionId);
  }, [markSessionViewed, restoreChatPanelForSession, setActiveSessionId]);

  useEffect(() => {
    if (mode !== 'tasks' || !activeSubtaskId) return;
    if (activeSessionIdRef.current === activeSubtaskId) return;
    setActiveSessionId(activeSubtaskId);
    markSessionViewed(activeSubtaskId);
  }, [activeSessionIdRef, activeSubtaskId, markSessionViewed, mode, setActiveSessionId]);

  useEffect(() => {
    if (mode !== 'tasks' || activeSubtaskId) return;
    const current = activeSessionIdRef.current;
    if (current && sessionsRef.current?.find(session => session.id === current)?.type === 'subtask') {
      setActiveSessionId(null);
    }
  }, [activeSessionIdRef, activeSubtaskId, mode, sessionsRef, setActiveSessionId]);

  return selectSession;
}
