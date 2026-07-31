import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ApprovalDecision } from '@gian/shared';
import { useT } from '../i18n/index.js';
import type { ApprovalActionContext, ApprovalItem } from '../types.js';
import { formatTime } from '../utils/format.js';

export function SeverityIcon({ risk }: { risk: 'low' | 'medium' | 'high' }) {
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
    context?: ApprovalActionContext,
  ) => void;
}) {
  const t = useT();
  const isQuestion = item.category === 'question' && item.questions && item.questions.length > 0;
  const isPlanExit = item.category === 'exit_plan_mode' && item.planActions && item.planActions.length > 0;
  const isNative = (item.nativeOptions?.length ?? 0) > 0;
  const sessionScopeAllowed = (item.scopeOptions ?? ['once']).includes('session');

  // Keyboard shortcut wiring (A / Shift+A / D) while pending — only for
  // ordinary approvals; AskUserQuestion uses option pickers, and the plan
  // exit card uses semantic three-way buttons rather than allow/deny.
  useEffect(() => {
    if (item.status !== 'pending' || isQuestion || isPlanExit || isNative) return;
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
  }, [item.status, item.approvalId, onApprove, isQuestion, isPlanExit, isNative, sessionScopeAllowed]);

  if (item.status === 'pending' && isQuestion) {
    return <QuestionCard item={item} onApprove={onApprove} />;
  }

  // Resolved question: a question isn't an "allow/deny" — it's answered or
  // cancelled. Render a question-specific resolved card (badge + the picked
  // answer) instead of the generic "Allowed once · by web" permission note,
  // which reads wrong for a question.
  if (item.status !== 'pending' && item.category === 'question') {
    const cancelled = item.status === 'declined';
    return (
      <div className={`approval question ${cancelled ? 'declined' : 'resolved'}`}>
        <div className="approval-top">
          <div className="approval-ico">
            {cancelled ? <XIcon /> : <CheckIcon />}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="approval-title">
              <span>{item.title}</span>
              <span className="approval-risk">
                {cancelled ? t('transcript.question.cancelled') : t('transcript.question.answered')}
              </span>
            </div>
            {!cancelled && item.answeredWith && (
              <div className="approval-sub">{item.answeredWith}</div>
            )}
          </div>
          <span className="evt-meta" style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--text-3)' }}>{formatTime(item.ts)}</span>
        </div>
      </div>
    );
  }

  if (item.status !== 'pending') {
    const ok = item.status !== 'declined';
    const label =
      item.status === 'approved-once' ? t('transcript.approval.allowedOnce') :
      item.status === 'approved-session' ? t('transcript.approval.allowedSession') :
      t('transcript.approval.declined');
    const riskLabel = ok ? t('transcript.approval.approved') : t('transcript.approval.declined');
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
            <div className="approval-sub">{item.reason || t('transcript.approval.command')}</div>
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
          <span>{label} · {t('transcript.approval.byWeb')}</span>
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
            <span className={`approval-risk approval-risk--${item.risk}`}>{t(`transcript.approval.${item.risk}Risk`)}</span>
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
      {isNative ? (
        <div className="approval-actions approval-actions--native">
          {item.nativeOptions!.map(option => {
            const rejected = option.kind.startsWith('reject');
            const decision: ApprovalDecision = rejected
              ? 'decline'
              : option.kind === 'allow_always'
                ? 'allow_session'
                : 'allow_once';
            return (
              <button
                key={option.optionId}
                className={`btn sm ${rejected ? 'danger-ghost' : 'primary'}`}
                onClick={() => onApprove(
                  item.approvalId,
                  decision,
                  undefined,
                  {
                    category: item.category,
                    nativeOptionId: option.optionId,
                  },
                )}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      ) : isPlanExit ? (
        <div className="approval-actions approval-actions--plan">
          <button
            className="btn primary sm"
            onClick={() => onApprove(item.approvalId, 'accept_with_auto')}
          >
            {t('transcript.approval.autoAccept')}
          </button>
          <button
            className="btn secondary sm"
            onClick={() => onApprove(item.approvalId, 'accept_with_ask')}
          >
            {t('transcript.approval.manualApprove')}
          </button>
          <button
            className="btn danger-ghost sm"
            onClick={() => onApprove(item.approvalId, 'keep_planning')}
          >
            {t('transcript.approval.keepPlanning')}
          </button>
        </div>
      ) : (
        <div className="approval-actions">
          <button className="btn primary sm" onClick={() => onApprove(item.approvalId, 'allow_once')}>{t('transcript.approval.allowOnce')}</button>
          {allowSession && (
            <button className="btn secondary sm" onClick={() => onApprove(item.approvalId, 'allow_session')}>{t('transcript.approval.allowSession')}</button>
          )}
          <button className="btn danger-ghost sm" onClick={() => onApprove(item.approvalId, 'decline')}>{t('transcript.approval.decline')}</button>
          <span className="spacer" />
          <span className="approval-tip">
            <kbd className="kc">A</kbd>{' '}{t('transcript.approval.once')}
            {allowSession && <> · <kbd className="kc">⇧A</kbd>{' '}{t('transcript.approval.session')}</>}
            {' '}· <kbd className="kc">D</kbd>{' '}{t('transcript.approval.decline')}
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * Pending AskUserQuestion approval from the structured cc-proxy bridge,
 * tagged with `category='question'` plus parsed questions.
 *
 * Submit serializes selections as an `answers` map keyed by question text.
 * The parent view sends the structured `approval:resolve` response.
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
    context?: ApprovalActionContext,
  ) => void;
}) {
  const t = useT();
  // Per-question selection state. Single-select stores the chosen label;
  // multi-select stores a list. "Other" (free text) lives in a parallel map.
  const [selections, setSelections] = useState<Record<string, string | string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  // Present one question at a time — mirrors how native Claude Code surfaces a
  // multi-question AskUserQuestion (one selector per question) rather than a
  // wall of them. Answers are still collected across all and submitted together.
  const [idx, setIdx] = useState(0);
  const questions = item.questions ?? [];

  const isAnswered = (q: { question: string; multiSelect?: boolean }): boolean => {
    const sel = selections[q.question];
    const free = other[q.question]?.trim();
    if (q.multiSelect) {
      return (Array.isArray(sel) && sel.length > 0) || !!free;
    }
    return (typeof sel === 'string' && sel.length > 0) || !!free;
  };
  const total = questions.length;
  const cur = questions[Math.min(idx, total - 1)];
  const curAnswered = cur ? isAnswered(cur) : false;
  const isLast = idx >= total - 1;

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
    onApprove(item.approvalId, 'allow_once', answers, { category: item.category });
  }

  return (
    <div className="approval question">
      <div className="approval-top">
        <div className="approval-ico">
          <SeverityIcon risk="low" />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="approval-title">
            <span>{t(questions.length > 1 ? 'transcript.question.titlePlural' : 'transcript.question.title')}</span>
            <span className="approval-risk">{t('transcript.question.badge')}</span>
          </div>
        </div>
        <span className="evt-meta" style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--text-3)' }}>{formatTime(item.ts)}</span>
      </div>
      <div className="question-body">
        {total > 1 && (
          <div className="question-progress">{`${idx + 1} / ${total}`}</div>
        )}
        {(() => {
          const q = cur;
          const qi = idx;
          if (!q) return null;
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
                    <span className="question-option-label">{t('transcript.question.other')}</span>
                    <input
                      type="text"
                      placeholder={t('transcript.question.placeholder')}
                      value={other[q.question] ?? ''}
                      onChange={e => setOther(prev => ({ ...prev, [q.question]: e.target.value }))}
                    />
                  </label>
                </li>
              </ul>
            </div>
          );
        })()}
      </div>
      <div className="approval-actions">
        {idx > 0 && (
          <button
            className="btn ghost sm"
            onClick={() => setIdx(i => Math.max(0, i - 1))}
          >
            {t('transcript.question.back')}
          </button>
        )}
        {!isLast ? (
          <button
            className="btn primary sm"
            disabled={!curAnswered}
            onClick={() => setIdx(i => Math.min(total - 1, i + 1))}
          >
            {t('transcript.question.next')}
          </button>
        ) : (
          <button
            className="btn primary sm"
            disabled={!curAnswered}
            onClick={submit}
          >
            {t('common.submit')}
          </button>
        )}
        <button
          className="btn danger-ghost sm"
          onClick={() => onApprove(item.approvalId, 'decline', undefined, { category: item.category })}
        >
          {t('common.cancel')}
        </button>
      </div>
    </div>
  );
}
