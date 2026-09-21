/**
 * Link classification — the single place where href scheme sniffing lives.
 * Every anchor rendered by `@gian/chat-ui` goes through `classifyLink` first;
 * components never match URL schemes with their own regexes.
 */

export type LinkKind =
  | 'web'
  | 'file'
  | 'relative'
  | 'editor'
  | 'external-scheme'
  | 'fragment'
  | 'unsafe';

export interface LinkTarget {
  kind: LinkKind;
  /** The original href (trimmed). Empty string when there was none. */
  href: string;
  /** Absolute file path recovered by the render-time file-linkify pass
   *  (`data-file-abs`). Only set for kind `file`. */
  fileAbs: string | null;
  /** 1-based line recovered alongside `fileAbs`, when present. */
  fileLine?: number | undefined;
}

/** Schemes that open in an external editor/IDE by convention. */
const EDITOR_SCHEMES = new Set([
  'vscode',
  'vscode-insiders',
  'cursor',
  'zed',
  'sublime',
  'atom',
]);

/** Schemes that must never render as a navigable anchor. `file:` is here
 *  deliberately: the package never synthesizes absolute-path navigation, and
 *  browsers refuse file: from http(s) pages anyway. */
const UNSAFE_SCHEMES = new Set(['javascript', 'data', 'vbscript', 'file']);

const SCHEME_RE = /^([a-z][a-z0-9+.-]*):/i;

/**
 * Classify an href into a routing decision input.
 *
 * - `extra.fileAbs` (a render-time-resolved absolute path) always wins →
 *   kind `file`, regardless of the href text.
 * - `#…` → `fragment`; no scheme → `relative` (the host may re-resolve it
 *   against its file index at click time).
 * - `http(s)` → `web`; known editor schemes → `editor`; any other parseable
 *   scheme (`mailto:`, `tel:`, …) → `external-scheme`.
 * - `javascript:`/`data:`/`vbscript:`/`file:`, empty hrefs, and scheme'd
 *   URLs the URL parser rejects → `unsafe` (never an `<a>`).
 */
export function classifyLink(
  href: string | null | undefined,
  extra?: { fileAbs?: string | null; fileLine?: number },
): LinkTarget {
  const fileAbs = extra?.fileAbs ?? null;
  if (fileAbs) {
    return { kind: 'file', href: href ?? fileAbs, fileAbs, fileLine: extra?.fileLine };
  }
  const raw = (href ?? '').trim();
  if (!raw) return { kind: 'unsafe', href: '', fileAbs: null };
  if (raw.startsWith('#')) return { kind: 'fragment', href: raw, fileAbs: null };
  const scheme = SCHEME_RE.exec(raw)?.[1]?.toLowerCase() ?? null;
  if (!scheme) return { kind: 'relative', href: raw, fileAbs: null };
  if (scheme === 'http' || scheme === 'https') {
    return parseable(raw) ? { kind: 'web', href: raw, fileAbs: null } : unsafe(raw);
  }
  if (UNSAFE_SCHEMES.has(scheme)) return unsafe(raw);
  if (EDITOR_SCHEMES.has(scheme)) return { kind: 'editor', href: raw, fileAbs: null };
  return parseable(raw) ? { kind: 'external-scheme', href: raw, fileAbs: null } : unsafe(raw);
}

function parseable(href: string): boolean {
  try {
    new URL(href);
    return true;
  } catch {
    return false;
  }
}

function unsafe(href: string): LinkTarget {
  return { kind: 'unsafe', href, fileAbs: null };
}
