import { act, renderHook } from '@testing-library/react';
import type { Session } from '@gian/shared';
import {
  DEFAULT_KEYMAP_BINDINGS,
  isValidKeymapBinding,
  resolveKeymap,
} from '@gian/shared';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAppShortcuts } from '../src/controllers/use-app-shortcuts.js';
import type { OperationDispatcher } from '../src/operations/dispatcher.js';
import {
  acceleratorDisplayParts,
  acceleratorFromEvent,
  comboDisplayParts,
  comboFromEvent,
  keymapConflict,
  setKeymapPreferences,
} from '../src/shortcut-prefs.js';
import { sessionContractFixture } from './fixtures/ws-contract.js';

afterEach(() => {
  setKeymapPreferences(undefined);
});

describe('keymap combo grammar', () => {
  it('normalizes Command and Control without losing their distinction', () => {
    expect(comboFromEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, shiftKey: true })))
      .toBe('mod+shift+k');
    expect(comboFromEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, shiftKey: true })))
      .toBe('ctrl+shift+k');
    expect(comboFromEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true })))
      .toBe('mod+enter');
    expect(comboFromEvent(new KeyboardEvent('keydown', { key: 'F2' }))).toBe('f2');
    expect(comboFromEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }))).toBe('up');
  });

  it('validates punctuation, function keys and explicit null overrides', () => {
    expect(isValidKeymapBinding('mod+shift+[')).toBe(true);
    expect(isValidKeymapBinding('mod+6')).toBe(true);
    expect(isValidKeymapBinding('f2')).toBe(true);
    expect(isValidKeymapBinding('mod+mod+k')).toBe(false);
    expect(isValidKeymapBinding('')).toBe(false);
    expect(resolveKeymap({ preset: 'default', bindings: { 'tool.terminal': null } })['tool.terminal'])
      .toBeUndefined();
  });

  it('renders key combinations as platform keycaps', () => {
    expect(comboDisplayParts('mod+shift+[')).toEqual(['⌘', '⇧', '[']);
    expect(comboDisplayParts('ctrl+tab')).toEqual(['⌃', '⇥']);
    expect(acceleratorDisplayParts('Control+Command+A')).toEqual(['⌃', '⌘', 'A']);
  });

  it('builds Electron accelerators from keydown events with distinct modifiers', () => {
    expect(acceleratorFromEvent(new KeyboardEvent('keydown', {
      key: 'a', metaKey: true, ctrlKey: true,
    }))).toBe('Command+Control+A');
  });

  it('detects conflicts between product commands', () => {
    const map = { ...DEFAULT_KEYMAP_BINDINGS, 'session.archive': 'mod+k' };
    expect(keymapConflict('mod+k', 'session.archive', map)).toBe('app.quickSwitcher');
  });
});

describe('remapped app keymap', () => {
  function renderKeymap(session: Session, setPaletteOpen = vi.fn() as Dispatch<SetStateAction<boolean>>) {
    const dispatch = vi.fn();
    const sessionsRef = { current: [session] } as RefObject<Session[]>;
    const ops = { dispatch, dispose: vi.fn(), store: {} } as unknown as OperationDispatcher;
    const onCommand = vi.fn();
    const view = renderHook(() => useAppShortcuts({
      authenticated: true,
      activeSessionId: session.id,
      sessionsRef,
      ops,
      paletteOpen: false,
      setPaletteOpen,
      onCommand,
    }));
    return { dispatch, onCommand, rerender: view.rerender, setPaletteOpen };
  }

  it('steers with a remapped binding instead of the default', () => {
    const session = sessionContractFixture({ id: 'remapped-steer', executor: 'codex' });
    const view = renderKeymap(session);
    act(() => setKeymapPreferences({
      preset: 'default', bindings: { 'session.sendOrSteer': 'mod+shift+enter' },
    }));
    view.rerender();

    act(() => document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', metaKey: true, bubbles: true, cancelable: true,
    })));
    expect(view.dispatch).not.toHaveBeenCalled();

    act(() => document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', metaKey: true, shiftKey: true, bubbles: true, cancelable: true,
    })));
    expect(view.dispatch).toHaveBeenCalledWith('queue.sendNow', { sessionId: session.id });
  });

  it('remaps the quick switcher', () => {
    const view = renderKeymap(sessionContractFixture({ id: 'palette' }));
    act(() => setKeymapPreferences({
      preset: 'default', bindings: { 'app.quickSwitcher': 'mod+shift+p' },
    }));
    view.rerender();
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'p', metaKey: true, shiftKey: true, bubbles: true, cancelable: true,
    })));
    expect(view.setPaletteOpen).toHaveBeenCalledOnce();
  });

  it('maps Later to unread state but never fires a bare binding while typing', () => {
    const session = sessionContractFixture({ id: 'later' });
    const view = renderKeymap(session);
    act(() => setKeymapPreferences({
      preset: 'default', bindings: { 'session.later': 'u' },
    }));
    view.rerender();
    const input = document.createElement('input');
    document.body.appendChild(input);
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'u', bubbles: true })));
    expect(view.dispatch).not.toHaveBeenCalled();
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'u', bubbles: true })));
    expect(view.dispatch).toHaveBeenCalledWith('session.setUnread', {
      sessionId: session.id,
      unread: true,
    });
    input.remove();
  });

  it('routes tool commands to the App command handler', () => {
    const view = renderKeymap(sessionContractFixture({ id: 'tools' }));
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', {
      key: '6', metaKey: true, bubbles: true, cancelable: true,
    })));
    expect(view.onCommand).toHaveBeenCalledWith('tool.terminal');
  });
});
