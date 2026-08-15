import { useEffect } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { Session } from '@gian/shared';
import type { Mode } from '../components/Topbar.js';
import type { OperationDispatcher } from '../operations/dispatcher.js';
import { comboFromEvent, comboMatches, useShortcuts } from '../shortcut-prefs.js';

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
  /** A modal owns keyboard focus; global navigation/mutation shortcuts must
   *  not operate the obscured app behind it. */
  disabled?: boolean;
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
  disabled = false,
  setPaletteOpen,
}: UseAppShortcutsInput): void {
  // User-remappable bindings (defaults + settings.save overrides), kept in
  // the module store so both effects re-subscribe on a remap.
  const shortcuts = useShortcuts();

  useEffect(() => {
    if (disabled) return;
    function onKeyDown(event: KeyboardEvent) {
      if (comboMatches(event, shortcuts.commandPalette)) {
        event.preventDefault();
        setPaletteOpen(open => !open);
      }
      if (event.key === 'Escape' && paletteOpen) setPaletteOpen(false);
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [disabled, paletteOpen, setPaletteOpen, shortcuts]);

  useEffect(() => {
    if (!authenticated || disabled) return;

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
      // A remapped bare key (no mod) must not fire while the user is typing
      // in an input/textarea/contenteditable — same guard the approval cards
      // use for their letter shortcuts.
      const combo = comboFromEvent(event);
      if (combo && !combo.includes('mod')) {
        const target = event.target as HTMLElement | null;
        const tag = target?.tagName ?? '';
        if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;
      }
      if (comboMatches(event, shortcuts.steerOrSendNow)) {
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
          // triggers while one drain is in flight.
          ops.dispatch('queue.sendNow', { sessionId: activeSessionId });
        }
        return;
      }
      if (comboMatches(event, shortcuts.markUnread)) {
        if (activeSessionId) {
          event.preventDefault();
          ops.dispatch('session.setUnread', { sessionId: activeSessionId, unread: true });
        }
      } else if (comboMatches(event, shortcuts.createClaudeChild)) {
        event.preventDefault();
        spawnChild('claude');
      } else if (comboMatches(event, shortcuts.createCodexChild)) {
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
    disabled,
    mode,
    ops,
    sessionsRef,
    shortcuts,
  ]);
}
