import { useEffect, useRef, useState } from 'react';
import type { MsgItem, TranscriptItem } from '../types.js';
import { useT } from '../i18n/index.js';
import { useMinimapEnabled } from '../display-prefs.js';

/** Side room (scroll width minus transcript width, halved) needed for the
 *  minimap rail to sit beside the centered transcript without covering
 *  message text. Below it the rail stays hidden. */
const PILL_MIN_GUTTER_PX = 190;
/** Not worth a minimap rail below this many of the user's own messages. */
const MIN_MESSAGES = 3;
/** A jumped-to message lands this far below the viewport top. */
const LANDING_PX = 24;

function snippet(s: string): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > 64 ? `${one.slice(0, 64)}…` : one;
}

/** Index of the message currently anchored at the viewport top. The window is
 *  wider than the landing offset so a freshly-jumped-to message reads as
 *  "current" rather than "the next one" — otherwise the next button no-ops on
 *  the message it just scrolled to. */
function anchorIndexOf(offs: { offset: number }[], scrollTop: number): number {
  let idx = 0;
  for (let i = 0; i < offs.length; i++) {
    if (offs[i]!.offset <= scrollTop + LANDING_PX + 8) idx = i; else break;
  }
  return idx;
}

/** True when the message row for `id` still has any part at/below the viewport
 *  top — i.e. it's actually on screen, not scrolled off above it. */
function isMsgVisible(scrollEl: HTMLElement, id: string | undefined): boolean {
  if (!id) return false;
  const node = scrollEl.querySelector(`[data-msg-id="${id}"]`) as HTMLElement | null;
  if (!node) return false;
  return node.offsetTop + node.offsetHeight > scrollEl.scrollTop;
}

/**
 * Navigation for your own messages in the transcript:
 *  - prev/next arrow buttons (always available) jump to the message above/below
 *    the current scroll position. They render INLINE in the underbar row the
 *    caller places this component in (next to the Plan/Agent chips, flush
 *    right) — no caption, no floating pill, same layout at any width;
 *  - an optional right-gutter minimap rail (toggled in Settings, off by
 *    default, only when the layout is wide enough) modelled on the ChatGPT
 *    "scrollbar/outline" extensions: one tick per message, spaced evenly by
 *    turn order, hover reveals the text, the current message stays
 *    highlighted.
 *
 * The rail is an absolute overlay anchored to `.main` (NOT a child of the
 * scroll container) so it stays put while the conversation scrolls. The nav
 * row is plain inline content. The only layout coupling is `data-msg-id` on
 * user message rows.
 */
