import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ApprovalDecision } from '@gian/shared';
import type { TranscriptItem } from '../types.js';
import { formatTime } from '../utils/format.js';
import { AgentSpawnRow, ApprovalCard, AssistantMessage, AutoNoticeCard, Caret, CommandCard, DiffCard, FileReadCard, FileSearchCard, ReasoningCard, ToolEvent, UserMessage, WebSearchRow } from './items.js';
import { GianMascot } from '../components/GianMascot.js';

/**
 * Render-time grouping: walk items[] and fold consecutive action items
 * (everything that's not user/assistant text, approval, or error) into a
 * virtual `turn-actions` block. Boundaries (text/approval/error) flush the
 * current block. The trailing block — i.e. the one with no boundary after
 * it, meaning the agent is still acting — is flagged so the wrapper can
 * default to expanded while live and auto-collapse once a reply arrives.
 */
type RenderableItem =
  | TranscriptItem
  | { kind: 'turn-actions'; id: string; items: TranscriptItem[]; isTrailing: boolean };

function isActionItem(item: TranscriptItem): boolean {
  switch (item.kind) {
    case 'user':
    case 'assistant':
    case 'approval':
    case 'error':
    case 'status':
    case 'turn-start':
    case 'turn-end':
      return false;
    case 'auto-notice':
      // Inline classifier-denials fold into turn-actions; the circuit-breaker
      // is session-stopping and breaks the group so the card stands out.
      return item.variant === 'classifier-denied';
    default:
      return true;
  }
}

function groupIntoBlocks(items: TranscriptItem[]): RenderableItem[] {
  const out: RenderableItem[] = [];
  let bucket: TranscriptItem[] = [];
  const flush = () => {
    if (bucket.length === 0) return;
    out.push({
      kind: 'turn-actions',
      id: `actions_${bucket[0]!.id}`,
      items: bucket,
      isTrailing: false,
    });
    bucket = [];
  };
  for (const it of items) {
    if (isActionItem(it)) {
      bucket.push(it);
    } else {
      flush();
      out.push(it);
    }
  }
  flush();
  // Mark only the very last item as trailing (if it's an actions block).
  const last = out[out.length - 1];
  if (last && last.kind === 'turn-actions') {
    last.isTrailing = true;
  }
  return out;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n).trimEnd() + '…' : s;
}

export function renderItem(
  item: TranscriptItem,
  onApprove: (
    approvalId: string,
    decision: ApprovalDecision,
    answers?: Record<string, string | string[]>,
  ) => void,
  currentUserRef?: React.RefObject<HTMLDivElement | null>,
  isCurrentUser?: boolean,
  hideAvatar?: boolean,
) {
  switch (item.kind) {
    case 'user':
      if (isCurrentUser && currentUserRef) {
        return (
          <div key={item.id} ref={currentUserRef} data-current-user="true">
            <UserMessage item={item} hideAvatar={hideAvatar} />
          </div>
        );
      }
      return <UserMessage key={item.id} item={item} hideAvatar={hideAvatar} />;
    case 'assistant':
      return <AssistantMessage key={item.id} item={item} hideAvatar={hideAvatar} />;
    case 'reasoning':
      return <ReasoningCard key={item.id} item={item} />;
    case 'tool':
      return <ToolEvent key={item.id} item={item} />;
    case 'approval':
      return <ApprovalCard key={item.id} item={item} onApprove={onApprove} />;
    case 'diff':
      return <DiffCard key={item.id} item={item} />;
    case 'turn-start':
      // Hidden per design (PR5/A1) — TURN N dividers removed from transcript UI.
      // Data still flows through items[] / DB; only the visual divider is suppressed.
      return null;
    case 'turn-end':
      return null; // Skip, separator already shown by next turn-start
    case 'error':
      return (
        <div key={item.id} className="approval declined" style={{ maxWidth: 820 }}>
          <div className="approval-top">
            <div style={{ flex: 1 }}>
              <div className="approval-title">
                <span>Turn failed</span>
                <span className="approval-risk">error</span>
              </div>
              <div className="approval-sub">{item.text}</div>
            </div>
            <span className="evt-meta" style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--text-3)' }}>{formatTime(item.ts)}</span>
          </div>
        </div>
      );
    case 'status':
      return <div key={item.id} className="transcript-empty">{item.text}</div>;
    case 'command':
      return <CommandCard key={item.id} item={item} />;
    case 'file-read':
      return <FileReadCard key={item.id} item={item} />;
    case 'file-search':
      return <FileSearchCard key={item.id} item={item} />;
    case 'web-search':
      return <WebSearchRow key={item.id} item={item} />;
    case 'agent-spawn':
      return <AgentSpawnRow key={item.id} item={item} />;
    case 'auto-notice':
      return <AutoNoticeCard key={item.id} item={item} />;
  }
}

/**
 * Wraps a stretch of consecutive action items so the user can collapse the
 * "what the agent did" between two text replies. Single-item blocks fall
 * through to the bare child render — no wrapper noise. Multi-item blocks
 * default to expanded while trailing (live), collapse once a reply arrives.
 */
