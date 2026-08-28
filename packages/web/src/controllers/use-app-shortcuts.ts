import { useEffect } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { KeymapCommand, Session } from '@gian/shared';
import type { OperationDispatcher } from '../operations/dispatcher.js';
import { comboMatches, useKeymap } from '../shortcut-prefs.js';

interface UseAppShortcutsInput {
  authenticated: boolean;
  activeSessionId: string | null;
  sessionsRef: RefObject<Session[]>;
  /** All shortcut commands dispatch through the operation layer (Session in
   *  Phase 2a; ⌘Enter queue.sendNow in Phase 2b). */
  ops: OperationDispatcher;
  paletteOpen: boolean;
  /** A modal owns keyboard focus; global navigation/mutation shortcuts must
   *  not operate the obscured app behind it. */
  disabled?: boolean;
  setPaletteOpen: Dispatch<SetStateAction<boolean>>;
  /** Layout, navigation and tool commands are App-owned because their state
   *  spans the topbar, workbench and route controllers. */
  onCommand?: (command: KeymapCommand) => void;
}

export function useAppShortcuts({
  authenticated,
  activeSessionId,
  sessionsRef,
  ops,
  paletteOpen,
  disabled = false,
  setPaletteOpen,
  onCommand,
}: UseAppShortcutsInput): void {
  const keymap = useKeymap();

  useEffect(() => {
    if (disabled) return;
    function onKeyDown(event: KeyboardEvent) {
      if (comboMatches(event, keymap['app.quickSwitcher'])) {
        event.preventDefault();
        setPaletteOpen(open => !open);
      }
      if (event.key === 'Escape' && paletteOpen) setPaletteOpen(false);
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [disabled, keymap, paletteOpen, setPaletteOpen]);

  useEffect(() => {
    if (!authenticated || disabled) return;

    function onKey(event: KeyboardEvent) {
      if (event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName ?? '';
      const editing = tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable;
      if (comboMatches(event, keymap['session.sendOrSteer'])) {
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
      if (editing) return;
      if (comboMatches(event, keymap['session.later'])) {
        if (activeSessionId) {
          event.preventDefault();
          ops.dispatch('session.setUnread', { sessionId: activeSessionId, unread: true });
        }
        return;
      }
      if (comboMatches(event, keymap['session.archive'])) {
        if (activeSessionId) {
          event.preventDefault();
          ops.dispatch('session.archive', { sessionId: activeSessionId, archived: true });
        }
        return;
      }
      for (const command of Object.keys(keymap) as KeymapCommand[]) {
        if (command === 'app.quickSwitcher'
          || command === 'session.sendOrSteer'
          || command === 'session.later'
          || command === 'session.archive') continue;
        if (!comboMatches(event, keymap[command])) continue;
        event.preventDefault();
        onCommand?.(command);
        return;
      }
    }

    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [
    activeSessionId,
    authenticated,
    disabled,
    keymap,
    onCommand,
    ops,
    sessionsRef,
  ]);
}
