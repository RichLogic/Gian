import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { DEFAULT_TERMINAL_PREFERENCES } from '@gian/shared';

import {
  sanitizeShortcuts,
  sanitizeTerminalPreferences,
} from '../src/storage/config.js';

test('sanitizeShortcuts keeps known actions with valid combos', () => {
  assert.deepEqual(sanitizeShortcuts(null), {});
  assert.deepEqual(sanitizeShortcuts([]), {});
  assert.deepEqual(sanitizeShortcuts({
    commandPalette: 'mod+shift+p',
    unknownAction: 'mod+x',
    approveOnce: 'mod+shift',
    decline: 'd',
  }), {
    commandPalette: 'mod+shift+p',
    decline: 'd',
  });
});

test('sanitizeTerminalPreferences falls back to defaults for unknown values', () => {
  assert.deepEqual(sanitizeTerminalPreferences(null), { ...DEFAULT_TERMINAL_PREFERENCES });
  assert.deepEqual(sanitizeTerminalPreferences({
    font_family: 'comic-sans',
    font_size: 9,
    line_height: 3,
    cursor_style: 'beam',
    cursor_blink: 'yes',
    scrollback_lines: 12,
    shell: '/bin/zsh',
    start_directory: 'tmp',
  }), {
    ...DEFAULT_TERMINAL_PREFERENCES,
    shell: '/bin/zsh',
  });
  assert.deepEqual(sanitizeTerminalPreferences({
    font_family: 'sf-mono',
    font_size: 16,
    line_height: 1.4,
    cursor_style: 'bar',
    cursor_blink: false,
    scrollback_lines: 10_000,
    shell: '',
    start_directory: 'home',
  }), {
    font_family: 'sf-mono',
    font_size: 16,
    line_height: 1.4,
    cursor_style: 'bar',
    cursor_blink: false,
    scrollback_lines: 10_000,
    shell: '',
    start_directory: 'home',
  });
});
