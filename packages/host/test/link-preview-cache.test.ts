// Link-preview caches: TTL/LRU behavior, cache-key normalization, and the
// per-session rate limiter. Pure unit tests with an injected clock.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  RateLimiter,
  TtlLruCache,
  normalizePreviewUrl,
} from '../src/web/link-preview/cache.js';

function clock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance(ms: number) { now += ms; },
  };
}

test('TTL: entries live until their deadline, then expire lazily', () => {
  const t = clock();
  const cache = new TtlLruCache<string>(10, t.now);
  cache.set('a', 'success', 60 * 60 * 1000); // 1h success
  cache.set('b', 'negative', 5 * 60 * 1000); // 5min negative
  assert.equal(cache.get('a'), 'success');
  t.advance(5 * 60 * 1000 + 1);
  assert.equal(cache.get('b'), undefined, 'negative entry expired after 5min');
  assert.equal(cache.get('a'), 'success', 'success entry still fresh');
  t.advance(60 * 60 * 1000);
  assert.equal(cache.get('a'), undefined, 'success entry expired after 1h');
});

test('LRU: eviction drops the least-recently-used entry past the bound', () => {
  const t = clock();
  const cache = new TtlLruCache<string>(2, t.now);
  cache.set('a', '1', 60_000);
  cache.set('b', '2', 60_000);
  cache.get('a'); // refresh recency: b is now oldest
  cache.set('c', '3', 60_000);
  assert.equal(cache.get('a'), '1');
  assert.equal(cache.get('b'), undefined, 'least-recently-used evicted');
  assert.equal(cache.get('c'), '3');
  assert.equal(cache.size, 2);
});

test('normalizePreviewUrl: lowercase host, strip default port + fragment', () => {
  assert.equal(
    normalizePreviewUrl('HTTP://EXAMPLE.COM:80/Path?q=1#frag'),
    'http://example.com/Path?q=1',
  );
  assert.equal(
    normalizePreviewUrl('https://EXAMPLE.com:443/x#y'),
    'https://example.com/x',
  );
  assert.equal(
    normalizePreviewUrl('https://example.com:8443/x'),
    'https://example.com:8443/x',
    'non-default ports survive',
  );
  assert.equal(normalizePreviewUrl('ftp://example.com/x'), null);
  assert.equal(normalizePreviewUrl('not a url'), null);
});

test('rate limiter: N fetches per window per session, then 429s', () => {
  const t = clock();
  const limiter = new RateLimiter(30, 60_000, t.now);
  for (let i = 0; i < 30; i += 1) {
    assert.equal(limiter.allow('session-a'), true, `fetch ${i + 1} allowed`);
  }
  assert.equal(limiter.allow('session-a'), false, '31st fetch in the window is denied');
  assert.equal(limiter.allow('session-b'), true, 'other sessions have their own bucket');
  t.advance(61_000);
  assert.equal(limiter.allow('session-a'), true, 'window slides');
});
