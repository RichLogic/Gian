/**
 * Theme resolution — the `system` setting tracks the OS dark-mode preference
 * live via `prefers-color-scheme`. Everything else passes through unchanged.
 */

import { useSyncExternalStore } from 'react';
import type { ThemeName } from './controller/types.js';

/** Concrete themes the tokens bind to (`body[data-theme]`). */
export type ResolvedTheme = 'light' | 'warm' | 'dark';

export function resolveTheme(theme: ThemeName, systemDark: boolean): ResolvedTheme {
  if (theme === 'system') return systemDark ? 'dark' : 'light';
  return theme;
}

export function useSystemDark(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia('(prefers-color-scheme: dark)');
      query.addEventListener('change', onChange);
      return () => query.removeEventListener('change', onChange);
    },
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
    () => false,
  );
}
