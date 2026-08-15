import { useSyncExternalStore } from 'react';
import type { ShortcutAction, ShortcutMap } from '@gian/shared';
import { DEFAULT_SHORTCUTS, resolveShortcuts } from '@gian/shared';

/** Resolved keyboard shortcuts (defaults + the user's settings.save
 *  overrides). Kept in a module store — like display-prefs — because the
 *  consumers (global keydown handlers, approval cards deep in the transcript
 *  tree) must not depend on prop drilling from App. App syncs the rendered
 *  config into here via `setShortcutOverrides`. */

let current: Record<ShortcutAction, string> = resolveShortcuts(undefined);
const listeners = new Set<() => void>();

export function setShortcutOverrides(overrides: ShortcutMap | undefined): void {
  const next = resolveShortcuts(overrides);
  const same = (Object.keys(next) as ShortcutAction[])
    .every(action => next[action] === current[action]);
  if (same) return;
  current = next;
  for (const listener of listeners) listener();
}

export function getShortcuts(): Record<ShortcutAction, string> {
  return current;
}

export function useShortcuts(): Record<ShortcutAction, string> {
  return useSyncExternalStore(
    listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getShortcuts,
  );
}

/** Normalize a keydown event into the canonical combo string
 *  ("mod+shift+k"). `mod` covers Cmd and Ctrl so a remapped shortcut works
 *  for both macOS and other platforms. Returns null for pure modifier
 *  presses and keys outside the remappable grammar. */
export function comboFromEvent(event: KeyboardEvent): string | null {
  const key = event.key.toLowerCase();
  if (key === 'meta' || key === 'control' || key === 'shift' || key === 'alt') return null;
  const named = key === 'enter' || key === 'escape' || key === 'tab' || key === ' '
    ? key === ' ' ? 'space' : key
    : /^[a-z0-9]$/.test(key) ? key : null;
  if (!named) return null;
  const parts: string[] = [];
  if (event.metaKey || event.ctrlKey) parts.push('mod');
  if (event.shiftKey) parts.push('shift');
  if (event.altKey) parts.push('alt');
  parts.push(named);
  return parts.join('+');
}

export function comboMatches(event: KeyboardEvent, combo: string): boolean {
  return comboFromEvent(event) === combo;
}

/** Split a combo into keycap display tokens ("mod+shift+k" → ["⌘","⇧","K"]). */
export function comboDisplayParts(combo: string): string[] {
  const parts = combo.split('+');
  return parts.map(part => {
    switch (part) {
      case 'mod': return '⌘';
      case 'shift': return '⇧';
      case 'alt': return '⌥';
      case 'enter': return '⏎';
      case 'escape': return '⎋';
      case 'tab': return '⇥';
      case 'space': return '␣';
      default: return part.toUpperCase();
    }
  });
}

/** Build an Electron accelerator directly from a keydown, keeping Command
 *  and Control distinct (in-app combos collapse both into `mod`, which would
 *  lose information a global shortcut needs). Returns null for pure
 *  modifier presses. */
export function acceleratorFromEvent(event: KeyboardEvent): string | null {
  const key = event.key.toLowerCase();
  if (key === 'meta' || key === 'control' || key === 'shift' || key === 'alt') return null;
  let name: string | null = null;
  if (/^[a-z0-9]$/.test(key)) name = key.toUpperCase();
  else if (key === 'enter') name = 'Enter';
  else if (key === ' ') name = 'Space';
  else if (key === 'tab') name = 'Tab';
  if (!name) return null;
  const parts: string[] = [];
  if (event.metaKey) parts.push('Command');
  if (event.ctrlKey) parts.push('Control');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  parts.push(name);
  return parts.join('+');
}

/** Keycap tokens for an Electron accelerator, preserving the ⌃/⌘
 *  distinction ("Control+Command+A" → ["⌃","⌘","A"]). */
export function acceleratorDisplayParts(accelerator: string): string[] {
  if (!accelerator) return [];
  return accelerator.split('+').map(part => {
    switch (part.toLowerCase()) {
      case 'command':
      case 'cmd':
      case 'commandorcontrol':
      case 'cmdorctrl':
        return '⌘';
      case 'control':
      case 'ctrl':
        return '⌃';
      case 'shift': return '⇧';
      case 'alt':
      case 'option':
        return '⌥';
      case 'enter':
      case 'return':
        return '⏎';
      case 'escape':
      case 'esc':
        return '⎋';
      case 'tab': return '⇥';
      case 'space': return '␣';
      default: return part.toUpperCase();
    }
  });
}

/** First conflicting action for a combo, excluding `self`. */
export function shortcutConflict(
  combo: string,
  self: ShortcutAction,
  map: Record<ShortcutAction, string> = current,
): ShortcutAction | null {
  for (const action of Object.keys(map) as ShortcutAction[]) {
    if (action !== self && map[action] === combo) return action;
  }
  return null;
}

/** True when a map entry differs from the built-in default (drives the
 *  per-row reset affordance). */
export function isShortcutCustomized(
  action: ShortcutAction,
  map: Record<ShortcutAction, string> = current,
): boolean {
  return map[action] !== DEFAULT_SHORTCUTS[action];
}
