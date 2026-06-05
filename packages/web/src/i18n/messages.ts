export type Locale = 'en' | 'zh-CN';

/**
 * Gian's UI is still being migrated to i18n. Keep keys open-ended so new V2
 * surfaces can be localized incrementally without editing a large union first.
 * The locale files remain the source of truth for actual strings.
 */
export type MessageKey = string;

export type Messages = Record<MessageKey, string>;
