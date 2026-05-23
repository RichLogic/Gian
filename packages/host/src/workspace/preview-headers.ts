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
 * Resolve MIME from the extension and build the full security-header set.
 * Used by `/api/working_trees/:id/raw`.
 */
export function buildRawPreviewHeaders(input: RawPreviewHeaderInput): RawPreviewHeaders {
  const ext = input.rel.toLowerCase().split('.').pop() ?? '';
  const contentType = MIME[ext] ?? 'application/octet-stream';
  const filename = input.rel.split('/').pop()?.replace(/"/g, '') ?? 'file';
  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'Content-Length': String(input.size),
    'Content-Disposition': `inline; filename="${filename}"`,
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
