// Raw-preview MIME + security header builder, extracted from
// `web/app.ts`'s `/api/working_trees/:id/raw` route. Kept as a pure
// function so it can be exercised directly by SEC-009 / FILE-003 tests
// without spinning up Hono. Behavior is preserved verbatim — every header
// in the route is now driven by this helper.

const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  txt: 'text/plain; charset=utf-8',
  json: 'application/json',
  css: 'text/css; charset=utf-8',
  js: 'application/javascript',
};

/** 20 MiB cap on the raw preview endpoint — anything larger gets 413. */
export const RAW_PREVIEW_MAX_BYTES = 20 * 1024 * 1024;

/** Strict CSP for HTML previews. Forbids framing, plugins, base/form
 *  redirection, and same-origin network calls. Inline styles + scripts are
 *  allowed so static-rendered HTML still works, but `script-src` and
 *  `connect-src` deliberately exclude `'self'` — workspace HTML is served
 *  on the host's own origin, so allowing `'self'` would let a malicious
 *  preview fetch the Gian host API (SEC pivot).
 */
const HTML_CSP =
  "default-src 'none'; " +
  "img-src 'self' data: blob:; " +
  "style-src 'unsafe-inline'; " +
  "script-src 'unsafe-inline'; " +
  "font-src 'self' data:; " +
  "connect-src 'none'; " +
  "media-src 'self' data: blob:; " +
  "object-src 'none'; " +
  "frame-src 'none'; " +
  "child-src 'none'; " +
  "frame-ancestors 'none'; " +
  "base-uri 'none'; " +
  "form-action 'none'";

/** Stricter CSP for SVG: no scripts at all. SVG can carry JS in
 *  `<script>` tags, so `script-src 'none'` is non-negotiable. */
const SVG_CSP =
  "default-src 'none'; " +
  "img-src 'self' data: blob:; " +
  "style-src 'unsafe-inline'; " +
  "script-src 'none'; " +
  "object-src 'none'; " +
  "frame-ancestors 'none'; " +
  "base-uri 'none'; " +
  "form-action 'none'";

export interface RawPreviewHeaderInput {
  /** Relative path of the file (or just its name). Only the extension and
   *  basename are read — no FS lookup. */
  rel: string;
  /** Size in bytes (from `stat`). Used for `Content-Length`. */
  size: number;
}

export interface RawPreviewHeaders {
  contentType: string;
  headers: Record<string, string>;
}

/**
 * Build an RFC 6266-compliant `Content-Disposition` value for a basename.
 *
 * HTTP header values must be ISO-8859-1 (Latin-1). A filename containing
 * non-ASCII characters — e.g. a CJK name like `方案二.html` — cannot appear
 * verbatim: Node's HTTP writer throws `ERR_INVALID_CHAR` from
 * `ServerResponse.writeHead`, and because that fires inside the
 * `@hono/node-server` adapter *after* the route returns its `Response`, the
 * route's own try/catch never sees it — the whole response aborts mid-write
 * (the browser just sees a failed/empty load). So we ALWAYS emit an
 * ASCII-safe `filename="..."` token, and when the real name has any non-ASCII
 * char we additionally advertise it via the RFC 5987 `filename*=UTF-8''...`
 * form (percent-encoded, hence pure ASCII) for modern browsers.
 */
function contentDisposition(name: string): string {
  // ASCII fallback: strip quotes/backslash (no breaking out of the quoted
  // value — header-injection guard, preserved from the original behavior) and
  // replace any non-printable-ASCII byte with `_` so the token stays Latin-1.
  const ascii = name.replace(/["\\]/g, '').replace(/[^\x20-\x7e]/g, '_');
  let value = `inline; filename="${ascii}"`;
  if (/[^\x00-\x7f]/.test(name)) {
    value += `; filename*=UTF-8''${encodeRfc5987(name)}`;
  }
  return value;
}

/** Percent-encode a string for the RFC 5987 `ext-value` grammar (attr-char).
 *  `encodeURIComponent` covers most of it but leaves `! ' ( ) *` unescaped,
 *  none of which are attr-chars, so encode those too. */
function encodeRfc5987(str: string): string {
  return encodeURIComponent(str).replace(
    /['()*!]/g,
    c => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

/**
 * Resolve MIME from the extension and build the full security-header set.
 * Used by `/api/working_trees/:id/raw`.
 */
export function buildRawPreviewHeaders(input: RawPreviewHeaderInput): RawPreviewHeaders {
  const ext = input.rel.toLowerCase().split('.').pop() ?? '';
  const contentType = MIME[ext] ?? 'application/octet-stream';
  const basename = input.rel.split('/').pop() ?? 'file';
  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'Content-Length': String(input.size),
    'Content-Disposition': contentDisposition(basename),
    'Cache-Control': 'private, max-age=60',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  };
  if (contentType.includes('html')) {
    headers['Content-Security-Policy'] = HTML_CSP;
  } else if (contentType === 'image/svg+xml') {
    headers['Content-Security-Policy'] = SVG_CSP;
  }
  return { contentType, headers };
}

/** True if `size` is over the configured cap. The route uses this to
 *  return 413 before reading the file. */
export function rawPreviewOversize(size: number): boolean {
  return size > RAW_PREVIEW_MAX_BYTES;
}

/** Exposed for tests so the CSP literals stay in sync. */
export const RAW_PREVIEW_CSP = {
  html: HTML_CSP,
  svg: SVG_CSP,
};
