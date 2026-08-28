import { Fragment, useLayoutEffect, useRef } from 'react';
import type { DiffItem, TranscriptItem } from '../types.js';
import { useStableExpand } from './items.js';
import { ApprovalLine } from './approval-cards.js';
import { eventDetailText, EventLine } from './event-lines.js';
import { transcriptItemIdentity } from './identity.js';

/**
 * The panel-2 event feed (2026-08-24): the event box expanded into
 * ChatContextPanel. Same live projection as the box, rendered as full-width
 * rows that expand IN PLACE (`.trow-detail` below the row, same grammar as
 * the transcript's level-2 rows) — no navigation to a separate detail
 * view, no extra layer. Every row has SOME detail: the structured payload
 * when one exists, otherwise the raw-item JSON dump. Resolved approval
 * lines stay static (they already are the full record).
 *
 * `anchorId` (2026-08-27): a transcript item identity the feed locates
 * after render — the row scrolls into view and flashes once
 * (`.trow.is-anchor-flash`, ~1.6s × 2). The turn work block sets it when a
 * preview row is clicked.
 */
export function EventFeed({ items, anchorId }: { items: TranscriptItem[]; anchorId?: string }) {
  const rowsRef = useRef(new Map<string, HTMLElement>());
  useLayoutEffect(() => {
    if (!anchorId) return;
    const el = rowsRef.current.get(anchorId);
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    el.classList.add('is-anchor-flash');
    const timer = window.setTimeout(() => el.classList.remove('is-anchor-flash'), 3_400);
    return () => {
      window.clearTimeout(timer);
      el.classList.remove('is-anchor-flash');
    };
  }, [anchorId]);
  return (
    <section className="chat-context-feed" data-testid="chat-event-feed">
      {items.map(item => {
        const id = transcriptItemIdentity(item);
        return (
          <EventFeedRow
            key={id}
            item={item}
            rowRef={(el) => {
              if (el) rowsRef.current.set(id, el);
              else rowsRef.current.delete(id);
            }}
          />
        );
      })}
    </section>
  );
}

/** Long details keep the transcript's capped, scrolling detail form. */
const FEED_DETAIL_SCROLL_LINES = 16;

function EventFeedRow({
  item,
  rowRef,
}: {
  item: TranscriptItem;
  rowRef?: (el: HTMLElement | null) => void;
}) {
  const { open, toggle } = useStableExpand();
  if (item.kind === 'approval') return <ApprovalLine item={item} />;
  const text = eventDetailText(item);
  if (!text) return <EventLine item={item} rowRef={rowRef} />;
  const scroll = text.split('\n').length > FEED_DETAIL_SCROLL_LINES;
  // Colored hunks only when hunks actually exist; a hunk-less diff (stats
  // only) falls back to the text form so the expansion is never empty.
  const hasHunks = item.kind === 'diff' && item.files.some(f => f.hunks.length > 0);
  return (
    <>
      <EventLine item={item} expand={{ open, toggle }} rowRef={rowRef} />
      {open && (
        hasHunks && item.kind === 'diff'
          ? <DiffDetail item={item} />
          : (
            <div className={`trow-detail${scroll ? ' scroll' : ''}`}>
              <pre className="tool-output">{text}</pre>
            </div>
          )
      )}
    </>
  );
}

/** Same colored hunk rendering as the transcript's inline mini-diff, per
 *  file, so a feed diff row expands to exactly what the transcript would
 *  have shown. */
function DiffDetail({ item }: { item: DiffItem }) {
  return (
    <div className="trow-detail diff">
      {item.files.map((file, fi) => (
        <Fragment key={fi}>
          {item.files.length > 1 && (
            <div className="dline ctx">
              <span className="dsign"> </span>
              <span className="dtext">{file.path}  +{file.add} −{file.del}</span>
            </div>
          )}
          {file.hunks.map((h, hi) => (
            <Fragment key={hi}>
              <div className="dline hunk">{h.header}</div>
              {h.lines.map((l, li) => (
                <div key={li} className={`dline ${l.kind}`}>
                  <span className="dsign">{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}</span>
                  <span className="dtext">{l.text}</span>
                </div>
              ))}
            </Fragment>
          ))}
        </Fragment>
      ))}
    </div>
  );
}
