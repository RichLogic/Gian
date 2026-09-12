/**
 * Viewport mode — drives the three layout tiers (§12.1/§12.2):
 *   wide   >= 1200px   rail + chat + optional file panel
 *   mid    768–1199px  rail + chat; file/settings replace the main panel
 *   narrow < 768px     single column; rail/file/settings are full pages
 *
 * Tests and fixtures can pin the mode through ViewportProvider instead of
 * relying on jsdom's matchMedia stub.
 */

import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';

export type ViewportMode = 'wide' | 'mid' | 'narrow';

const Ctx = createContext<ViewportMode | null>(null);

function currentMode(): ViewportMode {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return 'wide';
  if (window.matchMedia('(min-width: 1200px)').matches) return 'wide';
  if (window.matchMedia('(min-width: 768px)').matches) return 'mid';
  return 'narrow';
}

export function ViewportProvider({
  value,
  children,
}: {
  /** Pinned mode for tests/screenshots; omit to track the real viewport. */
  value?: ViewportMode;
  children: ReactNode;
}) {
  const [tracked, setTracked] = useState<ViewportMode>(currentMode);
  useEffect(() => {
    if (value) return;
    const wide = window.matchMedia('(min-width: 1200px)');
    const mid = window.matchMedia('(min-width: 768px)');
    const onChange = () => setTracked(currentMode());
    wide.addEventListener('change', onChange);
    mid.addEventListener('change', onChange);
    return () => {
      wide.removeEventListener('change', onChange);
      mid.removeEventListener('change', onChange);
    };
  }, [value]);
  return <Ctx.Provider value={value ?? tracked}>{children}</Ctx.Provider>;
}

export function useViewportMode(): ViewportMode {
  const mode = useContext(Ctx);
  if (!mode) throw new Error('ViewportProvider is missing');
  return mode;
}
