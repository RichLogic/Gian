/**
 * `LinkifiedText` — renders plain text with `http(s)://` URLs turned into
 * `LinkAnchor`s. Conservative by design: a bare URL tokenizer (no markdown
 * parsing, no file-path sniffing), trailing sentence punctuation trimmed,
 * and the surface policy decides whether URLs linkify at all.
 */

import { Fragment, useMemo } from 'react';
import { LinkAnchor } from './LinkAnchor.js';
import { useLinkPolicy } from './LinkBehaviorContext.js';

export interface LinkTextToken {
  type: 'text' | 'url';
  value: string;
}

const URL_RE = /https?:\/\/[^\s<>"'`]+/gi;
/** Characters that end a sentence, not a URL. */
const TRAILING_CHARS = new Set([...'.,;:!?)]}\'"']);

/** Split plain text into URL and non-URL runs. Exported for tests. */
export function splitLinkTokens(text: string): LinkTextToken[] {
  const tokens: LinkTextToken[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_RE)) {
    let url = match[0];
    // Trim trailing punctuation, but keep a `)` that closes a `(` inside
    // the URL (Wikipedia-style paths).
    while (url.length > 0 && TRAILING_CHARS.has(url[url.length - 1]!)) {
      if (url.endsWith(')')) {
        const opens = (url.match(/\(/g) ?? []).length;
        const closes = (url.match(/\)/g) ?? []).length;
        if (closes <= opens) break;
      }
      url = url.slice(0, -1);
    }
    const end = match.index + url.length;
    if (!url) continue;
    if (match.index > last) tokens.push({ type: 'text', value: text.slice(last, match.index) });
    tokens.push({ type: 'url', value: url });
    last = end;
  }
  if (last < text.length) tokens.push({ type: 'text', value: text.slice(last) });
  return tokens;
}

export function LinkifiedText({ text }: { text: string }) {
  const policy = useLinkPolicy();
  const tokens = useMemo(() => splitLinkTokens(text), [text]);
  if (!tokens.some(token => token.type === 'url')) return <>{text}</>;
  return (
    <>
      {tokens.map((token, i) =>
        token.type === 'url' && policy.allowScheme('web') ? (
          <LinkAnchor key={i} href={token.value}>
            {token.value}
          </LinkAnchor>
        ) : (
          <Fragment key={i}>{token.value}</Fragment>
        ),
      )}
    </>
  );
}
