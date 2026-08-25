import { Fragment } from 'react';
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
 */
export function EventFeed({ items }: { items: TranscriptItem[] }) {
  return (
    <section className="chat-context-feed" data-testid="chat-event-feed">
      {items.map(item => (
        <EventFeedRow key={transcriptItemIdentity(item)} item={item} />
      ))}
    </section>
  );
}

/** Long details keep the transcript's capped, scrolling detail form. */
const FEED_DETAIL_SCROLL_LINES = 16;

function EventFeedRow({ item }: { item: TranscriptItem }) {
  const { open, toggle } = useStableExpand();
  if (item.kind === 'approval') return <ApprovalLine item={item} />;
  const text = eventDetailText(item);
  if (!text) return <EventLine item={item} />;
  const scroll = text.split('\n').length > FEED_DETAIL_SCROLL_LINES;
  // Colored hunks only when hunks actually exist; a hunk-less diff (stats
  // only) falls back to the text form so the expansion is never empty.
  const hasHunks = item.kind === 'diff' && item.files.some(f => f.hunks.length > 0);
  return (
    <>
      <EventLine item={item} expand={{ open, toggle }} />
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
