import { useRef } from 'react';

interface Props {
  axis?: 'x' | 'y';
  side?: 'left' | 'right';
  varName: string;
  base: number;
  min?: number;
  max?: number;
  /** When true (right-anchored panels like Sheet/Inspector), drag direction is inverted. */
  invert?: boolean;
}

/** V2 Splitter — 4px drag handle that updates a CSS custom property on body
 *  during drag for live layout. Matches design/gian-design-v2/js/components.jsx
 *  verbatim. */
export function Splitter({ axis = 'x', side = 'left', varName, base, min = 160, max = 800, invert = false }: Props) {
  const isY = axis === 'y';
  const ref = useRef<HTMLDivElement>(null);

  function onMouseDown(e: React.MouseEvent) {
    e.preventDefault();
    const node = ref.current;
    if (node) node.classList.add('dragging');
    const start = isY ? e.clientY : e.clientX;
    const cur = parseInt(getComputedStyle(document.body).getPropertyValue(varName)) || base;
    function onMove(ev: MouseEvent) {
      const pos = isY ? ev.clientY : ev.clientX;
      const d = (pos - start) * (invert ? -1 : 1);
      const w = Math.max(min, Math.min(max, cur + d));
      document.body.style.setProperty(varName, w + 'px');
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      if (node) node.classList.remove('dragging');
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.cursor = isY ? 'row-resize' : 'col-resize';
    document.body.style.userSelect = 'none';
  }

  return <div ref={ref} className={`splitter ${isY ? 'h' : side}`} onMouseDown={onMouseDown} />;
}
