import { createContext, useCallback, useContext } from 'react';
import type { ReactNode } from 'react';
import type { Locale, MessageKey } from './messages.js';
import { EN } from './en.js';
import { ZH } from './zh.js';

interface LocaleCtx {
  locale: Locale;
  t: (key: MessageKey) => string;
}

const Ctx = createContext<LocaleCtx>({
  locale: 'en',
  t: (k) => k,
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
  return <Ctx.Provider value={{ locale, t }}>{children}</Ctx.Provider>;
}

export function useT(): (key: MessageKey) => string {
  return useContext(Ctx).t;
}

export type { Locale, MessageKey };
