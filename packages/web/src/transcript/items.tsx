import { createContext, Fragment, isValidElement, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { isNativeImageMime } from '../attachments.js';
import { useT } from '../i18n/index.js';
import { dispatchMessageSend } from '../operations/message.js';
import { useOperationDispatchOptional, useOperationRun } from '../operations/use-operations.js';
import {
  BrowserLinkOpenContext,
  ChatPanelOpenContext,
} from '../presentation/chat-panel.js';
import type { AgentSpawnItem, AutoNoticeItem, CommandItem, CompactionItem, DiffItem, FileReadItem, FileSearchItem, MsgItem, ReasoningItem, ToolItem, WebSearchItem } from '../types.js';
import { formatTime } from '../utils/format.js';
import { Caret } from './approval-cards.js';
import { transcriptItemIdentity } from './identity.js';
export { ApprovalCard, Caret } from './approval-cards.js';

/**
 * Provided by App.tsx to route file-link clicks into the in-app Files view
 * preview pane (the "fourth-level page"). When undefined, FileLink falls
 * back to the vscode:// scheme so the link still does something useful.
 */
export const FileLinkOpenContext = createContext<
  ((absPath: string, line?: number) => void) | null
>(null);

/** Provided by App.tsx to open an image in the in-app lightbox (an in-page
 *  overlay) instead of navigating to a new browser tab. Consumed by the user
 *  message attachment thumbnails. Null when no provider is mounted, in which
 *  case the thumbnail falls back to its plain `href` (new tab). */
export const ImageZoomContext = createContext<
  ((src: string, alt?: string) => void) | null
>(null);

/** Provided by App.tsx to push a DiffItem into the 4th-level inspector. Click
 *  handler on DiffCard fires this instead of expanding inline — the card
 *  itself stays compact (just file path + +/- stats). */
export const DiffOpenContext = createContext<((item: DiffItem) => void) | null>(null);

/** Compatibility path for transcript plan entries that open the chat-owned
 *  panel. The persistent PlanChip itself still expands inline. */
export interface PlanOpenPayload {
  /** Stable id used as the Sheet tab key. */
  id: string;
  title: string;
  markdown: string;
}
export const PlanOpenContext = createContext<
  ((payload: PlanOpenPayload) => void) | null
>(null);

/**
 * Provided by App.tsx: click-time fallback for relative-path markdown links
 * that the render-time linkify pass did NOT resolve (file created after the
 * index loaded, index missing, etc.). The handler re-resolves the href
 * against the active working tree with a fresh file list and opens it in the
 * in-app Files view. Null when no provider is mounted — clicks are then
 * swallowed so the SPA never navigates to a junk relative URL.
 */
export const RelativeLinkOpenContext = createContext<
  ((href: string) => void) | null
>(null);

/**
 * Provided by App.tsx: a rehype plugin (bound to the active working tree's
 * file index) that linkifies file references in transcript markdown. Null
 * until the index loads / when there's no working tree — markdown then renders
 * with no file linkification. See `linkify-files.ts`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const FileRefRehypeContext = createContext<
  null | (() => (tree: any) => void)
>(null);

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

/** Markdown renderer for transcript prose (assistant text + reasoning). Adds
 *  the file-linkify rehype plugin and an `a` override so detected files open
 *  in the in-app preview (with line jump) instead of navigating away. */
function MarkdownAnchor(props: {
  node?: { properties?: Record<string, unknown> };
  href?: string;
  children?: React.ReactNode;
}) {
  const openBrowser = useContext(BrowserLinkOpenContext);
  const openRelative = useContext(RelativeLinkOpenContext);
  const p = props.node?.properties ?? {};
  const abs = typeof p.dataFileAbs === 'string' ? p.dataFileAbs : null;
  if (abs) {
    const line = p.dataFileLine ? Number(p.dataFileLine) : undefined;
    return <FileLink path={abs} line={line} className="file-link-auto">{props.children}</FileLink>;
  }
  const routesToBrowser = !!props.href && /^https?:\/\//i.test(props.href);
  // Relative/bare-path hrefs the render-time linkify pass didn't resolve
  // (e.g. a file the agent created after the index loaded) never got a
  // dataFileAbs. Without a handler we'd have to swallow the click — such
  // hrefs would just reload the SPA at a junk URL (in the desktop shell
  // that spawns a whole second Gian window). With a handler, re-resolve
  // against the working tree at click time instead.
  const isDeadRelative = !!props.href && !/^[a-z][a-z0-9+.-]*:/i.test(props.href);
  return (
    <a
      href={props.href}
      target={routesToBrowser && openBrowser ? undefined : '_blank'}
      rel="noreferrer noopener"
      onClick={event => {
        if (isDeadRelative) {
          event.preventDefault();
          if (openRelative && props.href) openRelative(props.href);
          return;
        }
        if (!routesToBrowser || !openBrowser || !props.href) return;
        event.preventDefault();
        openBrowser(props.href);
      }}
    >
      {props.children}
    </a>
  );
}

/** Recursively flatten a React node tree to its text — used to recover the raw
 *  source of a fenced code block for its copy button. */
function reactNodeText(node: React.ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(reactNodeText).join('');
  if (isValidElement(node)) return reactNodeText((node.props as { children?: React.ReactNode }).children);
  return '';
}

/** Custom <pre> for rendered markdown: wraps the code block so a copy button can
 *  pin to its top-right (the <pre> itself scrolls horizontally, so the button
 *  rides the non-scrolling wrapper). */
function MarkdownPre({ children }: { node?: unknown; children?: React.ReactNode }) {
  const t = useT();
  const code = reactNodeText(children).replace(/\n+$/, '');
  return (
    <div className="code-block">
      {code.length > 0 && <CopyButton text={code} title={t('transcript.copyCode')} className="code-copy" />}
      <pre>{children}</pre>
    </div>
  );
}

export function MarkdownText({ children }: { children: string }) {
  const makeRehype = useContext(FileRefRehypeContext);
  const rehypePlugins = useMemo(
    () => (makeRehype ? [makeRehype] : []),
    [makeRehype],
  );
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={rehypePlugins as never}
      components={{ a: MarkdownAnchor as never, pre: MarkdownPre as never }}
    >
      {children}
    </ReactMarkdown>
  );
}

