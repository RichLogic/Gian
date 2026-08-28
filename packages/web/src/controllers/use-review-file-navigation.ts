import { useCallback, useEffect, useState, type RefObject } from 'react';

function fileElement(root: HTMLElement, path: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`.cs-file[data-path="${CSS.escape(path)}"]`);
}

/** Last file whose header has reached the bottom edge of the pinned header. */
export function reviewFileIndexAtAnchor(fileTops: readonly number[], anchorTop: number): number {
  if (fileTops.length === 0) return -1;
  let active = 0;
  for (let index = 0; index < fileTops.length; index += 1) {
    if (fileTops[index]! > anchorTop) break;
    active = index;
  }
  return active;
}

export function useReviewFileNavigation(
  rootRef: RefObject<HTMLDivElement | null>,
  paths: readonly string[],
) {
  const [activeIndex, setActiveIndex] = useState(0);
  const pathKey = paths.join('\u0000');

  useEffect(() => {
    setActiveIndex(current => Math.max(0, Math.min(current, paths.length - 1)));
  }, [pathKey, paths.length]);

  useEffect(() => {
    const root = rootRef.current;
    const scroller = root?.closest<HTMLElement>('.sheet-content');
    if (!root || !scroller || paths.length === 0) return;
    const update = () => {
      const pinned = root.querySelector<HTMLElement>('.cs-pinned-head');
      const anchorTop = pinned?.getBoundingClientRect().bottom
        ?? scroller.getBoundingClientRect().top;
      const tops = paths.map(path => fileElement(root, path)?.getBoundingClientRect().top ?? Infinity);
      const next = reviewFileIndexAtAnchor(tops, anchorTop);
      if (next >= 0) setActiveIndex(next);
    };
    update();
    scroller.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      scroller.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, [pathKey, paths, rootRef]);

  const go = useCallback((delta: -1 | 1) => {
    const root = rootRef.current;
    if (!root || paths.length === 0) return;
    const next = Math.max(0, Math.min(activeIndex + delta, paths.length - 1));
    const target = fileElement(root, paths[next]!);
    if (!target) return;
    target.scrollIntoView({ block: 'start' });
    setActiveIndex(next);
  }, [activeIndex, paths, rootRef]);

  return {
    activeIndex,
    canPrevious: paths.length > 0 && activeIndex > 0,
    canNext: paths.length > 0 && activeIndex < paths.length - 1,
    previous: () => go(-1),
    next: () => go(1),
  };
}
