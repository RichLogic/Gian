import { act, renderHook } from '@testing-library/react';
import type { Session } from '@gian/shared';
import { DEFAULT_SHORTCUTS, isValidShortcutCombo, resolveShortcuts } from '@gian/shared';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAppShortcuts } from '../src/controllers/use-app-shortcuts.js';
import type { OperationDispatcher } from '../src/operations/dispatcher.js';
import {
  acceleratorDisplayParts,
  acceleratorFromEvent,
  comboDisplayParts,
  comboFromEvent,
  setShortcutOverrides,
  shortcutConflict,
} from '../src/shortcut-prefs.js';
import { sessionContractFixture } from './fixtures/ws-contract.js';

afterEach(() => {
  // The module store persists across tests — always reset to defaults.
  setShortcutOverrides(undefined);
});

describe('shortcut combo grammar', () => {
  it('normalizes keydown events into canonical combos', () => {
    expect(comboFromEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, shiftKey: true })))
      .toBe('mod+shift+k');
    expect(comboFromEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, shiftKey: true })))
      .toBe('mod+shift+k');
    expect(comboFromEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true })))
      .toBe('mod+enter');
    expect(comboFromEvent(new KeyboardEvent('keydown', { key: 'a' }))).toBe('a');
    expect(comboFromEvent(new KeyboardEvent('keydown', { key: 'A', shiftKey: true })))
      .toBe('shift+a');
  });

  it('ignores pure modifier presses', () => {
    for (const key of ['Meta', 'Control', 'Shift', 'Alt']) {
      expect(comboFromEvent(new KeyboardEvent('keydown', { key }))).toBeNull();
    }
  });

  it('validates combo strings and rejects duplicate modifiers', () => {
    expect(isValidShortcutCombo('mod+shift+k')).toBe(true);
    expect(isValidShortcutCombo('a')).toBe(true);
    expect(isValidShortcutCombo('mod+enter')).toBe(true);
    expect(isValidShortcutCombo('mod+mod+k')).toBe(false);
    expect(isValidShortcutCombo('MOD+K')).toBe(false);
    expect(isValidShortcutCombo('mod+')).toBe(false);
    expect(isValidShortcutCombo('')).toBe(false);
  });

  it('resolves invalid overrides back to the defaults', () => {
    const resolved = resolveShortcuts({
      commandPalette: 'mod+shift+p',
      decline: 'not valid!',
    });
    expect(resolved.commandPalette).toBe('mod+shift+p');
    expect(resolved.decline).toBe(DEFAULT_SHORTCUTS.decline);
  });

  it('renders combos as platform keycaps', () => {
    expect(comboDisplayParts('mod+shift+k')).toEqual(['⌘', '⇧', 'K']);
    expect(comboDisplayParts('mod+enter')).toEqual(['⌘', '⏎']);
    expect(comboDisplayParts('shift+a')).toEqual(['⇧', 'A']);
  });

  it('renders Electron accelerators preserving the ⌃/⌘ distinction', () => {
    expect(acceleratorDisplayParts('Control+Command+A')).toEqual(['⌃', '⌘', 'A']);
    expect(acceleratorDisplayParts('Command+Shift+S')).toEqual(['⌘', '⇧', 'S']);
  });

  it('builds Electron accelerators from keydown events with distinct modifiers', () => {
    expect(acceleratorFromEvent(new KeyboardEvent('keydown', {
      key: 'a', metaKey: true, ctrlKey: true,
    }))).toBe('Command+Control+A');
    expect(acceleratorFromEvent(new KeyboardEvent('keydown', {
      key: 's', metaKey: true, shiftKey: true,
    }))).toBe('Command+Shift+S');
    expect(acceleratorFromEvent(new KeyboardEvent('keydown', { key: 'Shift' }))).toBeNull();
  });

  it('detects a combo conflict with another action', () => {
    act(() => { setShortcutOverrides({ decline: 'mod+u' }); });
    expect(shortcutConflict('mod+u', 'decline')).toBe('markUnread');
    expect(shortcutConflict('mod+u', 'markUnread')).toBe('decline');
    expect(shortcutConflict('mod+shift+f10', 'decline')).toBeNull();
  });
});

