import { useContext } from 'react';
import { useT } from '../i18n/index.js';
import { ChatPanelOpenContext } from '../presentation/chat-panel.js';
import type { TranscriptItem } from '../types.js';
import { EventLine } from './event-lines.js';
import { transcriptItemIdentity } from './identity.js';

/**
 * The event box (2026-08-24): one in-flight turn's LATEST EVENT_BOX_LINES
 * events, as a live tail — every event is exactly one line (`.trow-subject`
 * is nowrap/ellipsis), so 5 rows always means the 5 most recent events; a
 * newer event pushes the oldest visible one out the top. No internal
 * scroll: the box never clips a row, and anything older is one click away
 * in panel 2. The header (breathing live dot + label + TOTAL event count,
 * including the ones not shown) is part of the whole-box click target that
 * routes the same live item set to panel 2 as `{kind:'event-feed'}`. When
 * the turn ends, the turnsum fold takes over these items and the box
 * disappears.
 */

/** Events visible in the box; every event is one line, so this is both the
 *  row count and the event count. */
export const EVENT_BOX_LINES = 5;
export function EventBox({
  block,
}: {
  block: { turn: number; items: TranscriptItem[] };
}) {
  const t = useT();
  const openChatPanel = useContext(ChatPanelOpenContext);
  const visible = block.items.slice(-EVENT_BOX_LINES);
  const open = () => openChatPanel?.({ kind: 'event-feed', turn: block.turn });

  return (
    <div
      className="eventbox"
      data-testid="event-box"
      data-turn={block.turn}
      {...(openChatPanel
        ? {
            role: 'button',
            tabIndex: 0,
            title: t('transcript.eventbox.open'),
            onClick: open,
            onKeyDown: (e: React.KeyboardEvent) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                open();
              }
            },
          }
        : {})}
    >
      <div className="eventbox-head">
        <span className="eventbox-live" aria-hidden />
        <span className="eventbox-title">{t('chatPanel.eventFeed.title')}</span>
        <span className="eventbox-count">
          {block.items.length} {t(block.items.length === 1 ? 'transcript.turnsum.action' : 'transcript.turnsum.actions')}
        </span>
        {openChatPanel && <span className="eventbox-ext">⇥ panel</span>}
      </div>
      <div className="eventbox-body">
        {visible.map(item => (
          <EventLine key={transcriptItemIdentity(item)} item={item} />
        ))}
      </div>
    </div>
  );
}
