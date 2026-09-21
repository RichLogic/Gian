import { Fragment, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { useChatUiT } from './i18n.js';
import {
  ChatPanelOpenContext,
  DiffOpenContext,
  ImageZoomContext,
  MessageAttachmentOpenContext,
  ScheduleOpenContext,
} from './contexts.js';
import type { AgentSpawnItem, AutoNoticeItem, CommandItem, CompactionItem, DiffItem, FileReadItem, FileSearchItem, MsgItem, ReasoningItem, ToolItem, WebSearchItem } from './types.js';
import { formatElapsed, formatTime, formatBytes, isNativeImageMime } from './utils.js';
import { MarkdownText, FileLink } from './markdown.js';
import { LinkifiedText } from './links/linkify-text.js';
import { CopyButton } from './copy-button.js';
import { Caret } from './approval-cards.js';
import { ContextCards } from './context-cards.js';
import { InlineReferenceDocument } from './inline-reference-document.js';
import { transcriptItemIdentity } from './identity.js';
export { ApprovalCard, Caret } from './approval-cards.js';
export { MarkdownText, FileLink } from './markdown.js';
export { formatElapsed } from './utils.js';

/**
 * Expand/collapse state for an `.evt` card that keeps the clicked header at
 * the same viewport position. When the transcript is pinned to the bottom,
 * browser scroll anchoring follows the content *after* the card, so a bare
 * toggle bumps scrollTop by the inserted/removed body height and the header
 * jumps up out of view (2026-08-04). Recording the head's position at click
 * time and correcting scrollTop in a layout effect cancels the jump before
 * paint, while anchoring keeps handling non-interactive growth (streaming).
 */
export function useStableExpand(initial = false) {
  const [open, setOpen] = useState(initial);
  const pending = useRef<{ el: HTMLElement; top: number } | null>(null);
  const toggle = (e: MouseEvent<HTMLElement>) => {
    pending.current = { el: e.currentTarget, top: e.currentTarget.getBoundingClientRect().top };
    setOpen(o => !o);
  };
  useLayoutEffect(() => {
    const rec = pending.current;
    pending.current = null;
    if (!rec) return;
    const scroller = rec.el.closest('.main-scroll') as HTMLElement | null;
    if (scroller) scroller.scrollTop += rec.el.getBoundingClientRect().top - rec.top;
  });
  return { open, setOpen, toggle };
}

/* ------------------------------------------------------------------
 * Transcript redesign P1 (2026-08-08): single-line `.trow` system.
 * Every tool/event card below renders as one `.trow` row — caret (only
 * when the row can expand inline) + mono verb + subject + right meta —
 * with an optional `.trow-detail` in-place expansion for small content.
 * Over-threshold content (>10 output lines, multi-file / >30-line diffs,
 * long reasoning) routes to the host app's detail surface when one is
 * provided, or stays inline with a capped, scrolling detail.
 * ------------------------------------------------------------------ */

/** Level-2 thresholds (locked in docs/work-items/transcript-redesign-acd.md). */
export const INLINE_OUTPUT_LINES = 10;
const INLINE_DIFF_LINES = 30;
const INLINE_DETAIL_COLUMNS = 120;

/** Re-render once a second while `active` so running timers tick. */
function useNowSeconds(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

/** Right-meta for a running detail row: breathing dot + timer from item.ts. */
export function RunningMeta({ since }: { since: number }) {
  const now = useNowSeconds(true);
  return <span className="trow-run">running · {formatElapsed(now - since)}</span>;
}

/** Shared `.trow` row shell. `expandable` rows get a caret and toggle on
 *  click; `onRowClick` rows (detail-surface push) are clickable but never
 *  expand inline. `caret` forces the caret glyph on a clickable level-3 row
 *  (only level-1 "row is everything" rows go caret-less). Exported for the
 *  event feed, whose lines reuse the row grammar without any per-row click
 *  behavior (the whole box is the click target). */
export function TRow({
  verb,
  subject,
  subjectDim = false,
  subjectTitle,
  meta,
  expandable = false,
  open = false,
  onToggle,
  onRowClick,
  caret = false,
  rowRef,
  dataAttrs,
}: {
  verb: React.ReactNode;
  subject: React.ReactNode;
  subjectDim?: boolean;
  subjectTitle?: string;
  meta?: React.ReactNode;
  expandable?: boolean;
  open?: boolean;
  onToggle?: (e: MouseEvent<HTMLElement>) => void;
  onRowClick?: () => void;
  caret?: boolean;
  rowRef?: React.Ref<HTMLDivElement>;
  dataAttrs?: Record<string, string>;
}) {
  return (
    <div
      ref={rowRef}
      className={`trow${expandable ? ' expandable' : ''}${!expandable && onRowClick ? ' clickable' : ''}${open ? ' open' : ''}`}
      onClick={expandable ? onToggle : onRowClick}
      {...(onRowClick && !expandable ? {
        role: 'button',
        tabIndex: 0,
        onKeyDown: (e: React.KeyboardEvent) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onRowClick(); }
        },
      } : {})}
      {...dataAttrs}
    >
      {(expandable || caret) && <Caret className="trow-caret" />}
      <span className="trow-verb">{verb}</span>
      <span className={`trow-subject${subjectDim ? ' dim' : ''}`} title={subjectTitle}>{subject}</span>
      {meta && <span className="trow-meta">{meta}</span>}
    </div>
  );
}

