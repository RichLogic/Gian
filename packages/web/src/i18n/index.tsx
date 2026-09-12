import { createContext, useCallback, useContext } from 'react';
import type { ReactNode } from 'react';
import { ChatUiI18nContext } from '@gian/chat-ui';
import type { Locale, MessageKey } from './messages.js';
import { EN } from './en.js';
import { ZH } from './zh.js';

interface LocaleCtx {
  locale: Locale;
  t: (key: MessageKey) => string;
}

const Ctx = createContext<LocaleCtx>({
  locale: 'en',
  t: (k) => EN[k] ?? k,
});

export function LocaleProvider({
  locale,
  children,
}: {
  locale: Locale;
  children: ReactNode;
}) {
  const messages = locale === 'zh-CN' ? ZH : EN;
  const t = useCallback((k: MessageKey) => messages[k] ?? k, [messages]);
  // The shared chat-ui components read copy through their own context; feed
  // them the same translator so transcript/interaction UI follows the locale.
  // web's MessageKey union is a superset of the chat-ui keys.
  return (
    <Ctx.Provider value={{ locale, t }}>
      <ChatUiI18nContext.Provider value={t}>{children}</ChatUiI18nContext.Provider>
    </Ctx.Provider>
  );
}

export function useT(): (key: MessageKey) => string {
  return useContext(Ctx).t;
}

export type { Locale, MessageKey };
