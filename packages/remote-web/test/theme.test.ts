import { describe, expect, it } from 'vitest';
import { resolveTheme } from '../src/theme.js';

describe('resolveTheme', () => {
  it('passes concrete themes through unchanged', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('warm', true)).toBe('warm');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('maps system onto the OS dark-mode preference', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });
});
