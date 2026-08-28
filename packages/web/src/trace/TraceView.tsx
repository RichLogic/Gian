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
 * The Calls control folds tool/agent rows into one expandable summary per
 * Step, falling back to one summary under the Turn when no Step exists.
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
import {
  deriveStepTimeline,
  filterTraceItems,
  groupTraceByTurn,
  summarizeTrace,
  traceItemDurationMs,
  type TraceTimelineEntry,
  type TraceTimelineMode,
  type TraceTurnGroup,
} from './model.js';
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

function Icon({ d, size = 13 }: { d: string; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor"
         strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

const I = {
  clock: 'M12 7v5l3 2 M21 12a9 9 0 1 1-9-9 9 9 0 0 1 9 9z',
  turns: 'M8 6h13 M8 12h13 M8 18h13 M3 6h.01 M3 12h.01 M3 18h.01',
  calls: 'M8 9l-4 3 4 3 M16 9l4 3-4 3 M14 5l-4 14',
  search: 'M21 21l-4.35-4.35 M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0z',
  download: 'M12 3v12 M7 10l5 5 5-5 M5 21h14',
};

export function downloadTraceSnapshot(snapshot: TraceSnapshot): void {
  const blob = new Blob([`${JSON.stringify(snapshot, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `gian-trace-${snapshot.sessionId}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

function TraceToolbar({
  mode,
  allTurnsCollapsed,
  callsCollapsed,
  query,
  stats,
  onToggleMode,
  onToggleTurns,
  onToggleCalls,
  onQuery,
  onDownload,
}: {
  mode: TraceTimelineMode;
  allTurnsCollapsed: boolean;
  callsCollapsed: boolean;
  query: string;
  stats: ReturnType<typeof summarizeTrace>;
  onToggleMode: () => void;
  onToggleTurns: () => void;
  onToggleCalls: () => void;
  onQuery: (value: string) => void;
  onDownload: () => void;
}) {
  const t = useT();
  return (
    <div className="trace-toolbar trace-pinned-head" data-testid="trace-toolbar">
      <div className="trace-toolbar-controls">
        <button type="button" className="trace-toolbar-btn" aria-pressed={mode === 'duration'}
                onClick={onToggleMode} data-testid="trace-control-duration">
          <Icon d={I.clock} />
          <span>{t('trace.control.duration')}</span>
        </button>
        <button type="button" className="trace-toolbar-btn" aria-pressed={allTurnsCollapsed}
                onClick={onToggleTurns} data-testid="trace-control-turns">
          <Icon d={I.turns} />
          <span>{t('trace.control.turns')}</span>
          <span className="trace-control-count">{stats.turns}</span>
        </button>
        <button type="button" className="trace-toolbar-btn" aria-pressed={callsCollapsed}
                onClick={onToggleCalls} data-testid="trace-control-calls">
          <Icon d={I.calls} />
          <span>{t('trace.control.calls')}</span>
          <span className="trace-control-count">{stats.calls}</span>
        </button>
      </div>
      <label className="trace-search">
        <Icon d={I.search} />
        <input value={query} onChange={event => onQuery(event.target.value)}
               placeholder={t('trace.control.search')} aria-label={t('trace.control.search')}
               data-testid="trace-search" />
      </label>
      <button type="button" className="trace-toolbar-icon" title={t('trace.control.download')}
              aria-label={t('trace.control.download')} onClick={onDownload}
              data-testid="trace-download">
        <Icon d={I.download} size={14} />
      </button>
    </div>
  );
}

function TraceStatsLine({ items }: { items: TraceItem[] }) {
  const t = useT();
  const stats = useMemo(() => summarizeTrace(items), [items]);
  return (
    <div className="trace-stats" data-testid="trace-stats">
      <span>{stats.turns} {t('trace.stats.turns')}</span>
      <span>{stats.steps} {t('trace.stats.steps')}</span>
      <span>{stats.calls} {t('trace.stats.calls')}</span>
      <span>{stats.events} {t('trace.stats.events')}</span>
      {stats.modelDurationMs > 0 && <span>{t('trace.stats.model')} {formatElapsed(stats.modelDurationMs)}</span>}
      {stats.toolDurationMs > 0 && <span>{t('trace.stats.tools')} {formatElapsed(stats.toolDurationMs)}</span>}
    </div>
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
  const duration = traceItemDurationMs(item);
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
      data-shape={item.shape}
    >
      {item.kind === 'step' && <Caret className="trace-step-caret" />}
      <span className={`trace-shape ${item.shape}`} aria-hidden="true" />
      <span className={`trace-kind ${item.kind}`}>{t(`trace.kind.${item.kind}`)}</span>
      <span className="trow-subject" title={item.title}>{item.title}</span>
      {item.summary && (
        <span className="trow-subject dim trace-row-summary" title={item.summary}>
          {item.summary}
        </span>
      )}
      <span className="trow-meta">
        {duration !== undefined && (
          <span className="trace-step-dur" data-testid={`trace-step-dur-${item.id}`}>
            {formatElapsed(duration)}
          </span>
        )}
        {item.status && <StatusBadge status={item.status} />}
        <span className="trace-row-time">{formatTraceClock(item.at)}</span>
      </span>
    </div>
  );
}

type TraceCallGroupEntry = {
  type: 'calls';
  groupId: string;
  calls: TraceItem[];
};

type TraceCallRowEntry = { type: 'item'; item: TraceItem } | TraceCallGroupEntry;
type TraceDisplayEntry = TraceTimelineEntry | TraceCallGroupEntry;

function isCall(item: TraceItem): boolean {
  return item.kind === 'tool' || item.kind === 'agent';
}

function callGroupStatus(calls: TraceItem[]): TraceStatus | undefined {
  if (calls.some(item => item.status === 'failed')) return 'failed';
  if (calls.some(item => item.status === 'interrupted')) return 'interrupted';
  if (calls.some(item => item.status === 'running')) return 'running';
  if (calls.length > 0 && calls.every(item => item.status === 'succeeded')) return 'succeeded';
  return undefined;
}

function collapseCallItems(items: TraceItem[], groupId: string): TraceCallRowEntry[] {
  const calls = items.filter(isCall);
  if (calls.length === 0) return items.map(item => ({ type: 'item', item }));
  let inserted = false;
  const entries: TraceCallRowEntry[] = [];
  for (const item of items) {
    if (!isCall(item)) {
      entries.push({ type: 'item', item });
      continue;
    }
    if (inserted) continue;
    inserted = true;
    entries.push({ type: 'calls', groupId, calls });
  }
  return entries;
}

function collapseTopLevelCalls(
  entries: TraceTimelineEntry[],
  groupId: string,
): TraceDisplayEntry[] {
  const calls = entries.flatMap(entry => (
    entry.type === 'item' && isCall(entry.item) ? [entry.item] : []
  ));
  if (calls.length === 0) return entries;
  let inserted = false;
  const display: TraceDisplayEntry[] = [];
  for (const entry of entries) {
    if (entry.type !== 'item' || !isCall(entry.item)) {
      display.push(entry);
      continue;
    }
    if (inserted) continue;
    inserted = true;
    display.push({ type: 'calls', groupId, calls });
  }
  return display;
}

function TraceCallGroupRow({
  groupId,
  calls,
  selected,
  onExpand,
}: {
  groupId: string;
  calls: TraceItem[];
  selected: boolean;
  onExpand: () => void;
}) {
  const t = useT();
  const status = callGroupStatus(calls);
  const titles = calls.map(item => item.title).filter(Boolean);
  const summary = [
    ...titles.slice(0, 3),
    ...(titles.length > 3 ? [`+${titles.length - 3}`] : []),
  ].join(', ');
  const first = calls[0]!;
  return (
    <div
      className={`trow clickable trace-row trace-call-group${selected ? ' selected' : ''}`}
      onClick={onExpand}
      role="button"
      tabIndex={0}
      aria-expanded="false"
      aria-label={`${t('trace.control.calls')} ${calls.length}`}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onExpand();
        }
      }}
      data-testid={`trace-call-group-${groupId}`}
    >
      <Caret className="trace-call-caret" />
      <span className="trace-shape span" aria-hidden="true" />
      <span className="trace-kind tool">{t('trace.control.calls')}</span>
      {summary && <span className="trow-subject dim trace-row-summary" title={summary}>{summary}</span>}
      <span className="trow-meta">
        <span className="trace-call-count" data-testid="trace-call-count">{calls.length}</span>
        {status && <StatusBadge status={status} />}
        <span className="trace-row-time">{formatTraceClock(first.at)}</span>
      </span>
    </div>
  );
}

function TraceCallRows({
  items,
  groupId,
  callsCollapsed,
  selectedId,
  onOpen,
  onExpandCalls,
}: {
  items: TraceItem[];
  groupId: string;
  callsCollapsed: boolean;
  selectedId: string | null;
  onOpen: (item: TraceItem) => void;
  onExpandCalls: () => void;
}) {
  const entries = callsCollapsed
    ? collapseCallItems(items, groupId)
    : items.map(item => ({ type: 'item' as const, item }));
  return entries.map(entry => entry.type === 'calls' ? (
    <TraceCallGroupRow
      key={`calls:${entry.groupId}`}
      groupId={entry.groupId}
      calls={entry.calls}
      selected={entry.calls.some(item => item.id === selectedId)}
      onExpand={onExpandCalls}
    />
  ) : (
    <TraceRow
      key={entry.item.id}
      item={entry.item}
      selected={selectedId === entry.item.id}
      onSelect={() => onOpen(entry.item)}
    />
  ));
}

function TraceTurnSection({
  group,
  selectedId,
  expandedStepIds,
  collapsed,
  callsCollapsed,
  onOpen,
  onExpandCalls,
  onToggleTurn,
  onToggleStep,
}: {
  group: TraceTurnGroup;
  selectedId: string | null;
  expandedStepIds: ReadonlySet<string>;
  collapsed: boolean;
  callsCollapsed: boolean;
  onOpen: (item: TraceItem) => void;
  onExpandCalls: () => void;
  onToggleTurn: () => void;
  onToggleStep: (id: string) => void;
}) {
  const t = useT();
  const timeline = deriveStepTimeline(group.items);
  const visibleTimeline = callsCollapsed
    ? collapseTopLevelCalls(timeline, group.turnId)
    : timeline;
  return (
    <section className={`trace-turn${collapsed ? ' collapsed' : ''}`} data-testid={`trace-turn-${group.turnId}`}>
      <header className="trace-turn-head">
        <button type="button" className="trace-turn-toggle" onClick={onToggleTurn}
                aria-expanded={!collapsed} aria-label={t('trace.control.turns')}>
          <Caret className="trace-turn-caret" />
          <span className="trace-turn-title">
            {group.turn?.title ?? `${t('trace.turn.fallback')} ${group.turnId}`}
          </span>
        </button>
        <StatusBadge status={group.status} />
        {group.durationMs !== undefined && (
          <span className="trace-turn-dur">{formatElapsed(group.durationMs)}</span>
        )}
        <span className="trace-turn-time">{formatTime(Date.parse(group.startAt))}</span>
      </header>
      {!collapsed && <div className="trace-turn-body">
        {visibleTimeline.map(entry => entry.type === 'item' ? (
          <TraceRow
            key={entry.item.id}
            item={entry.item}
            selected={selectedId === entry.item.id}
            onSelect={() => onOpen(entry.item)}
          />
        ) : entry.type === 'calls' ? (
          <TraceCallGroupRow
            key={`calls:${entry.groupId}`}
            groupId={entry.groupId}
            calls={entry.calls}
            selected={entry.calls.some(item => item.id === selectedId)}
            onExpand={onExpandCalls}
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
                <TraceCallRows
                  items={entry.children}
                  groupId={entry.step.id}
                  callsCollapsed={callsCollapsed}
                  selectedId={selectedId}
                  onOpen={onOpen}
                  onExpandCalls={onExpandCalls}
                />
              </div>
            )}
          </div>
        ))}
      </div>}
    </section>
  );
}

