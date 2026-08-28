import { useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ApprovalDecision } from '@gian/shared';
import { useT } from '../i18n/index.js';
import { normalizeGfmTables } from '../markdown-tables.js';
import { useOperationPending } from '../operations/use-operations.js';
import type { ApprovalActionContext, ApprovalItem } from '../types.js';

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
  answers?: Record<string, string | boolean | string[]>,
  context?: ApprovalActionContext,
) => void;

/* ────────────────────────────────────────────────────────────────────────────
   .ap2 card chrome (2026-08-27 redesign, mockup §5′/§6′)
   Every pending interactive card shares one shell: a head row (type icon +
   uppercase mono kind label + right meta), a content body, and a right-aligned
   action row. Risk / v2 tone drive only the 3px left tone bar and the head
   meta — low / unreported risk renders a fully neutral card.
   ──────────────────────────────────────────────────────────────────────────── */

type CardIconKind = 'command' | 'file' | 'plan' | 'question' | 'choice' | 'confirmation';

/** Type icons copied verbatim from the 2026-08-26 mockup (.ap2-icon svgs). */
function CardIcon({ kind }: { kind: CardIconKind }) {
  switch (kind) {
    case 'command':
      return (
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M2 4.5 6 8l-4 3.5M8 12h6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case 'plan':
      return (
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M3 2.5h10M3 8h10M3 13.5h6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      );
    case 'question':
      return (
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="5.75" stroke="currentColor" strokeWidth="1.3" />
          <path d="M6.2 6.3c.2-1 1-1.6 1.9-1.6 1 0 1.8.7 1.8 1.6 0 1.2-1.2 1.5-1.8 2.1-.2.2-.3.5-.3.9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          <circle cx="8" cy="11.4" r=".8" fill="currentColor" />
        </svg>
      );
    case 'choice':
      return (
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.3" />
          <path d="M8 5v3l2 1.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      );
    case 'confirmation':
      return (
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M8 2 1.8 13h12.4z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
          <path d="M8 6.5v3M8 11.5v.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      );
    case 'file':
    default:
      return (
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M4 1.75h5l3 3V14.25H4z" stroke="currentColor" strokeWidth="1.2" />
          <path d="M9 1.75v3h3" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      );
  }
}

/** Icon for a generic permission subject: commands get the terminal glyph,
 *  file writes and every other subject get the file glyph. */
function subjectIcon(item: ApprovalItem): CardIconKind {
  return item.category === 'command' ? 'command' : 'file';
}

/**
 * Left tone bar driver. Two signals compete and the more severe wins:
 * the v2 presentation `tone` (warning / danger) and the normalized `risk`
 * (medium → warn, high → danger). low / unreported risk and neutral / info
 * tone render no bar at all — a neutral card, by design.
 */
function ap2ToneClass(item: ApprovalItem): string {
  const riskTone = item.risk === 'high' ? 'danger' : item.risk === 'medium' ? 'warning' : null;
  const hintTone = item.tone === 'danger' ? 'danger' : item.tone === 'warning' ? 'warning' : null;
  const tone = riskTone === 'danger' || hintTone === 'danger' ? 'danger' : (riskTone ?? hintTone);
  return tone ? ` tone-${tone}` : '';
}

/**
 * Right head meta for risk: `▲ medium risk` (warn) / `▲ high risk` (danger).
 * low or unreported risk renders NOTHING — safety earns no badge.
 */
function RiskMeta({ risk }: { risk?: ApprovalItem['risk'] }) {
  const t = useT();
  if (risk === 'medium') {
    return (
      <span className="ap2-head-meta">
        <span className="is-medium">▲</span> {t('transcript.approval.mediumRisk')}
      </span>
    );
  }
  if (risk === 'high') {
    return (
      <span className="ap2-head-meta">
        <span className="is-high">▲</span> {t('transcript.approval.highRisk')}
      </span>
    );
  }
  return null;
}

/** Card head row: type icon + uppercase mono kind label + right meta. */
function CardHead({
  kind,
  icon,
  meta,
}: {
  kind: 'approval' | 'question' | 'plan' | 'choice' | 'confirmation';
  icon: CardIconKind;
  meta?: React.ReactNode;
}) {
  const t = useT();
  return (
    <div className="ap2-head">
      <span className="ap2-icon"><CardIcon kind={icon} /></span>
      <span className="ap2-kind">{t(`transcript.cardKind.${kind}`)}</span>
      {meta}
    </div>
  );
}

/** Resolving indicator — pinned to the far left of the action row
 *  (`margin-right: auto` in CSS), so the buttons stay right-aligned. */
function ResolvingNote() {
  const t = useT();
  return <span className="ap2-resolving">{t('transcript.approval.resolving')}</span>;
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
 * Approval card — `.ap2` shell (2026-08-27 redesign).
 * Pending: head row (icon + kind label + risk meta) + command body
 * (`.ap2-cmd` / `.ap2-plan`) + a right-aligned button row. Buttons are all
 * secondary / danger-ghost — never primary, never with kbd hints — and the
 * danger action is pinned last. Resolved items compress to `.approval-line`.
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
  const protocolActions = item.actions ?? [];
  const hasProtocolActions = protocolActions.length > 0;
  const isNative = !hasProtocolActions && (item.nativeOptions?.length ?? 0) > 0;
  const [inputValues, setInputValues] = useState<Record<string, string | boolean | string[]>>({});
  const kimiQuestion = isKimiQuestion(item);
  // Plan bodies are model-written markdown — repair spec-invalid tables the
  // same way the transcript renderer does.
  const planMarkdown = useMemo(
    () => (item.category === 'exit_plan_mode' && item.cmd ? normalizeGfmTables(item.cmd) : ''),
    [item.category, item.cmd],
  );
  const sessionScopeAllowed = (item.scopeOptions ?? ['once']).includes('session');
  // Pending approval.resolve run (Phase 2b, proposal §5): clicking any
  // decision immediately disables the submitted card and labels it
  // resolving; failure re-enables it (the run settles as failed) and the
  // host's error envelope surfaces the error.
  const resolving = useOperationPending(`approval:${item.approvalId}`, 'approval.resolve');

  // Resolved approvals and questions compress to a single line that reads
  // inline with the surrounding process rows.
  if (item.status !== 'pending') {
    return <ApprovalLine item={item} />;
  }

  // gian.proxy/2.0 §12 unified interaction card: any v2 signal (actions,
  // inputs, or an explicit presentation kind) takes this single rendering
  // path — kind label + subject + description + generic inputs + verbatim
  // action buttons. The legacy QuestionCard / KimiQuestionCard / plan /
  // generic branches below stay as v1-fallback-only paths.
  const isProtocol = hasProtocolActions || (item.inputs?.length ?? 0) > 0 || item.interactionKind !== undefined;
  if (isProtocol) {
    const answers = interactionAnswers(item.inputs, inputValues);
    const inputsReady = protocolInputsReady(item.inputs, inputValues);
    const headKind = item.interactionKind === 'question' ? 'question'
      : item.interactionKind === 'choice' ? 'choice'
      : item.interactionKind === 'confirmation' ? 'confirmation'
      : 'approval';
    const headIcon: CardIconKind = item.interactionKind === 'question' ? 'question'
      : item.interactionKind === 'choice' ? 'choice'
      : item.interactionKind === 'confirmation' ? 'confirmation'
      : subjectIcon(item);
    return (
      <div className={`ap2${ap2ToneClass(item)}`}>
        <CardHead kind={headKind} icon={headIcon} meta={<RiskMeta risk={item.risk} />} />
        {item.cmd && (
          item.hasSubject
            ? <div className="ap2-cmd">{item.cmd}</div>
            : <div className="ap2-prose">{item.cmd}</div>
        )}
        {item.reason && <div className="ap2-desc">{item.reason}</div>}
        {item.inputs && item.inputs.length > 0 && (
          <InteractionInputs
            approvalId={item.approvalId}
            inputs={item.inputs}
            values={inputValues}
            disabled={resolving}
            onChange={(id, value) => setInputValues(current => ({ ...current, [id]: value }))}
          />
        )}
        <div className="ap2-actions">
          {resolving && <ResolvingNote />}
          {dangerLast(protocolActions).map(action => (
            <button
              key={action.id}
              className={actionButtonClass(action.style)}
              disabled={resolving || !inputsReady}
              onClick={() => onApprove(
                item.approvalId,
                actionDecision(action.id),
                answers,
                {
                  category: item.category,
                  nativeOptionId: action.id,
                },
              )}
            >
              {action.label}
            </button>
          ))}
        </div>
      </div>
    );
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
  const answers = interactionAnswers(item.inputs, inputValues);
  const inputsReady = protocolInputsReady(item.inputs, inputValues);
  return (
    <div className={`ap2${ap2ToneClass(item)}`}>
      <CardHead
        kind={isPlanExit ? 'plan' : 'approval'}
        icon={isPlanExit ? 'plan' : subjectIcon(item)}
        meta={<RiskMeta risk={item.risk} />}
      />
      {item.inputs && item.inputs.length > 0 && (
        <InteractionInputs
          approvalId={item.approvalId}
          inputs={item.inputs}
          values={inputValues}
          disabled={resolving}
          onChange={(id, value) => setInputValues(current => ({ ...current, [id]: value }))}
        />
      )}
      {item.cmd && (
        item.category === 'exit_plan_mode'
          ? (
            <div className="ap2-plan">
              <div className="approval-plan-md">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{planMarkdown}</ReactMarkdown>
              </div>
            </div>
          )
          : (
            <div className="ap2-cmd">
              {cmdPrefix && <span className="prompt">{cmdPrefix}</span>}
              {item.cmd}
            </div>
          )
      )}
      {hasProtocolActions ? (
        <div className="ap2-actions">
          {resolving && <ResolvingNote />}
          {dangerLast(protocolActions).map(action => (
            <button
              key={action.id}
              className={actionButtonClass(action.style)}
              disabled={resolving || !inputsReady}
              onClick={() => onApprove(
                item.approvalId,
                actionDecision(action.id),
                answers,
                {
                  category: item.category,
                  nativeOptionId: action.id,
                },
              )}
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : isNative ? (
        <div className="ap2-actions">
          {resolving && <ResolvingNote />}
          {dangerLastNative(item.nativeOptions!).map(option => {
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
        </div>
      ) : isPlanExit ? (
        <div className="ap2-actions">
          {resolving && <ResolvingNote />}
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
          <button
            className="btn danger-ghost sm"
            disabled={resolving}
            onClick={() => onApprove(item.approvalId, 'keep_planning')}
          >
            {t('transcript.approval.keepPlanning')}
          </button>
        </div>
      ) : (
        <div className="ap2-actions">
          {resolving && <ResolvingNote />}
          {allowSession && (
            <button className="btn secondary sm" disabled={resolving} onClick={() => onApprove(item.approvalId, 'allow_session')}>{t('transcript.approval.allowSession')}</button>
          )}
          <button className="btn secondary sm" disabled={resolving} onClick={() => onApprove(item.approvalId, 'allow_once')}>{t('transcript.approval.allowOnce')}</button>
          <button className="btn danger-ghost sm" disabled={resolving} onClick={() => onApprove(item.approvalId, 'decline')}>{t('transcript.approval.decline')}</button>
        </div>
      )}
    </div>
  );
}

/** Buttons never use primary (2026-08-27 decision, kept from v3: approvals
 *  don't nudge) — a protocol `primary` style degrades to secondary. */
function actionButtonClass(style: 'primary' | 'secondary' | 'danger'): string {
  if (style === 'danger') return 'btn danger-ghost sm';
  return 'btn secondary sm';
}

/** Danger-styled actions pin to the end of the row (stable partition). */
function dangerLast<T extends { style: 'primary' | 'secondary' | 'danger' }>(actions: T[]): T[] {
  return [...actions.filter(a => a.style !== 'danger'), ...actions.filter(a => a.style === 'danger')];
}

/** Reject-kind native options pin to the end of the row (stable partition). */
function dangerLastNative<T extends { kind: string }>(options: T[]): T[] {
  return [...options.filter(o => !o.kind.startsWith('reject')), ...options.filter(o => o.kind.startsWith('reject'))];
}

function actionDecision(actionId: string): ApprovalDecision {
  if (actionId.startsWith('reject') || actionId === 'decline' || actionId === 'cancelled') {
    return 'decline';
  }
  if (actionId.includes('always') || actionId.includes('session')) return 'allow_session';
  return 'allow_once';
}

function interactionAnswers(
  inputs: ApprovalItem['inputs'],
  values: Record<string, string | boolean | string[]>,
): Record<string, string | boolean | string[]> | undefined {
  if (!inputs?.length) return undefined;
  const answers: Record<string, string | boolean | string[]> = {};
  for (const input of inputs) {
    const value = values[input.id];
    if (value === undefined) continue;
    answers[input.id] = value;
  }
  return Object.keys(answers).length > 0 ? answers : undefined;
}

function protocolInputsReady(
  inputs: ApprovalItem['inputs'],
  values: Record<string, string | boolean | string[]>,
): boolean {
  if (!inputs?.length) return true;
  return inputs.every(input => {
    if (!input.required) return true;
    const value = values[input.id];
    if (input.type === 'boolean') return typeof value === 'boolean';
    if (Array.isArray(value)) return value.length > 0;
    return typeof value === 'string' && value.trim().length > 0;
  });
}

function InteractionInputs({
  approvalId,
  inputs,
  values,
  disabled,
  onChange,
}: {
  approvalId: string;
  inputs: NonNullable<ApprovalItem['inputs']>;
  values: Record<string, string | boolean | string[]>;
  disabled: boolean;
  onChange: (id: string, value: string | boolean | string[]) => void;
}) {
  return (
    <div className="approval-inputs">
      {inputs.map(input => {
        const value = values[input.id];
        const description = input.description
          ? <span className="approval-input-desc">{input.description}</span>
          : null;
        if (input.type === 'boolean') {
          return (
            <label key={input.id} className="approval-input approval-input-bool">
              <input
                type="checkbox"
                disabled={disabled}
                checked={value === true}
                onChange={event => onChange(input.id, event.target.checked)}
              />
              <span>{input.label}</span>
              {description}
            </label>
          );
        }
        if (input.type === 'single_select' || input.type === 'multi_select') {
          const multi = input.type === 'multi_select';
          const selected = Array.isArray(value) ? value : [];
          return (
            <div key={input.id} className="approval-input approval-input-select">
              <span>{input.label}</span>
              {description}
              <ul className="ap2-opts">
                {(input.choices ?? []).map(choice => {
                  const picked = multi ? selected.includes(choice.value) : value === choice.value;
                  return (
                    <li key={choice.value} className={`ap2-opt${picked ? ' is-picked' : ''}`}>
                      <label>
                        <input
                          type={multi ? 'checkbox' : 'radio'}
                          name={`approval-input-${approvalId}-${input.id}`}
                          disabled={disabled}
                          checked={picked}
                          onChange={event => {
                            if (multi) {
                              onChange(
                                input.id,
                                event.target.checked
                                  ? [...selected, choice.value]
                                  : selected.filter(item => item !== choice.value),
                              );
                            } else {
                              onChange(input.id, choice.value);
                            }
                          }}
                        />
                        <span>
                          <span className="ap2-opt-label">{choice.displayName}</span>
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        }
        const multiline = input.type === 'multiline_text' || input.multiline;
        return (
          <label key={input.id} className="approval-input approval-input-text">
            <span>{input.label}</span>
            {description}
            {multiline ? (
              <textarea
                className="approval-text-field"
                disabled={disabled}
                placeholder={input.placeholder}
                value={typeof value === 'string' ? value : ''}
                onChange={event => onChange(input.id, event.target.value)}
              />
            ) : (
              <input
                className="approval-text-field"
                type={input.sensitive ? 'password' : 'text'}
                disabled={disabled}
                placeholder={input.placeholder}
                value={typeof value === 'string' ? value : ''}
                onChange={event => onChange(input.id, event.target.value)}
              />
            )}
          </label>
        );
      })}
    </div>
  );
}

/**
 * Resolved approval / question, compressed to a single line
 * (`.approval-line`) that mixes in with the process rows: ✓ (ok) / ✕
 * (danger) + subject (the command or the question text) + right note
 * (`Allowed once · by web` / the picked answer / `Declined · by web`).
 * Exported for the event box, where a resolved interaction joins the live
 * tail as the same one-line summary.
 */
export function ApprovalLine({ item }: { item: ApprovalItem }) {
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
 * `.ap2` shell (2026-08-27): options are whole-row clickable card rows —
 * the picked row gets the accent ring + accent-soft fill (`.is-picked`);
 * the CLI-sent `header` stays as a small chip; multiSelect uses checkboxes;
 * "Other" free text is the same row shape with an inline input. Multi-
 * question cards page one question per screen (Back/Next, the `N / M`
 * progress lives in the head meta); answers collect across all pages and
 * submit together on the last one.
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

  const q = cur;
  const sel = q ? selections[q.question] : undefined;
  return (
    <div className={`ap2${ap2ToneClass(item)}`}>
      <CardHead
        kind="question"
        icon="question"
        meta={(
          <>
            {total > 1 && <span className="ap2-head-meta">{`${idx + 1} / ${total}`}</span>}
            <RiskMeta risk={item.risk} />
          </>
        )}
      />
      {q && (
        <>
          {q.header && <span className="ap2-q-chip">{q.header}</span>}
          <div className="ap2-q-text">{q.question}</div>
          <ul className="ap2-opts">
            {q.options.map((opt, oi) => {
              const isPicked = q.multiSelect
                ? Array.isArray(sel) && sel.includes(opt.label)
                : sel === opt.label;
              return (
                <li key={oi} className={`ap2-opt${isPicked ? ' is-picked' : ''}`}>
                  <label>
                    <input
                      type={q.multiSelect ? 'checkbox' : 'radio'}
                      name={`q-${item.approvalId}-${idx}`}
                      checked={isPicked}
                      onChange={() => q.multiSelect
                        ? toggleMulti(q.question, opt.label)
                        : pickSingle(q.question, opt.label)}
                    />
                    <span>
                      <span className="ap2-opt-label">{opt.label}</span>
                      {opt.description && (
                        <span className="ap2-opt-desc">{opt.description}</span>
                      )}
                    </span>
                  </label>
                </li>
              );
            })}
            <li className="ap2-opt ap2-opt-other">
              <label>
                <span className="ap2-opt-label">{t('transcript.question.other')}</span>
                <input
                  type="text"
                  placeholder={t('transcript.question.placeholder')}
                  value={other[q.question] ?? ''}
                  onChange={e => setOther(prev => ({ ...prev, [q.question]: e.target.value }))}
                />
              </label>
            </li>
          </ul>
        </>
      )}
      <div className="ap2-actions">
        {resolving && <ResolvingNote />}
        <button
          className="btn ghost sm"
          disabled={resolving}
          onClick={() => onApprove(item.approvalId, 'decline', undefined, { category: item.category })}
        >
          {t('common.cancel')}
        </button>
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
      </div>
    </div>
  );
}

/**
 * Kimi's AskUserQuestion, which arrives as a nativeOptions approval (see
 * `isKimiQuestion`). Renders the same `.ap2` question card as the
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
    <div className={`ap2${ap2ToneClass(item)}`}>
      <CardHead kind="question" icon="question" meta={<RiskMeta risk={item.risk} />} />
      <div className="ap2-q-text">{questionText}</div>
      <ul className="ap2-opts">
        {acceptOptions.map(opt => (
          <li key={opt.optionId} className={`ap2-opt${picked === opt.optionId ? ' is-picked' : ''}`}>
            <label>
              <input
                type="radio"
                name={`kimi-q-${item.approvalId}`}
                checked={picked === opt.optionId}
                onChange={() => setPicked(opt.optionId)}
              />
              <span>
                <span className="ap2-opt-label">{opt.label}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      <div className="ap2-actions">
        {resolving && <ResolvingNote />}
        <button
          className="btn ghost sm"
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
      </div>
    </div>
  );
}
