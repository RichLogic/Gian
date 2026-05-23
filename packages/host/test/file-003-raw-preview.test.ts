// Coverage for traceability rows:
//   FILE-003 — Raw preview must set MIME, inline Content-Disposition,
//              `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
//              `Cache-Control: private`, `Referrer-Policy: no-referrer`,
//              and a 20 MiB size cap (413 on overflow).
//   SEC-009 — Raw preview HTML/SVG must carry a strict CSP sandbox so a
//              user-authored asset cannot pivot into the host origin.
//
// Pure-function unit on `workspace/preview-headers.ts`. The route in
// `web/app.ts` is now a thin wrapper around `buildRawPreviewHeaders` +
// `rawPreviewOversize`; behavior of the route's headers is therefore
// directly observable here.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  buildRawPreviewHeaders,
  rawPreviewOversize,
  RAW_PREVIEW_MAX_BYTES,
  RAW_PREVIEW_CSP,
} from '../src/workspace/preview-headers.js';

const SAFETY_HEADERS_BY_NAME = [
  'Content-Type',
  'Content-Length',
  'Content-Disposition',
  'Cache-Control',
  'Referrer-Policy',
  'X-Content-Type-Options',
  'X-Frame-Options',
];

// ---------------------------------------------------------------------------
// FILE-003 — baseline header contract
// ---------------------------------------------------------------------------

