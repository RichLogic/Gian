import { useEffect, useState } from 'react';

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
  maxPx: number,
  direction: 'left' | 'right' = 'left',
) {
  const [width, setWidth] = useState(() => {
    if (typeof window === 'undefined') return defaultPx;
    const stored = window.localStorage.getItem(key);
    if (!stored) return defaultPx;
    const n = Number(stored);
    if (!Number.isFinite(n)) return defaultPx;
    return Math.max(minPx, Math.min(maxPx, n));
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
    const startX = e.clientX;
    const startWidth = width;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX;
      const next = direction === 'left'
        ? startWidth + delta
        : startWidth - delta;
      setWidth(Math.max(minPx, Math.min(maxPx, next)));
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
    />
  );
}
