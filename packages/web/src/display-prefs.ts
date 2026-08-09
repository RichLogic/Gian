import { useEffect, useState } from 'react';
import { desktopBridge } from './desktop-bridge.js';

/** Client-only display preferences (localStorage-backed, no server round-trip).
 *  These belong to the current device rather than a project/Host config. */

const MINIMAP_KEY = 'gian.transcript.minimap';
const MINIMAP_EVENT = 'gian:minimap-pref';
const ZOOM_KEY = 'gian.appearance.zoom-percent';
const ZOOM_EVENT = 'gian:zoom-pref';

export const MIN_ZOOM_PERCENT = 80;
export const MAX_ZOOM_PERCENT = 150;
export const ZOOM_STEP_PERCENT = 10;
export const DEFAULT_ZOOM_PERCENT = 100;

export function normalizeZoomPercent(value: unknown): number {
  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== ''
      ? Number(value)
      : Number.NaN;
  const safe = Number.isFinite(numeric) ? numeric : DEFAULT_ZOOM_PERCENT;
  const stepped = Math.round(safe / ZOOM_STEP_PERCENT) * ZOOM_STEP_PERCENT;
  return Math.min(MAX_ZOOM_PERCENT, Math.max(MIN_ZOOM_PERCENT, stepped));
}

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

export function getZoomPercent(): number {
  try {
    return normalizeZoomPercent(localStorage.getItem(ZOOM_KEY));
  } catch {
    return DEFAULT_ZOOM_PERCENT;
  }
}

/** Save and announce a zoom change. Returns the normalized value. */
export function setZoomPercent(value: unknown): number {
  const percent = normalizeZoomPercent(value);
  const previous = getZoomPercent();
  try {
    localStorage.setItem(ZOOM_KEY, String(percent));
  } catch {
    /* localStorage may be unavailable (privacy mode) */
  }
  if (previous !== percent) window.dispatchEvent(new CustomEvent(ZOOM_EVENT));
  return percent;
}

export function useZoomPercent(): number {
  const [percent, setPercent] = useState(getZoomPercent);
  useEffect(() => {
    const handler = () => setPercent(getZoomPercent());
    window.addEventListener(ZOOM_EVENT, handler);
    window.addEventListener('storage', handler);
    return () => {
      window.removeEventListener(ZOOM_EVENT, handler);
      window.removeEventListener('storage', handler);
    };
  }, []);
  return percent;
}

/**
 * Mount once at App scope. Electron owns the real page zoom; browser-only
 * development uses CSS zoom so the Appearance control remains previewable.
 * Native Cmd +/- changes are mirrored back into the same local preference.
 */
export function useAppZoom(): void {
  const percent = useZoomPercent();

  useEffect(() => {
    const zoom = desktopBridge()?.zoom;
    if (!zoom) return;
    return zoom.onChanged(next => { setZoomPercent(next); });
  }, []);

  useEffect(() => {
    const zoom = desktopBridge()?.zoom;
    if (zoom) {
      document.documentElement.style.removeProperty('zoom');
      document.documentElement.style.removeProperty('--gian-browser-viewport-width');
      document.documentElement.style.removeProperty('--gian-browser-viewport-height');
      void zoom.set(percent).then(applied => {
        if (typeof applied === 'number') setZoomPercent(applied);
      });
      return;
    }
    const scale = percent / 100;
    document.documentElement.style.zoom = String(scale);
    // CSS `zoom` enlarges a 100vw/100vh child beyond the physical viewport.
    // Compensate the app shell's logical size so zoom behaves like native page
    // zoom: text grows, while every panel remains inside the usable window.
    document.documentElement.style.setProperty('--gian-browser-viewport-width', `${100 / scale}vw`);
    document.documentElement.style.setProperty('--gian-browser-viewport-height', `${100 / scale}vh`);
  }, [percent]);
}
