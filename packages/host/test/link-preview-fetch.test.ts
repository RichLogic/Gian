// Link-preview fetcher: the SSRF hardening matrix behind
// GET /api/link-preview (+ /favicon). All network and DNS are injected —
// these tests never touch a socket.
//
// Covers: scheme rejection, the private/loopback/link-local/CGNAT range
// matrix (IPv4 + IPv6 + embeddings), per-hop redirect re-validation,
// redirect/timeout/byte caps, text/html gating, og/title/favicon parsing
// with fallbacks, and the favicon mime allowlist + magic-byte sniffing.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  fetchFaviconAsset,
  fetchLinkMetadata,
  isBlockedIpAddress,
  parseHtmlMetadata,
  type LinkPreviewFetchDeps,
} from '../src/web/link-preview/fetch-metadata.js';

const PUBLIC = { address: '93.184.216.34', family: 4 };

type FetchCall = { url: string; init?: RequestInit };

function harness(options: {
  hosts?: Record<string, { address: string; family: number }[]>;
  responses?: Map<string, Response> | ((url: string, init?: RequestInit) => Promise<Response>);
} = {}) {
  const fetches: FetchCall[] = [];
  const lookups: string[] = [];
  const bodies = new Map<Response, Promise<ArrayBuffer | null>>();
  const lookupFn = async (hostname: string) => {
    lookups.push(hostname);
    return options.hosts?.[hostname] ?? [PUBLIC];
  };
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    fetches.push({ url: href, init });
    if (typeof options.responses === 'function') return options.responses(href, init);
    const response = options.responses?.get(href);
    if (!response) throw new Error(`unexpected fetch: ${href}`);
    // A clone tees the stream: cancelling it can wait forever for the unused
    // original. Each synthetic fetch needs an independent, cancellable body.
    if (!bodies.has(response)) bodies.set(response, response.body ? response.arrayBuffer() : Promise.resolve(null));
    const body = await bodies.get(response)!;
    return new Response(body?.slice(0) ?? null, {
      status: response.status, statusText: response.statusText, headers: response.headers,
    });
  }) as typeof fetch;
  const deps: LinkPreviewFetchDeps = { fetchFn, lookupFn };
  return { deps, fetches, lookups };
}

function htmlResponse(html: string, init: ResponseInit = {}): Response {
  return new Response(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', ...(init.headers ?? {}) },
    ...init,
  });
}

const OG_PAGE = `<!doctype html><html><head>
  <title>Fallback Title</title>
  <meta property="og:title" content="OG Title" />
  <meta property="og:description" content="OG description &amp; more" />
  <meta property="og:site_name" content="Example Site" />
  </head><body>content</body></html>`;

// ---------------------------------------------------------------------------
// Scheme + IP range rejection (SSRF matrix)
// ---------------------------------------------------------------------------

test('rejects non-http(s) schemes without any DNS or network work', async () => {
  const { deps, fetches, lookups } = harness();
  for (const url of ['ftp://example.com/x', 'file:///etc/passwd', 'javascript:alert(1)', 'gopher://x/']) {
    assert.equal(await fetchLinkMetadata(url, deps), null, url);
  }
  assert.deepEqual(fetches, []);
  assert.deepEqual(lookups, []);
});

test('rejects when DNS resolves to any private/loopback/link-local/CGNAT address', async () => {
  const blocked = [
    '10.0.0.1', '10.255.255.255',
    '172.16.0.1', '172.31.255.255',
    '192.168.1.1',
    '127.0.0.1', '127.1.2.3',
    '169.254.169.254', // cloud metadata
    '100.64.0.1', '100.127.255.254', // CGNAT
    '0.0.0.0',
    '224.0.0.1', '255.255.255.255',
    '::1', '::',
    'fc00::1', 'fd12:3456::1',
    'fe80::1',
    'ff02::1',
    '::ffff:127.0.0.1', '::ffff:10.1.2.3',
    '2002:0a00::1', // 6to4 embedding 10.0.0.0
  ];
  for (const address of blocked) {
    const { deps, fetches } = harness({
      hosts: { 'internal.test': [PUBLIC, { address, family: address.includes(':') ? 6 : 4 }] },
    });
    assert.equal(
      await fetchLinkMetadata('https://internal.test/page', deps),
      null,
      `must reject ${address} (even alongside a public address)`,
    );
    assert.deepEqual(fetches, [], `no fetch for ${address}`);
  }
});

