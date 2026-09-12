import { useEffect, useRef, useState } from 'react';

export interface RailLayoutController {
  width: number;
  collapsed: boolean;
  setCollapsed: (next: boolean) => void;
  onMouseDown: (e: React.MouseEvent) => void;
}

/**
 * Drag-to-resize a horizontal pane width, persisted to localStorage.
 *
 * `direction: 'left'` means the pane sits to the LEFT of the splitter
 * (dragging the splitter right grows the pane). `direction: 'right'` flips it
 * for right-side panels.
 */
export function useResizableWidth(
  key: string,
  defaultPx: number,
  minPx: number,
  maxPx: number | (() => number),
  direction: 'left' | 'right' = 'left',
) {
  const [width, setWidth] = useState(() => {
    if (typeof window === 'undefined') return defaultPx;
    const stored = window.localStorage.getItem(key);
    if (!stored) return defaultPx;
    const n = Number(stored);
    if (!Number.isFinite(n)) return defaultPx;
    const max = typeof maxPx === 'function' ? maxPx() : maxPx;
    return Math.max(minPx, Math.min(max, n));
  });
  const [collapsed, setCollapsedState] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(`${key}.collapsed`) === '1';
  });

  useEffect(() => {
    window.localStorage.setItem(key, String(width));
  }, [key, width]);
  useEffect(() => {
    window.localStorage.setItem(`${key}.collapsed`, collapsed ? '1' : '0');
  }, [key, collapsed]);

  const setCollapsed = (next: boolean) => setCollapsedState(next);

  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    // A function maxPx is evaluated at drag start, so the cap can follow the
    // live container width (panel-2's chat-style quarter-floor rule).
    const max = typeof maxPx === 'function' ? maxPx() : maxPx;
    const startX = e.clientX;
    const startWidth = width;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX;
      const next = direction === 'left'
        ? startWidth + delta
        : startWidth - delta;
      setWidth(Math.max(minPx, Math.min(max, next)));
    };
    const onUp = () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return { width, collapsed, setCollapsed, onMouseDown };
}

/** Panel-2 (detail sheet) width on the primary pages (Agents / Custom /
 *  Timer): until the user drags, the CSS `clamp(440px, 42vw, 640px)` stays
 *  the fluid baseline; the first drag pins an explicit width that persists.
 *  The drag cap follows the chat middle pair's rule — panel 2 may take up to
 *  3/4 of the main+panel-2 pair (the main pane keeps its quarter floor), so
 *  wide windows are no longer hard-capped at 640px (2026-09-06 owner call).
 *  `useResizableWidth` writes the width key on mount, so "the user chose
 *  this" needs its own marker. */
export const P2_WIDTH_KEY = 'gian.p2.w';
const P2_WIDTH_CUSTOM_KEY = 'gian.p2.w.custom';

export function usePanel2Width() {
  const pairWidthRef = useRef(0);
  const base = useResizableWidth(P2_WIDTH_KEY, 440, 340, () => {
    const pair = pairWidthRef.current;
    return pair > 0 ? Math.max(340, Math.round(pair * 0.75)) : 640;
  }, 'right');
  const [customized, setCustomized] = useState(() =>
    typeof window !== 'undefined'
    && window.localStorage.getItem(P2_WIDTH_CUSTOM_KEY) === '1');

  const onMouseDown = (e: React.MouseEvent) => {
    // Measure the main|panel-2 pair (the splitter's flex parent) at drag
    // start — the cap function reads it synchronously inside the drag.
    const container = (e.currentTarget as HTMLElement).parentElement;
    pairWidthRef.current = container?.getBoundingClientRect().width ?? 0;
    if (!customized) {
      setCustomized(true);
      try { window.localStorage.setItem(P2_WIDTH_CUSTOM_KEY, '1'); }
      catch { /* localStorage full / disabled — the width itself still drags */ }
    }
    base.onMouseDown(e);
  };

  return { width: base.width, customized, onMouseDown };
}

/**
 * Drag handle sitting on the seam between sidebar and main pane. Designed for
 * the `.view` shell: parent is `position: relative` and exposes `--rail-w`
 * for the sidebar's current width; the handle is absolute-positioned in the
 * middle of the flex `gap`.
 */
export function RailSplitter({
  onMouseDown,
  ariaLabel = 'Resize panel',
}: {
  onMouseDown: (e: React.MouseEvent) => void;
  ariaLabel?: string;
}) {
  return (
    <div
      className="view-splitter"
      onMouseDown={onMouseDown}
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      data-panel-seam="sidebar-main"
    />
  );
}
