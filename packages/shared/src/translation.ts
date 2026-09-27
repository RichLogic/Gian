export const TRANSLATION_LANGUAGES = [
  ['en', 'English'], ['zh-CN', '简体中文'], ['zh-TW', '繁體中文'],
  ['ja', '日本語'], ['ko', '한국어'], ['fr', 'Français'], ['de', 'Deutsch'],
  ['es', 'Español'], ['pt', 'Português'], ['ru', 'Русский'], ['ar', 'العربية'],
] as const;

export interface TranslationPreferences {
  sending_language: string;
  reading_language: string;
  agent_id: string;
  model: string;
}

export const DEFAULT_TRANSLATION_PREFERENCES: Readonly<TranslationPreferences> = {
  sending_language: 'en', reading_language: 'zh-CN', agent_id: '', model: '',
};

export function isTranslationLanguage(value: unknown): value is string {
  return typeof value === 'string' && TRANSLATION_LANGUAGES.some(([id]) => id === value);
}

export function isTranslationConfigured(value: TranslationPreferences): boolean {
  return isTranslationLanguage(value.sending_language)
    && isTranslationLanguage(value.reading_language)
    && value.agent_id.length > 0
    && !value.agent_id.startsWith('remote:')
    && value.model.length > 0;
}

export function parseTranslationPreferences(value: unknown): TranslationPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('translation must be an object');
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some(key => !(key in DEFAULT_TRANSLATION_PREFERENCES))
    || !isTranslationLanguage(record.sending_language)
    || !isTranslationLanguage(record.reading_language)
    || typeof record.agent_id !== 'string' || record.agent_id.length > 128 || record.agent_id.startsWith('remote:')
    || typeof record.model !== 'string' || record.model.length > 256) {
    throw new Error('Invalid translation preferences');
  }
  return {
    sending_language: record.sending_language, reading_language: record.reading_language,
    agent_id: record.agent_id, model: record.model,
  };
}

export interface TranslationRecord {
  id: string;
  sessionId: string;
  sourceText: string;
  text: string;
  targetLanguage: string;
  agentId: string;
  model: string;
  purpose: 'send' | 'read';
  sourceId?: string;
  sourceDocument?: import('./context.js').ComposerDocument;
  translatedDocument?: import('./context.js').ComposerDocument;
}