test('rejects IP-literal hosts without touching DNS', async () => {
  const { deps, fetches, lookups } = harness();
  for (const url of [
    'http://127.0.0.1/',
    'http://[::1]/',
    'http://2130706433/', // 127.0.0.1 as a decimal DWORD
    'http://0x7f000001/', // 127.0.0.1 in hex
    'http://169.254.169.254/latest/meta-data',
  ]) {
    assert.equal(await fetchLinkMetadata(url, deps), null, url);
  }
  assert.deepEqual(fetches, []);
  assert.deepEqual(lookups, []);
});

test('isBlockedIpAddress unit matrix (allowed addresses stay fetchable)', () => {
  const allowed = [
    '8.8.8.8', '93.184.216.34', '172.15.0.1', '172.32.0.1',
    '100.63.255.255', '100.128.0.1', '11.0.0.1', '192.167.1.1', '192.169.0.1',
    '::ffff:8.8.8.8',
    '2001:4860:4860::8888', '2606:4700:4700::1111',
  ];
  for (const address of allowed) {
    assert.equal(isBlockedIpAddress(address), false, `${address} must be allowed`);
  }
  assert.equal(isBlockedIpAddress('not-an-ip'), true, 'garbage fails closed');
  assert.equal(isBlockedIpAddress(''), true, 'empty fails closed');
});

// ---------------------------------------------------------------------------
// Redirects: manual following, per-hop re-validation
// ---------------------------------------------------------------------------

function redirectTo(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

test('follows redirects (max 3 hops) and re-validates every hop', async () => {
  const responses = new Map<string, Response>([
    ['https://a.test/start', redirectTo('https://b.test/middle')],
    ['https://b.test/middle', redirectTo('https://c.test/final')],
    ['https://c.test/final', htmlResponse(OG_PAGE)],
  ]);
  const { deps, fetches, lookups } = harness({ responses });
  const metadata = await fetchLinkMetadata('https://a.test/start', deps);
  assert.ok(metadata);
  assert.equal(metadata.url, 'https://c.test/final');
  assert.equal(metadata.title, 'OG Title');
  assert.deepEqual(
    fetches.map(call => call.url),
    ['https://a.test/start', 'https://b.test/middle', 'https://c.test/final'],
  );
  assert.deepEqual(lookups, ['a.test', 'b.test', 'c.test'], 'every hop is DNS-revalidated');
});

test('resolves relative Location headers against the current URL', async () => {
  const responses = new Map<string, Response>([
    ['https://a.test/start', redirectTo('/moved?x=1')],
    ['https://a.test/moved?x=1', htmlResponse(OG_PAGE)],
  ]);
  const { deps } = harness({ responses });
  const metadata = await fetchLinkMetadata('https://a.test/start', deps);
  assert.equal(metadata?.url, 'https://a.test/moved?x=1');
});

test('rejects a redirect into a blocked address (metadata-IP bounce)', async () => {
  const responses = new Map<string, Response>([
    ['https://a.test/bounce', redirectTo('http://169.254.169.254/latest/meta-data')],
  ]);
  const { deps, fetches } = harness({ responses });
  assert.equal(await fetchLinkMetadata('https://a.test/bounce', deps), null);
  assert.deepEqual(fetches.map(call => call.url), ['https://a.test/bounce'],
    'the second hop is never fetched');
});

test('rejects a redirect to a non-http(s) scheme', async () => {
  const responses = new Map<string, Response>([
    ['https://a.test/bounce', redirectTo('file:///etc/passwd')],
  ]);
  const { deps, fetches } = harness({ responses });
  assert.equal(await fetchLinkMetadata('https://a.test/bounce', deps), null);
  assert.equal(fetches.length, 1);
});

test('gives up after 3 redirects', async () => {
  const { deps, fetches } = harness({
    responses: (url: string) => Promise.resolve(redirectTo(`${url}/next`)),
  });
  assert.equal(await fetchLinkMetadata('https://a.test/loop', deps), null);
  assert.equal(fetches.length, 4, 'initial + 3 followed redirects, then stop');
});

// ---------------------------------------------------------------------------
// Content gating: html only, streamed byte cap, total timeout, no cookies
// ---------------------------------------------------------------------------

test('rejects non-HTML content types', async () => {
  const responses = new Map<string, Response>([
    ['https://a.test/data', new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })],
  ]);
  const { deps } = harness({ responses });
  assert.equal(await fetchLinkMetadata('https://a.test/data', deps), null);
});