export function TraceView({ snapshot }: { snapshot: TraceSnapshot }) {
  const t = useT();
  const openChatPanel = useContext(ChatPanelOpenContext);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expandedStepIds, setExpandedStepIds] = useState<Set<string>>(() => new Set());
  const [collapsedTurnIds, setCollapsedTurnIds] = useState<Set<string>>(() => new Set());
  const [callsCollapsed, setCallsCollapsed] = useState(false);
  const [timelineMode, setTimelineMode] = useState<TraceTimelineMode>('duration');
  const [query, setQuery] = useState('');
  const visibleItems = useMemo(
    () => filterTraceItems(snapshot.items, query),
    [snapshot.items, query],
  );
  const groups = useMemo(() => groupTraceByTurn(visibleItems), [visibleItems]);
  const stats = useMemo(() => summarizeTrace(snapshot.items), [snapshot.items]);
  const allTurnsCollapsed = groups.length > 0
    && groups.every(group => collapsedTurnIds.has(group.turnId));
  const isEmpty = snapshot.items.length === 0;
  const noResults = !isEmpty && visibleItems.length === 0;

  /** Timeline click: select, open detail, and bring the matching row into view. */
  function selectFromTimeline(itemId: string) {
    const item = snapshot.items.find(candidate => candidate.id === itemId);
    if (!item) return;
    const scrollToRow = () => {
      const row = document.querySelector(`[data-testid="trace-row-${CSS.escape(itemId)}"]`);
      row?.scrollIntoView({ block: 'nearest' });
      return row !== null;
    };
    const parent = item.parentId
      ? snapshot.items.find(candidate => candidate.id === item.parentId)
      : undefined;
    setCollapsedTurnIds(current => {
      const next = new Set(current);
      next.delete(item.turnId);
      return next;
    });
    if (parent?.kind === 'step') {
      setExpandedStepIds(current => new Set(current).add(item.parentId!));
    }
    if (isCall(item)) setCallsCollapsed(false);
    if (!scrollToRow()) window.requestAnimationFrame(scrollToRow);
    openItem(item);
  }

  /** Row click: select and open the item detail in panel 2. */
  function openItem(item: TraceItem) {
    setSelectedId(item.id);
    openChatPanel?.({ kind: 'trace-item', item });
  }

  return (
    <div className={`trace-view${snapshot.items.length > 100 ? ' large' : ''}`}
         data-testid="trace-view" data-partial={snapshot.partial || undefined}
         data-virtualized={snapshot.items.length > 100 || undefined}>
      {snapshot.partial && (
        <div className="trace-partial" role="status" data-testid="trace-partial">
          {t('trace.partial')}
        </div>
      )}
      {isEmpty ? (
        <div className="trace-empty" data-testid="trace-empty">{t('trace.empty')}</div>
      ) : (
        <>
          <TraceToolbar
            mode={timelineMode}
            allTurnsCollapsed={allTurnsCollapsed}
            callsCollapsed={callsCollapsed}
            query={query}
            stats={stats}
            onToggleMode={() => setTimelineMode(current => current === 'duration' ? 'sequence' : 'duration')}
            onToggleTurns={() => setCollapsedTurnIds(allTurnsCollapsed
              ? new Set()
              : new Set(groups.map(group => group.turnId)))}
            onToggleCalls={() => setCallsCollapsed(current => !current)}
            onQuery={setQuery}
            onDownload={() => downloadTraceSnapshot(snapshot)}
          />
          <TraceTimeline
            items={visibleItems}
            selectedId={selectedId}
            mode={timelineMode}
            onSelect={selectFromTimeline}
          />
          <TraceStatsLine items={visibleItems} />
          {noResults && (
            <div className="trace-empty" data-testid="trace-no-results">{t('trace.search.empty')}</div>
          )}
          {groups.map(group => (
            <TraceTurnSection
              key={group.turnId}
              group={group}
              selectedId={selectedId}
              expandedStepIds={expandedStepIds}
              collapsed={collapsedTurnIds.has(group.turnId)}
              callsCollapsed={callsCollapsed}
              onOpen={openItem}
              onExpandCalls={() => setCallsCollapsed(false)}
              onToggleTurn={() => setCollapsedTurnIds(current => {
                const next = new Set(current);
                if (next.has(group.turnId)) next.delete(group.turnId);
                else next.add(group.turnId);
                return next;
              })}
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
