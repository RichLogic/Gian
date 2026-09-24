/**
 * Theme resolution — the `system` setting tracks the OS dark-mode preference
 * live via `prefers-color-scheme`; its light side is the user's chosen light
 * theme (default warm). Everything else passes through unchanged.
 */

import { useSyncExternalStore } from 'react';
import type { SystemConfig } from '@gian/shared';

/** Concrete themes the tokens bind to (`body[data-theme]`). */
export type ResolvedTheme = 'light' | 'warm' | 'dark';

export function resolveTheme(
  theme: SystemConfig['theme'],
  systemDark: boolean,
  systemLight: 'light' | 'warm' = 'warm',
): ResolvedTheme {
  if (theme !== 'system') return theme;
  return systemDark ? 'dark' : systemLight;
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
