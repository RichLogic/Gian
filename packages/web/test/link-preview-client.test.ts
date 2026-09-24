// links/link-preview-client.ts — Gian Web's LinkPreviewFetcher: same-origin
// fetch wrapper over GET /api/link-preview, null-collapsed failures, and the
// per-session in-memory LRU (hits and nulls alike).

import { describe, expect, it, vi } from 'vitest';
import { createLinkPreviewClient } from '../src/links/link-preview-client.js';

const PAYLOAD = {
  url: 'https://example.com/',
  title: 'Example',
  description: 'Desc',
  siteName: 'Site',
  faviconUrl: '/api/link-preview/favicon?url=x',
};

function stubFetch(responses: Map<string, { status: number; body?: unknown }>) {
  const calls: Array<{ path: string; signal?: AbortSignal }> = [];
  const fetchFn = (async (path: string | URL | Request, init?: RequestInit) => {
    const key = String(path);
    calls.push({ path: key, signal: init?.signal ?? undefined });
    const entry = responses.get(key);
    if (!entry) return new Response(null, { status: 404 });
    return new Response(JSON.stringify(entry.body ?? null), { status: entry.status });
  }) as typeof fetch;
  return { fetchFn, calls };
}

function pathFor(url: string): string {
  return `/api/link-preview?url=${encodeURIComponent(url)}`;
}

describe('createLinkPreviewClient', () => {
  it('fetches the host route and returns the parsed preview', async () => {
    const { fetchFn, calls } = stubFetch(new Map([[pathFor('https://example.com/'), { status: 200, body: PAYLOAD }]]));
    const client = createLinkPreviewClient({ fetchFn });
    const preview = await client.fetchPreview('https://example.com/', new AbortController().signal);
    expect(preview).toEqual(PAYLOAD);
    expect(calls).toHaveLength(1);
  });

  it('collapses non-200 and network failures to null', async () => {
    const { fetchFn } = stubFetch(new Map());
    const client = createLinkPreviewClient({ fetchFn });
    expect(await client.fetchPreview('https://example.com/404', new AbortController().signal)).toBeNull();
    const failing = createLinkPreviewClient({
      fetchFn: (() => Promise.reject(new Error('down'))) as unknown as typeof fetch,
    });
    expect(await failing.fetchPreview('https://example.com/x', new AbortController().signal)).toBeNull();
  });

  it('returns null for malformed payloads', async () => {
    const { fetchFn } = stubFetch(new Map([
      [pathFor('https://example.com/a'), { status: 200, body: { nope: 1 } }],
      [pathFor('https://example.com/b'), { status: 200, body: 'garbage' }],
    ]));
    const client = createLinkPreviewClient({ fetchFn });
    expect(await client.fetchPreview('https://example.com/a', new AbortController().signal)).toBeNull();
    expect(await client.fetchPreview('https://example.com/b', new AbortController().signal)).toBeNull();
  });

  it('caches hits and nulls for the session (one network call per URL)', async () => {
    const { fetchFn, calls } = stubFetch(new Map([
      [pathFor('https://example.com/hit'), { status: 200, body: PAYLOAD }],
    ]));
    const client = createLinkPreviewClient({ fetchFn });
    const signal = new AbortController().signal;
    expect(await client.fetchPreview('https://example.com/hit', signal)).toEqual(PAYLOAD);
    expect(await client.fetchPreview('https://example.com/hit', signal)).toEqual(PAYLOAD);
    expect(await client.fetchPreview('https://example.com/miss', signal)).toBeNull();
    expect(await client.fetchPreview('https://example.com/miss', signal)).toBeNull();
    expect(calls).toHaveLength(2);
  });

  it('passes the abort signal through to fetch', async () => {
    const { fetchFn, calls } = stubFetch(new Map([[pathFor('https://example.com/'), { status: 200, body: PAYLOAD }]]));
    const client = createLinkPreviewClient({ fetchFn });
    const controller = new AbortController();
    await client.fetchPreview('https://example.com/', controller.signal);
    expect(calls[0]!.signal).toBe(controller.signal);
  });

  it('evicts the least-recently-used entry past the bound', async () => {
    const { fetchFn, calls } = stubFetch(new Map([
      [pathFor('https://a.test/'), { status: 200, body: PAYLOAD }],
      [pathFor('https://b.test/'), { status: 200, body: PAYLOAD }],
      [pathFor('https://c.test/'), { status: 200, body: PAYLOAD }],
    ]));
    const client = createLinkPreviewClient({ fetchFn, maxEntries: 2 });
    const signal = new AbortController().signal;
    await client.fetchPreview('https://a.test/', signal);
    await client.fetchPreview('https://b.test/', signal);
    await client.fetchPreview('https://c.test/', signal); // evicts a.test
    expect(calls).toHaveLength(3);
    await client.fetchPreview('https://c.test/', signal); // cached
    await client.fetchPreview('https://b.test/', signal); // cached
    expect(calls).toHaveLength(3);
    await client.fetchPreview('https://a.test/', signal); // evicted: refetches
    expect(calls).toHaveLength(4);
  });
});