export function DiffCard({ item }: { item: DiffItem }) {
  const t = useChatUiT();
  // Level routing: a single-file diff with ≤30 hunk lines expands inline as
  // a mini diff; anything larger (multi-file, >30 lines, or no hunk data at
  // all) clicks through to the app's detail surface (panel-2 routing is P3).
  const openDiff = useContext(DiffOpenContext);
  const { open, toggle } = useStableExpand();
  const totalAdd = item.files.reduce((s, f) => s + f.add, 0);
  const totalDel = item.files.reduce((s, f) => s + f.del, 0);
  const fileCount = item.files.length;
  const file = fileCount === 1 ? item.files[0]! : null;
  const diffLineCount = file
    ? file.hunks.reduce((n, h) => n + 1 + h.lines.length, 0)
    : 0;
  const inlineOk = file !== null && diffLineCount > 0 && diffLineCount <= INLINE_DIFF_LINES;
  const stats = (
    <>
      <span className="add">+{totalAdd}</span>
      <span className="del">−{totalDel}</span>
    </>
  );
  const subject = fileCount === 1 ? item.files[0]!.path : `${t('transcript.diff.changedFiles')} ${fileCount}`;
  if (inlineOk && file) {
    return (
      <>
        <TRow
          verb={t('transcript.diff.edit')}
          subject={subject}
          subjectTitle={subject}
          meta={stats}
          dataAttrs={{ 'data-testid': `diff-${item.id}` }}
          expandable
          open={open}
          onToggle={toggle}
        />
        {open && (
          <div className="trow-detail diff">
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
          </div>
        )}
      </>
    );
  }
  // Level 3 (P3): multi-file or >30-line diff — click opens the full diff in
  // the app's detail surface.
  return (
    <TRow
      verb={t('transcript.diff.edit')}
      subject={subject}
      subjectTitle={subject}
      meta={stats}
      dataAttrs={{ 'data-testid': `diff-${item.id}` }}
      onRowClick={() => openDiff?.(item)}
      caret
    />
  );
}