test('enforces the streamed byte cap', async () => {
  const big = `<html><head><title>x</title></head><body>${'a'.repeat(4096)}</body></html>`;
  const responses = new Map<string, Response>([['https://a.test/big', htmlResponse(big)]]);
  const { deps } = harness({ responses });
  assert.equal(await fetchLinkMetadata('https://a.test/big', { ...deps, maxBytes: 1024 }), null);
  assert.ok(await fetchLinkMetadata('https://a.test/big', { ...deps, maxBytes: 8192 }),
    'same page under the cap parses');
});

test('rejects early when content-length already exceeds the cap', async () => {
  const responses = new Map<string, Response>([
    ['https://a.test/big', htmlResponse('x', { headers: { 'content-length': '999999' } })],
  ]);
  const { deps } = harness({ responses });
  assert.equal(await fetchLinkMetadata('https://a.test/big', { ...deps, maxBytes: 1024 }), null);
});

test('honors the total timeout budget', async () => {
  const fetchFn = ((_: string | URL | Request, init?: RequestInit) => new Promise<Response>((_, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
  })) as typeof fetch;
  const { deps } = harness();
  const result = await fetchLinkMetadata('https://a.test/slow', {
    ...deps,
    fetchFn,
    timeoutMs: 20,
  });
  assert.equal(result, null);
});

test('sends the Gian-LinkPreview UA and no cookies', async () => {
  const responses = new Map<string, Response>([['https://a.test/', htmlResponse(OG_PAGE)]]);
  const { deps, fetches } = harness({ responses });
  await fetchLinkMetadata('https://a.test/', deps);
  const headers = new Headers(fetches[0]!.init?.headers);
  assert.equal(headers.get('user-agent'), 'Gian-LinkPreview');
  assert.equal(headers.get('cookie'), null, 'no cookies are sent');
  assert.equal(headers.get('authorization'), null);
});

// ---------------------------------------------------------------------------
// Metadata parsing
// ---------------------------------------------------------------------------

test('parses og tags, decodes entities, and defaults the favicon to the origin', async () => {
  const responses = new Map<string, Response>([['https://a.test/page', htmlResponse(OG_PAGE)]]);
  const { deps } = harness({ responses });
  const metadata = await fetchLinkMetadata('https://a.test/page', deps);
  assert.deepEqual(metadata, {
    url: 'https://a.test/page',
    title: 'OG Title',
    description: 'OG description & more',
    siteName: 'Example Site',
    faviconUrl: 'https://a.test/favicon.ico',
  });
});

test('falls back to the <title> tag when og:title is absent', () => {
  const parsed = parseHtmlMetadata(
    '<html><head><title>Plain &amp; Simple &#8212; v2</title></head></html>',
    new URL('https://a.test/x'),
  );
  assert.equal(parsed.title, 'Plain & Simple — v2');
  assert.equal(parsed.description, null);
  assert.equal(parsed.siteName, null);
});

test('handles reversed and single-quoted meta attributes', () => {
  const parsed = parseHtmlMetadata(
    `<html><head>
      <meta content="Reversed" property="og:title">
      <meta name='og:description' content='Single quoted'>
    </head></html>`,
    new URL('https://a.test/x'),
  );
  assert.equal(parsed.title, 'Reversed');
  assert.equal(parsed.description, 'Single quoted');
});

test('resolves the declared favicon against the page URL and prefers rel=icon', () => {
  const parsed = parseHtmlMetadata(
    `<html><head>
      <link rel="apple-touch-icon" href="/apple.png">
      <link rel="icon" href="icons/fav.png">
    </head></html>`,
    new URL('https://a.test/dir/page'),
  );
  assert.equal(parsed.faviconUrl, 'https://a.test/dir/icons/fav.png');
});

