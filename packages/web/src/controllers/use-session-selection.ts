import { useCallback, useEffect } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { Session } from '@gian/shared';
import type { Mode } from '../components/Topbar.js';
import type { ChatPanelTarget } from '../presentation/chat-panel.js';
import type { GianWs } from '../ws.js';

interface UseSessionSelectionInput {
  mode: Mode;
  activeSubtaskId: string | null;
  sessionsRef: RefObject<Session[]>;
  activeSessionIdRef: RefObject<string | null>;
  setActiveSessionId: Dispatch<SetStateAction<string | null>>;
  setChatPanel: Dispatch<SetStateAction<ChatPanelTarget | null>>;
  ws: GianWs;
}

export function useSessionSelection({
  mode,
  activeSubtaskId,
  sessionsRef,
  activeSessionIdRef,
  setActiveSessionId,
  setChatPanel,
  ws,
}: UseSessionSelectionInput): (sessionId: string) => void {
  const markSessionViewed = useCallback((sessionId: string) => {
    const session = sessionsRef.current?.find(candidate => candidate.id === sessionId);
    if (session?.unread === 1) {
      ws.send({ type: 'session:set_unread', session_id: sessionId, unread: false });
    }
  }, [sessionsRef, ws]);

  const selectSession = useCallback((sessionId: string) => {
    setChatPanel(null);
    setActiveSessionId(sessionId);
    markSessionViewed(sessionId);
  }, [markSessionViewed, setActiveSessionId, setChatPanel]);

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
