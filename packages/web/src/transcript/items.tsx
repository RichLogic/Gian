import { createContext, useContext, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ApprovalDecision } from '@gian/shared';
import type { AgentSpawnItem, ApprovalItem, CommandItem, DiffItem, FileReadItem, FileSearchItem, MsgItem, ToolItem, WebSearchItem } from '../types.js';
import { formatTime } from '../utils/format.js';

/**
 * Provided by App.tsx to route file-link clicks into the in-app Files view
 * preview pane (the "fourth-level page"). When undefined, FileLink falls
 * back to the vscode:// scheme so the link still does something useful.
 */
export const FileLinkOpenContext = createContext<
  ((absPath: string, line?: number) => void) | null
>(null);

/** Provided by App.tsx to push a DiffItem into the 4th-level inspector. Click
 *  handler on DiffCard fires this instead of expanding inline — the card
 *  itself stays compact (just file path + +/- stats). */
export const DiffOpenContext = createContext<((item: DiffItem) => void) | null>(null);

/** Provided by App.tsx to push the latest exit_plan_mode approval into the
 *  4th-level inspector. PlanChip (above the composer) and the inline plan
 *  approval card both fire this when clicked. */
export const PlanOpenContext = createContext<
  ((approval: ApprovalItem) => void) | null
>(null);

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