test('keeps the shortcut-icon fallback and rejects non-http favicons', () => {
  const shortcut = parseHtmlMetadata(
    '<html><head><link rel="shortcut icon" href="/s.ico"></head></html>',
    new URL('https://a.test/'),
  );
  assert.equal(shortcut.faviconUrl, 'https://a.test/s.ico');
  const data = parseHtmlMetadata(
    '<html><head><link rel="icon" href="data:image/png;base64,AAAA"></head></html>',
    new URL('https://a.test/'),
  );
  assert.equal(data.faviconUrl, 'https://a.test/favicon.ico',
    'data: favicons fall back to the origin default');
});

test('returns null when the page carries no usable metadata', async () => {
  const responses = new Map<string, Response>([
    ['https://a.test/empty', htmlResponse('<html><head></head><body>nothing</body></html>')],
  ]);
  const { deps } = harness({ responses });
  assert.equal(await fetchLinkMetadata('https://a.test/empty', deps), null);
});

// ---------------------------------------------------------------------------
// Favicon asset: mime allowlist, magic-byte sniffing, byte cap
// ---------------------------------------------------------------------------

const ICO_BYTES = new Uint8Array([0x00, 0x00, 0x01, 0x00, 0x10, 0x10]);

test('serves allowlisted image mimes', async () => {
  const responses = new Map<string, Response>([
    ['https://a.test/favicon.ico', new Response(ICO_BYTES, {
      status: 200,
      headers: { 'content-type': 'image/x-icon' },
    })],
  ]);
  const { deps } = harness({ responses });
  const favicon = await fetchFaviconAsset('https://a.test/favicon.ico', deps);
  assert.equal(favicon?.contentType, 'image/x-icon');
  assert.deepEqual(Array.from(favicon!.bytes), Array.from(ICO_BYTES));
});

test('sniffs magic bytes when the server mislabels or omits the type', async () => {
  for (const contentType of ['application/octet-stream', '']) {
    const responses = new Map<string, Response>([
      ['https://a.test/favicon.ico', new Response(ICO_BYTES, {
        status: 200,
        ...(contentType ? { headers: { 'content-type': contentType } } : {}),
      })],
    ]);
    const { deps } = harness({ responses });
    const favicon = await fetchFaviconAsset('https://a.test/favicon.ico', deps);
    assert.equal(favicon?.contentType, 'image/x-icon', contentType || '(no type)');
  }
});

test('rejects SVG and other non-allowlisted types even with image-ish bytes', async () => {
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const responses = new Map<string, Response>([
    ['https://a.test/favicon.svg', new Response(svg, {
      status: 200,
      headers: { 'content-type': 'image/svg+xml' },
    })],
  ]);
  const { deps } = harness({ responses });
  assert.equal(await fetchFaviconAsset('https://a.test/favicon.svg', deps), null);
});

test('rejects text/html served at a favicon URL', async () => {
  const responses = new Map<string, Response>([
    ['https://a.test/favicon.ico', htmlResponse('<html><head><title>not an icon</title></head></html>')],
  ]);
  const { deps } = harness({ responses });
  assert.equal(await fetchFaviconAsset('https://a.test/favicon.ico', deps), null);
});

test('enforces the favicon byte cap', async () => {
  const big = new Uint8Array(70 * 1024).fill(0x89);
  big.set([0x89, 0x50, 0x4e, 0x47], 0);
  const responses = new Map<string, Response>([
    ['https://a.test/big.png', new Response(big, {
      status: 200,
      headers: { 'content-type': 'image/png' },
    })],
  ]);
  const { deps } = harness({ responses });
  assert.equal(await fetchFaviconAsset('https://a.test/big.png', deps), null);
});

test('applies the same SSRF rules to favicon fetches', async () => {
  const { deps, fetches } = harness({
    hosts: { 'internal.test': [{ address: '192.168.0.1', family: 4 }] },
  });
  assert.equal(await fetchFaviconAsset('https://internal.test/favicon.ico', deps), null);
  assert.deepEqual(fetches, []);
});
