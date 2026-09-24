/**
 * `GET /api/link-preview?url=…` — host-side unfurl for web-link hover
 * previews. Registered behind the same `requireAuth` middleware as every
 * other API route. The metadata fetch itself lives in
 * `../link-preview/fetch-metadata.ts` (SSRF-hardened: scheme + DNS-range
 * validation on every redirect hop, time/byte caps, HTML-only parsing).
 *
 * `GET /api/link-preview/favicon?url=…` — favicons are re-hosted through
 * this route instead of being hot-linked by the client, so a crafted
 * transcript can never make the Web UI beacon third-party icon URLs.
 *
 * Responses:
 * - 200 `{ url, title, description, siteName, faviconUrl }` where
 *   `faviconUrl` points back at the favicon proxy route (null when the
 *   page is unreachable as metadata);
 * - 404 `{ error }` when no preview is available (negative-cached 5min);
 * - 429 when the session exceeds the fetch rate limit.
 */

import type { Context, Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import {
  FAVICON_CACHE_MAX_ENTRIES,
  FAVICON_SUCCESS_TTL_MS,
  LINK_PREVIEW_CACHE_MAX_ENTRIES,
  LINK_PREVIEW_NEGATIVE_TTL_MS,
  LINK_PREVIEW_RATE_LIMIT,
  LINK_PREVIEW_RATE_WINDOW_MS,
  LINK_PREVIEW_SUCCESS_TTL_MS,
  RateLimiter,
  TtlLruCache,
  normalizePreviewUrl,
} from '../link-preview/cache.js';
import {
  fetchFaviconAsset,
  fetchLinkMetadata,
  type LinkPreviewFavicon,
  type LinkPreviewFetchDeps,
} from '../link-preview/fetch-metadata.js';

export interface LinkPreviewPayload {
  url: string;
  title: string | null;
  description: string | null;
  siteName: string | null;
  faviconUrl: string | null;
}

export interface LinkPreviewRouteOptions {
  /** Test seams forwarded to the fetchers (fetchFn / lookupFn / budgets). */
  fetchDeps?: LinkPreviewFetchDeps;
  fetchMetadataFn?: typeof fetchLinkMetadata;
  fetchFaviconFn?: typeof fetchFaviconAsset;
  cache?: TtlLruCache<LinkPreviewPayload | null>;
  faviconCache?: TtlLruCache<LinkPreviewFavicon | null>;
  rateLimiter?: RateLimiter;
}

/** Rate-limit bucket: the session credential when one is presented (the
 *  same cookie/bearer `requireAuth` checks), otherwise a single shared
 *  local bucket — with auth disabled the Host is loopback-only anyway. */
function rateLimitKey(c: Context): string {
  const cookie = getCookie(c, 'gian_session');
  if (cookie) return `cookie:${cookie}`;
  const header = c.req.header('Authorization');
  if (header?.startsWith('Bearer ')) return `bearer:${header.slice(7)}`;
  return 'local';
}

export function registerLinkPreviewRoutes(
  app: Hono,
  options: LinkPreviewRouteOptions = {},
): void {
  const fetchDeps = options.fetchDeps ?? {};
  const fetchMetadata = options.fetchMetadataFn ?? fetchLinkMetadata;
  const fetchFavicon = options.fetchFaviconFn ?? fetchFaviconAsset;
  const cache = options.cache
    ?? new TtlLruCache<LinkPreviewPayload | null>(LINK_PREVIEW_CACHE_MAX_ENTRIES);
  const faviconCache = options.faviconCache
    ?? new TtlLruCache<LinkPreviewFavicon | null>(FAVICON_CACHE_MAX_ENTRIES);
  const rateLimiter = options.rateLimiter
    ?? new RateLimiter(LINK_PREVIEW_RATE_LIMIT, LINK_PREVIEW_RATE_WINDOW_MS);

  app.get('/api/link-preview', async c => {
    const raw = c.req.query('url') ?? '';
    const key = raw ? normalizePreviewUrl(raw) : null;
    if (!key) return c.json({ error: 'http(s) url required' }, 400);

    const cached = cache.get(key);
    if (cached !== undefined) {
      return cached === null
        ? c.json({ error: 'preview unavailable' }, 404)
        : c.json(cached, 200, { 'cache-control': 'private, max-age=60' });
    }
    if (!rateLimiter.allow(rateLimitKey(c))) {
      return c.json({ error: 'rate limited' }, 429);
    }

    const metadata = await fetchMetadata(raw, fetchDeps);
    if (!metadata) {
      cache.set(key, null, LINK_PREVIEW_NEGATIVE_TTL_MS);
      return c.json({ error: 'preview unavailable' }, 404);
    }
    const payload: LinkPreviewPayload = {
      url: metadata.url,
      title: metadata.title,
      description: metadata.description,
      siteName: metadata.siteName,
      faviconUrl: metadata.faviconUrl
        ? `/api/link-preview/favicon?url=${encodeURIComponent(metadata.faviconUrl)}`
        : null,
    };
    cache.set(key, payload, LINK_PREVIEW_SUCCESS_TTL_MS);
    return c.json(payload, 200, { 'cache-control': 'private, max-age=60' });
  });

  app.get('/api/link-preview/favicon', async c => {
    const raw = c.req.query('url') ?? '';
    const key = raw ? normalizePreviewUrl(raw) : null;
    if (!key) return c.json({ error: 'http(s) url required' }, 400);

    const cached = faviconCache.get(key);
    if (cached !== undefined) {
      return cached === null
        ? c.json({ error: 'favicon unavailable' }, 404)
        : faviconResponse(cached);
    }
    if (!rateLimiter.allow(rateLimitKey(c))) {
      return c.json({ error: 'rate limited' }, 429);
    }

    const favicon = await fetchFavicon(raw, fetchDeps);
    if (!favicon) {
      faviconCache.set(key, null, LINK_PREVIEW_NEGATIVE_TTL_MS);
      return c.json({ error: 'favicon unavailable' }, 404);
    }
    faviconCache.set(key, favicon, FAVICON_SUCCESS_TTL_MS);
    return faviconResponse(favicon);
  });
}

function faviconResponse(favicon: LinkPreviewFavicon): Response {
  return new Response(favicon.bytes.slice(), {
    status: 200,
    headers: {
      'content-type': favicon.contentType,
      'content-length': String(favicon.bytes.byteLength),
      'cache-control': 'private, max-age=3600',
      'x-content-type-options': 'nosniff',
    },
  });
}
