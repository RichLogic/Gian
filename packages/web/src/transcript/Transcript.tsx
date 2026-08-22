import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import type { ApprovalDecision } from '@gian/shared';
import type { TranscriptHistoryError } from '../controllers/use-transcript-hydration.js';
import { useT } from '../i18n/index.js';
import type { ApprovalActionContext, ApprovalItem, StatusItem, TranscriptItem } from '../types.js';
import { formatTime } from '../utils/format.js';
import { AgentSpawnRow, ApprovalCard, AssistantMessage, AutoNoticeCard, Caret, CommandCard, CompactionRow, DiffCard, FileReadCard, FileSearchCard, formatElapsed, MinimalErrorCard, ReasoningCard, ToolEvent, UserMessage, useStableExpand, WebSearchRow } from './items.js';
import { GianMascot } from '../components/GianMascot.js';
import { ForkFromTurnControl } from '../components/ForkControls.js';
import type { ActionControlState } from '../components/action-gating.js';
import { transcriptItemIdentity } from './identity.js';

/**
 * P2 render-time grouping (2026-08-08): a completed turn folds ALL of its
 * process events into one `.turnsum` summary row ("完成即折" — collapse as
 * soon as the turn ends, historical replays included). A turn counts as
 * complete once its `turn-end` item is in the flow. Turns still in flight
 * (no turn-end) render their rows flat in P1 process form.
 *
 * Fold rules (docs/work-items/transcript-redesign-acd.md §3):
 * - tool / command / diff / file-read / file-search / web-search / reasoning
 *   / agent-spawn / auto-notice / compaction rows and RESOLVED approvals
 *   fold (resolved approvals render as `.approval-line` rows in the body);
 * - PENDING approvals/questions never fold — they render right after their
 *   turn's summary row;
 * - user/assistant messages, status and error items are turn-boundary
 *   content and stay outside the fold;
 * - a turn with no process events at all gets no summary row.
 */
type RenderableItem =
  | TranscriptItem
  | {
    kind: 'turnsum';
    id: string;
    turn: number;
    /** Folded process rows, in flow order. */
    items: TranscriptItem[];
    /** Process-event count including pending approvals (each counts 1). */
    actions: number;
    startTs: number;
    endTs: number;
  };

/** Item kinds that fold into a completed turn's summary (one action each). */
const TURN_FOLD_KINDS: ReadonlySet<TranscriptItem['kind']> = new Set([
  'tool',
  'command',
  'diff',
  'file-read',
  'file-search',
  'web-search',
  'reasoning',
  'agent-spawn',
  'auto-notice',
  'compaction',
]);

