import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ApprovalDecision } from '@gian/shared';
import { useT } from '../i18n/index.js';
import { useOperationPending } from '../operations/use-operations.js';
import type { ApprovalActionContext, ApprovalItem } from '../types.js';

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

/**
 * Caret used in expand toggles. SVG chevron (right-pointing) so the 90deg
 * rotation animation reads as a clean geometric flip rather than a font
 * glyph spinning in place. The class selects the positioning context:
 * `.evt-caret` for legacy `.evt` heads, `.trow-caret` for P1 `.trow` rows.
 * The parent's `.open` class drives the rotation.
 */
export function Caret({ className = 'evt-caret' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 10 10" aria-hidden="true">
      <path d="M3.5 2l3 3-3 3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

type OnApprove = (
  approvalId: string,
  decision: ApprovalDecision,
  answers?: Record<string, string | string[]>,
  context?: ApprovalActionContext,
) => void;

/**
 * Card type label row (P1 revision, 2026-08-08): a mono micro-label at the
 * top of each interactive card distinguishing Approval / Question / Plan at
 * a glance. Resolved `.approval-line` rows carry no head.
 */
function CardHead({ kind }: { kind: 'approval' | 'question' | 'plan' }) {
  const t = useT();
  return <div className="approval-head">{t(`transcript.cardKind.${kind}`)}</div>;
}

/**
 * kimi-proxy's ACP adapter surfaces AskUserQuestion as a permission request
 * whose toolCall title is the bare string 'AskUserQuestion' (the question
 * text itself travels in the approval `reason`); normalize-kimi tags the
 * category 'other' and passes the answer options through as nativeOptions.
 * That title is the only marker the web layer can key on without host
 * changes — see kimi-proxy service.ts `permissionContentText`.
 */
function isKimiQuestion(item: ApprovalItem): boolean {
  return (item.nativeOptions?.length ?? 0) > 0 && item.title === 'AskUserQuestion';
}

/**
 * Approval card — minimal v3 (transcript redesign P1, 2026-08-08).
 * Pending: a card-type label row (`.approval-head`) + the command body
 * (`.approval-cmd`) + a button row. The v2 chrome (icon, title, risk pill,
 * timestamp, kbd hints, high-risk outline) is gone. Allow session sits
 * left; Allow / Decline sit right; everything is a secondary /
 * danger-ghost button — no primary.
 */
export function ApprovalCard({
  item,
  onApprove,
}: {
  item: ApprovalItem;
  onApprove: OnApprove;
}) {
  const t = useT();
  const isQuestion = item.category === 'question' && item.questions && item.questions.length > 0;
  const isPlanExit = item.category === 'exit_plan_mode' && item.planActions && item.planActions.length > 0;
  const isNative = (item.nativeOptions?.length ?? 0) > 0;
  const kimiQuestion = isKimiQuestion(item);
  const sessionScopeAllowed = (item.scopeOptions ?? ['once']).includes('session');
  // Pending approval.resolve run (Phase 2b, proposal §5): clicking any
  // decision immediately disables the submitted card and labels it
  // resolving; failure re-enables it (the run settles as failed) and the
  // host's error envelope surfaces the error.
  const resolving = useOperationPending(`approval:${item.approvalId}`, 'approval.resolve');

  // Keyboard shortcut wiring (A / Shift+A / D) while pending — only for
  // ordinary approvals; AskUserQuestion uses option pickers, and the plan
  // exit card uses semantic three-way buttons rather than allow/deny. The
  // visible kbd hint chips were removed in v3; the shortcuts stay.
  useEffect(() => {
    if (item.status !== 'pending' || resolving || isQuestion || isPlanExit || isNative) return;
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
  }, [item.status, item.approvalId, onApprove, resolving, isQuestion, isPlanExit, isNative, sessionScopeAllowed]);

  // Resolved approvals and questions compress to a single line that reads
  // inline with the surrounding process rows.
  if (item.status !== 'pending') {
    return <ApprovalLine item={item} />;
  }

  if (isQuestion) {
    return <QuestionCard item={item} onApprove={onApprove} />;
  }

  if (kimiQuestion) {
    return <KimiQuestionCard item={item} onApprove={onApprove} />;
  }

  // Bash gets a `$ ` prompt prefix; everything else just shows the value
  // (file path / URL / pattern / query) — no shell prefix to avoid the
  // "$ /Users/.../foo.ts" weirdness.
  const cmdPrefix = item.category === 'command' ? '$ ' : '';
  // Only surface "Allow session" when the category supports it (host
  // disables session scope for `other` / `exit_plan_mode` / `question`).
  const allowSession = sessionScopeAllowed;
  return (
    <div className="approval">
      <CardHead kind={isPlanExit ? 'plan' : 'approval'} />
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
        <div className="approval-actions">
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
                className={`btn sm ${rejected ? 'danger-ghost' : 'secondary'}`}
                disabled={resolving}
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
          {resolving && <span className="approval-resolving">{t('transcript.approval.resolving')}</span>}
        </div>
      ) : isPlanExit ? (
        <div className="approval-actions">
          <button
            className="btn danger-ghost sm"
            disabled={resolving}
            onClick={() => onApprove(item.approvalId, 'keep_planning')}
          >
            {t('transcript.approval.keepPlanning')}
          </button>
          <span className="spacer" />
          <button
            className="btn secondary sm"
            disabled={resolving}
            onClick={() => onApprove(item.approvalId, 'accept_with_ask')}
          >
            {t('transcript.approval.manualApprove')}
          </button>
          <button
            className="btn secondary sm"
            disabled={resolving}
            onClick={() => onApprove(item.approvalId, 'accept_with_auto')}
          >
            {t('transcript.approval.autoAccept')}
          </button>
          {resolving && <span className="approval-resolving">{t('transcript.approval.resolving')}</span>}
        </div>
      ) : (
        <div className="approval-actions">
          {allowSession && (
            <button className="btn secondary sm" disabled={resolving} onClick={() => onApprove(item.approvalId, 'allow_session')}>{t('transcript.approval.allowSession')}</button>
          )}
          <span className="spacer" />
          <button className="btn secondary sm" disabled={resolving} onClick={() => onApprove(item.approvalId, 'allow_once')}>{t('transcript.approval.allowOnce')}</button>
          <button className="btn danger-ghost sm" disabled={resolving} onClick={() => onApprove(item.approvalId, 'decline')}>{t('transcript.approval.decline')}</button>
          {resolving && <span className="approval-resolving">{t('transcript.approval.resolving')}</span>}
        </div>
      )}
    </div>
  );
}

