import { createContext, isValidElement, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { isNativeImageMime } from '../attachments.js';
import { useT } from '../i18n/index.js';
import {
  BrowserLinkOpenContext,
  ChatPanelOpenContext,
} from '../presentation/chat-panel.js';
import type { AgentSpawnItem, AutoNoticeItem, CommandItem, DiffItem, FileReadItem, FileSearchItem, MsgItem, ReasoningItem, ToolItem, WebSearchItem } from '../types.js';
import { formatTime } from '../utils/format.js';
import { Caret, SeverityIcon } from './approval-cards.js';
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

/** Compatibility path for callers that explicitly push plan markdown into the
 *  4th-level inspector. The persistent PlanChip now expands inline; keeping
 *  this provider leaves the Sheet capability available to other plan entry
 *  points without coupling the status strip back to the panel. */
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
  const p = props.node?.properties ?? {};
  const abs = typeof p.dataFileAbs === 'string' ? p.dataFileAbs : null;
  if (abs) {
    const line = p.dataFileLine ? Number(p.dataFileLine) : undefined;
    return <FileLink path={abs} line={line} className="file-link-auto">{props.children}</FileLink>;
  }
  const routesToBrowser = !!props.href && /^https?:\/\//i.test(props.href);
  return (
    <a
      href={props.href}
      target={routesToBrowser && openBrowser ? undefined : '_blank'}
      rel="noreferrer noopener"
      onClick={event => {
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

export function DiffCard({ item }: { item: DiffItem }) {
  const t = useT();
  // Compact-only: click pushes the diff to the inspector drawer instead of
  // expanding inline. The diff itself can be hundreds of lines; inlining it
  // crowded the transcript heavily. Now the card is one-line and the
  // inspector renders the hunks.
  const openDiff = useContext(DiffOpenContext);
  const totalAdd = item.files.reduce((s, f) => s + f.add, 0);
  const totalDel = item.files.reduce((s, f) => s + f.del, 0);
  const fileCount = item.files.length;
  return (
    <div
      className="evt fc compact"
      onClick={() => openDiff?.(item)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDiff?.(item); }
      }}
    >
      <div className="evt-head">
        <span className="evt-verb">{t('transcript.diff.edit')}</span>
        <span className="evt-subject">
          {fileCount === 1 ? item.files[0]!.path : `${t('transcript.diff.changedFiles')} ${fileCount}`}
        </span>
        <span className="evt-meta">
          <span className="add">+{totalAdd}</span>
          <span className="del">−{totalDel}</span>
        </span>
      </div>
    </div>
  );
}

export function ToolEvent({ item }: { item: ToolItem }) {
  const t = useT();
  const { open, toggle } = useStableExpand();
  return (
    <div className={`evt agent ${open ? 'open' : ''}`}>
      <div className="evt-head" onClick={toggle}>
        <Caret />
        <span className="evt-verb">{t('transcript.tool')}</span>
        <span className="evt-subject" title={item.name}>{item.name}</span>
        <span className="evt-meta">
          <span className={`evt-status ${item.status}`}>{item.status}</span>
        </span>
      </div>
      {(item.summary || item.output) && (
        <div className="evt-body">
          {item.summary && <ToolArgs raw={item.summary} />}
          {item.output && <pre className="tool-output">{item.output}</pre>}
        </div>
      )}
    </div>
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
  // Optimistic echo: `pending` until the server emits its `user_message`,
  // `failed` when an `error` envelope marks it rejected.
  const stateCls = item.pending ? ' pending' : item.failed ? ' failed' : '';
  const hasText = item.text.length > 0;
  const attachments = item.attachments ?? [];
  return (
    <div className={`msg user${stateCls}`} data-msg-id={item.id}>
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
 * row on the shared `.evt` shell (`.evt.thinking` variant) — same caret,
 * gutter, fonts and hover as every other action row so it folds naturally
 * into a turn-actions block. Both `variant: 'summary'` and `variant: 'full'`
 * use the same shell, differentiated only by the header label and the
 * summary accent.
 */
export function ReasoningCard({ item }: { item: ReasoningItem }) {
  const t = useT();
  const { open, toggle } = useStableExpand();
  const lineCount = item.text ? item.text.split('\n').length : 0;
  const label = item.variant === 'summary' ? t('transcript.reasoning.summary') : t('transcript.reasoning.full');
  return (
    <div className={`evt thinking${open ? ' open' : ''}`} data-variant={item.variant}>
      <div className="evt-head" onClick={toggle}>
        <Caret />
        <span className="evt-verb">{label}</span>
        <span className="evt-meta">{lineCount} {t(lineCount === 1 ? 'transcript.line' : 'transcript.lines')}</span>
      </div>
      {open && (
        <div className="evt-body md">
          <MarkdownText>{item.text}</MarkdownText>
        </div>
      )}
    </div>
  );
}

export function CommandCard({ item }: { item: CommandItem }) {
  const t = useT();
  const { open, toggle } = useStableExpand();
  const statusClass = item.status === 'running' ? 'running' : item.status === 'success' ? 'success' : 'error';
  const hasOutput = !!(item.stdout || item.stderr);
  return (
    <div className={`evt command ${open && hasOutput ? 'open' : ''}`}>
      <div className="evt-head" onClick={e => { if (hasOutput) toggle(e); }}>
        {hasOutput && <Caret />}
        <span className="evt-verb">{t('transcript.command.run')}</span>
        <span className="evt-subject cmd" title={item.command}>{item.command}</span>
        <span className="evt-meta">
          {item.cwd && <span style={{ color: 'var(--text-3)' }} title={item.cwd}>{item.cwd}</span>}
          {item.status !== 'success' && (
            <span className={`evt-status ${statusClass}`}>{item.status}</span>
          )}
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fz-10)', color: 'var(--text-3)' }}>{formatTime(item.ts)}</span>
        </span>
      </div>
      {hasOutput && (
        <div className="evt-body" style={{ padding: '8px 12px', whiteSpace: 'pre-wrap', color: 'var(--text-2)' }}>
          {item.status === 'running'
            ? (
              <div className="cmd-stream">
                <span>{item.stdout}</span>
                <span className="cmd-cursor" />
              </div>
            )
            : <span>{item.stdout}{item.stderr ? `\n${item.stderr}` : ''}</span>
          }
        </div>
      )}
    </div>
  );
}

export function FileReadCard({ item }: { item: FileReadItem }) {
  const t = useT();
  const lineRange = item.startLine !== undefined
    ? ` :${item.startLine}${item.endLine !== undefined ? `–${item.endLine}` : ''}`
    : '';
  const fullLabel = `${item.path}${lineRange}`;
  return (
    <div className="evt inline">
      <div className="evt-head">
        <span className="evt-verb">{t('transcript.file.read')}</span>
        <span className="evt-subject path" title={fullLabel}>
          <FileLink path={item.path} line={item.startLine}>{fullLabel}</FileLink>
        </span>
        <span className="evt-meta">
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fz-10)', color: 'var(--text-3)' }}>{formatTime(item.ts)}</span>
        </span>
      </div>
    </div>
  );
}

export function FileSearchCard({ item }: { item: FileSearchItem }) {
  const t = useT();
  const { open, toggle } = useStableExpand();
  const hasMatches = item.matches && item.matches.length > 0;
  const count = item.matchCount ?? item.matches?.length;
  return (
    <div className={`evt search ${open && hasMatches ? 'open' : ''}`}>
      <div className="evt-head" onClick={e => { if (hasMatches) toggle(e); }}>
        {hasMatches && <Caret />}
        <span className="evt-verb">{item.searchKind === 'glob' ? t('transcript.file.glob') : t('transcript.file.grep')}</span>
        <span className="evt-subject" title={item.pattern}>
          <span className="search-pattern">{item.pattern}</span>
        </span>
        <span className="evt-meta">
          {count !== undefined && <span>{count} {t(count === 1 ? 'transcript.file.match' : 'transcript.file.matches')}</span>}
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fz-10)', color: 'var(--text-3)' }}>{formatTime(item.ts)}</span>
        </span>
      </div>
      {hasMatches && (
        <div className="evt-body search-results" style={{ maxHeight: 200 }}>
          {item.matches!.map((m, i) => (
            <div key={i} className="search-result">
              <span className="sr-loc">{m}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function WebSearchRow({ item }: { item: WebSearchItem }) {
  const t = useT();
  return (
    <div className="evt web inline">
      <div className="evt-head">
        <span className="evt-verb">{t('transcript.web.search')}</span>
        <span className="evt-subject" title={item.query}>{item.query}</span>
        <span className="evt-meta">
          {item.resultCount !== undefined && <span>{item.resultCount} {t('transcript.web.results')}</span>}
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fz-10)', color: 'var(--text-3)' }}>{formatTime(item.ts)}</span>
        </span>
      </div>
    </div>
  );
}

/**
 * Renders cc auto-mode notices: per-action classifier denials (info) and the
 * 3-in-a-row / 20-total circuit-breaker trip (alert). The recovery action set
 * sketched in the schema (retry / switch to ask / abort) isn't wired yet —
 * host has no control channel for it — so the card is presentational. Once
 * those controls exist, the buttons drop in below `.auto-notice-body`.
 */
export function AutoNoticeCard({ item }: { item: AutoNoticeItem }) {
  const t = useT();
  if (item.variant === 'circuit-breaker') {
    const triggerLabel = item.trigger === 'total'
      ? `${item.total} ${t('transcript.auto.totalDenials')}`
      : `${item.consecutive} ${t('transcript.auto.consecutiveDenials')}`;
    return (
      <div className="approval declined auto-notice auto-notice--breaker">
        <div className="approval-top">
          <div className="approval-ico">
            <SeverityIcon risk="high" />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="approval-title">
              <span>{t('transcript.auto.breaker')}</span>
              <span className="approval-risk">{t('transcript.auto.stopped')}</span>
            </div>
            <div className="approval-sub">
              {triggerLabel} — {t('transcript.auto.paused')}
            </div>
          </div>
          <span className="evt-meta" style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fz-10)', color: 'var(--text-3)' }}>{formatTime(item.ts)}</span>
        </div>
        <div className="approval-resolved-note">
          <span className="dot" />
          <span>
            {t('transcript.auto.recovery')}
          </span>
        </div>
      </div>
    );
  }
  // classifier-denied: lightweight inline notice, mirrors the FileSearch / Run
  // row look so it folds naturally into a turn-actions block.
  return (
    <div className="evt inline auto-notice auto-notice--classifier">
      <div className="evt-head">
        <span className="evt-verb">{t('transcript.auto.block')}</span>
        <span className="evt-subject">
          <span style={{ color: 'var(--text-2)' }}>{item.action || t('transcript.auto.action')}</span>
          {item.reason && (
            <span style={{ marginLeft: 8, color: 'var(--text-3)', fontSize: 'var(--fz-12)' }}>
              {item.reason}
            </span>
          )}
        </span>
        <span className="evt-meta">
          <span style={{ color: 'var(--text-3)' }}>
            {item.consecutive}/3 · {item.total} {t('transcript.auto.total')}
          </span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fz-10)', color: 'var(--text-3)' }}>{formatTime(item.ts)}</span>
        </span>
      </div>
    </div>
  );
}

export function AgentSpawnRow({ item }: { item: AgentSpawnItem }) {
  const t = useT();
  const openChatPanel = useContext(ChatPanelOpenContext);
  const statusClass = item.status === 'running' ? 'running' : item.status === 'done' ? 'success' : 'error';
  return (
    <div
      className="evt agent"
      data-agent-id={item.id}
      data-provider={item.provider}
      role="button"
      tabIndex={0}
      title={t('transcript.agentOpen')}
      onClick={() => openChatPanel?.({ kind: 'agent', id: item.id })}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openChatPanel?.({ kind: 'agent', id: item.id });
        }
      }}
    >
      <div className="evt-head">
        <span className="evt-verb">{t('transcript.agent')}</span>
        <span className="evt-subject" title={item.description}>{item.description}</span>
        <span className="evt-meta">
          {item.status !== 'done' && (
            <span className={`evt-status ${statusClass}`}>{item.status}</span>
          )}
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fz-10)', color: 'var(--text-3)' }}>{formatTime(item.ts)}</span>
        </span>
      </div>
    </div>
  );
}
