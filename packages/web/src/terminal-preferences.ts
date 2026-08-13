import type { TerminalPreferences } from '@gian/shared';

export const TERMINAL_FONT_STACKS: Record<TerminalPreferences['font_family'], string> = {
  'jetbrains-mono': '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace',
  'system-mono': 'ui-monospace, "SF Mono", Menlo, Monaco, monospace',
  'sf-mono': '"SF Mono", ui-monospace, Menlo, Monaco, monospace',
  menlo: 'Menlo, Monaco, ui-monospace, monospace',
};

export interface MutableTerminalOptions {
  fontFamily?: string;
  fontSize?: number;
  lineHeight?: number;
  cursorStyle?: TerminalPreferences['cursor_style'];
  cursorBlink?: boolean;
  scrollback?: number;
}

export function terminalOptionsFromPreferences(
  preferences: TerminalPreferences,
): Required<MutableTerminalOptions> {
  return {
    fontFamily: TERMINAL_FONT_STACKS[preferences.font_family],
    fontSize: preferences.font_size,
    lineHeight: preferences.line_height,
    cursorStyle: preferences.cursor_style,
    cursorBlink: preferences.cursor_blink,
    scrollback: preferences.scrollback_lines,
  };
}

export function applyTerminalPreferences(
  target: MutableTerminalOptions,
  preferences: TerminalPreferences,
): void {
  Object.assign(target, terminalOptionsFromPreferences(preferences));
}