/**
 * Renders a file path as a clickable link. By default routes clicks into
 * the in-app Files view via `FileLinkOpenContext`; falls back to
 * `vscode://file/...` if no context provider is mounted (so right-click →
 * Copy Link Address still yields a useful URL either way).
 *
 * Absolute paths only — both proxies' normalizers emit absolute paths
 * today (see normalize-{cc,codex}.ts).
 */
function FileLink({
  path,
  line,
  className,
  children,
}: {
  path: string;
  line?: number | undefined;
  className?: string;
  children?: React.ReactNode;
}) {
  const openInApp = useContext(FileLinkOpenContext);
  // encodeURI keeps `/` and `:` intact; covers spaces and unicode in paths.
  const encoded = encodeURI(path);
  const href = line ? `vscode://file/${encoded}:${line}` : `vscode://file/${encoded}`;
  const title = openInApp
    ? `Preview ${path}${line ? `:${line}` : ''}`
    : `Open ${path}${line ? `:${line}` : ''} in VS Code`;
  return (
    <a
      className={`file-link${className ? ` ${className}` : ''}`}
      href={href}
      onClick={e => {
        // stopPropagation lets these sit inside collapsible card headers
        // without toggling the card on click.
        e.preventDefault();
        e.stopPropagation();
        if (openInApp) openInApp(path, line);
        else window.open(href, '_blank', 'noopener');
      }}
      title={title}
    >
      {children ?? path}
    </a>
  );
}

/* ------------------------------------------------------------------
 * Transcript redesign P1 (2026-08-08): single-line `.trow` system.
 * Every tool/event card below renders as one `.trow` row — caret (only
 * when the row can expand inline) + mono verb + subject + right meta —
 * with an optional `.trow-detail` in-place expansion for small content.
 * Over-threshold content (>10 output lines, multi-file / >30-line diffs,
 * long reasoning) keeps today's behavior: inline expand with a capped,
 * scrolling detail, or the existing inspector push for large diffs.
 * ------------------------------------------------------------------ */

/** Level-2 thresholds (locked in docs/work-items/transcript-redesign-acd.md). */
const INLINE_OUTPUT_LINES = 10;
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

/** `8s` under a minute, `1m 03s` past it. Exported for the P2 turnsum lead. */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

/** Right-meta for a running row: breathing dot + live timer from item.ts. */
function RunningMeta({ since }: { since: number }) {
  const now = useNowSeconds(true);
  return <span className="trow-run">running · {formatElapsed(now - since)}</span>;
}

/** Shared `.trow` row shell. `expandable` rows get a caret and toggle on
 *  click; `onRowClick` rows (panel-2 detail / inspector push / chat panel)
 *  are clickable but never expand inline. `caret` forces the caret glyph on
 *  a clickable level-3 row (the mockup marks every drill-down row with it;
 *  only level-1 "row is everything" rows go caret-less). */
