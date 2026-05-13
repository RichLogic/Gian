import { useEffect, useMemo, useRef, useState } from 'react';
import type { TranscriptItem } from '../types.js';
import { formatTime } from '../utils/format.js';
import { AgentSpawnRow, ApprovalCard, AssistantMessage, Avatar, Caret, CommandCard, DiffCard, FileReadCard, FileSearchCard, ToolEvent, UserMessage, WebSearchRow } from './items.js';

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
    decision: 'allow_once' | 'allow_session' | 'decline',
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
    decision: 'allow_once' | 'allow_session' | 'decline',
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
      <div className="evt-head" onClick={() => setOpen(o => !o)}>
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
  items, pending, executor, onApprove,
}: {
  items: TranscriptItem[];
  pending: boolean;
  executor: 'claude' | 'codex';
  onApprove: (
    approvalId: string,
    decision: 'allow_once' | 'allow_session' | 'decline',
    answers?: Record<string, string | string[]>,
  ) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const currentUserRef = useRef<HTMLDivElement | null>(null);
  const [pinVisible, setPinVisible] = useState(false);

  // Track the trailing assistant bubble's text length too — codex streams
  // deltas into the last bubble, so items.length alone misses growth.
  const tailLen = items.length > 0 && 'text' in items[items.length - 1]!
    ? (items[items.length - 1] as { text: string }).text.length
    : 0;
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: 'smooth' });
  }, [items.length, tailLen, pending]);

  // Find the most recent user message — that's the "current" turn's user input.
  const currentUser = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i]!;
      if (it.kind === 'user') return it;
    }
    return null;
  }, [items]);

  // Pin sticky bar when the current user message is fully scrolled above the viewport.
  useEffect(() => {
    setPinVisible(false);
    const el = currentUserRef.current;
    const root = ref.current;
    if (!el || !root || !currentUser) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry) return;
        const rootBounds = entry.rootBounds;
        if (!rootBounds) return;
        // Show pin only when the user message has been scrolled fully above
        // the viewport top — i.e. its bottom is above the scroll root's top.
        const isAboveViewport = entry.boundingClientRect.bottom <= rootBounds.top;
        setPinVisible(!entry.isIntersecting && isAboveViewport);
      },
      { root, threshold: 0 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [currentUser?.id]);

  function scrollToCurrentUser() {
    currentUserRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // Hide the "thinking…" ticker once an assistant bubble exists for this
  // turn — codex streams text into it, so the ticker becomes redundant.
  // Approvals also count as content (we're waiting on the user, not codex).
  const lastItem = items[items.length - 1];
  const showTicker = pending && lastItem?.kind !== 'assistant' && lastItem?.kind !== 'approval';

  return (
    <div className="transcript-wrap" ref={ref}>
      {pinVisible && currentUser && currentUser.kind === 'user' && (
        <div
          className="transcript-pin"
          onClick={scrollToCurrentUser}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); scrollToCurrentUser(); } }}
          aria-label="Scroll back to current user message"
        >
          <svg className="pin-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path d="M8 13V3M8 3L4 7M8 3l4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="pin-text">{truncate(currentUser.text, 80)}</span>
        </div>
      )}
      <div className="transcript">
        {items.length === 0 && !pending && (
          <div className="transcript-empty">say hi to start the conversation</div>
        )}
        {(() => {
          // Track the last visible sender so consecutive user/assistant
          // messages from the same side collapse to a single avatar. Turn-
          // actions blocks (the "WORKING N actions" wrapper) don't change
          // the sender — when the agent emits multiple text blocks
          // separated only by tool runs, we still treat them as one stretch.
          let prevSender: 'user' | 'claude' | 'codex' | null = null;
          return groupIntoBlocks(items).map((item) => {
            if (item.kind === 'turn-actions') {
              return <TurnActionsBlock key={item.id} block={item} onApprove={onApprove} />;
            }
            let hideAvatar = false;
            if (item.kind === 'user') {
              hideAvatar = prevSender === 'user';
              prevSender = 'user';
            } else if (item.kind === 'assistant') {
              hideAvatar = prevSender === item.exec;
              prevSender = item.exec;
            } else if (item.kind === 'approval' || item.kind === 'error' || item.kind === 'diff') {
              // Hard break — the next text message gets a fresh avatar.
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
        {showTicker && (
          <div className="msg">
            <Avatar exec={executor} />
            <div className="msg-body">
              <div className="msg-meta">
                <span className={`msg-author ${executor}`}>{executor === 'codex' ? 'Codex' : 'Claude'}</span>
              </div>
              <div className="msg-text">
                <span className="ticker">
                  <span className="dots"><span /><span /><span /></span>
                  thinking…
                </span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
