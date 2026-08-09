import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { MsgItem, TranscriptItem } from '../types.js';
import { useT } from '../i18n/index.js';
import { useMinimapEnabled } from '../display-prefs.js';
import { transcriptItemIdentity } from './identity.js';

/**
 * Keep the right-edge outline outside the 820px transcript column. At narrower
 * panel widths the rail would sit on top of message text, so hide it entirely.
 */
const PANEL_MIN_WIDTH_PX = 960;
/** A compact outline is useful only once there is something to navigate. */
const MIN_MESSAGES = 3;
/** Codex keeps the outline as a compact stack rather than filling the screen. */
const MAX_STACK_HEIGHT_PX = 288;
const MARKER_GAP_PX = 15;
const LANDING_PX = 24;
const BOTTOM_PX = 40;

interface MinimapMarker {
  id: string;
  prompt: string;
  response: string;
  tickWidth: number;
}

interface MessageOffset {
  id: string;
  offset: number;
  height: number;
}

function previewText(text: string, limit: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > limit ? `${one.slice(0, limit)}…` : one;
}

function userPreview(item: MsgItem): string {
  if (item.text.trim()) return previewText(item.text, 160);
  const names = item.attachments?.map(attachment => attachment.name).filter(Boolean) ?? [];
  return names.length > 0 ? names.join(', ') : 'Message';
}

/**
 * Codex previews a conversation stop, not just an isolated prompt. Pair each
 * user message with the first assistant text before the next user message.
 */
export function projectMinimapMarkers(items: TranscriptItem[]): MinimapMarker[] {
  const markers: MinimapMarker[] = [];
  for (let index = 0; index < items.length; index++) {
    const item = items[index]!;
    if (item.kind !== 'user') continue;

    let response = '';
    for (let next = index + 1; next < items.length; next++) {
      const candidate = items[next]!;
      if (candidate.kind === 'user') break;
      if (candidate.kind === 'assistant' && candidate.text.trim()) {
        response = previewText(candidate.text, 260);
        break;
      }
    }

    const prompt = userPreview(item);
    // Codex's pale ticks vary with prompt density. Keep that signal bounded so
    // a long prompt never turns into the active-position bar by itself.
    const tickWidth = Math.min(24, Math.max(8, 8 + Math.round(Math.sqrt(prompt.length) * 1.25)));
    markers.push({ id: transcriptItemIdentity(item), prompt, response, tickWidth });
  }
  return markers;
}

function anchorIndexOf(offsets: { offset: number }[], scrollTop: number): number {
  let index = 0;
  for (let current = 0; current < offsets.length; current++) {
    if (offsets[current]!.offset <= scrollTop + LANDING_PX + 8) index = current;
    else break;
  }
  return index;
}

function messageNode(scrollEl: HTMLElement, id: string): HTMLElement | null {
  for (const node of scrollEl.querySelectorAll<HTMLElement>('[data-msg-id]')) {
    if (node.dataset.msgId === id) return node;
  }
  return null;
}

function measureMessageOffsets(
  scrollEl: HTMLElement,
  markers: MinimapMarker[],
): MessageOffset[] {
  return markers.flatMap(marker => {
    const node = messageNode(scrollEl, marker.id);
    return node ? [{ id: marker.id, offset: node.offsetTop, height: node.offsetHeight }] : [];
  });
}

function isMessageVisible(scrollEl: HTMLElement, offset: MessageOffset | undefined): boolean {
  return !!offset && offset.offset + offset.height > scrollEl.scrollTop;
}

/**
 * Codex-style transcript outline:
 *  - one compact right-edge tick per user turn;
 *  - resting ticks stay quiet; hovering the rail reveals their relative size;
 *  - hover/focus expands to the left with the prompt and first response;
 *  - click scrolls the transcript to that user turn.
 *
 * This component must be a direct child of `.main`. Its absolute rail is then
 * positioned against `.main`, while JS aligns its viewport to `.main-scroll`.
 * Gian keeps this compact Codex-style outline on the Chat Panel's right edge.
 */
