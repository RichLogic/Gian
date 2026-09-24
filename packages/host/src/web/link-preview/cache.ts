/**
 * TTL caches and the per-session rate limiter behind the link-preview
 * routes. In-memory by design: metadata is a pure latency optimization, a
 * Host restart losing it is harmless, and a SQLite table would persist
 * model-influenced URLs for no benefit.
 *
 * Numbers (single-user Host; transcripts are model-influenced, so bursts of
 * crafted links are the abuse case):
 * - metadata: 1h success TTL, 5min negative TTL, 1000-entry LRU;
 * - favicon: 24h success TTL, 5min negative TTL, 500-entry LRU;
 * - rate limit: 30 network fetches / minute / session across both routes
 *   (cache hits are free — the limiter guards the network, not the Map).
 */

export const LINK_PREVIEW_SUCCESS_TTL_MS = 60 * 60 * 1000;
export const LINK_PREVIEW_NEGATIVE_TTL_MS = 5 * 60 * 1000;
export const LINK_PREVIEW_CACHE_MAX_ENTRIES = 1000;
export const FAVICON_SUCCESS_TTL_MS = 24 * 60 * 60 * 1000;
export const FAVICON_CACHE_MAX_ENTRIES = 500;
export const LINK_PREVIEW_RATE_LIMIT = 30;
export const LINK_PREVIEW_RATE_WINDOW_MS = 60 * 1000;

/** Bounded TTL cache with LRU eviction (Map insertion order). */
export class TtlLruCache<V> {
  readonly #entries = new Map<string, { value: V; expiresAt: number }>();

  constructor(
    readonly maxEntries: number,
    readonly now: () => number = () => Date.now(),
  ) {}

  /** Undefined on miss or expiry (expired entries are dropped lazily). */
  get(key: string): V | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.#entries.delete(key);
      return undefined;
    }
    // Refresh recency.
    this.#entries.delete(key);
    this.#entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V, ttlMs: number): void {
    this.#entries.delete(key);
    this.#entries.set(key, { value, expiresAt: this.now() + ttlMs });
    while (this.#entries.size > this.maxEntries) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) break;
      this.#entries.delete(oldest.value);
    }
  }

  get size(): number {
    return this.#entries.size;
  }
}

/** Cache key: fragment stripped, scheme/host lowercased, default port
 *  removed (`new URL` lowercases scheme+host already). Null when the input
 *  is not an http(s) URL — callers treat that as "do not cache". */
export function normalizePreviewUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  url.hash = '';
  if ((url.protocol === 'http:' && url.port === '80')
    || (url.protocol === 'https:' && url.port === '443')) {
    url.port = '';
  }
  return url.href;
}

/** Fixed-window sliding log rate limiter: `limit` events per `windowMs`
 *  per key. Keys with no recent events are pruned on write. */
export class RateLimiter {
  readonly #hits = new Map<string, number[]>();

  constructor(
    readonly limit: number,
    readonly windowMs: number,
    readonly now: () => number = () => Date.now(),
  ) {}

  allow(key: string): boolean {
    const cutoff = this.now() - this.windowMs;
    const recent = (this.#hits.get(key) ?? []).filter(at => at > cutoff);
    if (recent.length >= this.limit) {
      this.#hits.set(key, recent);
      return false;
    }
    recent.push(this.now());
    this.#hits.set(key, recent);
    return true;
  }
}