function TurnActionsBlock({
  block,
  onApprove,
}: {
  block: { id: string; items: TranscriptItem[]; isTrailing: boolean };
  onApprove: (
    approvalId: string,
    decision: ApprovalDecision,
    answers?: Record<string, string | string[]>,
  ) => void;
}) {
  const [open, setOpen] = useState(block.isTrailing);
  // Auto-fold once the agent stops acting (a reply / approval comes after).
  // If the user manually toggled while trailing, this still collapses on
  // reply — that matches "show me what's happening live, then get out of
  // the way" UX. They can always reopen.
  useEffect(() => {
    setOpen(block.isTrailing);
  }, [block.isTrailing]);

  if (block.items.length === 1) {
    return <>{renderItem(block.items[0]!, onApprove)}</>;
  }

  // Tiny tally: count by major kinds for the summary line.
  const tally = countActions(block.items);
  return (
    <div className={`evt actions ${open ? 'open' : ''}`}>
      <div className="evt-head" onClick={() => setOpen((o: boolean) => !o)}>
        <Caret />
        <span className="evt-verb">{block.isTrailing ? 'Working' : 'Steps'}</span>
        <span className="evt-subject">
          <span style={{ color: 'var(--text-2)' }}>{block.items.length} actions</span>
          {tally && (
            <span style={{ marginLeft: 8, color: 'var(--text-3)', fontSize: 11.5 }}>
              {tally}
            </span>
          )}
        </span>
      </div>
      {open && (
        <div className="evt-body actions-body">
          {block.items.map(child => renderItem(child, onApprove))}
        </div>
      )}
    </div>
  );
}

function countActions(items: TranscriptItem[]): string {
  let run = 0, edit = 0, explore = 0, agent = 0, other = 0;
  for (const it of items) {
    if (it.kind === 'command') run++;
    else if (it.kind === 'diff') edit++;
    else if (it.kind === 'file-read' || it.kind === 'file-search' || it.kind === 'web-search') explore++;
    else if (it.kind === 'agent-spawn') agent++;
    else other++;
  }
  return [
    explore && `Explored ${explore}`,
    run && `Ran ${run}`,
    edit && `Edited ${edit}`,
    agent && `Agent ${agent}`,
    other && `Other ${other}`,
  ].filter(Boolean).join(' · ');
}

export function Transcript({
  items, pending, onApprove,
}: {
  items: TranscriptItem[];
  pending: boolean;
  onApprove: (
    approvalId: string,
    decision: ApprovalDecision,
    answers?: Record<string, string | string[]>,
  ) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const currentUserRef = useRef<HTMLDivElement | null>(null);

  // Track the trailing assistant bubble's text length too — codex streams
  // deltas into the last bubble, so items.length alone misses growth.
  const tailLen = items.length > 0 && 'text' in items[items.length - 1]!
    ? (items[items.length - 1] as { text: string }).text.length
    : 0;
  // Scroll to bottom on every items change. The actual scroll container is
  // CodingView's `.main-scroll` wrapper (V2-style island), not our local
  // `.transcript-wrap`, so we walk up via closest(). Jam scrollTop twice —
  // synchronously and on next rAF — to absorb async layout shifts from
  // ReactMarkdown / syntax highlight that grow the transcript after the
  // initial measurement.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const scroller = (el.closest('.main-scroll') as HTMLElement | null) ?? el;
    scroller.scrollTop = scroller.scrollHeight;
    const id = window.requestAnimationFrame(() => {
      scroller.scrollTop = scroller.scrollHeight;
    });
    return () => window.cancelAnimationFrame(id);
  }, [items.length, tailLen, pending]);

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
        {items.length === 0 && !pending && (
          <div className="transcript-empty">say hi to start the conversation</div>
        )}
        {(() => {
          // Track the last visible sender. The author header (Claude · time)
          // hides for an *immediately consecutive* same-sender bubble (streaming
          // chunks within a single text block). Any intervening item — user
          // message, turn-actions block, approval, error, or diff — counts as
          // a sender break, so the next text gets a fresh header.
          let prevSender: 'user' | 'claude' | 'codex' | null = null;
          return groupIntoBlocks(items).map((item) => {
            if (item.kind === 'turn-actions') {
              prevSender = null;
              return <TurnActionsBlock key={item.id} block={item} onApprove={onApprove} />;
            }
            let hideAvatar = false;
            if (item.kind === 'user') {
              hideAvatar = prevSender === 'user';
              prevSender = 'user';
            } else if (item.kind === 'assistant') {
              hideAvatar = prevSender === item.exec;
              prevSender = item.exec;
            } else {
              // Anything else rendered between two text bubbles — reasoning,
              // approval, error, diff, auto-notice, status, turn markers —
              // counts as a sender break. The next assistant text must get a
              // fresh header (time + copy), even when the bubbles are from
              // the same exec. Codex in particular interleaves reasoning
              // cards between assistant_text chunks; without this the
              // post-reasoning bubble would lose its footer.
              prevSender = null;
            }
            return renderItem(
              item,
              onApprove,
              currentUserRef,
              item.kind === 'user' && currentUser !== null && item.id === currentUser.id,
              hideAvatar,
            );
          });
        })()}
        {showMascot && (
          <div className="msg-mascot">
            <GianMascot size={36} state="working" title="Working…" />
          </div>
        )}
    </div>
  );
}