/**
 * Resolved approval / question, compressed to a single line
 * (`.approval-line`) that mixes in with the process rows: ✓ (ok) / ✕
 * (danger) + subject (the command or the question text) + right note
 * (`Allowed once · by web` / the picked answer / `Declined · by web`).
 */
function ApprovalLine({ item }: { item: ApprovalItem }) {
  const t = useT();
  const ok = item.status !== 'declined';
  let subject: React.ReactNode;
  let note: string;
  if (item.category === 'question') {
    subject = item.questions?.[0]?.question ?? item.title;
    note = ok
      ? (item.answeredWith ?? t('transcript.question.answered'))
      : t('transcript.question.cancelled');
  } else {
    const label =
      item.status === 'approved-once' ? t('transcript.approval.allowedOnce') :
      item.status === 'approved-session' ? t('transcript.approval.allowedSession') :
      t('transcript.approval.declined');
    note = `${label} · ${t('transcript.approval.byWeb')}`;
    if (item.category === 'exit_plan_mode' || !item.cmd) {
      // A resolved plan is markdown — the title is the only one-line summary.
      subject = item.title;
    } else {
      subject = (
        <>
          {item.category === 'command' && <span className="prompt">$ </span>}
          {item.cmd}
        </>
      );
    }
  }
  return (
    <div className="approval-line">
      <span className={`al-mark ${ok ? 'ok' : 'no'}`}>{ok ? '✓' : '✕'}</span>
      <span className="al-subject">{subject}</span>
      <span className="al-note">{note}</span>
    </div>
  );
}

/**
 * Pending AskUserQuestion approval from the structured cc-proxy bridge,
 * tagged with `category='question'` plus parsed questions.
 *
 * v3 (P1 redesign): no icon / title / pill — the question IS the content;
 * the CLI-sent `header` stays as a small chip; multiSelect uses checkboxes;
 * "Other" free text stays. Multi-question cards page one question per
 * screen (Back/Next + a mono `N / M` progress in the button row); answers
 * collect across all pages and submit together on the last one.
 *
 * Submit serializes selections as an `answers` map keyed by question text.
 * The parent view sends the structured `approval:resolve` response.
 */
