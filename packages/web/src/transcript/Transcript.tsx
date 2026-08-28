import { Fragment, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import type { ApprovalDecision } from '@gian/shared';
import type { TranscriptHistoryError } from '../controllers/use-transcript-hydration.js';
import { useT } from '../i18n/index.js';
import type { ApprovalActionContext, ApprovalItem, StatusItem, TranscriptItem } from '../types.js';
import { formatTime } from '../utils/format.js';
import { AgentSpawnRow, ApprovalCard, AssistantMessage, AutoNoticeCard, Caret, CommandCard, CompactionRow, DiffCard, FileReadCard, FileSearchCard, formatElapsed, MinimalErrorCard, ReasoningCard, ToolEvent, UserMessage, useStableExpand, WebSearchRow } from './items.js';
import { TURN_WORK_KINDS, isTurnWorkItem } from './event-feed.js';
import { EventLine } from './event-lines.js';
import { ChatPanelOpenContext } from '../presentation/chat-panel.js';
import { GianMascot } from '../components/GianMascot.js';
import { ForkFromTurnControl } from '../components/ForkControls.js';
import type { ActionControlState } from '../components/action-gating.js';
import { transcriptItemIdentity } from './identity.js';
import {
  TranscriptSelectionActions,
  type TranscriptSelectionActionsConfig,
} from './TranscriptSelectionActions.js';

/**
 * One stable Turn work boundary (Issue #116; interaction redesign
 * 2026-08-27): process events fold into one `Working <elapsed>` block while
 * live; when `turn-end` arrives the same key/component becomes
 * Worked/Failed/Stopped at that boundary, so the final assistant summary
 * remains below it. A dangling idle turn stays flat history.
 *
 * Interaction model (Working / terminal aligned):
 * - collapsed = head only (state + elapsed [+ end time]); expanded = the
 *   turn's FULL tool-row list in a capped scroll area (`.turn-work-scroll`)
 *   of single, never-expandable EventLine rows;
 * - Working defaults expanded; a manual collapse is remembered (new events
 *   never re-expand); the Working→terminal handoff auto-collapses unless
 *   the user manually expanded during the turn; terminal defaults
 *   collapsed, the user's choice persisting across re-renders;
 * - clicking a row jumps to the panel-2 event feed anchored at that row
 *   (`{kind:'event-feed', anchorId}`). Without a chat panel the rows are
 *   inert and terminal blocks fall back to the original in-place card
 *   expansion;
 * - exception: the RUNNING command row keeps its streaming output block
 *   (`.turn-work-live-stream`) until the command ends.
 *
 * Fold rules (docs/work-items/transcript-redesign-acd.md §3):
 * - tool / command / diff / file-read / file-search / web-search / reasoning
 *   / agent-spawn / auto-notice / compaction rows and RESOLVED approvals
 *   fold (resolved approvals render as `.approval-line` rows in the body);
 * - PENDING approvals/questions stay inline after the boundary;
 * - user/assistant messages, status and errors remain outside details;
 * - a turn with no process events gets no work boundary.
 */
type TurnWorkState = 'working' | 'worked' | 'failed' | 'stopped';

type RenderableItem =
  | TranscriptItem
  | {
    kind: 'turn-work';
    id: string;
    turn: number;
    items: TranscriptItem[];
    actions: number;
    startTs: number;
    endTs?: number;
    ts: number;
    state: TurnWorkState;
  };

function terminalState(items: TranscriptItem[], turn: number, end: StatusItem): 'worked' | 'failed' | 'stopped' {
  if (end.outcome === 'failed' || end.outcome === 'stopped') return end.outcome;
  const error = items.find(item => item.turn === turn && item.kind === 'error');
  if (!error || error.kind !== 'error') return 'worked';
  return /interrupt|cancel|stopp/i.test(error.text) ? 'stopped' : 'failed';
}

export function groupIntoBlocks(items: TranscriptItem[], live: boolean): RenderableItem[] {
  const endByTurn = new Map<number, StatusItem>();
  const lastIndexByTurn = new Map<number, number>();
  for (const it of items) {
    if (it.kind === 'turn-end' && !endByTurn.has(it.turn)) endByTurn.set(it.turn, it);
  }
  items.forEach((item, index) => lastIndexByTurn.set(item.turn, index));

  const foldablesByTurn = new Map<number, TranscriptItem[]>();
  const pendingByTurn = new Map<number, ApprovalItem[]>();
  const skip = new Set<TranscriptItem>();
  const firstPendingIndexByTurn = new Map<number, number>();
  const pushTo = (map: Map<number, TranscriptItem[]>, turn: number, it: TranscriptItem) => {
    const list = map.get(turn) ?? [];
    list.push(it);
    map.set(turn, list);
  };
  items.forEach((it, index) => {
    if (!endByTurn.has(it.turn)) {
      if (live && isTurnWorkItem(it)) {
        pushTo(foldablesByTurn, it.turn, it);
        skip.add(it);
      } else if (live && it.kind === 'approval' && it.status === 'pending') {
        if (!firstPendingIndexByTurn.has(it.turn)) firstPendingIndexByTurn.set(it.turn, index);
      }
      return;
    }
    if (TURN_WORK_KINDS.has(it.kind)) {
      pushTo(foldablesByTurn, it.turn, it);
      skip.add(it);
    } else if (it.kind === 'approval') {
      if (it.status === 'pending') pushTo(pendingByTurn, it.turn, it);
      else pushTo(foldablesByTurn, it.turn, it); // resolved → `.approval-line`
      skip.add(it);
    }
  });

  const out: RenderableItem[] = [];
  const makeBlock = (turn: number, state: TurnWorkState, end?: StatusItem) => {
    const foldables = foldablesByTurn.get(turn) ?? [];
    const pendings = pendingByTurn.get(turn) ?? [];
    if (foldables.length === 0) return null;
    const startTs = Math.min(
      ...foldables.map(item => item.ts),
      ...pendings.map(item => item.ts),
    );
    const ts = end?.ts ?? Math.max(...items.filter(item => item.turn === turn).map(item => item.ts));
    return {
      kind: 'turn-work' as const,
      id: `turnwork_${turn}_${foldables[0]!.id}`,
      turn,
      items: foldables,
      actions: foldables.length + pendings.length,
      startTs,
      ...(end ? { endTs: end.ts } : {}),
      ts,
      state,
    };
  };
  items.forEach((it, index) => {
    const end = endByTurn.get(it.turn);
    if (end && it === end) {
      const block = makeBlock(it.turn, terminalState(items, it.turn, end), end);
      if (block) out.push(block);
      out.push(...(pendingByTurn.get(it.turn) ?? []));
      out.push(it);
      return;
    }

    if (!end && live) {
      const firstPendingIndex = firstPendingIndexByTurn.get(it.turn);
      const anchorIndex = firstPendingIndex ?? lastIndexByTurn.get(it.turn);
      if (anchorIndex === index) {
        const block = makeBlock(it.turn, 'working');
        if (firstPendingIndex === index) {
          if (block) out.push(block);
          if (!skip.has(it)) out.push(it);
        } else {
          if (!skip.has(it)) out.push(it);
          if (block) out.push(block);
        }
        return;
      }
    }

    if (!skip.has(it)) {
      out.push(it);
      return;
    }
  });
  return out;
}

/** Distance from the bottom (px) within which the scroll-follow stays pinned. */
const AT_BOTTOM_PX = 40;
const LOAD_OLDER_TOP_PX = 80;

export function renderItem(
  item: TranscriptItem,
  onApprove: (
    approvalId: string,
    decision: ApprovalDecision,
    answers?: Record<string, string | boolean | string[]>,
    context?: ApprovalActionContext,
  ) => void,
  currentUserRef?: React.RefObject<HTMLDivElement | null>,
  isCurrentUser?: boolean,
  hideAvatar?: boolean,
  showFooter?: boolean,
  turnCompleted?: boolean,
  assistantFooter?: { copyable?: boolean; actions?: ReactNode },
) {
  const identity = transcriptItemIdentity(item);
  switch (item.kind) {
    case 'user':
      if (isCurrentUser && currentUserRef) {
        return (
          <div key={identity} ref={currentUserRef} data-current-user="true">
            <UserMessage item={item} />
          </div>
        );
      }
      return <UserMessage key={identity} item={item} />;
    case 'assistant':
      return (
        <AssistantMessage
          key={identity}
          item={item}
          hideAvatar={hideAvatar}
          showFooter={showFooter}
          copyable={assistantFooter?.copyable}
          footerActions={assistantFooter?.actions}
        />
      );
    case 'reasoning':
      return <ReasoningCard key={identity} item={item} />;
    case 'tool':
      return <ToolEvent key={identity} item={item} turnCompleted={turnCompleted} />;
    case 'approval':
      return <ApprovalCard key={identity} item={item} onApprove={onApprove} />;
    case 'diff':
      return <DiffCard key={identity} item={item} />;
    case 'turn-start':
      // Hidden per design (PR5/A1) — TURN N dividers removed from transcript UI.
      // Data still flows through items[] / DB; only the visual divider is suppressed.
      return null;
    case 'turn-end':
      return null; // Skip, separator already shown by next turn-start
    case 'error':
      return <TranscriptErrorCard key={identity} item={item} />;
    case 'status':
      return <div key={identity} className="status-line">{item.text}</div>;
    case 'compaction':
      return <CompactionRow key={identity} item={item} />;
    case 'command':
      return <CommandCard key={identity} item={item} turnCompleted={turnCompleted} />;
    case 'file-read':
      return <FileReadCard key={identity} item={item} />;
    case 'file-search':
      return <FileSearchCard key={identity} item={item} />;
    case 'web-search':
      return <WebSearchRow key={identity} item={item} />;
    case 'agent-spawn':
      return <AgentSpawnRow key={identity} item={item} turnCompleted={turnCompleted} />;
    case 'auto-notice':
      return <AutoNoticeCard key={identity} item={item} />;
  }
}

/** Turn failed / session error: the minimal P2 error card (danger label +
 *  error text on the neutral `.approval` shell — no icon/title/pill/time). */
function TranscriptErrorCard({ item }: { item: StatusItem }) {
  const t = useT();
  return <MinimalErrorCard label={t('transcript.turnFailed')}>{item.text}</MinimalErrorCard>;
}

function useTurnWorkNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

/** One stable Turn boundary: Working while live, terminal label in place. */
function TurnWorkBlock({
  block,
  onApprove,
}: {
  block: Extract<RenderableItem, { kind: 'turn-work' }>;
  onApprove: (
    approvalId: string,
    decision: ApprovalDecision,
    answers?: Record<string, string | boolean | string[]>,
    context?: ApprovalActionContext,
  ) => void;
}) {
  const t = useT();
  // Working mounts expanded, terminal mounts collapsed; the stable component
  // key keeps the user's choice across re-renders and live event appends.
  const { open, setOpen, toggle } = useStableExpand(block.state === 'working');
  const openChatPanel = useContext(ChatPanelOpenContext);
  const live = block.state === 'working';
  const hasPanel = openChatPanel !== null;
  // The last manual toggle while Working. At the Working→terminal handoff
  // the block auto-collapses UNLESS the user manually expanded during the
  // turn; a manual collapse is simply the already-collapsed state.
  const manualRef = useRef<'expanded' | 'collapsed' | null>(null);
  const wasLiveRef = useRef(live);
  useEffect(() => {
    if (wasLiveRef.current && !live) {
      if (manualRef.current !== 'expanded') setOpen(false);
      manualRef.current = null;
    } else if (!wasLiveRef.current && live) {
      // A block that (re-)becomes Working takes the Working default: expanded.
      setOpen(true);
      manualRef.current = null;
    }
    wasLiveRef.current = live;
  }, [live, setOpen]);
  const now = useTurnWorkNow(live);
  const elapsed = formatElapsed((block.endTs ?? now) - block.startTs);
  const label = t(`transcript.turnsum.${block.state}`);
  // Chat-style bottom pinning: new rows keep the scroll area at its tail
  // until the user scrolls up; never yank it back afterwards.
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const lastRowId = block.items.length > 0
    ? transcriptItemIdentity(block.items[block.items.length - 1]!)
    : '';
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [open, block.items.length, lastRowId]);
  const onBodyScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= AT_BOTTOM_PX;
  };
  const activate = (event: MouseEvent<HTMLElement>) => {
    // Clicks inside the expanded body (rows jump to the panel or are inert,
    // the live stream is output) never toggle the block.
    if ((event.target as HTMLElement).closest('.turn-work-scroll')) return;
    manualRef.current = open ? 'collapsed' : 'expanded';
    if (!open) pinnedRef.current = true; // re-opening lands on the newest rows
    toggle(event);
  };
  return (
    <>
      <div
        className={`turnsum turn-work-block is-${block.state}${open ? ' open' : ''}`}
        data-testid="turn-work"
        data-state={block.state}
        aria-label={`${label} ${elapsed}; ${block.actions} ${t(
          block.actions === 1 ? 'transcript.turnsum.action' : 'transcript.turnsum.actions',
        )}`}
        onClick={activate}
      >
        <div className="turnsum-head turn-work">
          <Caret className="turnsum-caret" />
          <span className="turnsum-lead">
            <span>{label}</span>
            <span className="turn-work-duration">{elapsed}</span>
          </span>
          {!live && block.endTs !== undefined && (
            <span className="turnsum-time">{formatTime(block.endTs)}</span>
          )}
        </div>
        {open && (live || hasPanel) && (
          <div
            className="turnsum-body turn-work-preview turn-work-scroll"
            data-testid="turn-work-preview"
            ref={scrollRef}
            onScroll={onBodyScroll}
          >
            {block.items.map(child => {
              const rowId = transcriptItemIdentity(child);
              return (
                <Fragment key={rowId}>
                  <EventLine
                    item={child}
                    turnCompleted={!live}
                    onRowClick={hasPanel
                      ? () => openChatPanel({ kind: 'event-feed', turn: block.turn, anchorId: rowId })
                      : undefined}
                  />
                  {live && child.kind === 'command' && child.status === 'running' && child.stdout.length > 0 && (
                    <div className="trow-detail cmd turn-work-live-stream">
                      <div className="cmd-stream">
                        <span>{child.stdout}</span>
                        <span className="cmd-cursor" />
                      </div>
                    </div>
                  )}
                </Fragment>
              );
            })}
          </div>
        )}
      </div>
      {!live && !hasPanel && open && (
        <div className="turnsum-body">
          {block.items.map(child => renderItem(
            child,
            onApprove,
            undefined,
            undefined,
            undefined,
            undefined,
            !live,
          ))}
        </div>
      )}
    </>
  );
}

