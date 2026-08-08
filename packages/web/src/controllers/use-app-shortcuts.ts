import { useEffect } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { Session } from '@gian/shared';
import type { Mode } from '../components/Topbar.js';
import type { OperationDispatcher } from '../operations/dispatcher.js';

interface UseAppShortcutsInput {
  authenticated: boolean;
  mode: Mode;
  activeSessionId: string | null;
  activeTaskId: string | null;
  activeSubtaskId: string | null;
  sessionsRef: RefObject<Session[]>;
  /** All shortcut commands dispatch through the operation layer (Session in
   *  Phase 2a; ⌘Enter queue.sendNow in Phase 2b). */
  ops: OperationDispatcher;
  paletteOpen: boolean;
  setPaletteOpen: Dispatch<SetStateAction<boolean>>;
}

export function useAppShortcuts({
  authenticated,
  mode,
  activeSessionId,
  activeTaskId,
  activeSubtaskId,
  sessionsRef,
  ops,
  paletteOpen,
  setPaletteOpen,
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
      // Fork needs a workspace — an Unfiled (workspace-deleted) session
      // cannot be forked.
      if (session.workspace_id == null) return;
      const baseName = session.name && session.name.length > 0
        ? session.name
        : `session ${session.id.slice(0, 6)}`;
      // The pending fork run drives the global "Forking session…" toast (App
      // derives it from the operation store); it ends on operation:result.
      ops.dispatch('session.fork', {
        workspaceId: session.workspace_id,
        executor,
        approvalMode: session.approval_mode,
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
        if (
          activeSessionId
          && session?.executor === 'codex'
          && session.completed_at == null
          && session.worktree_outcome == null
        ) {
          event.preventDefault();
          // Pending policy: the dispatcher's duplicate guard blocks repeat
          // ⌘Enter while one drain is in flight.
          ops.dispatch('queue.sendNow', { sessionId: activeSessionId });
        }
        return;
      }
      const key = event.key.toLowerCase();
      if (key === 'u') {
        if (activeSessionId) {
          event.preventDefault();
          ops.dispatch('session.setUnread', { sessionId: activeSessionId, unread: true });
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
    ops,
    sessionsRef,
  ]);
}
