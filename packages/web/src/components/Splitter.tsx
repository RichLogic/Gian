interface Props {
  axis?: 'x' | 'y';
  side?: 'left' | 'right';
  seam: 'main-sheet' | 'sheet-inspector';
  onMouseDown: (event: React.MouseEvent<HTMLDivElement>) => void;
  ariaLabel: string;
}

/** V2 Splitter — layout math is owned by the four-panel controller. */
export function Splitter({ axis = 'x', side = 'left', seam, onMouseDown, ariaLabel }: Props) {
  const isY = axis === 'y';
  return (
    <div
      className={`splitter ${isY ? 'h' : side}`}
      onMouseDown={onMouseDown}
      role="separator"
      aria-orientation={isY ? 'horizontal' : 'vertical'}
      aria-label={ariaLabel}
      data-panel-seam={seam}
    />
  );
}