function QuestionCard({
  item,
  onApprove,
}: {
  item: ApprovalItem;
  onApprove: OnApprove;
}) {
  const t = useT();
  // Per-question selection state. Single-select stores the chosen label;
  // multi-select stores a list. "Other" (free text) lives in a parallel map.
  const [selections, setSelections] = useState<Record<string, string | string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  // Submitted card: the pending approval.resolve run disables the card and
  // labels it resolving (proposal §5); failure re-enables it.
  const resolving = useOperationPending(`approval:${item.approvalId}`, 'approval.resolve');
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
      <CardHead kind="question" />
      <div className="question-body">
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
        <button
          className="btn danger-ghost sm"
          disabled={resolving}
          onClick={() => onApprove(item.approvalId, 'decline', undefined, { category: item.category })}
        >
          {t('common.cancel')}
        </button>
        <span className="spacer" />
        {total > 1 && (
          <span className="question-progress">{`${idx + 1} / ${total}`}</span>
        )}
        {idx > 0 && (
          <button
            className="btn secondary sm"
            disabled={resolving}
            onClick={() => setIdx(i => Math.max(0, i - 1))}
          >
            {t('transcript.question.back')}
          </button>
        )}
        {!isLast ? (
          <button
            className="btn secondary sm"
            disabled={!curAnswered || resolving}
            onClick={() => setIdx(i => Math.min(total - 1, i + 1))}
          >
            {t('transcript.question.next')}
          </button>
        ) : (
          <button
            className="btn secondary sm"
            disabled={!curAnswered || resolving}
            onClick={submit}
          >
            {t('common.submit')}
          </button>
        )}
        {resolving && <span className="approval-resolving">{t('transcript.approval.resolving')}</span>}
      </div>
    </div>
  );
}

/**
 * Kimi's AskUserQuestion, which arrives as a nativeOptions approval (see
 * `isKimiQuestion`). Renders the same minimal question card as the
 * structured variant with the limits the transport imposes: no header chip,
 * no option descriptions, no "Other" free text, a single question with
 * single-select. Reject-kind options collapse into the Cancel button (its
 * click resolves with that option id so ACP gets the executor's own reject
 * choice). Submission reuses the approval decision channel with the picked
 * `nativeOptionId` — no answers map.
 */
function KimiQuestionCard({
  item,
  onApprove,
}: {
  item: ApprovalItem;
  onApprove: OnApprove;
}) {
  const t = useT();
  const resolving = useOperationPending(`approval:${item.approvalId}`, 'approval.resolve');
  const [picked, setPicked] = useState<string | null>(null);
  const options = item.nativeOptions ?? [];
  const acceptOptions = options.filter(o => !o.kind.startsWith('reject'));
  const rejectOption = options.find(o => o.kind.startsWith('reject'));
  const questionText = item.reason || item.title;
  return (
    <div className="approval question kimi-question">
      <CardHead kind="question" />
      <div className="question-body">
        <div className="question-block">
          <div className="question-text">
            <span>{questionText}</span>
          </div>
          <ul className="question-options">
            {acceptOptions.map(opt => (
              <li key={opt.optionId} className="question-option">
                <label>
                  <input
                    type="radio"
                    name={`kimi-q-${item.approvalId}`}
                    checked={picked === opt.optionId}
                    onChange={() => setPicked(opt.optionId)}
                  />
                  <span className="question-option-label">{opt.label}</span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      </div>
      <div className="approval-actions">
        <button
          className="btn danger-ghost sm"
          disabled={resolving}
          onClick={() => onApprove(
            item.approvalId,
            'decline',
            undefined,
            {
              category: item.category,
              ...(rejectOption ? { nativeOptionId: rejectOption.optionId } : {}),
            },
          )}
        >
          {t('common.cancel')}
        </button>
        <span className="spacer" />
        <button
          className="btn secondary sm"
          disabled={!picked || resolving}
          onClick={() => picked && onApprove(
            item.approvalId,
            'allow_once',
            undefined,
            { category: item.category, nativeOptionId: picked },
          )}
        >
          {t('common.submit')}
        </button>
        {resolving && <span className="approval-resolving">{t('transcript.approval.resolving')}</span>}
      </div>
    </div>
  );
}