export function ToolEvent({
  item,
  turnCompleted = false,
}: {
  item: ToolItem;
  turnCompleted?: boolean;
}) {
  const t = useChatUiT();
  const { open, toggle } = useStableExpand();
  const openChatPanel = useContext(ChatPanelOpenContext);
  const hasDetail = !!(item.summary || item.output);
  // Historical tool cards all re-render while the current item streams. Keep
  // JSON parsing/stringifying bounded to a card whose own payload changed.
  const detail = useMemo(
    () => measureToolDetail(item.summary, item.output),
    [item.summary, item.output],
  );
  const detailNeedsPanel = detail.lines > INLINE_OUTPUT_LINES || detail.summaryTruncated;
  const running = !turnCompleted && (item.status === 'running' || item.status === 'pending');
  // Level 3: measure the complete detail, not just output. Tool arguments are
  // often a one-line JSON object and the inline key/value view deliberately
  // truncates long values; both forms must still offer the full value in the
  // detail surface. Running tools remain inline so live output does not jump.
  if (!running && hasDetail && detailNeedsPanel && openChatPanel) {
    return (
      <TRow
        verb={t('transcript.tool')}
        subject={item.name}
        subjectTitle={item.name}
        meta={
          <>
            {item.status === 'error' && <span className="err">error</span>}
            <span>{detail.lines} {t(detail.lines === 1 ? 'transcript.line' : 'transcript.lines')}</span>
          </>
        }
        onRowClick={() => openChatPanel({
          kind: 'transcript-detail',
          title: `${t('transcript.tool')}: ${item.name}`,
          text: detail.text,
          sourceId: transcriptItemIdentity(item),
        })}
        caret
      />
    );
  }
  return (
    <>
      <TRow
        verb={t('transcript.tool')}
        subject={item.name}
        subjectTitle={item.name}
        meta={
          running ? <RunningMeta since={item.ts} />
          : item.status === 'error' ? <span className="err">error</span>
          : undefined
        }
        expandable={hasDetail}
        open={open}
        onToggle={toggle}
      />
      {open && hasDetail && (
        <div className={`trow-detail${detailNeedsPanel ? ' scroll' : ''}`}>
          {item.summary && <ToolArgs raw={item.summary} />}
          {item.output && <pre className="tool-output">{item.output}</pre>}
        </div>
      )}
    </>
  );
}

/** Build full detail text and its routing metadata in one parse. With both
 *  input and output present, retain the inline card's input-first ordering.
 *  Exported for the event feed's per-row detail routing. */
export function measureToolDetail(summary: string, output: string | undefined): {
  text: string;
  lines: number;
  summaryTruncated: boolean;
} {
  let input = summary;
  let summaryTruncated = false;
  if (summary) {
    try {
      const parsed = JSON.parse(summary) as unknown;
      input = JSON.stringify(parsed, null, 2);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        summaryTruncated = Object.values(parsed as Record<string, unknown>).some(value => {
          if (typeof value === 'string') return value.length > INLINE_DETAIL_COLUMNS;
          if (value && typeof value === 'object') {
            return JSON.stringify(value).length > INLINE_DETAIL_COLUMNS;
          }
          return false;
        });
      }
    } catch {
      // A provider may send a plain-text summary; keep it losslessly.
    }
  }
  const text = !input ? output ?? '' : !output ? input : `${input}\n\n${output}`;
  return { text, lines: visualLineCount(text), summaryTruncated };
}

/** Estimate wrapped rows as well as explicit newlines. A giant one-line JSON
 *  value is visually long even though `split('\\n')` reports one line. */
function visualLineCount(text: string): number {
  if (!text) return 0;
  return text.split('\n').reduce(
    (count, line) => count + Math.max(1, Math.ceil(line.length / INLINE_DETAIL_COLUMNS)),
    0,
  );
}

