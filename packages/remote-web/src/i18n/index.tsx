import { createContext, useCallback, useContext, useEffect } from 'react';
import type { ReactNode } from 'react';
import { ChatUiI18nContext } from '@gian/chat-ui';
import type { Locale, MessageKey } from './messages.js';
import { EN } from './en.js';
import { ZH } from './zh.js';

/** The UI locale follows the Host: `state.snapshot.host.locale` lands in
 *  `RemoteUiState.locale` and App re-binds this provider to it. Before the
 *  first snapshot (pairing, enrollment) — and against Hosts predating
 *  `wire.host_locale` — the fallback is 'en'. index.html keeps `lang="en"`
 *  as the pre-boot default; the provider syncs `<html lang>` from here.
 *  Conversation, Task, Repo, and Host names remain user data and are never
 *  translated. */
interface LocaleCtx {
  locale: Locale;
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
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
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
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
