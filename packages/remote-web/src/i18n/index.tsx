import { createContext, useCallback, useContext } from 'react';
import type { ReactNode } from 'react';
import { ChatUiI18nContext } from '@gian/chat-ui';
import type { Locale, MessageKey } from './messages.js';
import { EN } from './en.js';
import { ZH } from './zh.js';

interface LocaleCtx {
  locale: Locale;
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
}

/** Remote Web intentionally ships with one product language. Conversation,
 * Task, Repo, and Host names remain user data and are never translated. */
export const REMOTE_WEB_LOCALE: Locale = 'en';

export function resolveRemoteWebLocale(_search = ''): Locale {
  return REMOTE_WEB_LOCALE;
}

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}

const Ctx = createContext<LocaleCtx>({
  locale: 'en',
  t: (k, vars) => interpolate(EN[k] ?? k, vars),
});

export function LocaleProvider({
  locale,
  children,
}: {
  locale: Locale;
  children: ReactNode;
}) {
  const messages = locale === 'zh-CN' ? ZH : EN;
  const t = useCallback(
    (k: MessageKey, vars?: Record<string, string | number>) =>
      interpolate(messages[k] ?? EN[k] ?? k, vars),
    [messages],
  );
  // chat-ui components read copy through their own context; feed them the
  // same translator (remote-web's table is a superset of the chat-ui keys).
  return (
    <Ctx.Provider value={{ locale, t }}>
      <ChatUiI18nContext.Provider value={t}>{children}</ChatUiI18nContext.Provider>
    </Ctx.Provider>
  );
}

export function useT(): (key: MessageKey, vars?: Record<string, string | number>) => string {
  return useContext(Ctx).t;
}

export type { Locale, MessageKey };
