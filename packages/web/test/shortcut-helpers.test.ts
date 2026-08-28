import { describe, expect, it } from 'vitest';
import type { ShortcutAction } from '@gian/shared';
import {
  acceleratorDisplayParts,
  acceleratorFromEvent,
  comboDisplayParts,
  comboFromEvent,
  comboMatches,
  isShortcutCustomized,
  shortcutConflict,
} from '../src/shortcut-prefs.js';

const map = {
  commandPalette: 'mod+p',
  steerOrSendNow: 'mod+enter',
  createClaudeChild: 'mod+j',
  createCodexChild: 'mod+k',
  markUnread: 'mod+u',
  approveOnce: 'a',
  approveSession: 'shift+a',
  decline: 'd',
} as Record<ShortcutAction, string>;

describe('shortcut display and conflict helpers', () => {
  it('maps combo tokens to keycaps', () => {
    expect(comboDisplayParts('alt+space')).toEqual(['⌥', '␣']);
    expect(comboDisplayParts('mod+tab')).toEqual(['⌘', '⇥']);
  });

  it('maps Electron accelerators while keeping control distinct', () => {
    expect(acceleratorDisplayParts('Control+Shift+Tab')).toEqual(['⌃', '⇧', '⇥']);
    expect(acceleratorDisplayParts('')).toEqual([]);
  });

  it('reports the first conflicting action against an injected map', () => {
    expect(shortcutConflict('mod+p', 'markUnread', map)).toBe('commandPalette');
    expect(shortcutConflict('mod+p', 'commandPalette', map)).toBeNull();
  });

  it('detects customization against an injected map', () => {
    expect(isShortcutCustomized('commandPalette', map)).toBe(true);
    expect(isShortcutCustomized('decline', map)).toBe(false);
  });
});

describe('comboFromEvent', () => {
  it('returns null for modifier-only presses and supports navigation keys', () => {
    expect(comboFromEvent(new KeyboardEvent('keydown', { key: 'Meta' }))).toBeNull();
    expect(comboFromEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }))).toBe('up');
  });

  it('normalizes letters with mod and matches a combo string', () => {
    const event = new KeyboardEvent('keydown', { key: 'u', metaKey: true });
    expect(comboFromEvent(event)).toBe('mod+u');
    expect(comboMatches(event, 'mod+u')).toBe(true);
    expect(comboMatches(event, 'mod+k')).toBe(false);
  });

  it('keeps Command and Control distinct for Electron accelerators', () => {
    expect(acceleratorFromEvent(new KeyboardEvent('keydown', { key: 'Meta' }))).toBeNull();
    expect(acceleratorFromEvent(new KeyboardEvent('keydown', {
      key: 'a',
      ctrlKey: true,
      shiftKey: true,
    }))).toBe('Control+Shift+A');
  });
});
