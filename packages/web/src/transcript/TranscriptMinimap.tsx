import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { MsgItem, TranscriptItem } from '../types.js';
import { useT } from '../i18n/index.js';
import { useMinimapEnabled } from '../display-prefs.js';

/** Hide the right-edge outline before it would overlap the transcript body. */
const PANEL_MIN_WIDTH_PX = 640;
/** A compact outline is useful only once there is something to navigate. */
const MIN_MESSAGES = 3;
/** Codex keeps the outline as a compact stack rather than filling the screen. */
const MAX_STACK_HEIGHT_PX = 288;
const MARKER_GAP_PX = 15;
const LANDING_PX = 24;

interface MinimapMarker {
  id: string;
  prompt: string;
  response: string;
  tickWidth: number;
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
    markers.push({ id: item.id, prompt, response, tickWidth });
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

/**
 * Codex-style transcript outline:
 *  - one compact right-edge tick per user turn;
 *  - tick length hints at prompt size, while the current turn is dark/long;
 *  - hover/focus previews both the prompt and the first assistant response;
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
