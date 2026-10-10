import { MarkdownText, type MsgItem } from '@gian/chat-ui';
import { TRANSLATION_LANGUAGES } from '@gian/shared';
import { useT } from '../i18n/index.js';
import type { ReadingTranslation, TranslationController } from './use-translation.js';

export function languageName(code: string): string {
  return TRANSLATION_LANGUAGES.find(([id]) => id === code)?.[1] ?? code;
}

/**
 * Shared "Translating" indicator: a quiet label plus three permanent dots
 * running a staggered wave keyframe (see translation.css; the animation
 * degrades to static dots under prefers-reduced-motion). Used by the pending
 * send echo's inline row and by the assistant translation toggle.
 */
export function TranslatingIndicator() {
  const t = useT();
  return <span className="translation-pending">
    <span>{t('translation.inProgress')}</span>
    <span className="translation-dots" aria-hidden="true"><span /><span /><span /></span>
  </span>;
}

export function TranslationButton({ item, controller }: { item: MsgItem; controller: TranslationController }) {
  const t = useT();
  const key = `turn:${item.turn}`;
  const expanded = controller.isReadExpanded(key);
  const title = t('translation.to').replace('{language}', languageName(controller.state.preferences.reading_language));
  // Not disabled while pending: the toggle must stay clickable so the user can
  // collapse a slow translation; toggleRead already no-ops the read when one
  // is in flight.
  return <button type="button" className={`translation-action${expanded ? ' on' : ''}`} title={title} aria-label={title}
    aria-expanded={expanded} aria-pressed={expanded}
    disabled={!controller.ready} onClick={() => controller.toggleRead(item.text, key)}>
    <span aria-hidden="true">文<span lang="en">A</span></span>
  </button>;
}

/**
 * The assistant message's translation block. Rendering is owned by the 文A
 * toggle (`expanded`): collapsed renders nothing — even when the Host already
 * has a cached record. The heading is skipped while pending (2026-10-09
 * owner: "Translation" above "Translating…" reads duplicated); it appears
 * with the record (`Translation · 简体中文`) or an error.
 */
export function TranslationResult({ value, expanded, onRetry }: { value: ReadingTranslation; expanded: boolean; onRetry: () => void }) {
  const t = useT();
  if (!expanded || (!value.pending && !value.error && !value.record)) return null;
  return <div className="translation-block" aria-busy={value.pending}>
    {!value.pending && (
      <div className="translation-heading">
        {t('translation.title')}{value.record ? ` · ${languageName(value.record.targetLanguage)}` : ''}
      </div>
    )}
    {value.pending && <TranslatingIndicator />}
    {value.error && <div className="translation-error" role="alert">{value.error}
      <button type="button" className="btn xs secondary" onClick={onRetry}>{t('translation.retry')}</button>
    </div>}
    {value.record && <div className="translation-bubble md"><MarkdownText>{value.record.text}</MarkdownText></div>}
  </div>;
}

/**
 * Inline progress row under a pending send echo while its translation runs
 * (the optimistic up-screen replaced the old centered TranslationSendStatus
 * bar). Pending: Translating dots + a "Send original" shortcut. Error: the
 * message plus Retry / Send original text links. There is deliberately no way
 * to cancel the whole message — the bubble is already on screen.
 */
export function TranslationSendRow({ controller }: { controller: TranslationController }) {
  const t = useT();
  if (!controller.sending) return null;
  if (controller.sending.pending) {
    return <div className="translation-send-row" role="status">
      <TranslatingIndicator />
      <button type="button" className="translation-link" onClick={() => controller.finishSend(true)}>
        {t('translation.sendOriginal')}
      </button>
    </div>;
  }
  return <div className="translation-send-row" role="alert">
    <span className="translation-error">{controller.sending.error}</span>
    <button type="button" className="translation-link" onClick={() => void controller.retrySend()}>
      {t('translation.retry')}
    </button>
    <button type="button" className="translation-link" onClick={() => controller.finishSend(true)}>
      {t('translation.sendOriginal')}
    </button>
  </div>;
}

/** Bare pending row for a `sendTranslation` echo whose flow has no controller
 *  send state (the new-session first message — its failure path restores the
 *  composer draft instead of offering in-row retry/send-original). */
export function TranslationEchoPendingRow() {
  return <div className="translation-send-row" role="status"><TranslatingIndicator /></div>;
}

/** lucide.dev `book-type` (24-grid, project 1.5px stroke) — the Auto
 * translate chip is icon-only; the label stays on title/aria. */
const BOOK_TYPE_PATHS = ['M10 13h4', 'M12 6v7', 'M16 8V6H8v2',
  'M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H19a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H6.5a1 1 0 0 1 0-5H20'];

/** Pure presentational auto-translate chip, shared by the session underbar
 *  (wired to the TranslationController) and the new-session form (wired to
 *  its local draft state + Settings validation). */
export function AutoTranslationChip({ on, disabled, onClick, title, testId }: {
  on: boolean;
  disabled?: boolean;
  onClick: () => void;
  title: string;
  testId?: string;
}) {
  return <button type="button"
    className={`translation-auto${on ? ' on' : ''}`}
    title={title}
    aria-label={title}
    aria-pressed={on}
    disabled={disabled}
    onClick={onClick}
    {...(testId ? { 'data-testid': testId } : {})}>
    <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor"
      strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {BOOK_TYPE_PATHS.map(d => <path key={d} d={d} />)}
    </svg>
  </button>;
}