describe('remapped app shortcuts', () => {
  function renderShortcuts(session: Session) {
    const dispatch = vi.fn();
    const sessionsRef = { current: [session] } as RefObject<Session[]>;
    const ops = { dispatch, dispose: vi.fn(), store: {} } as unknown as OperationDispatcher;
    const view = renderHook(() => useAppShortcuts({
      authenticated: true,
      mode: 'sessions',
      activeSessionId: session.id,
      activeTaskId: null,
      activeSubtaskId: null,
      sessionsRef,
      ops,
      paletteOpen: false,
      setPaletteOpen: vi.fn() as Dispatch<SetStateAction<boolean>>,
    }));
    return { dispatch, rerender: view.rerender };
  }

  it('steers with a remapped combo instead of the hardcoded one', () => {
    const session = sessionContractFixture({ id: 'remapped-steer' });
    const { dispatch, rerender } = renderShortcuts(session);

    // Remap steerOrSendNow from mod+enter to mod+shift+enter.
    act(() => { setShortcutOverrides({ steerOrSendNow: 'mod+shift+enter' }); });
    rerender();

    // The old default no longer fires.
    const oldEvent = new KeyboardEvent('keydown', {
      key: 'Enter', metaKey: true, bubbles: true, cancelable: true,
    });
    act(() => { document.dispatchEvent(oldEvent); });
    expect(dispatch).not.toHaveBeenCalled();

    // The new binding dispatches.
    const newEvent = new KeyboardEvent('keydown', {
      key: 'Enter', metaKey: true, shiftKey: true, bubbles: true, cancelable: true,
    });
    act(() => { document.dispatchEvent(newEvent); });
    expect(dispatch).toHaveBeenCalledWith('queue.sendNow', { sessionId: session.id });
  });

  it('toggles the palette with a remapped combo', () => {
    const session = sessionContractFixture({ id: 'remapped-palette' });
    const setPaletteOpen = vi.fn() as Dispatch<SetStateAction<boolean>>;
    const dispatch = vi.fn();
    const sessionsRef = { current: [session] } as RefObject<Session[]>;
    const ops = { dispatch, dispose: vi.fn(), store: {} } as unknown as OperationDispatcher;
    const view = renderHook(() => useAppShortcuts({
      authenticated: true,
      mode: 'sessions',
      activeSessionId: session.id,
      activeTaskId: null,
      activeSubtaskId: null,
      sessionsRef,
      ops,
      paletteOpen: false,
      setPaletteOpen,
    }));

    act(() => { setShortcutOverrides({ commandPalette: 'mod+shift+p' }); });
    view.rerender();

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'k', metaKey: true, shiftKey: true, bubbles: true, cancelable: true,
      }));
    });
    expect(setPaletteOpen).not.toHaveBeenCalled();

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'p', metaKey: true, shiftKey: true, bubbles: true, cancelable: true,
      }));
    });
    expect(setPaletteOpen).toHaveBeenCalledOnce();
  });

  it('does not fire a bare-key remap while typing in an input', () => {
    const session = sessionContractFixture({ id: 'bare-key' });
    const { dispatch, rerender } = renderShortcuts(session);

    // Remap markUnread from mod+u to the bare letter u.
    act(() => { setShortcutOverrides({ markUnread: 'u' }); });
    rerender();

    const input = document.createElement('input');
    document.body.appendChild(input);
    try {
      act(() => {
        input.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'u', bubbles: true, cancelable: true,
        }));
      });
      expect(dispatch).not.toHaveBeenCalled();

      act(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'u', bubbles: true, cancelable: true,
        }));
      });
      expect(dispatch).toHaveBeenCalledWith('session.setUnread', {
        sessionId: session.id,
        unread: true,
      });
    } finally {
      input.remove();
    }
  });
});
