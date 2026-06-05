import { useEffect, useState } from 'react';

/** Client-only display preferences (localStorage-backed, no server round-trip).
 *  Currently just the transcript minimap rail toggle. */

const MINIMAP_KEY = 'gian.transcript.minimap';
const MINIMAP_EVENT = 'gian:minimap-pref';

export function getMinimapEnabled(): boolean {
  try {
    return localStorage.getItem(MINIMAP_KEY) === '1';
  } catch {
    return false;
  }
}

export function setMinimapEnabled(on: boolean): void {
  try {
    localStorage.setItem(MINIMAP_KEY, on ? '1' : '0');
  } catch {
    /* localStorage may be unavailable (privacy mode) */
  }
  // Same-tab listeners don't get the native `storage` event — fire our own.
  window.dispatchEvent(new CustomEvent(MINIMAP_EVENT));
}

/** Subscribe to the minimap toggle (reacts to same-tab + cross-tab changes). */
export function useMinimapEnabled(): boolean {
  const [on, setOn] = useState(getMinimapEnabled);
  useEffect(() => {
    const handler = () => setOn(getMinimapEnabled());
    window.addEventListener(MINIMAP_EVENT, handler);
    window.addEventListener('storage', handler);
    return () => {
      window.removeEventListener(MINIMAP_EVENT, handler);
      window.removeEventListener('storage', handler);
    };
  }, []);
  return on;
}
