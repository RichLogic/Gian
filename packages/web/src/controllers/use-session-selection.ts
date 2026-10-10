import { useCallback, useEffect } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { Session } from '@gian/shared';
import type { Mode } from '../components/Topbar.js';
import type { OperationDispatcher } from '../operations/dispatcher.js';

interface UseSessionSelectionInput {
  mode: Mode;
  activeSubtaskId: string | null;
  activeSessionId: string | null;
  sessionsRef: RefObject<Session[]>;
  /** Visible sessions, including task overlays. Effect 2 uses this ahead of the canonical ref. */
  effectiveSessionsRef?: RefObject<readonly Session[] | null>;
  activeSessionIdRef: RefObject<string | null>;
  setActiveSessionId: Dispatch<SetStateAction<string | null>>;
  restoreChatPanelForSession: (sessionId: string | null) => void;
  ops: OperationDispatcher;
}

export function useSessionSelection({
  mode,
  activeSubtaskId,
  activeSessionId,
  sessionsRef,
  effectiveSessionsRef,
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
    if (activeSessionId === activeSubtaskId) return;
    setActiveSessionId(activeSubtaskId);
    markSessionViewed(activeSubtaskId);
  }, [activeSessionId, activeSubtaskId, markSessionViewed, mode, setActiveSessionId]);

  useEffect(() => {
    if (mode !== 'tasks' || activeSubtaskId) return;
    const current = activeSessionIdRef.current;
    if (!current) return;
    // A pending assign overlay changes type before the canonical row does.
    // The bare ref would still say subtask and clear the session just chosen
    // from 未分配.
    const effectiveList = effectiveSessionsRef?.current;
    const session = effectiveList
      ? effectiveList.find(item => item.id === current)
      : sessionsRef.current?.find(item => item.id === current);
    if (session?.type === 'subtask') setActiveSessionId(null);
  }, [activeSessionIdRef, activeSubtaskId, effectiveSessionsRef, mode, sessionsRef, setActiveSessionId]);

  return selectSession;
}