function groupIntoBlocks(items: TranscriptItem[]): RenderableItem[] {
  const endByTurn = new Map<number, number>();
  for (const it of items) {
    if (it.kind === 'turn-end' && !endByTurn.has(it.turn)) endByTurn.set(it.turn, it.ts);
  }
  if (endByTurn.size === 0) return [...items];

  const foldablesByTurn = new Map<number, TranscriptItem[]>();
  const pendingByTurn = new Map<number, ApprovalItem[]>();
  const skip = new Set<TranscriptItem>();
  const pushTo = (map: Map<number, TranscriptItem[]>, turn: number, it: TranscriptItem) => {
    const list = map.get(turn) ?? [];
    list.push(it);
    map.set(turn, list);
  };
  for (const it of items) {
    if (!endByTurn.has(it.turn)) continue;
    if (TURN_FOLD_KINDS.has(it.kind)) {
      pushTo(foldablesByTurn, it.turn, it);
      skip.add(it);
    } else if (it.kind === 'approval') {
      if (it.status === 'pending') pushTo(pendingByTurn, it.turn, it);
      else pushTo(foldablesByTurn, it.turn, it); // resolved → `.approval-line`
      skip.add(it);
    }
  }

  const out: RenderableItem[] = [];
  const emitted = new Set<number>();
  for (const it of items) {
    if (!skip.has(it)) {
      out.push(it);
      continue;
    }
    const turn = it.turn;
    if (emitted.has(turn)) continue;
    emitted.add(turn);
    const foldables = foldablesByTurn.get(turn) ?? [];
    const pendings = pendingByTurn.get(turn) ?? [];
    if (foldables.length > 0) {
      out.push({
        kind: 'turnsum',
        id: `turnsum_${turn}_${foldables[0]!.id}`,
        turn,
        items: foldables,
        actions: foldables.length + pendings.length,
        startTs: Math.min(foldables[0]!.ts, pendings[0]?.ts ?? Infinity),
        endTs: endByTurn.get(turn)!,
      });
    }
    // Pending interactions of a finished turn stay expanded, right after the
    // summary row (or in place when the turn had nothing foldable).
    out.push(...pendings);
  }
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
      return <AssistantMessage key={identity} item={item} hideAvatar={hideAvatar} showFooter={showFooter} />;
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

/**
 * A finished turn's summary row (P2): `Worked 1m 03s · 7 actions ·
 * 1 file +6 −2` with the turn-end time on the right. Doubles as the turn
 * boundary. Click expands the full process list on a left guide rail; the
 * rows inside behave exactly like the live process rows.
 */
function TurnSumBlock({
  block,
  onApprove,
}: {
  block: Extract<RenderableItem, { kind: 'turnsum' }>;
  onApprove: (
    approvalId: string,
    decision: ApprovalDecision,
    answers?: Record<string, string | boolean | string[]>,
    context?: ApprovalActionContext,
  ) => void;
}) {
  const t = useT();
  const { open, toggle } = useStableExpand();
  // Stats per the locked口径: files deduped by path with add/del summed
  // across the turn's diffs; failed = command errors + agent errors (kept
  // danger-red, never discounted).
  let add = 0;
  let del = 0;
  let failed = 0;
  const paths = new Set<string>();
  for (const it of block.items) {
    if (it.kind === 'diff') {
      for (const f of it.files) {
        paths.add(f.path);
        add += f.add;
        del += f.del;
      }
    } else if (it.kind === 'command' && it.status === 'error') {
      failed++;
    } else if (it.kind === 'agent-spawn' && it.status === 'error') {
      failed++;
    }
  }
  const fileCount = paths.size;
  return (
    <>
      <div className={`turnsum${open ? ' open' : ''}`} onClick={toggle}>
        <Caret className="turnsum-caret" />
        <span className="turnsum-lead">
          {t('transcript.turnsum.worked')} {formatElapsed(block.endTs - block.startTs)}
        </span>
        <span className="turnsum-stats">
          <span>{block.actions} {t(block.actions === 1 ? 'transcript.turnsum.action' : 'transcript.turnsum.actions')}</span>
          {fileCount > 0 && (
            <>
              <span className="sep">·</span>
              <span>{fileCount} {t(fileCount === 1 ? 'transcript.turnsum.file' : 'transcript.turnsum.files')}</span>
              <span className="add">+{add}</span>
              <span className="del">−{del}</span>
            </>
          )}
          {failed > 0 && (
            <>
              <span className="sep">·</span>
              <span className="err">{failed} {t('transcript.turnsum.failed')}</span>
            </>
          )}
        </span>
        <span className="turnsum-time">{formatTime(block.endTs)}</span>
      </div>
      {open && (
        <div className="turnsum-body">
          {block.items.map(child => renderItem(
            child,
            onApprove,
            undefined,
            undefined,
            undefined,
            undefined,
            true,
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
  forkAtTurn,
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
   *  Terminal Turn boundary (turn-end item) renders the standard control,
   *  greyed per `state` and per the item's Host-flowed turn identity. Absent
   *  on surfaces that can never be a fork source (Side Chat panels). */
  forkAtTurn?: {
    sourceSessionId: string;
    state: ActionControlState;
  } | null;
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
          const blocks = groupIntoBlocks(visibleItems);
          // Interleave `extras` (Manager subtask cards) by timestamp: each one
          // renders after the last block whose ts ≤ its afterTs. A card is a
          // sender break, like any non-text item.
          const sortedExtras = (extras ?? []).slice().sort((a, b) => a.afterTs - b.afterTs);
          const blockTs = (b: RenderableItem): number =>
            b.kind === 'turnsum'
              ? b.endTs
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
            if (item.kind === 'turnsum') {
              prevSender = null;
              out.push(<TurnSumBlock key={`turnsum:${item.turn}:${item.id}`} block={item} onApprove={onApprove} />);
            } else if (item.kind === 'turn-end' && forkAtTurn) {
              // Terminal Turn boundary: the standard per-turn Fork control
              // (§10.6). Only Terminal Turns have a turn-end item, so the
              // affordance appears exactly where a fork anchor exists.
              prevSender = null;
              out.push(
                <ForkFromTurnControl
                  key={transcriptItemIdentity(item)}
                  sourceSessionId={forkAtTurn.sourceSessionId}
                  turn={item.turn}
                  turnId={item.turn_id}
                  sourceTurnId={item.source_turn_id}
                  state={forkAtTurn.state}
                />,
              );
            } else {
              let hideAvatar = false;
              // Assistant footer (time + copy) renders on the TAIL of a
              // same-sender run, not the head — so a multi-bubble turn shows one
              // timestamp at the end and the final bubble never loses it.
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
    </div>
  );
}