// Inline SVG icons for severity / resolution states
function SeverityIcon({ risk }: { risk: 'low' | 'medium' | 'high' }) {
  if (risk === 'low') {
    // Muted circle for low risk
    return (
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <circle cx="8" cy="8" r="2.5" fill="currentColor" />
      </svg>
    );
  }
  // Filled triangle for medium (warn) and high (danger)
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M8 2L1.5 13h13z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8 7v3M8 12v.2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M3 8l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Caret used in `.evt-head` toggles. SVG chevron (right-pointing) so the
 * 90deg rotation animation reads as a clean geometric flip rather than a
 * font glyph spinning in place. Parent's `.open` class drives the rotation
 * via `.evt.open > .evt-head > .evt-caret`.
 */
export function Caret() {
  return (
    <svg className="evt-caret" viewBox="0 0 10 10" aria-hidden="true">
      <path d="M3.5 2l3 3-3 3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ApprovalCard({
  item,
  onApprove,
}: {
  item: ApprovalItem;
  onApprove: (
    approvalId: string,
    decision: ApprovalDecision,
    answers?: Record<string, string | string[]>,
  ) => void;
}) {
  const isQuestion = item.category === 'question' && item.questions && item.questions.length > 0;
  const isPlanExit = item.category === 'exit_plan_mode' && item.planActions && item.planActions.length > 0;
  const sessionScopeAllowed = (item.scopeOptions ?? ['once']).includes('session');

  // Keyboard shortcut wiring (A / Shift+A / D) while pending — only for
  // ordinary approvals; AskUserQuestion uses option pickers, and the plan
  // exit card uses semantic three-way buttons rather than allow/deny.
  useEffect(() => {
    if (item.status !== 'pending' || isQuestion || isPlanExit) return;
    function handleKey(e: KeyboardEvent) {
      // Ignore if focus is in an input/textarea/contenteditable
      const tag = (e.target as HTMLElement | null)?.tagName ?? '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement | null)?.isContentEditable) return;
      if (e.key === 'A' && e.shiftKey && sessionScopeAllowed) {
        e.preventDefault();
        onApprove(item.approvalId, 'allow_session');
      } else if (e.key === 'a' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        onApprove(item.approvalId, 'allow_once');
      } else if (e.key === 'd' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        onApprove(item.approvalId, 'decline');
      }
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [item.status, item.approvalId, onApprove, isQuestion, isPlanExit, sessionScopeAllowed]);

  if (item.status === 'pending' && isQuestion) {
    return <QuestionCard item={item} onApprove={onApprove} />;
  }

  if (item.status !== 'pending') {
    const ok = item.status !== 'declined';
    const label =
      item.status === 'approved-once' ? 'Allowed once' :
      item.status === 'approved-session' ? 'Allowed for session' :
      'Declined';
    const riskLabel = ok ? 'approved' : 'declined';
    return (
      <div className={`approval ${ok ? 'resolved' : 'declined'}`}>
        <div className="approval-top">
          <div className="approval-ico">
            {ok ? <CheckIcon /> : <XIcon />}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="approval-title">
              <span>{item.title}</span>
              <span className="approval-risk">{riskLabel}</span>
            </div>
            <div className="approval-sub">{item.reason || 'command'}</div>
          </div>
          <span className="evt-meta" style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--text-3)' }}>{formatTime(item.ts)}</span>
        </div>
        {item.cmd && (
          item.category === 'exit_plan_mode'
            ? (
              <div className="approval-plan approval-plan--resolved">
                <div className="approval-plan-md">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.cmd}</ReactMarkdown>
                </div>
              </div>
            )
            : (
              <div className="approval-cmd approval-cmd--resolved">
                <span className="prompt">$ </span>{item.cmd}
              </div>
            )
        )}
        <div className="approval-resolved-note">
          <span className="dot" />
          <span>{label} · by <strong>web</strong></span>
        </div>
      </div>
    );
  }

  const riskClass = item.risk === 'high' ? 'high' : item.risk === 'low' ? 'low' : '';
  // Bash gets a `$ ` prompt prefix; everything else just shows the value
  // (file path / URL / pattern / query) — no shell prefix to avoid the
  // "$ /Users/.../foo.ts" weirdness.
  const cmdPrefix = item.category === 'command' ? '$ ' : '';
  // Only surface "Allow session" when the category supports it (host
  // disables session scope for `other` / `exit_plan_mode` / `question`).
  const allowSession = sessionScopeAllowed;
  return (
    <div className={`approval ${riskClass}`}>
      <div className="approval-top">
        <div className="approval-ico">
          <SeverityIcon risk={item.risk} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="approval-title">
            <span>{item.title}</span>
            <span className={`approval-risk approval-risk--${item.risk}`}>{item.risk} risk</span>
          </div>
          {item.reason && <div className="approval-sub">{item.reason}</div>}
        </div>
        <span className="evt-meta" style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--text-3)' }}>{formatTime(item.ts)}</span>
      </div>
      {item.cmd && (
        item.category === 'exit_plan_mode'
          ? (
            <div className="approval-plan">
              <div className="approval-plan-md">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.cmd}</ReactMarkdown>
              </div>
            </div>
          )
          : (
            <div className="approval-cmd">
              {cmdPrefix && <span className="prompt">{cmdPrefix}</span>}
              {item.cmd}
            </div>
          )
      )}
      {isPlanExit ? (
        <div className="approval-actions approval-actions--plan">
          <button
            className="btn primary sm"
            onClick={() => onApprove(item.approvalId, 'accept_with_auto')}
          >
            Yes, auto-accept edits
          </button>
          <button
            className="btn secondary sm"
            onClick={() => onApprove(item.approvalId, 'accept_with_ask')}
          >
            Yes, manually approve edits
          </button>
          <button
            className="btn danger-ghost sm"
            onClick={() => onApprove(item.approvalId, 'keep_planning')}
          >
            No, keep planning
          </button>
        </div>
      ) : (
        <div className="approval-actions">
          <button className="btn primary sm" onClick={() => onApprove(item.approvalId, 'allow_once')}>Allow once</button>
          {allowSession && (
            <button className="btn secondary sm" onClick={() => onApprove(item.approvalId, 'allow_session')}>Allow session</button>
          )}
          <button className="btn danger-ghost sm" onClick={() => onApprove(item.approvalId, 'decline')}>Decline</button>
          <span className="spacer" />
          <span className="approval-tip">
            <kbd className="kc">A</kbd>{' '}once
            {allowSession && <> · <kbd className="kc">⇧A</kbd>{' '}session</>}
            {' '}· <kbd className="kc">D</kbd>{' '}decline
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * Pending AskUserQuestion approval. cc-proxy routes the AskUserQuestion tool
 * call through the same `approval_prompt` MCP bridge as regular tool
 * approvals; the host normalizer detects `toolName === 'AskUserQuestion'`
 * and tags it with `category='question'` plus a parsed `questions` struct.
 *
 * Submit serializes the user's selections as an `answers` map keyed by
 * question text; host forwards via the existing `approval:resolve` WS
 * channel and cc-proxy hands it back to the agent through the Claude SDK
 * `updatedInput.answers` channel. Cancel maps to a regular `decline`.
 */
function QuestionCard({
  item,
  onApprove,
}: {
  item: ApprovalItem;
  onApprove: (
    approvalId: string,
    decision: ApprovalDecision,
    answers?: Record<string, string | string[]>,
  ) => void;
}) {
  // Per-question selection state. Single-select stores the chosen label;
  // multi-select stores a list. "Other" (free text) lives in a parallel map.
  const [selections, setSelections] = useState<Record<string, string | string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const questions = item.questions ?? [];

  const allAnswered = questions.every(q => {
    const sel = selections[q.question];
    const free = other[q.question]?.trim();
    if (q.multiSelect) {
      return (Array.isArray(sel) && sel.length > 0) || !!free;
    }
    return (typeof sel === 'string' && sel.length > 0) || !!free;
  });

  function pickSingle(qText: string, label: string) {
    setSelections(prev => ({ ...prev, [qText]: label }));
  }

  function toggleMulti(qText: string, label: string) {
    setSelections(prev => {
      const current = Array.isArray(prev[qText]) ? prev[qText] as string[] : [];
      const next = current.includes(label)
        ? current.filter(x => x !== label)
        : [...current, label];
      return { ...prev, [qText]: next };
    });
  }

  function submit() {
    const answers: Record<string, string | string[]> = {};
    for (const q of questions) {
      const sel = selections[q.question];
      const free = other[q.question]?.trim();
      if (q.multiSelect) {
        const list = Array.isArray(sel) ? [...sel] : [];
        if (free) list.push(free);
        answers[q.question] = list;
      } else if (free) {
        answers[q.question] = free;
      } else if (typeof sel === 'string') {
        answers[q.question] = sel;
      }
    }
    onApprove(item.approvalId, 'allow_once', answers);
  }

  return (
    <div className="approval question">
      <div className="approval-top">
        <div className="approval-ico">
          <SeverityIcon risk="low" />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="approval-title">
            <span>Question{questions.length > 1 ? 's' : ''} from agent</span>
            <span className="approval-risk">question</span>
          </div>
        </div>
        <span className="evt-meta" style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--text-3)' }}>{formatTime(item.ts)}</span>
      </div>
      <div className="question-body">
        {questions.map((q, qi) => {
          const sel = selections[q.question];
          return (
            <div key={qi} className="question-block">
              <div className="question-text">
                {q.header && <span className="question-header">{q.header}</span>}
                <span>{q.question}</span>
              </div>
              <ul className="question-options">
                {q.options.map((opt, oi) => {
                  const isPicked = q.multiSelect
                    ? Array.isArray(sel) && sel.includes(opt.label)
                    : sel === opt.label;
                  return (
                    <li key={oi} className="question-option">
                      <label>
                        <input
                          type={q.multiSelect ? 'checkbox' : 'radio'}
                          name={`q-${item.approvalId}-${qi}`}
                          checked={isPicked}
                          onChange={() => q.multiSelect
                            ? toggleMulti(q.question, opt.label)
                            : pickSingle(q.question, opt.label)}
                        />
                        <span className="question-option-label">{opt.label}</span>
                        {opt.description && (
                          <span className="question-option-desc">{opt.description}</span>
                        )}
                      </label>
                    </li>
                  );
                })}
                <li className="question-option question-option--other">
                  <label>
                    <span className="question-option-label">Other</span>
                    <input
                      type="text"
                      placeholder="Type a custom answer"
                      value={other[q.question] ?? ''}
                      onChange={e => setOther(prev => ({ ...prev, [q.question]: e.target.value }))}
                    />
                  </label>
                </li>
              </ul>
            </div>
          );
        })}
      </div>
      <div className="approval-actions">
        <button
          className="btn primary sm"
          disabled={!allAnswered}
          onClick={submit}
        >
          Submit
        </button>
        <button
          className="btn danger-ghost sm"
          onClick={() => onApprove(item.approvalId, 'decline')}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

export function DiffCard({ item }: { item: DiffItem }) {
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
        <span className="evt-verb">Edit</span>
        <span className="evt-subject">
          {fileCount === 1 ? item.files[0]!.path : `Changed ${fileCount} files`}
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
  const [open, setOpen] = useState(false);
  return (
    <div className={`evt agent ${open ? 'open' : ''}`}>
      <div className="evt-head" onClick={() => setOpen(o => !o)}>
        <Caret />
        <span className="evt-verb">Tool</span>
        <span className="evt-subject">{item.name}</span>
        <span className="evt-meta" />{/* Tool default state is success — only render an evt-status when failed (TODO when we surface tool errors) */}
      </div>
      {item.summary && (
        <div className="evt-body">
          <ToolArgs raw={item.summary} />
        </div>
      )}
    </div>
  );
}

function ToolArgs({ raw }: { raw: string }) {
  // Best-effort: parse the truncated JSON summary into key/value rows for
  // legibility. Falls back to raw mono text when parsing fails (truncation
  // mid-string can leave the JSON invalid).
  let parsed: unknown = null;
  try { parsed = JSON.parse(raw); } catch { /* ignore */ }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const entries = Object.entries(parsed as Record<string, unknown>);
    if (entries.length === 0) {
      return <code className="tool-args-empty">no args</code>;
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
    <code style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--text-2)' }}>{raw}</code>
  );
}

function formatVal(v: unknown): string {
  if (v == null) return String(v);
  if (typeof v === 'string') return v.length > 120 ? v.slice(0, 120) + '…' : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = JSON.stringify(v);
  return s.length > 120 ? s.slice(0, 120) + '…' : s;
}

function CopyButton({ text, title = 'Copy message' }: { text: string; title?: string }) {
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
      className={`msg-copy${copied ? ' copied' : ''}`}
      title={copied ? 'Copied' : title}
      aria-label={title}
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
// hideAvatar is kept in the prop signature for caller compat but is a no-op.
export function UserMessage({ item }: { item: MsgItem; hideAvatar?: boolean }) {
  // Optimistic echo: `pending` until the server emits its `user_message`,
  // `failed` when an `error` envelope marks it rejected.
  const stateCls = item.pending ? ' pending' : item.failed ? ' failed' : '';
  return (
    <div className={`msg user${stateCls}`}>
      <div className="msg-body">
        <div className="msg-text user-text">{item.text}</div>
        <div className="msg-foot user">
          {item.failed && <span className="msg-state-failed">failed to send</span>}
          <CopyButton text={item.text} />
          <span className="msg-time user">{formatTime(item.ts)}</span>
        </div>
      </div>
    </div>
  );
}

export function AssistantMessage({ item, hideAvatar }: { item: MsgItem; hideAvatar?: boolean }) {
  // V2 design: no author label, time sits below the message body. Continuation
  // chunks (consecutive same-sender bubbles from streaming) suppress the time
  // so a streamed turn doesn't print a stack of timestamps.
  return (
    <div className={`msg${hideAvatar ? ' continuation' : ''}`}>
      <div className="msg-body">
        <div className="msg-text md">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.text}</ReactMarkdown>
        </div>
        {!hideAvatar && (
          <div className="msg-foot">
            <span className="msg-time">{formatTime(item.ts)}</span>
            <CopyButton text={item.text} />
          </div>
        )}
      </div>
    </div>
  );
}

// Kept as an unused export to avoid breaking external imports. V2 design
// doesn't render avatars in the transcript; this is left as a stub.
export function Avatar({ exec }: { exec: 'user' | 'claude' | 'codex' }) {
  const label = exec === 'user' ? 'R' : 'C';
  return <div className={`msg-av ${exec}`} aria-hidden>{label}</div>;
}

export function CommandCard({ item }: { item: CommandItem }) {
  const [open, setOpen] = useState(false);
  const statusClass = item.status === 'running' ? 'running' : item.status === 'success' ? 'success' : 'error';
  const hasOutput = !!(item.stdout || item.stderr);
  return (
    <div className={`evt command ${open && hasOutput ? 'open' : ''}`}>
      <div className="evt-head" onClick={() => hasOutput && setOpen(o => !o)}>
        {hasOutput && <Caret />}
        <span className="evt-verb">Run</span>
        <span className="evt-subject cmd">{item.command}</span>
        <span className="evt-meta">
          {item.cwd && <span style={{ color: 'var(--text-3)' }}>{item.cwd}</span>}
          {item.status !== 'success' && (
            <span className={`evt-status ${statusClass}`}>{item.status}</span>
          )}
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--text-3)' }}>{formatTime(item.ts)}</span>
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
  const lineRange = item.startLine !== undefined
    ? ` :${item.startLine}${item.endLine !== undefined ? `–${item.endLine}` : ''}`
    : '';
  return (
    <div className="evt inline">
      <div className="evt-head">
        <span className="evt-verb">Read</span>
        <span className="evt-subject path">
          <FileLink path={item.path} line={item.startLine}>{item.path}{lineRange}</FileLink>
        </span>
        <span className="evt-meta">
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--text-3)' }}>{formatTime(item.ts)}</span>
        </span>
      </div>
    </div>
  );
}

export function FileSearchCard({ item }: { item: FileSearchItem }) {
  const [open, setOpen] = useState(false);
  const hasMatches = item.matches && item.matches.length > 0;
  const count = item.matchCount ?? item.matches?.length;
  return (
    <div className={`evt search ${open && hasMatches ? 'open' : ''}`}>
      <div className="evt-head" onClick={() => hasMatches && setOpen(o => !o)}>
        {hasMatches && <Caret />}
        <span className="evt-verb">{item.searchKind === 'glob' ? 'Glob' : 'Grep'}</span>
        <span className="evt-subject">
          <span className="search-pattern">{item.pattern}</span>
        </span>
        <span className="evt-meta">
          {count !== undefined && <span>{count} match{count !== 1 ? 'es' : ''}</span>}
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--text-3)' }}>{formatTime(item.ts)}</span>
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
  return (
    <div className="evt web inline">
      <div className="evt-head">
        <span className="evt-verb">Search</span>
        <span className="evt-subject">{item.query}</span>
        <span className="evt-meta">
          {item.resultCount !== undefined && <span>{item.resultCount} results</span>}
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--text-3)' }}>{formatTime(item.ts)}</span>
        </span>
      </div>
    </div>
  );
}

export function AgentSpawnRow({ item }: { item: AgentSpawnItem }) {
  const statusClass = item.status === 'running' ? 'running' : item.status === 'done' ? 'success' : 'error';
  return (
    <div className="evt agent">
      <div className="evt-head">
        <span className="evt-verb">Agent</span>
        <span className="evt-subject">{item.description}</span>
        <span className="evt-meta">
          {item.status !== 'done' && (
            <span className={`evt-status ${statusClass}`}>{item.status}</span>
          )}
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--text-3)' }}>{formatTime(item.ts)}</span>
        </span>
      </div>
    </div>
  );
}
