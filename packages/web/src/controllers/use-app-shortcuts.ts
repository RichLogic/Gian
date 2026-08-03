import { useEffect } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { Session } from '@gian/shared';
import type { Mode } from '../components/Topbar.js';
import type { GianWs } from '../ws.js';

interface UseAppShortcutsInput {
  authenticated: boolean;
  mode: Mode;
  activeSessionId: string | null;
  activeTaskId: string | null;
  activeSubtaskId: string | null;
  sessionsRef: RefObject<Session[]>;
  ws: GianWs;
  paletteOpen: boolean;
  setPaletteOpen: Dispatch<SetStateAction<boolean>>;
  setCreatingSession: Dispatch<SetStateAction<boolean>>;
  setForkingSession: Dispatch<SetStateAction<boolean>>;
}

export function useAppShortcuts({
  authenticated,
  mode,
  activeSessionId,
  activeTaskId,
  activeSubtaskId,
  sessionsRef,
  ws,
  paletteOpen,
  setPaletteOpen,
  setCreatingSession,
  setForkingSession,
}: UseAppShortcutsInput): void {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.shiftKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen(open => !open);
      }
      if (event.key === 'Escape' && paletteOpen) setPaletteOpen(false);
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [paletteOpen, setPaletteOpen]);

  useEffect(() => {
    if (!authenticated) return;

    function spawnChild(executor: 'claude' | 'codex') {
      if (mode === 'tasks' && activeTaskId && !activeSubtaskId) {
        window.dispatchEvent(new CustomEvent('gian:new-subtask', { detail: { executor } }));
        return;
      }
      const session = activeSessionId
        ? sessionsRef.current?.find(candidate => candidate.id === activeSessionId) ?? null
        : null;
      if (!session) return;
      const baseName = session.name && session.name.length > 0
        ? session.name
        : `session ${session.id.slice(0, 6)}`;
      setCreatingSession(true);
      setForkingSession(true);
      ws.send({
        type: 'session:create',
        workspace_id: session.workspace_id,
        executor,
        ...(session.approval_mode ? { approval_mode: session.approval_mode } : {}),
        name: `${baseName} copy`,
      });
    }

    function onKey(event: KeyboardEvent) {
      if (event.defaultPrevented) return;
      const mod = event.metaKey || event.ctrlKey;
      if (!mod || event.shiftKey || event.altKey) return;
      if (event.key === 'Enter') {
        const session = activeSessionId
          ? sessionsRef.current?.find(candidate => candidate.id === activeSessionId)
          : undefined;
        if (activeSessionId && session?.executor === 'codex') {
          event.preventDefault();
          ws.send({ type: 'queue:send_now', session_id: activeSessionId });
        }
        return;
      }
      const key = event.key.toLowerCase();
      if (key === 'u') {
        if (activeSessionId) {
          event.preventDefault();
          ws.send({ type: 'session:set_unread', session_id: activeSessionId, unread: true });
        }
      } else if (key === 'j') {
        event.preventDefault();
        spawnChild('claude');
      } else if (key === 'k') {
        event.preventDefault();
        spawnChild('codex');
      }
    }

    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [
    activeSessionId,
    activeSubtaskId,
    activeTaskId,
    authenticated,
    mode,
    sessionsRef,
    setCreatingSession,
    setForkingSession,
    ws,
  ]);
}
