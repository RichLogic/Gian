export type Locale = 'en' | 'zh-CN';

/**
 * Same convention as packages/web: keys stay open-ended so new surfaces can
 * be localized incrementally. Locale files are the source of truth.
 */
export type MessageKey = string;

export type Messages = Record<MessageKey, string>;