/** A non-event node interleaved into the transcript by timestamp — e.g. the
 *  Manager's manual subtask-created cards, which must read in-line at the
 *  point in the conversation where the user acted, not all at the bottom. */
export interface TranscriptExtra {
  id: string;
  /** Render immediately after the last transcript item whose `ts` ≤ this. */
  afterTs: number;
  node: ReactNode;
}

export function Transcript({
  items, pending, onApprove, hiddenApprovalId, extras, hydrated = true,
  hasOlder = false, loadingOlder = false, onLoadOlder, historyError, onRetryHistory,
  forkAtTurn, selectionActions,
}: {
  items: TranscriptItem[];
  pending: boolean;
  onApprove: (
    approvalId: string,
    decision: ApprovalDecision,
    answers?: Record<string, string | boolean | string[]>,
    context?: ApprovalActionContext,
  ) => void;
  /** Approval id pinned elsewhere (e.g. the Beta question dock). Suppress its
   *  inline transcript card so a pending question isn't shown twice. */
  hiddenApprovalId?: string;
  /** Extra nodes interleaved among the items by timestamp (Manager subtask cards). */
  extras?: TranscriptExtra[];
  /** False while the session's history is still being fetched. The empty
   *  state is gated on this so switching to an unhydrated session doesn't
   *  flash "no messages" before the history arrives. */
  hydrated?: boolean;
  hasOlder?: boolean;
  loadingOlder?: boolean;
  onLoadOlder?: () => void;
  historyError?: TranscriptHistoryError | null;
  onRetryHistory?: () => void;
  /** Per-turn Fork affordance (gian.proxy/2.0 §10.6): when present, every
   *  Terminal Turn result footer renders the standard control beside Copy,
   *  greyed per `state` and the item's Host-flowed turn identity. Text-free,
   *  failed, and stopped turns use a compact fallback footer. Absent on
   *  surfaces that can never be a fork source (Side Chat panels). */
  forkAtTurn?: {
    sourceSessionId: string;
    state: ActionControlState;
  } | null;
  /** Context actions exposed only for selections contained in one visible
   *  user/assistant message. Side Chat transcripts omit this prop. */
  selectionActions?: TranscriptSelectionActionsConfig;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const currentUserRef = useRef<HTMLDivElement | null>(null);

  // Track the trailing assistant bubble's text length too — codex streams
  // deltas into the last bubble, so items.length alone misses growth.
  const tailLen = items.length > 0 && 'text' in items[items.length - 1]!
    ? (items[items.length - 1] as { text: string }).text.length
    : 0;
  // Scroll-follow: pin to the bottom on items change, but ONLY while the user
  // is already at the bottom — scrolling up releases the pin so streaming
  // output doesn't yank the view back down. Scrolling back to the bottom (or
  // clicking the nav row's scroll-to-bottom button) re-engages it. Sending a
  // message or switching sessions also re-pins.
  const atBottomRef = useRef(true);
  const olderAnchorRef = useRef<{ scroller: HTMLElement; height: number; top: number } | null>(null);
  const lastScrollTopRef = useRef(0);

  function rememberOlderAnchor() {
    const el = ref.current;
    if (!el) return;
    const scroller = (el.closest('.main-scroll') as HTMLElement | null) ?? el;
    olderAnchorRef.current = {
      scroller,
      height: scroller.scrollHeight,
      top: scroller.scrollTop,
    };
    atBottomRef.current = false;
  }

  function loadOlder() {
    if (!onLoadOlder || loadingOlder) return;
    rememberOlderAnchor();
    onLoadOlder();
  }

  function retryHistory() {
    if (!onRetryHistory) return;
    if (historyError?.operation === 'older') rememberOlderAnchor();
    onRetryHistory();
  }

  useEffect(() => {
    if (!loadingOlder) olderAnchorRef.current = null;
  }, [loadingOlder]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const scroller = (el.closest('.main-scroll') as HTMLElement | null) ?? el;
    const onScroll = () => {
      const movingUp = scroller.scrollTop < lastScrollTopRef.current;
      lastScrollTopRef.current = scroller.scrollTop;
      atBottomRef.current =
        scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= AT_BOTTOM_PX;
      if (movingUp && scroller.scrollTop <= LOAD_OLDER_TOP_PX && hasOlder && !loadingOlder) {
        loadOlder();
      }
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    lastScrollTopRef.current = scroller.scrollTop;
    atBottomRef.current =
      scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= AT_BOTTOM_PX;
    return () => scroller.removeEventListener('scroll', onScroll);
  }, [hasOlder, loadingOlder, onLoadOlder]);

  // The actual scroll container is CodingView's `.main-scroll` wrapper
  // (V2-style island), not our local `.transcript-wrap`, so we walk up via
  // closest(). Jam scrollTop twice — synchronously and on next rAF — to absorb
  // async layout shifts from ReactMarkdown / syntax highlight that grow the
  // transcript after the initial measurement.
  const firstId = items[0] ? transcriptItemIdentity(items[0]) : undefined;
  // Most recent user message — a new one means the user just sent/steered, so
  // the view re-pins to the bottom even if they had scrolled up.
  let lastUserId: string | undefined;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.kind === 'user') { lastUserId = transcriptItemIdentity(it); break; }
  }
  const idsRef = useRef<{ firstId?: string; lastUserId?: string }>({});
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const previousIds = idsRef.current;
    const olderAnchor = olderAnchorRef.current;
    if (olderAnchor && previousIds.firstId !== firstId) {
      const restoreAnchor = () => {
        olderAnchor.scroller.scrollTop = olderAnchor.top
          + (olderAnchor.scroller.scrollHeight - olderAnchor.height);
      };
      restoreAnchor();
      const id = window.requestAnimationFrame(restoreAnchor);
      olderAnchorRef.current = null;
      atBottomRef.current = false;
      idsRef.current = { firstId, lastUserId };
      return () => window.cancelAnimationFrame(id);
    }
    // A new session (first item changed) or a freshly sent user message
    // re-pins to the bottom regardless of where the user had scrolled.
    if (previousIds.firstId !== firstId || previousIds.lastUserId !== lastUserId) {
      atBottomRef.current = true;
    }
    idsRef.current = { firstId, lastUserId };
    if (!atBottomRef.current) return;
    const scroller = (el.closest('.main-scroll') as HTMLElement | null) ?? el;
    scroller.scrollTop = scroller.scrollHeight;
    const id = window.requestAnimationFrame(() => {
      scroller.scrollTop = scroller.scrollHeight;
    });
    return () => window.cancelAnimationFrame(id);
  }, [items.length, tailLen, pending, extras?.length, firstId, lastUserId]);

  // Find the most recent user message — that's the "current" turn's user input.
  const currentUser = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i]!;
      if (it.kind === 'user') return it;
    }
    return null;
  }, [items]);
  const selectionSourceIds = useMemo(
    () => new Set(items
      .filter(item => item.kind === 'user' || item.kind === 'assistant')
      .map(transcriptItemIdentity)),
    [items],
  );

  // Show the Gian "working" mascot whenever a turn is pending, except when the
  // last item is an approval card — in that case we're waiting on the *user*,
  // not the model, so an activity indicator would be misleading.
  const lastItem = items[items.length - 1];
  const showMascot = pending && lastItem?.kind !== 'approval';

  return (
    <div className="transcript" ref={ref}>
        {historyError && (
          <div className="transcript-history-error" role="alert">
            <span>
              {historyError.status === 401
                ? t('transcript.history.unauthorized')
                : historyError.operation === 'older'
                  ? t('transcript.history.olderError')
                  : t('transcript.history.error')}
            </span>
            {onRetryHistory && (
              <button className="btn secondary sm" type="button" onClick={retryHistory}>
                {t('transcript.history.retry')}
              </button>
            )}
          </div>
        )}
        {hasOlder && onLoadOlder && !historyError && (
          <div className="transcript-history-load">
            <button className="btn ghost sm" type="button" onClick={loadOlder} disabled={loadingOlder}>
              {loadingOlder ? t('transcript.history.loading') : t('transcript.history.older')}
            </button>
          </div>
        )}
        {items.length === 0 && (extras?.length ?? 0) === 0 && !pending && hydrated && (
          <div className="transcript-empty">{t('transcript.empty')}</div>
        )}
        {(() => {
          // Track the last visible sender. The author header (Claude · time)
          // hides for an *immediately consecutive* same-sender bubble (streaming
          // chunks within a single text block). Any intervening item — user
          // message, turn-actions block, approval, error, or diff — counts as
          // a sender break, so the next text gets a fresh header.
          let prevSender: 'user' | import('@gian/shared').Executor | null = null;
          // Drop the approval card pinned in the dock so it doesn't render
          // twice. Only the *pending* card is docked; once resolved the dock
          // releases it (hiddenApprovalId clears) and the resolved card shows
          // inline here as normal.
          const visibleItems = hiddenApprovalId
            ? items.filter(it => !(it.kind === 'approval' && it.approvalId === hiddenApprovalId))
            : items;
          const terminalByTurn = new Map<number, StatusItem>();
          for (const item of visibleItems) {
            if (item.kind === 'turn-end') terminalByTurn.set(item.turn, item);
          }
          const terminalStateByTurn = new Map(
            Array.from(terminalByTurn, ([turn, end]) => [turn, terminalState(visibleItems, turn, end)]),
          );
          // `assistant` has no guessed process/result flag. The authoritative
          // Terminal Turn boundary supplies it: only the last non-empty
          // assistant message of a successfully worked turn is copyable.
          const resultByTurn = new Map<number, string>();
          for (const item of visibleItems) {
            if (
              item.kind === 'assistant'
              && item.text.trim().length > 0
              && terminalStateByTurn.get(item.turn) === 'worked'
            ) {
              resultByTurn.set(item.turn, transcriptItemIdentity(item));
            }
          }
          const blocks = groupIntoBlocks(visibleItems, pending);
          // Interleave `extras` (Manager subtask cards) by timestamp: each one
          // renders after the last block whose ts ≤ its afterTs. A card is a
          // sender break, like any non-text item.
          const sortedExtras = (extras ?? []).slice().sort((a, b) => a.afterTs - b.afterTs);
          const blockTs = (b: RenderableItem): number =>
            b.kind === 'turn-work'
              ? b.ts
              : ((b as { ts?: number }).ts ?? 0);
          const out: ReactNode[] = [];
          let ei = 0;
          const flushExtrasBefore = (limit: number) => {
            while (ei < sortedExtras.length && sortedExtras[ei]!.afterTs < limit) {
              out.push(<Fragment key={`x_${sortedExtras[ei]!.id}`}>{sortedExtras[ei]!.node}</Fragment>);
              prevSender = null;
              ei++;
            }
          };
          blocks.forEach((item, bi) => {
            if (item.kind === 'turn-work') {
              prevSender = null;
              out.push(<TurnWorkBlock key={item.id} block={item} onApprove={onApprove} />);
            } else if (item.kind === 'turn-end' && forkAtTurn && !resultByTurn.has(item.turn)) {
              // A failed/stopped or text-free Terminal Turn has no result
              // footer to own the action. Keep the exact-boundary Fork in a
              // compact footer rather than fabricating a copyable result.
              prevSender = null;
              out.push(
                <div className="msg-foot turn-result-fallback" key={transcriptItemIdentity(item)}>
                  <ForkFromTurnControl
                    sourceSessionId={forkAtTurn.sourceSessionId}
                    turn={item.turn}
                    turnId={item.turn_id}
                    sourceTurnId={item.source_turn_id}
                    state={forkAtTurn.state}
                  />
                </div>,
              );
            } else {
              let hideAvatar = false;
              // Time stays on the tail of a same-sender run. Copy and Fork are
              // stricter: they render only on the successful terminal result.
              let isTail = true;
              if (item.kind === 'user') {
                hideAvatar = prevSender === 'user';
                prevSender = 'user';
              } else if (item.kind === 'assistant') {
                hideAvatar = prevSender === item.exec;
                prevSender = item.exec;
                const next = blocks[bi + 1];
                const nextTs = next ? blockTs(next) : Infinity;
                // An interleaved extra (subtask card) also breaks the run.
                const extraBreaks = ei < sortedExtras.length && sortedExtras[ei]!.afterTs < nextTs;
                isTail = extraBreaks || !next || next.kind !== 'assistant' || next.exec !== item.exec;
              } else {
                // Anything else between two text bubbles counts as a sender
                // break so the next assistant text gets a fresh header.
                prevSender = null;
              }
              out.push(renderItem(
                item,
                onApprove,
                currentUserRef,
                item.kind === 'user'
                  && currentUser !== null
                  && transcriptItemIdentity(item) === transcriptItemIdentity(currentUser),
                hideAvatar,
                isTail,
                undefined,
                item.kind === 'assistant'
                  && resultByTurn.get(item.turn) === transcriptItemIdentity(item)
                  ? {
                    copyable: true,
                    actions: forkAtTurn ? (
                      <ForkFromTurnControl
                        sourceSessionId={forkAtTurn.sourceSessionId}
                        turn={item.turn}
                        turnId={terminalByTurn.get(item.turn)?.turn_id}
                        sourceTurnId={terminalByTurn.get(item.turn)?.source_turn_id}
                        state={forkAtTurn.state}
                      />
                    ) : undefined,
                  }
                  : undefined,
              ));
            }
            const nextTs = bi + 1 < blocks.length ? blockTs(blocks[bi + 1]!) : Infinity;
            flushExtrasBefore(nextTs);
          });
          // Trailing extras (afterTs ≥ last block, or there were no blocks).
          flushExtrasBefore(Infinity);
          return out;
        })()}
        {showMascot && (
          <div className="msg-mascot">
            <GianMascot size={36} state="working" title={t('transcript.workingEllipsis')} />
          </div>
        )}
        {selectionActions && (
          <TranscriptSelectionActions
            rootRef={ref}
            actions={selectionActions}
            validSourceIds={selectionSourceIds}
          />
        )}
    </div>
  );
}
