/**
 * Per-origin favicon registry for link icons. Fed ONLY by already-completed
 * hover-preview fetches: `LinkPreviewCard`'s `WebLink` records the resolved
 * `preview.faviconUrl` (a same-origin, host-re-hosted `/api/link-preview/
 * favicon?…` URL — never a third-party hot-link). Icon rendering itself
 * never fetches; an origin without a completed preview keeps its mapped
 * brand glyph or the globe fallback.
 */

import { useCallback, useSyncExternalStore } from 'react';

const favicons = new Map<string, string>();
const listeners = new Set<() => void>();

function originOf(url: string): string | null {
  try {
    const origin = new URL(url).origin;
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

/** Record the re-hosted favicon of a successfully previewed page, keyed by
 *  the page's origin. No-ops repeat writes; listeners fire once per change. */
export function recordLinkFavicon(pageUrl: string, faviconUrl: string | null): void {
  if (!faviconUrl) return;
  const origin = originOf(pageUrl);
  if (!origin || favicons.get(origin) === faviconUrl) return;
  favicons.set(origin, faviconUrl);
  for (const listener of listeners) listener();
}

/** Forget every recorded favicon (test seam; surfaces are session-scoped). */
export function clearLinkFavicons(): void {
  if (favicons.size === 0) return;
  favicons.clear();
  for (const listener of listeners) listener();
}

/** The recorded favicon for `pageUrl`'s origin, reactive to later records. */
export function useLinkFavicon(pageUrl: string): string | null {
  const subscribe = useCallback((listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return useSyncExternalStore(subscribe, () => {
    const origin = originOf(pageUrl);
    return origin ? (favicons.get(origin) ?? null) : null;
  });
}
