/**
 * TraceView — the session's Trace tab (Trace view rework, 2026-08-19).
 *
 * Layout: the three-lane `TraceTimeline` on top, below it the event list
 * grouped by turn (stable chronological order, turn headers with title /
 * status / duration). Within a turn, `kind: 'step'` items render as
 * collapsible groups: the header row carries a caret, the step's own status
 * badge and its duration (only when the item reports `durationMs`), and the
 * items that named it via `parentId` nest indented underneath with the same
 * row interactions as top-level rows. A row shows a colored kind chip, a
 * one-line title
 * with a dimmed summary, and the status badge + HH:MM:SS time on the right.
 * Clicking a row selects it and opens the item detail in panel 2 through
 * `ChatPanelOpenContext`; clicking a timeline block selects the item and
 * scrolls its row into view. Rows reuse the transcript's `.trow` grammar;
 * trace-specific chrome lives in `styles/trace.css` on the same theme
 * tokens. Kinds the snapshot does not carry never render — no placeholder
 * tracks for capabilities a provider lacks.
 *
 * Data source today: the transcript projection (`derive.ts`, evidence
 * 'derived') or fixtures ('synthetic'). The view is source-agnostic; the
 * future Host feed only changes who builds the snapshot.
 */

import { useContext, useMemo, useState } from 'react';
import { useT } from '../i18n/index.js';
import { ChatPanelOpenContext } from '../presentation/chat-panel.js';
import { Caret } from '../transcript/approval-cards.js';
import { formatElapsed } from '../transcript/items.js';
import { formatTime } from '../utils/format.js';
import { deriveStepTimeline, groupSnapshotByTurn, type TraceTurnGroup } from './model.js';
import { TraceTimeline } from './TraceTimeline.js';
import type { TraceEvidence, TraceItem, TraceSnapshot, TraceStatus } from './types.js';

/** Local HH:MM:SS clock for rows and the panel-2 detail (chat times are HH:MM). */
export function formatTraceClock(iso: string): string {
  const d = new Date(Date.parse(iso));
  return Number.isNaN(d.getTime()) ? iso : d.toTimeString().slice(0, 8);
}

export function StatusBadge({ status }: { status: TraceStatus }) {
  const t = useT();
  return (
    <span className={`trace-badge ${status}`} data-testid={`trace-status-${status}`}>
      {t(`trace.status.${status}`)}
    </span>
  );
}

export function EvidenceChip({ evidence }: { evidence: TraceEvidence }) {
  const t = useT();
  return (
    <span className={`trace-evidence ${evidence}`} data-testid={`trace-evidence-${evidence}`}>
      {t(`trace.evidence.${evidence}`)}
    </span>
  );
}

function TraceRow({
  item,
  selected,
  expanded = false,
  onSelect,
}: {
  item: TraceItem;
  selected: boolean;
  expanded?: boolean;
  onSelect: () => void;
}) {
  const t = useT();
  return (
    <div
      className={`trow clickable trace-row${selected ? ' selected' : ''}${expanded ? ' expanded' : ''}`}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      aria-expanded={item.kind === 'step' ? expanded : undefined}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(); }
      }}
      data-testid={`trace-row-${item.id}`}
      data-kind={item.kind}
    >
      {item.kind === 'step' && <Caret className="trace-step-caret" />}
      <span className={`trace-kind ${item.kind}`}>{t(`trace.kind.${item.kind}`)}</span>
      <span className="trow-subject" title={item.title}>{item.title}</span>
      {item.summary && (
        <span className="trow-subject dim trace-row-summary" title={item.summary}>
          {item.summary}
        </span>
      )}
      <span className="trow-meta">
        {item.kind === 'step' && item.durationMs !== undefined && (
          <span className="trace-step-dur" data-testid={`trace-step-dur-${item.id}`}>
            {formatElapsed(item.durationMs)}
          </span>
        )}
        {item.status && <StatusBadge status={item.status} />}
        <span className="trace-row-time">{formatTraceClock(item.at)}</span>
      </span>
    </div>
  );
}

