// HTTP-level coverage for the link-preview routes through the real createApp
// stack (auth middleware, desktop boundary). Fetchers, caches and the rate
// limiter are injected — no sockets. The SSRF matrix itself lives in
// link-preview-fetch.test.ts; TTL/LRU units in link-preview-cache.test.ts.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { makeTestApp } from './fixtures/test-app.js';
import { RateLimiter, TtlLruCache } from '../src/web/link-preview/cache.js';
import type {
  LinkPreviewFavicon,
  LinkPreviewMetadata,
} from '../src/web/link-preview/fetch-metadata.js';
import type {
  LinkPreviewPayload,
  LinkPreviewRouteOptions,
} from '../src/web/routes/link-preview.js';

const METADATA: LinkPreviewMetadata = {
  url: 'https://example.com/',
  title: 'Example',
  description: 'An example page',
  siteName: 'Example Site',
  faviconUrl: 'https://example.com/favicon.ico',
};

const FAVICON: LinkPreviewFavicon = {
  bytes: new Uint8Array([0x00, 0x00, 0x01, 0x00]),
  contentType: 'image/x-icon',
};

function options(overrides: Partial<LinkPreviewRouteOptions> = {}) {
  const metadataCalls: string[] = [];
  const faviconCalls: string[] = [];
  const linkPreviewOptions: LinkPreviewRouteOptions = {
    fetchMetadataFn: async (url: string) => {
      metadataCalls.push(url);
      return METADATA;
    },
    fetchFaviconFn: async (url: string) => {
      faviconCalls.push(url);
      return FAVICON;
    },
    ...overrides,
  };
  return { metadataCalls, faviconCalls, linkPreviewOptions };
}

test('GET /api/link-preview returns the unfurl payload with a proxied favicon URL', async () => {
  const { linkPreviewOptions } = options();
  const appCtx = await makeTestApp({ linkPreviewOptions });
  try {
    const res = await appCtx.fetch(`/api/link-preview?url=${encodeURIComponent('https://example.com/')}`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as LinkPreviewPayload;
    assert.deepEqual(body, {
      url: 'https://example.com/',
      title: 'Example',
      description: 'An example page',
      siteName: 'Example Site',
      faviconUrl: `/api/link-preview/favicon?url=${encodeURIComponent('https://example.com/favicon.ico')}`,
    });
  } finally {
    await appCtx.cleanup();
  }
});

test('GET /api/link-preview rejects missing and non-http(s) URLs with 400', async () => {
  const { linkPreviewOptions, metadataCalls } = options();
  const appCtx = await makeTestApp({ linkPreviewOptions });
  try {
    assert.equal((await appCtx.fetch('/api/link-preview')).status, 400);
    assert.equal((await appCtx.fetch(`/api/link-preview?url=${encodeURIComponent('ftp://x/')}`)).status, 400);
    assert.deepEqual(metadataCalls, [], 'no fetch for invalid input');
  } finally {
    await appCtx.cleanup();
  }
});

test('GET /api/link-preview 404s when no metadata is available and negative-caches it', async () => {
  const { linkPreviewOptions, metadataCalls } = options({
    fetchMetadataFn: async (url: string) => {
      metadataCalls.push(url);
      return null;
    },
  });
  const appCtx = await makeTestApp({ linkPreviewOptions });
  try {
    const url = encodeURIComponent('https://example.com/gone');
    assert.equal((await appCtx.fetch(`/api/link-preview?url=${url}`)).status, 404);
    assert.equal((await appCtx.fetch(`/api/link-preview?url=${url}`)).status, 404);
    assert.equal(metadataCalls.length, 1, 'second 404 served from the negative cache');
  } finally {
    await appCtx.cleanup();
  }
});

test('GET /api/link-preview serves repeat requests from the success cache', async () => {
  const { linkPreviewOptions, metadataCalls } = options();
  const appCtx = await makeTestApp({ linkPreviewOptions });
  try {
    const url = encodeURIComponent('https://example.com/');
    assert.equal((await appCtx.fetch(`/api/link-preview?url=${url}`)).status, 200);
    const withFragment = encodeURIComponent('https://example.com/#other');
    assert.equal((await appCtx.fetch(`/api/link-preview?url=${withFragment}`)).status, 200);
    assert.equal(metadataCalls.length, 1, 'fragment-only difference still hits the cache');
  } finally {
    await appCtx.cleanup();
  }
});

test('GET /api/link-preview rate-limits network fetches per session', async () => {
  const { linkPreviewOptions } = options({
    rateLimiter: new RateLimiter(2, 60_000),
    // No cache: every request would hit the network without the limiter.
    cache: new TtlLruCache<LinkPreviewPayload | null>(0),
  });
  const appCtx = await makeTestApp({ linkPreviewOptions });
  try {
    assert.equal((await appCtx.fetch('/api/link-preview?url=https%3A%2F%2Fa.test%2F1')).status, 200);
    assert.equal((await appCtx.fetch('/api/link-preview?url=https%3A%2F%2Fa.test%2F2')).status, 200);
    const limited = await appCtx.fetch('/api/link-preview?url=https%3A%2F%2Fa.test%2F3');
    assert.equal(limited.status, 429);
  } finally {
    await appCtx.cleanup();
  }
});

test('GET /api/link-preview/favicon re-hosts icon bytes with nosniff', async () => {
  const { linkPreviewOptions, faviconCalls } = options();
  const appCtx = await makeTestApp({ linkPreviewOptions });
  try {
    const url = encodeURIComponent('https://example.com/favicon.ico');
    const res = await appCtx.fetch(`/api/link-preview/favicon?url=${url}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/x-icon');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Array.from(new Uint8Array(await res.arrayBuffer())), [0, 0, 1, 0]);
    assert.equal((await appCtx.fetch(`/api/link-preview/favicon?url=${url}`)).status, 200);
    assert.equal(faviconCalls.length, 1, 'repeat served from the favicon cache');
  } finally {
    await appCtx.cleanup();
  }
});

test('GET /api/link-preview/favicon 400s on bad input and 404s when unusable', async () => {
  const { linkPreviewOptions, faviconCalls } = options({
    fetchFaviconFn: async (url: string) => {
      faviconCalls.push(url);
      return null;
    },
  });
  const appCtx = await makeTestApp({ linkPreviewOptions });
  try {
    assert.equal((await appCtx.fetch('/api/link-preview/favicon')).status, 400);
    assert.equal(
      (await appCtx.fetch(`/api/link-preview/favicon?url=${encodeURIComponent('javascript:x')}`)).status,
      400,
    );
    assert.equal(
      (await appCtx.fetch(`/api/link-preview/favicon?url=${encodeURIComponent('https://x.test/f.ico')}`)).status,
      404,
    );
  } finally {
    await appCtx.cleanup();
  }
});