export function TranscriptMinimap({ items }: { items: TranscriptItem[] }) {
  const t = useT();
  const minimapOn = useMinimapEnabled();
  const railRef = useRef<HTMLDivElement>(null);
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [roomy, setRoomy] = useState(false);
  const [viewportHeight, setViewportHeight] = useState(0);
  const offsetsRef = useRef<{ id: string; offset: number }[]>([]);
  const markers = useMemo(() => projectMinimapMarkers(items), [items]);
  const markerIds = markers.map(marker => marker.id).join('|');

  useEffect(() => {
    const main = railRef.current?.closest('.main');
    setScrollEl((main?.querySelector('.main-scroll') as HTMLElement | null) ?? null);
  }, []);

  useEffect(() => {
    if (!scrollEl) return;
    const mainEl = scrollEl.closest('.main') as HTMLElement | null;
    let measureRaf = 0;
    let scrollRaf = 0;

    const layout = () => {
      const height = scrollEl.clientHeight;
      setRoomy((mainEl?.clientWidth ?? scrollEl.clientWidth) >= PANEL_MIN_WIDTH_PX);
      setViewportHeight(height);
      if (!mainEl || !railRef.current) return;
      const scrollRect = scrollEl.getBoundingClientRect();
      const mainRect = mainEl.getBoundingClientRect();
      railRef.current.style.top = `${scrollRect.top - mainRect.top}px`;
      railRef.current.style.height = `${height}px`;
    };

    const updateActive = () => {
      const offsets = offsetsRef.current;
      setActiveId(offsets[anchorIndexOf(offsets, scrollEl.scrollTop)]?.id ?? null);
    };

    const measure = () => {
      offsetsRef.current = markers.flatMap(marker => {
        const node = messageNode(scrollEl, marker.id);
        return node ? [{ id: marker.id, offset: node.offsetTop }] : [];
      });
      layout();
      updateActive();
    };

    const onScroll = () => {
      if (scrollRaf) return;
      scrollRaf = requestAnimationFrame(() => {
        scrollRaf = 0;
        updateActive();
      });
    };
    const scheduleMeasure = () => {
      if (measureRaf) return;
      measureRaf = requestAnimationFrame(() => {
        measureRaf = 0;
        measure();
      });
    };

    scrollEl.addEventListener('scroll', onScroll, { passive: true });
    const resizeObserver = new ResizeObserver(scheduleMeasure);
    resizeObserver.observe(scrollEl);
    if (mainEl) resizeObserver.observe(mainEl);
    const transcript = scrollEl.querySelector('.transcript');
    if (transcript) resizeObserver.observe(transcript);
    measure();
    const initial = requestAnimationFrame(measure);

    return () => {
      scrollEl.removeEventListener('scroll', onScroll);
      resizeObserver.disconnect();
      cancelAnimationFrame(initial);
      if (scrollRaf) cancelAnimationFrame(scrollRaf);
      if (measureRaf) cancelAnimationFrame(measureRaf);
    };
    // Text streaming changes marker previews without changing their anchors;
    // the ResizeObserver handles transcript-height changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollEl, markerIds]);

  const jumpTo = (id: string) => {
    const node = scrollEl ? messageNode(scrollEl, id) : null;
    if (!node) return;
    scrollEl?.scrollTo({
      top: Math.max(0, node.offsetTop - LANDING_PX),
      behavior: 'smooth',
    });
  };

  const count = markers.length;
  const availableHeight = Math.max(72, viewportHeight - 48);
  const stackHeight = Math.min(
    MAX_STACK_HEIGHT_PX,
    availableHeight,
    Math.max(24, (count - 1) * MARKER_GAP_PX + 12),
  );
  const markerTop = (index: number) => count <= 1
    ? stackHeight / 2
    : 6 + (index / (count - 1)) * (stackHeight - 12);
  const showRail = !!scrollEl && minimapOn && roomy && count >= MIN_MESSAGES;

  return (
    <div
      className={`transcript-minimap${showRail ? '' : ' is-hidden'}`}
      ref={railRef}
      aria-hidden={!showRail}
    >
      {showRail && (
        <div className="tm-stack" style={{ height: `${stackHeight}px` }}>
          {markers.map((marker, index) => {
            const active = activeId === marker.id;
            return (
              <button
                key={marker.id}
                type="button"
                className={`tm-item${active ? ' active' : ''}`}
                style={{
                  top: `${markerTop(index)}px`,
                  '--tm-tick-width': `${marker.tickWidth}px`,
                } as CSSProperties}
                aria-label={`${t('minimap.jump')} ${index + 1}: ${marker.prompt}`}
                aria-current={active ? 'true' : undefined}
                onClick={() => jumpTo(marker.id)}
              >
                <span className="tm-tick" aria-hidden />
                <span className="tm-preview">
                  <span className="tm-preview-prompt">{marker.prompt}</span>
                  {marker.response && (
                    <span className="tm-preview-response">{marker.response}</span>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * The existing previous/next/bottom controls are independent from the optional
 * minimap preference. They live in the composer underbar and appear whenever a
 * user message is outside the current viewport (or the viewport is unpinned).
 */
export function TranscriptNavigation({ items }: { items: TranscriptItem[] }) {
  const t = useT();
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [navVisible, setNavVisible] = useState(false);
  const [canPrev, setCanPrev] = useState(false);
  const [canNext, setCanNext] = useState(false);
  const offsetsRef = useRef<MessageOffset[]>([]);
  const markers = useMemo(() => projectMinimapMarkers(items), [items]);
  const markerIds = markers.map(marker => marker.id).join('|');

  useEffect(() => {
    const main = anchorRef.current?.closest('.main');
    setScrollEl((main?.querySelector('.main-scroll') as HTMLElement | null) ?? null);
  }, []);

  useEffect(() => {
    if (!scrollEl) return;
    const mainEl = scrollEl.closest('.main') as HTMLElement | null;
    let measureRaf = 0;
    let scrollRaf = 0;

    const updateNavigation = () => {
      const offsets = offsetsRef.current;
      const top = scrollEl.scrollTop;
      const bottom = top + scrollEl.clientHeight;
      setAtBottom(scrollEl.scrollHeight - bottom <= BOTTOM_PX);
      setNavVisible(offsets.some(offset => (
        offset.offset + offset.height <= top || offset.offset >= bottom
      )));

      const index = anchorIndexOf(offsets, top);
      const current = offsets[index];
      setCanPrev(index > 0 || !isMessageVisible(scrollEl, current));
      setCanNext(offsets.length > 0 && index < offsets.length - 1);
    };

    const measure = () => {
      offsetsRef.current = measureMessageOffsets(scrollEl, markers);
      updateNavigation();
    };
    const onScroll = () => {
      if (scrollRaf) return;
      scrollRaf = requestAnimationFrame(() => {
        scrollRaf = 0;
        updateNavigation();
      });
    };
    const scheduleMeasure = () => {
      if (measureRaf) return;
      measureRaf = requestAnimationFrame(() => {
        measureRaf = 0;
        measure();
      });
    };

    scrollEl.addEventListener('scroll', onScroll, { passive: true });
    const resizeObserver = new ResizeObserver(scheduleMeasure);
    resizeObserver.observe(scrollEl);
    if (mainEl) resizeObserver.observe(mainEl);
    const transcript = scrollEl.querySelector('.transcript');
    if (transcript) resizeObserver.observe(transcript);
    measure();
    const initial = requestAnimationFrame(measure);

    return () => {
      scrollEl.removeEventListener('scroll', onScroll);
      resizeObserver.disconnect();
      cancelAnimationFrame(initial);
      if (scrollRaf) cancelAnimationFrame(scrollRaf);
      if (measureRaf) cancelAnimationFrame(measureRaf);
    };
    // ResizeObserver covers streamed content whose anchors do not change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollEl, markerIds]);

  const scrollToOffset = (offset: number) => {
    scrollEl?.scrollTo({
      top: Math.max(0, offset - LANDING_PX),
      behavior: 'smooth',
    });
  };
  const goPrev = () => {
    if (!scrollEl) return;
    const offsets = offsetsRef.current;
    const index = anchorIndexOf(offsets, scrollEl.scrollTop);
    const current = offsets[index];
    if (current && !isMessageVisible(scrollEl, current)) {
      scrollToOffset(current.offset);
      return;
    }
    const previous = offsets[index - 1];
    if (previous) scrollToOffset(previous.offset);
  };
  const goNext = () => {
    if (!scrollEl) return;
    const offsets = offsetsRef.current;
    const next = offsets[anchorIndexOf(offsets, scrollEl.scrollTop) + 1];
    if (next) scrollToOffset(next.offset);
  };
  const scrollToBottom = () => {
    scrollEl?.scrollTo({ top: scrollEl.scrollHeight, behavior: 'smooth' });
  };

  return (
    <>
      <span ref={anchorRef} hidden />
      {(navVisible || !atBottom) && (
        <div className="transcript-navbtns">
          {!atBottom && (
            <button
              type="button"
              className="tn-btn"
              onClick={scrollToBottom}
              title={t('minimap.scrollBottom')}
              aria-label={t('minimap.scrollBottom')}
            >
              <svg viewBox="0 0 16 16" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3 4.5l5 5 5-5" />
                <path d="M3 8.5l5 5 5-5" />
              </svg>
            </button>
          )}
          {navVisible && (
            <>
              <button
                type="button"
                className="tn-btn"
                onClick={goPrev}
                disabled={!canPrev}
                title={t('minimap.prev')}
                aria-label={t('minimap.prev')}
              >
                <svg viewBox="0 0 16 16" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M4 10l4-4 4 4" />
                </svg>
              </button>
              <button
                type="button"
                className="tn-btn"
                onClick={goNext}
                disabled={!canNext}
                title={t('minimap.next')}
                aria-label={t('minimap.next')}
              >
                <svg viewBox="0 0 16 16" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M4 6l4 4 4-4" />
                </svg>
              </button>
            </>
          )}
        </div>
      )}
    </>
  );
}
