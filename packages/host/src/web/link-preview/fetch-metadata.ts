/**
 * SSRF-hardened metadata fetcher for the link-preview (unfurl) routes.
 *
 * Threat model: transcripts are model- and user-controlled, so any URL
 * rendered as a link can end up here. Every hop is validated before the
 * network is touched:
 * - http/https only, parsed via `new URL` (which also normalizes decimal /
 *   hex / octal IPv4 literals, so `http://2130706433/` is seen as 127.0.0.1);
 * - the hostname is DNS-resolved and EVERY resolved address is rejected when
 *   it is loopback, RFC1918, link-local, CGNAT, unspecified, multicast,
 *   reserved, or the IPv6 equivalents (ULA/link-local/loopback/unspecified,
 *   including IPv4-mapped and 6to4 embeddings);
 * - redirects are followed manually (max 3 hops) and each hop's target is
 *   re-parsed, re-scheme-checked and re-resolved — a public page can never
 *   bounce the Host into `169.254.169.254`;
 * - ~5s total budget across all hops, ~512KB streamed body cap, `text/html`
 *   only, no cookies or ambient auth, UA `Gian-LinkPreview`.
 *
 * The page is treated as inert text: only og:title / og:description /
 * og:site_name / <title> / favicon <link> are extracted (regex over the
 * <head>), nothing is ever executed. No new dependencies on purpose.
 *
 * Residual risk, accepted by design: the validation lookup and the actual
 * connection resolve the hostname independently (classic DNS-rebinding
 * TOCTOU). Pinning the connection to the validated address would need a
 * custom undici dispatcher, which is not in the Host dependency tree.
 */

import { promises as dns } from 'node:dns';

export const LINK_PREVIEW_USER_AGENT = 'Gian-LinkPreview';
export const LINK_PREVIEW_TIMEOUT_MS = 5000;
export const LINK_PREVIEW_MAX_HTML_BYTES = 512 * 1024;
export const LINK_PREVIEW_MAX_FAVICON_BYTES = 64 * 1024;
export const LINK_PREVIEW_MAX_REDIRECTS = 3;

export interface LinkPreviewMetadata {
  /** Final URL after redirects. */
  url: string;
  title: string | null;
  description: string | null;
  siteName: string | null;
  /** Absolute favicon URL (page-declared, else the origin default). */
  faviconUrl: string | null;
}

export interface LinkPreviewFavicon {
  bytes: Uint8Array;
  contentType: string;
}

export interface LinkPreviewFetchDeps {
  /** Test seam; production uses the global fetch. */
  fetchFn?: typeof fetch;
  /** Test seam; production uses dns.promises.lookup({ all: true }). */
  lookupFn?: (hostname: string) => Promise<{ address: string; family: number }[]>;
  timeoutMs?: number;
  maxRedirects?: number;
  maxBytes?: number;
  now?: () => number;
}

// ---------------------------------------------------------------------------
// IP range rejection
// ---------------------------------------------------------------------------

/** True when the address must never be fetched: loopback, RFC1918,
 *  link-local, CGNAT, unspecified, multicast, reserved — IPv4 and IPv6
 *  (ULA fc00::/7, link-local fe80::/10, deprecated site-local fec0::/10,
 *  IPv4-mapped ::ffff:0:0/96 and 6to4 2002::/16 embeddings included). */
