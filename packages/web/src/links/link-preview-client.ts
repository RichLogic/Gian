/**
 * Gian Web's `LinkPreviewFetcher` — a thin same-origin wrapper over the
 * Host's `GET /api/link-preview` (all SSRF hardening lives Host-side). The
 * in-memory LRU (200 entries, both hits and nulls) is the session cache:
 * hover previews must never refetch a URL the session already resolved.
 * Failures (non-200, network, malformed body) all collapse to null — the
 * card renders nothing extra either way.
 */

import type { LinkPreview, LinkPreviewFetcher } from '@gian/chat-ui';

export const LINK_PREVIEW_CLIENT_CACHE_MAX = 200;

export function createLinkPreviewClient(options: {
  fetchFn?: typeof fetch;
  maxEntries?: number;
} = {}): LinkPreviewFetcher {
  const fetchFn = options.fetchFn ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const maxEntries = options.maxEntries ?? LINK_PREVIEW_CLIENT_CACHE_MAX;
  const cache = new Map<string, LinkPreview | null>();

  return {
    async fetchPreview(url, signal) {
      const cached = cache.get(url);
      if (cached !== undefined) {
        // Refresh recency for the LRU bound.
        cache.delete(url);
        cache.set(url, cached);
        return cached;
      }
      let preview: LinkPreview | null;
      try {
        const res = await fetchFn(`/api/link-preview?url=${encodeURIComponent(url)}`, { signal });
        preview = res.ok ? sanitize(await res.json()) : null;
      } catch {
        preview = null;
      }
      cache.set(url, preview);
      while (cache.size > maxEntries) {
        const oldest = cache.keys().next();
        if (oldest.done) break;
        cache.delete(oldest.value);
      }
      return preview;
    },
  };
}

function sanitize(body: unknown): LinkPreview | null {
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  if (typeof record['url'] !== 'string') return null;
  return {
    url: record['url'],
    title: stringOrNull(record['title']),
    description: stringOrNull(record['description']),
    siteName: stringOrNull(record['siteName']),
    faviconUrl: stringOrNull(record['faviconUrl']),
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}
