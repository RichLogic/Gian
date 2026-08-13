import { describe, expect, it } from 'vitest';
import { DEFAULT_TERMINAL_PREFERENCES } from '@gian/shared';
import {
  applyTerminalPreferences,
  terminalOptionsFromPreferences,
} from '../src/terminal-preferences.js';

describe('terminal preferences', () => {
  it('maps every persisted visual preference to xterm options', () => {
    expect(terminalOptionsFromPreferences({
      ...DEFAULT_TERMINAL_PREFERENCES,
      font_family: 'menlo',
      font_size: 17,
      line_height: 1.35,
      cursor_style: 'underline',
      cursor_blink: false,
      scrollback_lines: 50_000,
    })).toEqual({
      fontFamily: 'Menlo, Monaco, ui-monospace, monospace',
      fontSize: 17,
      lineHeight: 1.35,
      cursorStyle: 'underline',
      cursorBlink: false,
      scrollback: 50_000,
    });
  });

  it('updates an existing xterm option object in place', () => {
    const options = { fontSize: 12, cursorBlink: true };
    applyTerminalPreferences(options, {
      ...DEFAULT_TERMINAL_PREFERENCES,
      font_size: 15,
      cursor_blink: false,
    });
    expect(options).toMatchObject({
      fontSize: 15,
      lineHeight: 1.2,
      cursorBlink: false,
      scrollback: 5_000,
    });
  });
});