function TraceTurnSection({
  group,
  selectedId,
  expandedStepIds,
  onOpen,
  onToggleStep,
}: {
  group: TraceTurnGroup;
  selectedId: string | null;
  expandedStepIds: ReadonlySet<string>;
  onOpen: (item: TraceItem) => void;
  onToggleStep: (id: string) => void;
}) {
  const t = useT();
  const timeline = deriveStepTimeline(group.items);
  return (
    <section className="trace-turn" data-testid={`trace-turn-${group.turnId}`}>
      <header className="trace-turn-head">
        <span className="trace-turn-title">
          {group.turn?.title ?? `${t('trace.turn.fallback')} ${group.turnId}`}
        </span>
        <StatusBadge status={group.status} />
        {group.durationMs !== undefined && (
          <span className="trace-turn-dur">{formatElapsed(group.durationMs)}</span>
        )}
        <span className="trace-turn-time">{formatTime(Date.parse(group.startAt))}</span>
      </header>
      <div className="trace-turn-body">
        {timeline.map(entry => entry.type === 'item' ? (
          <TraceRow
            key={entry.item.id}
            item={entry.item}
            selected={selectedId === entry.item.id}
            onSelect={() => onOpen(entry.item)}
          />
        ) : (
          <div className="trace-step-group" key={entry.step.id}>
            <TraceRow
              item={entry.step}
              selected={selectedId === entry.step.id}
              expanded={expandedStepIds.has(entry.step.id)}
              onSelect={() => {
                onToggleStep(entry.step.id);
                onOpen(entry.step);
              }}
            />
            {expandedStepIds.has(entry.step.id) && (
              <div
                className="trace-step-children"
                data-testid={`trace-step-children-${entry.step.id}`}
              >
                {entry.children.map(item => (
                  <TraceRow
                    key={item.id}
                    item={item}
                    selected={selectedId === item.id}
                    onSelect={() => onOpen(item)}
                  />
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

export function TraceView({ snapshot }: { snapshot: TraceSnapshot }) {
  const t = useT();
  const openChatPanel = useContext(ChatPanelOpenContext);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expandedStepIds, setExpandedStepIds] = useState<Set<string>>(() => new Set());
  const groups = useMemo(() => groupSnapshotByTurn(snapshot), [snapshot]);
  const isEmpty = snapshot.items.length === 0;

  /** Timeline click: select only; bring the matching row into view. */
  function selectFromTimeline(itemId: string) {
    const item = snapshot.items.find(candidate => candidate.id === itemId);
    const scrollToRow = () => {
      document
        .querySelector(`[data-testid="trace-row-${CSS.escape(itemId)}"]`)
        ?.scrollIntoView({ block: 'nearest' });
    };
    if (item?.parentId) {
      setExpandedStepIds(current => new Set(current).add(item.parentId!));
      window.requestAnimationFrame(scrollToRow);
    } else {
      scrollToRow();
    }
    setSelectedId(itemId);
  }

  /** Row click: select and open the item detail in panel 2. */
  function openItem(item: TraceItem) {
    setSelectedId(item.id);
    openChatPanel?.({ kind: 'trace-item', item });
  }

  return (
    <div className="trace-view" data-testid="trace-view" data-partial={snapshot.partial || undefined}>
      {snapshot.partial && (
        <div className="trace-partial" role="status" data-testid="trace-partial">
          {t('trace.partial')}
        </div>
      )}
      {isEmpty ? (
        <div className="trace-empty" data-testid="trace-empty">{t('trace.empty')}</div>
      ) : (
        <>
          <TraceTimeline
            items={snapshot.items}
            selectedId={selectedId}
            onSelect={selectFromTimeline}
          />
          {groups.map(group => (
            <TraceTurnSection
              key={group.turnId}
              group={group}
              selectedId={selectedId}
              expandedStepIds={expandedStepIds}
              onOpen={openItem}
              onToggleStep={id => setExpandedStepIds(current => {
                const next = new Set(current);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              })}
            />
          ))}
        </>
      )}
    </div>
  );
}
