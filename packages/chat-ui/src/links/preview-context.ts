/**
 * Link-preview (unfurl) injection. The host app provides a fetcher that
 * resolves an http(s) URL to its preview metadata; `@gian/chat-ui` renders
 * the hover card. A null context means the surface cannot fetch previews
 * (Remote Web has no generic host relay) — `LinkAnchor` then renders web
 * links exactly as before, with no hover behavior at all.
 *
 * The fetcher contract hides every failure behind `null`: the card never
 * surfaces errors, and the link itself is untouched either way.
 */

import { createContext, useContext } from 'react';

export interface LinkPreview {
  /** Final URL after redirects (may differ from the hovered href). */
  url: string;
  title: string | null;
  description: string | null;
  siteName: string | null;
  /** Same-origin URL of the host-re-hosted favicon; never a third-party
   *  hot-link. Null when the page has no usable icon. */
  faviconUrl: string | null;
}

export interface LinkPreviewFetcher {
  /** Resolve a preview, or null when none is available. Must reject only
   *  on abort-contract violations; ordinary failures resolve null. */
  fetchPreview(url: string, signal: AbortSignal): Promise<LinkPreview | null>;
}

export const LinkPreviewContext = createContext<LinkPreviewFetcher | null>(null);

export function useLinkPreview(): LinkPreviewFetcher | null {
  return useContext(LinkPreviewContext);
}