function TRow({
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

/** Hover-revealed `⇥ panel` hint on level-3 rows (P3). */
function PanelExtHint() {
  const t = useT();
  return <span className="trow-ext" title={t('transcript.panel.open')}>⇥ panel</span>;
}

export function DiffCard({ item }: { item: DiffItem }) {
  const t = useT();
  // Level routing: a single-file diff with ≤30 hunk lines expands inline as
  // a mini diff; anything larger (multi-file, >30 lines, or no hunk data at
  // all) keeps the pre-redesign behavior — click pushes the diff into the
  // inspector drawer (panel-2 routing is P3).
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
  // panel 2 (the Sheet's diff viewer, via the same preview-tab route as
  // before); the hover `⇥ panel` hint advertises the destination.
  return (
    <TRow
      verb={t('transcript.diff.edit')}
      subject={subject}
      subjectTitle={subject}
      meta={<>{openDiff && <PanelExtHint />}{stats}</>}
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
  const t = useT();
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
  // truncates long values; both forms must still offer the full value in
  // panel 2. Running tools remain inline so live output does not jump panels.
  if (!running && hasDetail && detailNeedsPanel && openChatPanel) {
    return (
      <TRow
        verb={t('transcript.tool')}
        subject={item.name}
        subjectTitle={item.name}
        meta={
          <>
            <PanelExtHint />
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

/** Build full panel text and its routing metadata in one parse. With both
 * input and output present, retain the inline card's input-first ordering. */
function measureToolDetail(summary: string, output: string | undefined): {
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
 * value is visually long even though `split('\\n')` reports one line. */
function visualLineCount(text: string): number {
  if (!text) return 0;
  return text.split('\n').reduce(
    (count, line) => count + Math.max(1, Math.ceil(line.length / INLINE_DETAIL_COLUMNS)),
    0,
  );
}

function ToolArgs({ raw }: { raw: string }) {
  const t = useT();
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

function CopyButton({ text, title = 'Copy message', className }: { text: string; title?: string; className?: string }) {
  const t = useT();
  const defaultTitle = title === 'Copy message' ? t('transcript.copyMessage') : title;
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);
  useEffect(() => {
    return () => { if (timerRef.current) window.clearTimeout(timerRef.current); };
  }, []);
  const onClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      if (timerRef.current) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setCopied(false), 1200);
    }).catch(() => {});
  };
  return (
    <button
      type="button"
      className={`msg-copy${className ? ` ${className}` : ''}${copied ? ' copied' : ''}`}
      title={copied ? t('common.copied') : defaultTitle}
      aria-label={defaultTitle}
      onClick={onClick}
    >
      {copied ? (
        <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
          <path d="M3 8l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
          <rect x="5" y="3" width="8" height="10" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <path d="M3 5v7.5A1.5 1.5 0 0 0 4.5 14H10" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      )}
    </button>
  );
}

// V2 Msg (design/gian-design-v2/js/components.jsx::Msg) renders just
// `.msg > .msg-body > .msg-text + .msg-time` — no avatar, no author label.
// User messages flow `row-reverse` so the bubble + time align right.
export function UserMessage({ item }: { item: MsgItem }) {
  const t = useT();
  const zoom = useContext(ImageZoomContext);
  const dispatch = useOperationDispatchOptional();
  // Echo lifecycle (proposal §9): `pending` until the server emits its
  // `user_message`; `failed` marks a rejected send IN PLACE with a retry
  // affordance (retry re-dispatches the same operation); a still-pending
  // echo whose operation run timed out (or disconnected) shows the
  // unknown-outcome "may not have been sent" state — never a silent success.
  const sendRun = useOperationRun(item.sendRunId);
  const sendUnknown = Boolean(item.pending && item.sendRunId && sendRun?.phase === 'timed-out');
  const stateCls = item.pending ? ' pending' : item.failed ? ' failed' : '';
  const hasText = item.text.length > 0;
  const attachments = item.attachments ?? [];
  return (
    <div className={`msg user${stateCls}`} data-msg-id={transcriptItemIdentity(item)}>
      <div className="msg-body">
        {attachments.length > 0 && (
          <div className="msg-attachments user-attachments">
            {attachments.map((a, i) => (
              isNativeImageMime(a.mime) ? (
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
                      <span className="msg-file-size">{formatAttachmentSize(a.size)}</span>
                    )}
                  </span>
                </a>
              )
            ))}
          </div>
        )}
        {hasText && <div className="msg-text user-text">{item.text}</div>}
        <div className="msg-foot user">
          {item.failed && <span className="msg-state-failed">{t('transcript.failedToSend')}</span>}
          {item.failed && item.sendRetry && dispatch && (
            <button
              type="button"
              className="msg-retry"
              onClick={() => dispatchMessageSend(dispatch, item.sendRetry!)}
            >
              {t('transcript.retrySend')}
            </button>
          )}
          {sendUnknown && <span className="msg-state-unknown">{t('transcript.sendUnknown')}</span>}
          {hasText && <CopyButton text={item.text} />}
          <span className="msg-time user">{formatTime(item.ts)}</span>
        </div>
      </div>
    </div>
  );
}

function formatAttachmentSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function AssistantMessage({ item, hideAvatar, showFooter }: { item: MsgItem; hideAvatar?: boolean; showFooter?: boolean }) {
  // V2 design: no author label, time sits below the message body. The footer
  // (time + copy) renders on the TAIL of a same-sender run — `hideAvatar` keeps
  // the tight continuation spacing for mid-run bubbles, but `showFooter` (the
  // last bubble of the run) decides the time/copy so a multi-bubble turn shows
  // one timestamp at the end and the final bubble never loses it.
  return (
    <div className={`msg${hideAvatar ? ' continuation' : ''}`}>
      <div className="msg-body">
        <div className="msg-text md">
          <MarkdownText>{item.text}</MarkdownText>
        </div>
        {showFooter && (
          <div className="msg-foot">
            <span className="msg-time">{formatTime(item.ts)}</span>
            <CopyButton text={item.text} />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Reasoning content from codex (full trace or summary). Default-collapsed
 * `.trow` row: verb label + a dim one-line preview + line count on the
 * right. Click expands the trace in place; long traces stay inline but
 * scroll (panel-2 routing is P3).
 */
export function ReasoningCard({ item }: { item: ReasoningItem }) {
  const t = useT();
  const { open, toggle } = useStableExpand();
  const openChatPanel = useContext(ChatPanelOpenContext);
  const lineCount = item.text ? item.text.split('\n').length : 0;
  const label = item.variant === 'summary' ? t('transcript.reasoning.summary') : t('transcript.reasoning.full');
  const preview = item.text.split('\n', 1)[0] ?? '';
  const expandable = item.text.length > 0;
  // Level 3 (P3): a long trace opens in panel 2 instead of scrolling inline.
  if (expandable && lineCount > INLINE_OUTPUT_LINES && openChatPanel) {
    return (
      <TRow
        verb={label}
        subject={preview}
        subjectDim
        subjectTitle={preview}
        meta={
          <>
            <PanelExtHint />
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
  const t = useT();
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
  // output in panel 2. Running commands keep streaming inline.
  if (hasOutput && lineCount > INLINE_OUTPUT_LINES && !running && openChatPanel) {
    return (
      <TRow
        verb={t('transcript.command.run')}
        subject={item.command}
        subjectTitle={item.cwd ? `${item.command} — ${item.cwd}` : item.command}
        meta={
          <>
            <PanelExtHint />
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
  const t = useT();
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
  const t = useT();
  const { open, toggle } = useStableExpand();
  const openChatPanel = useContext(ChatPanelOpenContext);
  const hasMatches = item.matches && item.matches.length > 0;
  const count = item.matchCount ?? item.matches?.length;
  const verb = item.searchKind === 'glob' ? t('transcript.file.glob') : t('transcript.file.grep');
  // Level 3 (P3): a long result list opens in panel 2 instead of scrolling
  // inline; short lists keep the inline detail.
  if (hasMatches && item.matches!.length > INLINE_OUTPUT_LINES && openChatPanel) {
    return (
      <TRow
        verb={verb}
        subject={<span className="search-pattern">{item.pattern}</span>}
        subjectDim
        subjectTitle={item.pattern}
        meta={
          <>
            <PanelExtHint />
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
  const t = useT();
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
 * `context compacted · 128k → 41k`. No producer yet — see CompactionItem.
 */
export function CompactionRow({ item }: { item: CompactionItem }) {
  const t = useT();
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
 * Renders cc auto-mode notices. P2 forms:
 *   classifier-denied — a `.trow` single line (verb Auto-block, subject the
 *                       blocked action + dimmed reason, meta the
 *                       `2/3 · 5 total` counters) that folds into the
 *                       turnsum with the other process rows.
 *   circuit-breaker   — the minimal error card (label AUTO-MODE STOPPED).
 * The recovery action set sketched in the schema (retry / switch to ask /
 * abort) still isn't wired — host has no control channel for it.
 */
export function AutoNoticeCard({ item }: { item: AutoNoticeItem }) {
  const t = useT();
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
  const t = useT();
  const openChatPanel = useContext(ChatPanelOpenContext);
  const identity = transcriptItemIdentity(item);
  const stillRunning = item.status === 'running'
    && (!turnCompleted || item.background === true);
  // Plain trow (the pre-redesign orange shell is gone); the row has no
  // inline detail — click opens the agent's chat panel instead.
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
