import { useState } from 'react';
import { CopyButton, MarkdownText, type MsgItem } from '@gian/chat-ui';
import { TRANSLATION_LANGUAGES } from '@gian/shared';
import { useT } from '../i18n/index.js';
import type { ReadingTranslation, TranslationController } from './use-translation.js';

export function languageName(code: string): string {
  return TRANSLATION_LANGUAGES.find(([id]) => id === code)?.[1] ?? code;
}

export function TranslationButton({ item, controller }: { item: MsgItem; controller: TranslationController }) {
  const t = useT();
  const key = `turn:${item.turn}`;
  const result = controller.result(key, item.text);
  const title = t('translation.to').replace('{language}', languageName(controller.state.preferences.reading_language));
  return <button type="button" className="translation-action" title={title} aria-label={title}
    disabled={!controller.ready || result.pending} onClick={() => void controller.read(item.text, key)}>
    <span aria-hidden="true">文<span lang="en">A</span></span>
  </button>;
}

export function TranslationResult({ value, onRetry }: { value: ReadingTranslation; onRetry: () => void }) {
  const t = useT();
  const [collapsed, setCollapsed] = useState(false);
  if (!value.pending && !value.error && !value.record) return null;
  return <div className="translation-block" aria-busy={value.pending}>
    <div className="translation-heading">
      <button type="button" className="translation-collapse" aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)}>
        {t('translation.title')}{value.record ? ` · ${languageName(value.record.targetLanguage)}` : ''}
        <span aria-hidden="true">{collapsed ? '+' : '−'}</span>
      </button>
      {value.record && <CopyButton text={value.record.text} />}
    </div>
    {value.pending && <div role="status">{t('translation.loading')}</div>}
    {value.error && <div className="translation-error" role="alert">{value.error}
      <button type="button" className="btn xs secondary" onClick={onRetry}>{t('translation.retry')}</button>
    </div>}
    {!collapsed && value.record && <div className="translation-bubble md"><MarkdownText>{value.record.text}</MarkdownText></div>}
  </div>;
}

export function AutoTranslationChip({ controller }: { controller: TranslationController }) {
  const t = useT();
  const on = controller.state.enabled;
  return <button type="button"
    className={`translation-auto${on ? ' on' : ''}`}
    title={t('translation.auto')}
    aria-pressed={on}
    disabled={!controller.ready || controller.saving || !!controller.sending}
    onClick={() => void controller.toggle(!on)}>
    {t('translation.auto')}
  </button>;
}

export function TranslationSendStatus({ controller }: { controller: TranslationController }) {
  const t = useT();
  if (!controller.sending) return null;
  return <div className="translation-send-status" role="status">
    <span>{controller.sending.pending ? t('translation.loading') : controller.sending.error}</span>
    {!controller.sending.pending && <>
      <button type="button" className="btn xs secondary" onClick={() => void controller.retrySend()}>{t('translation.retry')}</button>
      <button type="button" className="btn xs secondary" onClick={() => controller.finishSend(true)}>{t('translation.sendOriginal')}</button>
    </>}
    <button type="button" className="btn xs secondary" onClick={() => controller.finishSend(false)}>{t('common.cancel')}</button>
  </div>;
}