export function isBlockedIpAddress(raw: string): boolean {
  const address = raw.trim().toLowerCase().replace(/^\[|\]$/g, '').split('%')[0]!;
  if (address.includes(':')) {
    // IPv4 tail in dotted form (e.g. ::ffff:127.0.0.1) — convert to hextets.
    const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(address)?.[1];
    let normalized = address;
    if (dotted) {
      const parts = dotted.split('.').map(Number);
      if (parts.some(part => Number.isNaN(part) || part > 255)) return true;
      const hi = ((parts[0]! << 8) | parts[1]!).toString(16);
      const lo = ((parts[2]! << 8) | parts[3]!).toString(16);
      normalized = `${address.slice(0, address.length - dotted.length)}${hi}:${lo}`;
    }
    const hextets = expandIpv6(normalized);
    if (!hextets) return true; // unparseable: fail closed
    const [h0, h1, h2, h3, h4, h5, h6, h7] = hextets as [
      number, number, number, number, number, number, number, number,
    ];
    const allZero = hextets.every(h => h === 0);
    if (allZero) return true; // :: unspecified
    if (h7 === 1 && hextets.slice(0, 7).every(h => h === 0)) return true; // ::1 loopback
    if ((h0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
    if ((h0 & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
    if ((h0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((h0 & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local (deprecated)
    if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0xffff) {
      return isBlockedIpv4((h6 >> 8) & 0xff, h6 & 0xff, (h7 >> 8) & 0xff, h7 & 0xff);
    }
    if (h0 === 0x2002) {
      // 6to4 embeds the relay's IPv4 in hextets 1-2; a private embedding is
      // just an RFC1918 address wearing an IPv6 coat.
      return isBlockedIpv4((h1 >> 8) & 0xff, h1 & 0xff, (h2 >> 8) & 0xff, h2 & 0xff);
    }
    return false;
  }
  const octets = address.split('.').map(part => Number(part));
  if (octets.length !== 4 || octets.some(part => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true; // neither IPv4 nor IPv6: fail closed
  }
  return isBlockedIpv4(octets[0]!, octets[1]!, octets[2]!, octets[3]!);
}

function isBlockedIpv4(a: number, b: number, _c: number, _d: number): boolean {
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a >= 224) return true; // multicast 224.0.0.0/4 + reserved 240.0.0.0/4
  return false;
}

function expandIpv6(address: string): number[] | null {
  if (!/^[0-9a-f:]+$/.test(address)) return null;
  const doubleColon = address.indexOf('::');
  let head: string[];
  let tail: string[];
  if (doubleColon === -1) {
    head = address.split(':');
    tail = [];
  } else {
    if (address.indexOf('::', doubleColon + 1) !== -1) return null;
    head = address.slice(0, doubleColon).split(':').filter(Boolean);
    tail = address.slice(doubleColon + 2).split(':').filter(Boolean);
  }
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (doubleColon === -1 && missing !== 0)) return null;
  const parts = [...head, ...Array<string>(missing).fill('0'), ...tail];
  if (parts.length !== 8) return null;
  const hextets = parts.map(part => parseInt(part, 16));
  if (hextets.some(h => Number.isNaN(h) || h > 0xffff)) return null;
  return hextets;
}

// ---------------------------------------------------------------------------
// Validated fetch (scheme + DNS + per-hop redirect re-validation)
// ---------------------------------------------------------------------------

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

interface ValidatedResponse {
  /** The final, validated URL the response came from. */
  url: URL;
  response: Response;
}

async function validateUrl(
  raw: string,
  lookupFn: NonNullable<LinkPreviewFetchDeps['lookupFn']>,
): Promise<URL | null> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (/^[\d.:a-f]+$/i.test(hostname) && (hostname.includes(':') || /^\d+\.\d+\.\d+\.\d+$/.test(hostname))) {
    // IP literal: no DNS needed, check it directly.
    return isBlockedIpAddress(hostname) ? null : url;
  }
  let addresses: { address: string; family: number }[];
  try {
    addresses = await lookupFn(hostname);
  } catch {
    return null;
  }
  if (addresses.length === 0) return null;
  for (const { address } of addresses) {
    if (isBlockedIpAddress(address)) return null;
  }
  return url;
}

/** Fetch `raw` following redirects manually; every hop (initial URL and
 *  each Location target) is re-parsed, scheme-checked and DNS-revalidated.
 *  Returns null on any rejection, timeout, or network error. */
async function fetchValidated(
  raw: string,
  deps: LinkPreviewFetchDeps,
  accept: string,
): Promise<ValidatedResponse | null> {
  const fetchFn = deps.fetchFn ?? fetch;
  const lookupFn = deps.lookupFn
    ?? (async (hostname: string) => dns.lookup(hostname, { all: true, verbatim: true }));
  const timeoutMs = deps.timeoutMs ?? LINK_PREVIEW_TIMEOUT_MS;
  const maxRedirects = deps.maxRedirects ?? LINK_PREVIEW_MAX_REDIRECTS;
  const now = deps.now ?? (() => Date.now());
  const deadline = now() + timeoutMs;

  let current = raw;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const url = await validateUrl(current, lookupFn);
    if (!url) return null;
    const remaining = deadline - now();
    if (remaining <= 0) return null;
    let response: Response;
    try {
      response = await fetchFn(url.href, {
        redirect: 'manual',
        signal: AbortSignal.timeout(remaining),
        // No cookies, no ambient auth — this is an anonymous fetch of a
        // model-influenced URL.
        headers: {
          'user-agent': LINK_PREVIEW_USER_AGENT,
          accept,
        },
      });
    } catch {
      return null;
    }
    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get('location');
      void response.body?.cancel().catch(() => undefined);
      if (!location) return null;
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        return null;
      }
      current = next.href;
      continue;
    }
    return { url, response };
  }
  return null; // redirect chain longer than maxRedirects
}

/** Stream the body with a hard byte cap; returns null when exceeded. */
async function readBodyBounded(response: Response, maxBytes: number): Promise<Uint8Array | null> {
  const declared = Number(response.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    void response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

// ---------------------------------------------------------------------------
// Page metadata
// ---------------------------------------------------------------------------

/** Fetch and parse a page's unfurl metadata. Null on any failure — callers
 *  treat every rejection (SSRF block, timeout, non-HTML, empty metadata)
 *  identically: no preview. */
export async function fetchLinkMetadata(
  raw: string,
  deps: LinkPreviewFetchDeps = {},
): Promise<LinkPreviewMetadata | null> {
  const fetched = await fetchValidated(raw, deps, 'text/html,application/xhtml+xml');
  if (!fetched) return null;
  if (fetched.response.status >= 400) {
    void fetched.response.body?.cancel().catch(() => undefined);
    return null;
  }
  const contentType = (fetched.response.headers.get('content-type') ?? '').toLowerCase();
  if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
    void fetched.response.body?.cancel().catch(() => undefined);
    return null;
  }
  const body = await readBodyBounded(
    fetched.response,
    deps.maxBytes ?? LINK_PREVIEW_MAX_HTML_BYTES,
  );
  if (!body) return null;
  const html = new TextDecoder('utf-8').decode(body);
  const parsed = parseHtmlMetadata(html, fetched.url);
  if (!parsed.title && !parsed.description && !parsed.siteName) return null;
  return { url: fetched.url.href, ...parsed };
}

/** Extract og:title / og:description / og:site_name, the <title> fallback
 *  and the favicon <link> from inert HTML text. Regex over the <head> by
 *  design: no parser dependency, nothing executed. */
export function parseHtmlMetadata(
  html: string,
  finalUrl: URL,
): { title: string | null; description: string | null; siteName: string | null; faviconUrl: string | null } {
  const headEnd = html.search(/<\/head\s*>/i);
  const head = headEnd === -1 ? html : html.slice(0, headEnd);

  const meta = new Map<string, string>();
  for (const match of head.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    const key = attr(tag, 'property')?.toLowerCase() ?? attr(tag, 'name')?.toLowerCase();
    const content = attr(tag, 'content');
    if (!key || content === null || meta.has(key)) continue;
    meta.set(key, decodeEntities(content));
  }

  const titleTag = /<title[^>]*>([\s\S]*?)<\/title\s*>/i.exec(head)?.[1];

  let favicon: string | null = null;
  let faviconFallback: string | null = null;
  for (const match of head.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    const rel = attr(tag, 'rel')?.toLowerCase();
    const href = attr(tag, 'href');
    if (!rel || !href || !rel.split(/\s+/).includes('icon')) continue;
    const resolved = resolveHref(href, finalUrl);
    if (!resolved) continue;
    if (rel === 'icon') {
      favicon = resolved;
      break;
    }
    faviconFallback ??= resolved;
  }

  return {
    title: clean(meta.get('og:title') ?? (titleTag ? decodeEntities(titleTag) : null)),
    description: clean(meta.get('og:description') ?? null),
    siteName: clean(meta.get('og:site_name') ?? null),
    faviconUrl: favicon ?? faviconFallback ?? `${finalUrl.origin}/favicon.ico`,
  };
}

function attr(tag: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3] ?? '';
}

function resolveHref(href: string, base: URL): string | null {
  try {
    const url = new URL(href, base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.href;
  } catch {
    return null;
  }
}

function clean(value: string | null | undefined): string | null {
  const collapsed = value?.replace(/\s+/g, ' ').trim();
  return collapsed ? collapsed : null;
}

function decodeEntities(text: string): string {
  return text.replace(
    /&(#x?[0-9a-f]+|amp|lt|gt|quot|apos|nbsp);/gi,
    (raw, entity: string) => {
      const lower = entity.toLowerCase();
      if (lower.startsWith('#x')) return codePoint(parseInt(lower.slice(2), 16), raw);
      if (lower.startsWith('#')) return codePoint(parseInt(lower.slice(1), 10), raw);
      switch (lower) {
        case 'amp': return '&';
        case 'lt': return '<';
        case 'gt': return '>';
        case 'quot': return '"';
        case 'apos': return '\'';
        case 'nbsp': return ' ';
        default: return raw;
      }
    },
  );
}

function codePoint(value: number, fallback: string): string {
  if (!Number.isInteger(value) || value < 0 || value > 0x10ffff) return fallback;
  try {
    return String.fromCodePoint(value);
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Favicon asset (re-hosted; the client never hot-links third-party icons)
// ---------------------------------------------------------------------------

const FAVICON_MIME_ALLOWLIST = new Set([
  'image/x-icon',
  'image/vnd.microsoft.icon',
  'image/png',
  'image/gif',
  'image/jpeg',
  'image/webp',
  'image/avif',
  // SVG is deliberately absent: it can carry script, and the bytes are
  // served back from the Host origin.
]);

/** Fetch a favicon through the same SSRF gauntlet as page metadata, with an
 *  image-mime allowlist and a 64KB streamed cap. Null on any failure. */
export async function fetchFaviconAsset(
  raw: string,
  deps: LinkPreviewFetchDeps = {},
): Promise<LinkPreviewFavicon | null> {
  const fetched = await fetchValidated(raw, deps, 'image/*,*/*;q=0.8');
  if (!fetched) return null;
  if (fetched.response.status >= 400) {
    void fetched.response.body?.cancel().catch(() => undefined);
    return null;
  }
  const body = await readBodyBounded(
    fetched.response,
    deps.maxBytes ?? LINK_PREVIEW_MAX_FAVICON_BYTES,
  );
  if (!body || body.byteLength === 0) return null;
  const declared = (fetched.response.headers.get('content-type') ?? '')
    .split(';')[0]!.trim().toLowerCase();
  if (FAVICON_MIME_ALLOWLIST.has(declared)) return { bytes: body, contentType: declared };
  // Servers routinely mislabel .ico as application/octet-stream (or omit the
  // type); fall back to magic bytes, still inside the allowlist.
  const sniffed = sniffImageMime(body);
  if (sniffed) return { bytes: body, contentType: sniffed };
  return null;
}

function sniffImageMime(bytes: Uint8Array): string | null {
  const has = (offset: number, ...values: number[]) =>
    values.every((value, index) => bytes[offset + index] === value);
  if (has(0, 0x00, 0x00, 0x01, 0x00)) return 'image/x-icon';
  if (has(0, 0x89, 0x50, 0x4e, 0x47)) return 'image/png';
  if (has(0, 0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (has(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (has(0, 0x52, 0x49, 0x46, 0x46) && has(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  return null;
}
