import { useCallback, useSyncExternalStore } from 'react';
import { useT } from '../i18n/index.js';

const WRAP_KEY = 'gian.sheet.wordwrap';
const SPLIT_KEY = 'gian.sheet.diffsplit';

const subscribers = new Set<() => void>();

function readBool(key: string, fallback: boolean): boolean {
  try {
    const value = localStorage.getItem(key);
    if (value === null) return fallback;
    return value === 'on' || value === 'true';
  } catch {
    return fallback;
  }
}

function subscribe(onStoreChange: () => void): () => void {
  subscribers.add(onStoreChange);
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === WRAP_KEY || event.key === SPLIT_KEY) onStoreChange();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    subscribers.delete(onStoreChange);
    window.removeEventListener('storage', onStorage);
  };
}

function writeBool(key: string, value: boolean): void {
  try { localStorage.setItem(key, value ? 'on' : 'off'); } catch { /* storage disabled */ }
  subscribers.forEach(notify => notify());
}

/** Shared panel-2 preferences. Diffs and History remain mounted while the
 *  user switches rails, so localStorage alone cannot keep their React state
 *  synchronized inside the same browser document. */
export function useDiffViewPreferences() {
  const wrap = useSyncExternalStore(
    subscribe,
    () => readBool(WRAP_KEY, true),
    () => true,
  );
  const split = useSyncExternalStore(
    subscribe,
    () => readBool(SPLIT_KEY, true),
    () => true,
  );
  const toggleWrap = useCallback(() => writeBool(WRAP_KEY, !readBool(WRAP_KEY, true)), []);
  const toggleSplit = useCallback(() => writeBool(SPLIT_KEY, !readBool(SPLIT_KEY, true)), []);

  return { wrap, split, toggleWrap, toggleSplit };
}

function DiffLayoutIcon({ split }: { split: boolean }) {
  return (
    <svg className="diff-layout-icon" data-icon={split ? 'side-by-side' : 'stacked'}
         viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
      <rect className="frame" x="0.75" y="0.75" width="14.5" height="14.5" rx="3" />
      {split ? (
        <>
          <rect className="old" x="3" y="3" width="4.25" height="10" rx="1" />
          <rect className="next" x="8.75" y="3" width="4.25" height="10" rx="1" />
        </>
      ) : (
        <>
          <rect className="old" x="3" y="3" width="10" height="4.25" rx="1" />
          <rect className="next" x="3" y="8.75" width="10" height="4.25" rx="1" />
        </>
      )}
    </svg>
  );
}

function WordWrapIcon() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor"
         strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3.5 6h17 M3.5 10h17 M3.5 14h10a3 3 0 1 1 0 6H11 M13.5 17.5L11 20l2.5 2.5 M3.5 18h4" />
    </svg>
  );
}

function FileArrowIcon({ direction }: { direction: 'previous' | 'next' }) {
  const d = direction === 'previous' ? 'M6 14l6-6 6 6' : 'M6 10l6 6 6-6';
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor"
         strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

export function FileNavigationControls({
  canPrevious,
  canNext,
  onPrevious,
  onNext,
}: {
  canPrevious: boolean;
  canNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
}) {
  const t = useT();
  return (
    <span className="diff-file-navigation">
      <button className="sheet-tabs-act" type="button" disabled={!canPrevious}
              aria-label={t('sheet.diff.previousFile')} title={t('sheet.diff.previousFile')}
              onClick={onPrevious}>
        <FileArrowIcon direction="previous" />
      </button>
      <button className="sheet-tabs-act" type="button" disabled={!canNext}
              aria-label={t('sheet.diff.nextFile')} title={t('sheet.diff.nextFile')}
              onClick={onNext}>
        <FileArrowIcon direction="next" />
      </button>
    </span>
  );
}

export function DiffViewControls({
  split,
  wrap,
  onToggleSplit,
  onToggleWrap,
}: {
  split: boolean;
  wrap: boolean;
  onToggleSplit: () => void;
  onToggleWrap: () => void;
}) {
  const t = useT();
  const layoutLabel = split ? t('sheet.diffview.toStacked') : t('sheet.diffview.toSplit');
  const wrapLabel = wrap ? t('sheet.wordwrap.disable') : t('sheet.wordwrap.enable');

  return (
    <>
      <button className="sheet-tabs-act diff-layout-toggle" type="button"
              aria-label={layoutLabel} title={layoutLabel} aria-pressed={split}
              data-layout={split ? 'side-by-side' : 'stacked'} onClick={onToggleSplit}>
        <DiffLayoutIcon split={split} />
      </button>
      <button className={`sheet-tabs-act diff-wrap-toggle${wrap ? ' active' : ''}`} type="button"
              aria-label={wrapLabel} title={wrapLabel} aria-pressed={wrap} onClick={onToggleWrap}>
        <WordWrapIcon />
      </button>
    </>
  );
}