test('FILE-003: every raw preview response carries the seven mandatory safety headers', () => {
  const { headers } = buildRawPreviewHeaders({ rel: 'docs/readme.txt', size: 17 });
  for (const name of SAFETY_HEADERS_BY_NAME) {
    assert.ok(headers[name], `header ${name} must be set on every preview response`);
  }
  // Concrete safety values (exact strings — these are part of the contract).
  assert.equal(headers['Cache-Control'], 'private, max-age=60');
  assert.equal(headers['Referrer-Policy'], 'no-referrer');
  assert.equal(headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(headers['X-Frame-Options'], 'DENY');
});

test('FILE-003: Content-Length echoes the supplied size and never duplicates Content-Type', () => {
  const { headers } = buildRawPreviewHeaders({ rel: 'a.txt', size: 1234 });
  assert.equal(headers['Content-Length'], '1234',
    'Content-Length must match the stat-reported size so the browser shows accurate progress');
  // Hono/Node header objects are case-insensitive in transit, but our helper
  // returns a plain Record. Make sure we don't accidentally emit both casings.
  assert.equal(Object.keys(headers).filter((k) => k.toLowerCase() === 'content-type').length, 1);
});

test('FILE-003: inline Content-Disposition uses basename and strips embedded quotes', () => {
  // Path-quote injection: a user-supplied filename with `"` in it could break
  // out of the filename="..." quoting. We assert the helper strips quotes.
  const { headers } = buildRawPreviewHeaders({ rel: 'subdir/wei"rd.txt', size: 1 });
  assert.equal(headers['Content-Disposition'], 'inline; filename="weird.txt"',
    'quotes in the filename must be stripped to prevent breaking out of the disposition value');
});

test('FILE-003: Content-Disposition is always `inline` (never `attachment`)', () => {
  // `attachment` would force a download instead of in-browser preview, which
  // is exactly the opposite of what the Files-tab "Open in new tab" needs.
  const { headers } = buildRawPreviewHeaders({ rel: 'a.png', size: 1 });
  assert.match(headers['Content-Disposition']!, /^inline;/);
});

// ---------------------------------------------------------------------------
// FILE-003 — MIME mapping
// ---------------------------------------------------------------------------

test('FILE-003: MIME mapping covers all documented previewable extensions', () => {
  const cases: Array<[string, string]> = [
    ['a.html',  'text/html; charset=utf-8'],
    ['a.htm',   'text/html; charset=utf-8'],
    ['a.pdf',   'application/pdf'],
    ['a.png',   'image/png'],
    ['a.jpg',   'image/jpeg'],
    ['a.jpeg',  'image/jpeg'],
    ['a.gif',   'image/gif'],
    ['a.webp',  'image/webp'],
    ['a.svg',   'image/svg+xml'],
    ['a.txt',   'text/plain; charset=utf-8'],
    ['a.json',  'application/json'],
    ['a.css',   'text/css; charset=utf-8'],
    ['a.js',    'application/javascript'],
  ];
  for (const [rel, expectedType] of cases) {
    const { contentType } = buildRawPreviewHeaders({ rel, size: 1 });
    assert.equal(contentType, expectedType, `${rel} must map to ${expectedType}`);
  }
});

test('FILE-003: unknown extensions fall back to application/octet-stream', () => {
  const { contentType } = buildRawPreviewHeaders({ rel: 'a.exotic', size: 1 });
  assert.equal(contentType, 'application/octet-stream',
    'unknown extension must NOT inherit a sibling MIME — that would let attackers smuggle scripts as `.foo`');
});

test('FILE-003: extension matching is case-insensitive', () => {
  // Browsers normalize via lowercase, and so do most filesystems; assert
  // the helper matches that convention so `IMG.PNG` doesn't become octet-stream.
  const { contentType } = buildRawPreviewHeaders({ rel: 'IMG.PNG', size: 1 });
  assert.equal(contentType, 'image/png');
});

test('FILE-003: extensionless files fall back to application/octet-stream', () => {
  const { contentType } = buildRawPreviewHeaders({ rel: 'README', size: 1 });
  assert.equal(contentType, 'application/octet-stream');
});

// ---------------------------------------------------------------------------
// FILE-003 — 20 MiB cap
// ---------------------------------------------------------------------------

test('FILE-003: rawPreviewOversize matches the documented 20 MiB threshold', () => {
  assert.equal(RAW_PREVIEW_MAX_BYTES, 20 * 1024 * 1024,
    'the cap is a public contract — changing it requires updating FILE-003 row + Files-view client expectations');
  assert.equal(rawPreviewOversize(RAW_PREVIEW_MAX_BYTES), false,
    'exactly-at-cap must pass (the check is strict-greater-than)');
  assert.equal(rawPreviewOversize(RAW_PREVIEW_MAX_BYTES + 1), true,
    'one byte over the cap must be rejected');
  assert.equal(rawPreviewOversize(0), false, 'zero-byte files must pass');
});

// ---------------------------------------------------------------------------
// SEC-009 — strict CSP for active-content types
// ---------------------------------------------------------------------------

test('SEC-009: HTML preview carries a CSP that forbids framing, plugins, base, and form posts', () => {
  const { headers } = buildRawPreviewHeaders({ rel: 'preview.html', size: 1 });
  const csp = headers['Content-Security-Policy'];
  assert.ok(csp, 'HTML preview MUST carry a CSP header');
  assert.equal(csp, RAW_PREVIEW_CSP.html,
    'HTML CSP literal must match the documented sandbox; any change is a security-review surface');
  // Spot-check the critical directives so a refactor that drops one fails loudly.
  for (const needle of [
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ]) {
    assert.ok(csp!.includes(needle), `HTML CSP must contain "${needle}"`);
  }
});

test('SEC-009: SVG preview CSP is strictly tighter than HTML — no scripts allowed at all', () => {
  const { headers } = buildRawPreviewHeaders({ rel: 'icon.svg', size: 1 });
  const csp = headers['Content-Security-Policy'];
  assert.ok(csp, 'SVG preview MUST carry a CSP header (SVG can embed <script>)');
  assert.equal(csp, RAW_PREVIEW_CSP.svg);
  assert.ok(csp!.includes("script-src 'none'"),
    'SVG CSP MUST set script-src to none — SVG <script> tags are an injection vector');
  assert.ok(csp!.includes("frame-ancestors 'none'"));
  assert.ok(csp!.includes("default-src 'none'"),
    'SVG CSP starts from deny-all; only img-src + style-src open up');
});

test('SEC-009: non-active content types do NOT carry a CSP header (no CSP needed for PNG/PDF)', () => {
  // CSP only applies to active content. Adding it to PNG/PDF is harmless
  // but the intent is documented: the helper only sets it for html/svg.
  for (const rel of ['photo.png', 'doc.pdf', 'data.json', 'doc.txt', 'styles.css', 'app.js']) {
    const { headers } = buildRawPreviewHeaders({ rel, size: 1 });
    assert.equal(headers['Content-Security-Policy'], undefined,
      `${rel} must NOT add a CSP — it can't execute active content`);
  }
});

test('SEC-009: every active-content CSP includes frame-ancestors none (defense-in-depth with X-Frame-Options)', () => {
  // X-Frame-Options is the legacy mechanism, CSP frame-ancestors is the
  // modern one. Both should be present so a malicious preview can't be
  // framed by any other origin even if one mechanism is bypassed.
  for (const rel of ['preview.html', 'icon.svg']) {
    const { headers } = buildRawPreviewHeaders({ rel, size: 1 });
    assert.equal(headers['X-Frame-Options'], 'DENY');
    assert.ok(headers['Content-Security-Policy']!.includes("frame-ancestors 'none'"),
      `${rel} must double up X-Frame-Options:DENY with frame-ancestors 'none'`);
  }
});

test('SEC-009: HTML CSP allows inline styles+scripts (required for static HTML preview) but blocks all network egress and same-origin pivots', () => {
  const { headers } = buildRawPreviewHeaders({ rel: 'a.html', size: 1 });
  const csp = headers['Content-Security-Policy']!;
  // Inline allowed (the HTML files Gian previews are static, often dev artifacts).
  assert.ok(csp.includes("script-src 'unsafe-inline'"));
  assert.ok(csp.includes("style-src 'unsafe-inline'"));
  // Critical: `'self'` must NOT appear in script-src / connect-src. The raw
  // preview is served from the host's own origin, so allowing `'self'` would
  // let a malicious preview fetch the Gian host API (cross-feature pivot).
  assert.ok(!csp.includes("script-src 'self'"),
    "script-src MUST NOT include 'self' — the host origin serves the Gian API");
  assert.ok(csp.includes("connect-src 'none'"),
    'fetch/xhr/websocket must be fully denied — `self` would expose the host API');
  assert.ok(csp.includes("form-action 'none'"),
    'form submissions blocked — a preview must not be able to drive POST/GET to anywhere');
});