export function TranscriptMinimap({ items }: { items: TranscriptItem[] }) {
  const t = useT();
  const minimapOn = useMinimapEnabled();
  const railRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLDivElement>(null);
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null);
  const [markers, setMarkers] = useState<{ id: string; label: string }[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [roomy, setRoomy] = useState(false);
  const [navVisible, setNavVisible] = useState(false);
  const [canPrev, setCanPrev] = useState(false);
  const [canNext, setCanNext] = useState(false);
  const offsetsRef = useRef<{ id: string; offset: number; height: number }[]>([]);

  useEffect(() => {
    setScrollEl((railRef.current?.closest('.main')?.querySelector('.main-scroll') as HTMLElement | null) ?? null);
  }, []);

  const userMsgs = items.filter((it): it is MsgItem => it.kind === 'user');
  const userKey = userMsgs.map(u => u.id).join('|');

  useEffect(() => {
    if (!scrollEl) return;
    const mainEl = scrollEl.closest('.main') as HTMLElement | null;
    let measureRaf = 0;
    let scrollRaf = 0;

    const layout = () => {
      const content = scrollEl.querySelector('.transcript') as HTMLElement | null;
      const contentW = content?.offsetWidth ?? scrollEl.clientWidth;
      setRoomy((scrollEl.clientWidth - contentW) / 2 >= PILL_MIN_GUTTER_PX);
      if (mainEl) {
        const sr = scrollEl.getBoundingClientRect();
        const mr = mainEl.getBoundingClientRect();
        const rail = railRef.current;
        if (rail) {
          rail.style.top = `${sr.top - mr.top}px`;
          rail.style.height = `${scrollEl.clientHeight}px`;
        }
      }
    };
    const updateNav = () => {
      const offs = offsetsRef.current;
      const top = scrollEl.scrollTop;
      const bottom = top + scrollEl.clientHeight;
      // The nav earns its place only when one of your messages is actually
      // off-screen (above the viewport top or below the bottom); when every
      // message fits on screen there is nothing to jump to.
      setNavVisible(offs.some(o => o.offset + o.height <= top || o.offset >= bottom));
      const i = anchorIndexOf(offs, top);
      const cur = offs[i];
      setActiveId(cur?.id ?? null);
      // "prev" can also re-show the current message when it has scrolled off the
      // top, so enable it whenever there's a message above OR the current one is
      // no longer visible. "next" is unchanged.
      setCanPrev(i > 0 || (!!cur && !isMsgVisible(scrollEl, cur.id)));
      setCanNext(offs.length > 0 && i < offs.length - 1);
    };
    const measure = () => {
      const offs: { id: string; offset: number; height: number }[] = [];
      const labels: { id: string; label: string }[] = [];
      for (const u of userMsgs) {
        const node = scrollEl.querySelector(`[data-msg-id="${u.id}"]`) as HTMLElement | null;
        if (!node) continue;
        offs.push({ id: u.id, offset: node.offsetTop, height: node.offsetHeight });
        labels.push({ id: u.id, label: snippet(u.text) });
      }
      offsetsRef.current = offs;
      setMarkers(labels);
      layout();
      updateNav();
    };

    const onScroll = () => {
      if (scrollRaf) return;
      scrollRaf = requestAnimationFrame(() => { scrollRaf = 0; updateNav(); });
    };
    const scheduleMeasure = () => {
      if (measureRaf) return;
      measureRaf = requestAnimationFrame(() => { measureRaf = 0; measure(); });
    };

    scrollEl.addEventListener('scroll', onScroll, { passive: true });
    const ro = new ResizeObserver(scheduleMeasure);
    ro.observe(scrollEl);
    if (mainEl) ro.observe(mainEl);
    const content = scrollEl.querySelector('.transcript');
    if (content) ro.observe(content);
    measure();
    const initial = requestAnimationFrame(measure);

    return () => {
      scrollEl.removeEventListener('scroll', onScroll);
      ro.disconnect();
      cancelAnimationFrame(initial);
      if (scrollRaf) cancelAnimationFrame(scrollRaf);
      if (measureRaf) cancelAnimationFrame(measureRaf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollEl, userKey]);

  const scrollToOffset = (offset: number) => {
    scrollEl?.scrollTo({ top: Math.max(0, offset - LANDING_PX), behavior: 'smooth' });
  };
  const jumpTo = (id: string) => {
    const node = scrollEl?.querySelector(`[data-msg-id="${id}"]`) as HTMLElement | null;
    if (node) scrollToOffset(node.offsetTop);
  };
  const goPrev = () => {
    if (!scrollEl) return;
    const offs = offsetsRef.current;
    const i = anchorIndexOf(offs, scrollEl.scrollTop);
    const cur = offs[i];
    // If the current (anchored) message has scrolled above the viewport, "prev"
    // re-shows IT first instead of skipping to the message above it.
    if (cur && !isMsgVisible(scrollEl, cur.id)) {
      scrollToOffset(cur.offset);
      return;
    }
    const target = offs[i - 1];
    if (target) scrollToOffset(target.offset);
  };
  const goNext = () => {
    if (!scrollEl) return;
    const target = offsetsRef.current[anchorIndexOf(offsetsRef.current, scrollEl.scrollTop) + 1];
    if (target) scrollToOffset(target.offset);
  };

  const n = markers.length;
  const showRail = !!scrollEl && minimapOn && roomy && n >= MIN_MESSAGES;
  const showNav = !!scrollEl && navVisible;

  return (
    <>
      <div className={`transcript-minimap${showRail ? '' : ' is-hidden'}`} ref={railRef} aria-hidden={!showRail}>
        {showRail && markers.map((m, i) => (
          <button
            key={m.id}
            type="button"
            className={`tm-item${activeId === m.id ? ' active' : ''}`}
            style={{ top: `${((i + 0.5) / n) * 100}%` }}
            aria-label={`${t('minimap.jump')} ${i + 1}`}
            onClick={() => jumpTo(m.id)}
          >
            <span className="tm-tick" />
            <span className="tm-label">{m.label}</span>
          </button>
        ))}
      </div>
      {showNav && (
        <div className="transcript-navbtns" ref={navRef}>
          <button type="button" className="tn-btn" onClick={goPrev} disabled={!canPrev} title={t('minimap.prev')} aria-label={t('minimap.prev')}>
            <svg viewBox="0 0 16 16" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4 10l4-4 4 4" />
            </svg>
          </button>
          <button type="button" className="tn-btn" onClick={goNext} disabled={!canNext} title={t('minimap.next')} aria-label={t('minimap.next')}>
            <svg viewBox="0 0 16 16" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4 6l4 4 4-4" />
            </svg>
          </button>
        </div>
      )}
    </>
  );
}
