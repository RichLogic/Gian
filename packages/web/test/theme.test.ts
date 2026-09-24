// Theme resolution (Appearance phase 2): the `system` setting resolves
// against the live OS dark-mode preference and the user's chosen light
// theme; concrete themes pass through untouched.

import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { resolveTheme, useSystemDark } from '../src/theme.js';

describe('resolveTheme', () => {
  it('passes concrete themes through regardless of the OS preference', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('light', false)).toBe('light');
    expect(resolveTheme('warm', true)).toBe('warm');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('resolves system to dark when the OS prefers dark, ignoring the light pick', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', true, 'light')).toBe('dark');
    expect(resolveTheme('system', true, 'warm')).toBe('dark');
  });

  it('resolves system to the chosen light theme in OS light mode, default warm', () => {
    expect(resolveTheme('system', false)).toBe('warm');
    expect(resolveTheme('system', false, 'light')).toBe('light');
    expect(resolveTheme('system', false, 'warm')).toBe('warm');
  });
});

describe('useSystemDark', () => {
  it('tracks prefers-color-scheme changes live', () => {
    let dark = false;
    let listener: (() => void) | null = null;
    vi.stubGlobal('matchMedia', vi.fn().mockImplementation((query: string) => ({
      matches: dark,
      media: query,
      onchange: null,
      addEventListener: (_event: string, callback: () => void) => {
        listener = callback;
      },
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })));

    const { result } = renderHook(() => useSystemDark());
    expect(result.current).toBe(false);

    act(() => {
      dark = true;
      listener?.();
    });
    expect(result.current).toBe(true);

    act(() => {
      dark = false;
      listener?.();
    });
    expect(result.current).toBe(false);
    vi.unstubAllGlobals();
  });
});
