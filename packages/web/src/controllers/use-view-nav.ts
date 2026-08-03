import { useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { Mode } from '../components/Topbar.js';

/** One history entry: the sidebar view (mode) + the conversation selection.
 *  Nothing else participates — workbench rails/tabs, inspectors and other UI
 *  state deliberately stay out of the Topbar ‹ › history (decided 2026-08-03;
 *  replaces the old workbench rail/tab nav stack in use-workbench-layout). */
export interface ViewNavEntry {
  mode: Mode;
  sessionId: string | null;
  taskId: string | null;
  subtaskId: string | null;
}

interface UseViewNavInput {
  mode: Mode;
  activeSessionId: string | null;
  activeTaskId: string | null;
  activeSubtaskId: string | null;
  setMode: (mode: Mode) => void;
  setActiveSessionId: Dispatch<SetStateAction<string | null>>;
  setActiveTaskId: Dispatch<SetStateAction<string | null>>;
  setActiveSubtaskId: Dispatch<SetStateAction<string | null>>;
}

function sameEntry(a: ViewNavEntry, b: ViewNavEntry): boolean {
  return a.mode === b.mode
    && a.sessionId === b.sessionId
    && a.taskId === b.taskId
    && a.subtaskId === b.subtaskId;
}

export function useViewNav({
  mode,
  activeSessionId,
  activeTaskId,
  activeSubtaskId,
  setMode,
  setActiveSessionId,
  setActiveTaskId,
  setActiveSubtaskId,
}: UseViewNavInput) {
  const [navStack, setNavStack] = useState<ViewNavEntry[]>([
    { mode, sessionId: activeSessionId, taskId: activeTaskId, subtaskId: activeSubtaskId },
  ]);
  const [navIndex, setNavIndex] = useState(0);
  const navSkipRef = useRef(false);

  // Browser-style history: a state change pushes a new entry, truncating the
  // forward branch first. Restores via navigate() are skipped (navSkipRef).
  useEffect(() => {
    if (navSkipRef.current) {
      navSkipRef.current = false;
      return;
    }
    const entry: ViewNavEntry = {
      mode,
      sessionId: activeSessionId,
      taskId: activeTaskId,
      subtaskId: activeSubtaskId,
    };
    const current = navStack[navIndex];
    if (current && sameEntry(current, entry)) return;
    const next = [...navStack.slice(0, navIndex + 1), entry];
    setNavStack(next);
    setNavIndex(next.length - 1);
  }, [mode, activeSessionId, activeTaskId, activeSubtaskId, navIndex, navStack]);

  function navigate(delta: -1 | 1): void {
    const entry = navStack[navIndex + delta];
    if (!entry) return;
    navSkipRef.current = true;
    setNavIndex(navIndex + delta);
    setMode(entry.mode);
    setActiveSessionId(entry.sessionId);
    setActiveTaskId(entry.taskId);
    setActiveSubtaskId(entry.subtaskId);
  }

  return {
    canGoBack: navIndex > 0,
    canGoForward: navIndex < navStack.length - 1,
    navigate,
  };
}