function ToolArgs({ raw }: { raw: string }) {
  const t = useChatUiT();
  // Best-effort: parse the truncated JSON summary into key/value rows for
  // legibility. Falls back to raw mono text when parsing fails (truncation
  // mid-string can leave the JSON invalid).
  let parsed: unknown = null;
  try { parsed = JSON.parse(raw); } catch { /* ignore */ }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const entries = Object.entries(parsed as Record<string, unknown>);
    if (entries.length === 0) {
      return <code className="tool-args-empty">{t('transcript.tool.noArgs')}</code>;
    }
    return (
      <dl className="tool-args">
        {entries.map(([k, v]) => (
          <div key={k} className="tool-args-row">
            <dt className="tool-args-key">{k}</dt>
            <dd className="tool-args-val">{formatVal(v)}</dd>
          </div>
        ))}
      </dl>
    );
  }
  return (
    <code style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fz-12)', color: 'var(--text-2)' }}>{raw}</code>
  );
}

function formatVal(v: unknown): string {
  if (v == null) return String(v);
  if (typeof v === 'string') return v.length > 120 ? v.slice(0, 120) + '…' : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = JSON.stringify(v);
  return s.length > 120 ? s.slice(0, 120) + '…' : s;
}

// V2 Msg (design/gian-design-v2/js/components.jsx::Msg) renders just
// `.msg > .msg-body > .msg-text + .msg-time` — no avatar, no author label.
// User messages flow `row-reverse` so the bubble + time align right.
export function UserMessage({
  item,
  sendUnknown = false,
  onRetrySend,
}: {
  item: MsgItem;
  /** A still-pending echo whose send outcome is unknown (the app's send
   *  tracking timed out or disconnected) — the "may not have been sent"
   *  state. Never a silent success. Derived and injected by the host app. */
  sendUnknown?: boolean;
  /** Retry affordance for a failed echo; the host app re-dispatches the SAME
   *  send. Absent: no retry button. */
  onRetrySend?: () => void;
}) {
  const t = useChatUiT();
  const zoom = useContext(ImageZoomContext);
  const openAttachment = useContext(MessageAttachmentOpenContext);
  const openSchedule = useContext(ScheduleOpenContext);
  // Echo lifecycle: `pending` until the server emits its `user_message`;
  // `failed` marks a rejected send IN PLACE with a retry affordance.
  const stateCls = item.pending ? ' pending' : item.failed ? ' failed' : '';
  const hasText = item.text.length > 0;
  const attachments = item.attachments ?? [];
  const inlineDocument = item.composerDocument;
  return (
    <div
      className={`msg user${stateCls}`}
      data-msg-id={transcriptItemIdentity(item)}
      {...(item.scheduledTask ? { 'data-schedule-run': item.scheduledTask.run_id } : {})}
    >
      <div className="msg-body">
        {!inlineDocument && <ContextCards items={item.contextItems ?? []} className="message-context-cards" />}
        {!inlineDocument && attachments.length > 0 && (
          <div className="msg-attachments user-attachments">
            {attachments.map((a, i) => (
              openAttachment ? (
                <button
                  key={`${a.url}-${i}`}
                  type="button"
                  className="msg-file-att"
                  title={a.name}
                  onClick={() => openAttachment(a)}
                >
                  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path d="M4 1.75h5l3 3V14.25H4z" stroke="currentColor" strokeWidth="1.2" />
                    <path d="M9 1.75v3h3" stroke="currentColor" strokeWidth="1.2" />
                  </svg>
                  <span className="msg-file-meta">
                    <span className="msg-file-name">{a.name}</span>
                    {a.size !== undefined && <span className="msg-file-size">{formatBytes(a.size)}</span>}
                  </span>
                </button>
              ) : isNativeImageMime(a.mime) ? (
                <a
                  key={`${a.url}-${i}`}
                  className={`msg-att${zoom ? ' zoomable' : ''}`}
                  href={a.url}
                  target="_blank"
                  rel="noreferrer"
                  title={a.name}
                  onClick={zoom ? (e) => {
                    // Plain left-click → in-app lightbox. Leave modified clicks
                    // (⌘/ctrl/shift/alt, middle button) to the browser so
                    // "open in new tab" still works via the underlying href.
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
                    e.preventDefault();
                    zoom(a.url, a.name);
                  } : undefined}
                >
                  <img src={a.url} alt={a.name} />
                </a>
              ) : (
                <a
                  key={`${a.url}-${i}`}
                  className="msg-file-att"
                  href={a.url}
                  download={a.name}
                  title={a.name}
                >
                  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path d="M4 1.75h5l3 3V14.25H4z" stroke="currentColor" strokeWidth="1.2" />
                    <path d="M9 1.75v3h3" stroke="currentColor" strokeWidth="1.2" />
                  </svg>
                  <span className="msg-file-meta">
                    <span className="msg-file-name">{a.name}</span>
                    {a.size !== undefined && (
                      <span className="msg-file-size">{formatBytes(a.size)}</span>
                    )}
                  </span>
                </a>
              )
            ))}
          </div>
        )}
        {(hasText || inlineDocument) && (
          <div
            className="msg-text user-text"
            data-transcript-selectable="true"
            data-transcript-source-id={transcriptItemIdentity(item)}
            data-transcript-source-kind="user"
            data-transcript-turn={item.turn}
          >
            {inlineDocument ? (
              <InlineReferenceDocument
                document={inlineDocument}
                attachments={attachments}
                contextItems={item.contextItems}
                onAttachmentActivate={attachment => {
                  if (!zoom || !isNativeImageMime(attachment.mime ?? '') || !attachment.url) return false;
                  zoom(attachment.url, attachment.name);
                  return true;
                }}
              />
            ) : (
              <LinkifiedText text={item.text} />
            )}
          </div>
        )}
        <div className="msg-foot user">
          {item.scheduledTask && (
            openSchedule ? (
              <button
                type="button"
                className="msg-schedule-tag"
                data-testid={`schedule-tag-${item.scheduledTask.run_id}`}
                title={t('schedule.sentBySchedule')}
                aria-label={`${t('schedule.sentBySchedule')}: ${item.scheduledTask.schedule_name}`}
                onClick={event => {
                  event.stopPropagation();
                  openSchedule(item.scheduledTask!.schedule_id);
                }}
              >
                <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="12" cy="13" r="7" />
                  <path d="M12 9.5v3.5l2.5 2.5" />
                  <path d="M9 3.5h6" />
                </svg>
                <span className="msg-schedule-tag-name">{item.scheduledTask.schedule_name}</span>
              </button>
            ) : (
              <span className="msg-schedule-tag" title={t('schedule.sentBySchedule')}>
                <span className="msg-schedule-tag-name">{item.scheduledTask.schedule_name}</span>
              </span>
            )
          )}
          {item.failed && <span className="msg-state-failed">{t('transcript.failedToSend')}</span>}
          {item.failed && onRetrySend && (
            <button
              type="button"
              className="msg-retry"
              onClick={onRetrySend}
            >
              {t('transcript.retrySend')}
            </button>
          )}
          {sendUnknown && <span className="msg-state-unknown">{t('transcript.sendUnknown')}</span>}
          <span className="msg-time user">{formatTime(item.ts)}</span>
        </div>
      </div>
    </div>
  );
}

export function AssistantMessage({
  item,
  hideAvatar,
  showFooter,
  copyable = false,
  footerActions,
}: {
  item: MsgItem;
  hideAvatar?: boolean;
  showFooter?: boolean;
  copyable?: boolean;
  footerActions?: ReactNode;
}) {
  // V2 design: no author label, time sits below the message body. Timestamps
  // stay on the tail of each same-sender run, while message-level Copy and
  // per-turn actions belong only to the successful Terminal Turn result.
  return (
    <div className={`msg${hideAvatar ? ' continuation' : ''}`}>
      <div className="msg-body">
        <div
          className="msg-text md"
          data-transcript-selectable="true"
          data-transcript-source-id={transcriptItemIdentity(item)}
          data-transcript-source-kind="assistant"
          data-transcript-turn={item.turn}
        >
          <MarkdownText>{item.text}</MarkdownText>
        </div>
        {(showFooter || copyable || footerActions) && (
          <div className="msg-foot">
            {showFooter && <span className="msg-time">{formatTime(item.ts)}</span>}
            {copyable && <CopyButton text={item.text} />}
            {footerActions}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Reasoning content from the provider (full trace or summary).
 * Default-collapsed `.trow` row: verb label + a dim one-line preview + line
 * count on the right. Click expands the trace in place; long traces open in
 * the app's detail surface when one is provided.
 */
export function ReasoningCard({ item }: { item: ReasoningItem }) {
  const t = useChatUiT();
  const { open, toggle } = useStableExpand();
  const openChatPanel = useContext(ChatPanelOpenContext);
  const lineCount = item.text ? item.text.split('\n').length : 0;
  const label = item.variant === 'summary' ? t('transcript.reasoning.summary') : t('transcript.reasoning.full');
  const preview = item.text.split('\n', 1)[0] ?? '';
  const expandable = item.text.length > 0;
  // Level 3 (P3): a long trace opens in the detail surface instead of
  // scrolling inline.
  if (expandable && lineCount > INLINE_OUTPUT_LINES && openChatPanel) {
    return (
      <TRow
        verb={label}
        subject={preview}
        subjectDim
        subjectTitle={preview}
        meta={
          <>
            <span>{lineCount} {t(lineCount === 1 ? 'transcript.line' : 'transcript.lines')}</span>
          </>
        }
        onRowClick={() => openChatPanel({
          kind: 'transcript-detail',
          title: label,
          text: item.text,
          sourceId: transcriptItemIdentity(item),
        })}
        caret
        dataAttrs={{ 'data-variant': item.variant }}
      />
    );
  }
  return (
    <>
      <TRow
        verb={label}
        subject={preview}
        subjectDim
        subjectTitle={preview}
        meta={<span>{lineCount} {t(lineCount === 1 ? 'transcript.line' : 'transcript.lines')}</span>}
        expandable={expandable}
        open={open}
        onToggle={toggle}
        dataAttrs={{ 'data-variant': item.variant }}
      />
      {open && expandable && (
        <div className={`trow-detail cmd${lineCount > INLINE_OUTPUT_LINES ? ' scroll' : ''}`}>{item.text}</div>
      )}
    </>
  );
}

export function CommandCard({
  item,
  turnCompleted = false,
}: {
  item: CommandItem;
  turnCompleted?: boolean;
}) {
  const t = useChatUiT();
  const { open, toggle } = useStableExpand();
  const openChatPanel = useContext(ChatPanelOpenContext);
  const outputText = item.stdout + (item.stderr ? `\n${item.stderr}` : '');
  const hasOutput = outputText.length > 0;
  const lineCount = hasOutput ? visualLineCount(outputText) : 0;
  const running = !turnCompleted && item.status === 'running';
  const finishedMeta = (
    <>
      {item.status === 'error' && <span className="err">error</span>}
      {item.exitCode !== undefined && <span>exit {item.exitCode}</span>}
    </>
  );
  // Level 3 (P3): a finished command with >10 output lines opens the full
  // output in the detail surface. Running commands keep streaming inline.
  if (hasOutput && lineCount > INLINE_OUTPUT_LINES && !running && openChatPanel) {
    return (
      <TRow
        verb={t('transcript.command.run')}
        subject={item.command}
        subjectTitle={item.cwd ? `${item.command} — ${item.cwd}` : item.command}
        meta={
          <>
            {finishedMeta}
            <span>{lineCount} {t(lineCount === 1 ? 'transcript.line' : 'transcript.lines')}</span>
          </>
        }
        onRowClick={() => openChatPanel({
          kind: 'transcript-detail',
          title: `${t('transcript.command.run')}: ${item.command}`,
          text: outputText,
          sourceId: transcriptItemIdentity(item),
        })}
        caret
        dataAttrs={{ 'data-testid': `command-${item.id}` }}
      />
    );
  }
  return (
    <>
      <TRow
        verb={t('transcript.command.run')}
        subject={item.command}
        subjectTitle={item.cwd ? `${item.command} — ${item.cwd}` : item.command}
        meta={
          running ? <RunningMeta since={item.ts} />
          : finishedMeta
        }
        expandable={hasOutput}
        open={open}
        onToggle={toggle}
        dataAttrs={{ 'data-testid': `command-${item.id}` }}
      />
      {open && hasOutput && (
        <div className={`trow-detail cmd${lineCount > INLINE_OUTPUT_LINES ? ' scroll' : ''}`}>
          {running
            ? (
              <div className="cmd-stream">
                <span>{item.stdout}</span>
                <span className="cmd-cursor" />
              </div>
            )
            : outputText
          }
        </div>
      )}
    </>
  );
}

export function FileReadCard({ item }: { item: FileReadItem }) {
  const t = useChatUiT();
  const lineRange = item.startLine !== undefined
    ? ` :${item.startLine}${item.endLine !== undefined ? `–${item.endLine}` : ''}`
    : '';
  const fullLabel = `${item.path}${lineRange}`;
  return (
    <TRow
      verb={t('transcript.file.read')}
      subject={<FileLink path={item.path} line={item.startLine}>{fullLabel}</FileLink>}
      subjectTitle={fullLabel}
    />
  );
}

export function FileSearchCard({ item }: { item: FileSearchItem }) {
  const t = useChatUiT();
  const { open, toggle } = useStableExpand();
  const openChatPanel = useContext(ChatPanelOpenContext);
  const hasMatches = item.matches && item.matches.length > 0;
  const count = item.matchCount ?? item.matches?.length;
  const verb = item.searchKind === 'glob' ? t('transcript.file.glob') : t('transcript.file.grep');
  // Level 3 (P3): a long result list opens in the detail surface instead of
  // scrolling inline; short lists keep the inline detail.
  if (hasMatches && item.matches!.length > INLINE_OUTPUT_LINES && openChatPanel) {
    return (
      <TRow
        verb={verb}
        subject={<span className="search-pattern">{item.pattern}</span>}
        subjectDim
        subjectTitle={item.pattern}
        meta={
          <>
            {count !== undefined && <span>{count} {t(count === 1 ? 'transcript.file.match' : 'transcript.file.matches')}</span>}
          </>
        }
        onRowClick={() => openChatPanel({
          kind: 'transcript-detail',
          title: `${verb}: /${item.pattern}/`,
          text: item.matches!.join('\n'),
          sourceId: transcriptItemIdentity(item),
        })}
        caret
      />
    );
  }
  return (
    <>
      <TRow
        verb={verb}
        subject={<span className="search-pattern">{item.pattern}</span>}
        subjectDim
        subjectTitle={item.pattern}
        meta={count !== undefined ? <span>{count} {t(count === 1 ? 'transcript.file.match' : 'transcript.file.matches')}</span> : undefined}
        expandable={hasMatches}
        open={open}
        onToggle={toggle}
      />
      {open && hasMatches && (
        <div className={`trow-detail search-results${item.matches!.length > INLINE_OUTPUT_LINES ? ' scroll' : ''}`}>
          {item.matches!.map((m, i) => (
            <div key={i} className="search-result">
              <span className="sr-loc">{m}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

export function WebSearchRow({ item }: { item: WebSearchItem }) {
  const t = useChatUiT();
  return (
    <TRow
      verb={t('transcript.web.search')}
      subject={item.query}
      subjectDim
      subjectTitle={item.query}
      meta={item.resultCount !== undefined ? <span>{item.resultCount} {t('transcript.web.results')}</span> : undefined}
    />
  );
}

/**
 * Minimal error card (P2, 2026-08-08): the neutral `.approval` shell with a
 * small danger label + error text — no icon / title / pill / timestamp.
 * Shared by the Turn-failed card and the auto-mode circuit-breaker.
 */
export function MinimalErrorCard({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="approval">
      <div className="error-label">{label}</div>
      <div className="error-text">{children}</div>
    </div>
  );
}

/**
 * Compaction row (P2): `.trow` single line, verb `Compact`, subject
 * `context compacted · 128k → 41k`.
 */
export function CompactionRow({ item }: { item: CompactionItem }) {
  const t = useChatUiT();
  const k = (n: number) => `${Math.round(n / 1000)}k`;
  const subject = item.beforeTokens !== undefined && item.afterTokens !== undefined
    ? `${t('transcript.compact.subject')} · ${k(item.beforeTokens)} → ${k(item.afterTokens)}`
    : t('transcript.compact.subject');
  return (
    <TRow
      verb={t('transcript.compact.verb')}
      subject={subject}
      subjectDim
    />
  );
}

/**
 * Renders auto-mode notices. P2 forms:
 *   classifier-denied — a `.trow` single line (verb Auto-block, subject the
 *                       blocked action + dimmed reason, meta the
 *                       `2/3 · 5 total` counters) that folds into the
 *                       turnsum with the other process rows.
 *   circuit-breaker   — the minimal error card (label AUTO-MODE STOPPED).
 */
export function AutoNoticeCard({ item }: { item: AutoNoticeItem }) {
  const t = useChatUiT();
  if (item.variant === 'notice') {
    if (item.severity === 'error') {
      return (
        <MinimalErrorCard label={item.title || item.code || 'Notice'}>
          {item.message}
        </MinimalErrorCard>
      );
    }
    return (
      <TRow
        verb={item.title || 'Notice'}
        subject={item.message}
        subjectTitle={item.message}
        subjectDim={item.severity === 'info'}
        meta={item.code ? <span>{item.code}</span> : undefined}
      />
    );
  }
  if (item.variant === 'circuit-breaker') {
    const triggerLabel = item.trigger === 'total'
      ? `${item.total} ${t('transcript.auto.totalDenials')}`
      : `${item.consecutive} ${t('transcript.auto.consecutiveDenials')}`;
    return (
      <MinimalErrorCard label={t('transcript.auto.stoppedLabel')}>
        {triggerLabel} — {t('transcript.auto.paused')} {t('transcript.auto.recovery')}
      </MinimalErrorCard>
    );
  }
  return (
    <TRow
      verb={t('transcript.auto.block')}
      subject={
        <>
          {item.action || t('transcript.auto.action')}
          {item.reason && <span className="dim-reason">{item.reason}</span>}
        </>
      }
      subjectTitle={item.action}
      meta={<span>{item.consecutive}/3 · {item.total} {t('transcript.auto.total')}</span>}
    />
  );
}

export function AgentSpawnRow({
  item,
  turnCompleted = false,
}: {
  item: AgentSpawnItem;
  turnCompleted?: boolean;
}) {
  const t = useChatUiT();
  const openChatPanel = useContext(ChatPanelOpenContext);
  const identity = transcriptItemIdentity(item);
  const stillRunning = item.status === 'running'
    && (!turnCompleted || item.background === true);
  // Plain trow; the row has no inline detail — click opens the agent's chat
  // panel instead.
  return (
    <TRow
      verb={t('transcript.agent')}
      subject={item.description}
      subjectTitle={item.description}
      meta={
        stillRunning ? <RunningMeta since={item.ts} />
        : item.status === 'running' ? <span>{t('coding.status.interrupted')}</span>
        : item.status === 'error' ? <span className="err">error</span>
        : undefined
      }
      onRowClick={() => openChatPanel?.({ kind: 'agent', id: identity })}
      dataAttrs={{ 'data-agent-id': identity, 'data-provider': item.provider, title: t('transcript.agentOpen') }}
    />
  );
}
