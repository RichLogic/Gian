/**
 * Per-target inline icons shown before link text inside `LinkAnchor`.
 *
 * Web links resolve in order: the real site favicon once a hover preview has
 * already fetched one (favicon-store — rendering never fetches), a hand-rolled
 * brand glyph for known developer sites (WEB_BRAND_ICONS below), or the
 * generic globe. Brand colors must read on BOTH light and dark themes: marks
 * that are black/white by brand (GitHub, X, MDN, localhost) use
 * `currentColor` and follow the theme; fixed hues are mid-tone enough to
 * survive both backgrounds.
 *
 * File links get a colored extension square (FILE_EXTENSION_ICONS) readable
 * at 12px; unknown extensions keep the plain document glyph. Fragment links
 * carry no icon: they are in-page jumps and an extra glyph would only add
 * noise to heading prose.
 */

import { useMemo } from 'react';
import type { LinkKind } from './classify.js';
import { useLinkFavicon } from './favicon-store.js';

export function LinkKindIcon({
  kind,
  href,
  fileAbs,
}: {
  kind: LinkKind;
  /** Link target — picks the web brand/favicon (kind `web`) or the file
   *  extension glyph (kind `relative`, which has no fileAbs). */
  href?: string | undefined;
  /** Resolved absolute path for kind `file`; its extension drives the icon. */
  fileAbs?: string | null | undefined;
}) {
  switch (kind) {
    case 'web':
      return <WebLinkIcon href={href ?? ''} />;
    case 'file':
    case 'relative':
      return <FileLinkIcon path={fileAbs ?? href ?? ''} />;
    case 'editor':
      // Code brackets.
      return (
        <IconSvg kind={kind}>
          <path d="M6 4.5 2.5 8 6 11.5" />
          <path d="M10 4.5 13.5 8 10 11.5" />
        </IconSvg>
      );
    case 'external-scheme':
      // Envelope (mailto: et al).
      return (
        <IconSvg kind={kind}>
          <rect x="1.75" y="3.75" width="12.5" height="8.5" rx="1" />
          <path d="m2.5 4.75 5.5 4 5.5-4" />
        </IconSvg>
      );
    default:
      return null;
  }
}

// ── Web links ───────────────────────────────────────────────────────────────

function WebLinkIcon({ href }: { href: string }) {
  const favicon = useLinkFavicon(href);
  const host = useMemo(() => hostnameOf(href), [href]);
  if (favicon) {
    return (
      <img
        className="link-kind-icon link-favicon-icon"
        data-link-icon="web-favicon"
        src={favicon}
        alt=""
      />
    );
  }
  const brand = host ? webBrandFor(host) : null;
  if (brand) {
    return (
      <svg
        className="link-kind-icon"
        data-link-icon={`web-${brand.id}`}
        viewBox="0 0 16 16"
        aria-hidden="true"
      >
        {brand.glyph}
      </svg>
    );
  }
  // Globe fallback: circle + meridian ellipse + equator.
  return (
    <IconSvg kind="web">
      <circle cx="8" cy="8" r="6.25" />
      <ellipse cx="8" cy="8" rx="2.75" ry="6.25" />
      <path d="M1.75 8h12.5" />
    </IconSvg>
  );
}

function hostnameOf(href: string): string | null {
  try {
    return new URL(href).hostname.toLowerCase();
  } catch {
    return null;
  }
}

interface WebBrand {
  id: string;
  hosts: string[];
  glyph: React.ReactNode;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function webBrandFor(host: string): WebBrand | null {
  if (LOCAL_HOSTS.has(host) || host.endsWith('.localhost')) return LOCAL_BRAND;
  for (const brand of WEB_BRAND_ICONS) {
    if (brand.hosts.some(domain => host === domain || host.endsWith(`.${domain}`))) return brand;
  }
  return null;
}

const LOCAL_BRAND: WebBrand = {
  id: 'local',
  hosts: [...LOCAL_HOSTS],
  // Monitor + stand: the link points at a server on this machine.
  glyph: (
    <g fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
      <rect x="2" y="3" width="12" height="8" rx="1.2" />
      <path d="M6 13.5h4M8 11v2.5" />
    </g>
  ),
};

/** Domain → brand glyph. Matching also covers subdomains (`a.github.com`). */
const WEB_BRAND_ICONS: WebBrand[] = [
  {
    id: 'github',
    hosts: ['github.com', 'github.dev', 'github.io'],
    // Octocat mark, simplified; currentColor so it reads on dark themes.
    glyph: (
      <path
        fill="currentColor"
        d="M8 .8a7.2 7.2 0 0 0-2.28 14.03c.36.07.5-.16.5-.35v-1.23c-2.02.44-2.44-.97-2.44-.97-.33-.83-.8-1.05-.8-1.05-.65-.45.05-.44.05-.44.72.05 1.1.74 1.1.74.64 1.1 1.68.79 2.09.6.07-.47.25-.79.46-.97-1.61-.18-3.3-.8-3.3-3.59 0-.79.28-1.44.74-1.95-.08-.18-.32-.92.07-1.92 0 0 .6-.2 1.98.74a6.9 6.9 0 0 1 3.6 0c1.37-.94 1.98-.74 1.98-.74.39 1 .15 1.74.07 1.92.46.51.74 1.16.74 1.95 0 2.79-1.7 3.4-3.32 3.58.26.22.48.66.48 1.34v1.98c0 .2.13.42.5.35A7.2 7.2 0 0 0 8 .8z"
      />
    ),
  },
  {
    id: 'gitlab',
    hosts: ['gitlab.com'],
    // Tanuki head, simplified to its downward-fox silhouette.
    glyph: (
      <path
        fill="#e24329"
        d="M8 13.8 3.1 6.2l1.1-3.4a.38.38 0 0 1 .72 0L6.3 6h3.4l1.38-3.2a.38.38 0 0 1 .72 0l1.1 3.4z"
      />
    ),
  },
  {
    id: 'npm',
    hosts: ['npmjs.com'],
    // Letters punched out of the red block (holes show the page background
    // on any theme).
    glyph: (
      <path
        fill="#cb3837"
        fillRule="evenodd"
        d="M2 3.5h12v9H8.5v1.75H6.25V12.5H2zM4.75 5.5v5h1.5V7h1v3.5h1.5V7h1v3.5h1.5v-5z"
      />
    ),
  },
  {
    id: 'stackoverflow',
    hosts: ['stackoverflow.com'],
    // Tray in the theme foreground; the rising stack lines stay brand orange.
    glyph: (
      <>
        <path fill="currentColor" d="M3.5 9.5v4h9v-4H14v5.5H2V9.5z" />
        <path
          fill="#f48024"
          d="M5 11.4h6v1.3H5zM5.3 9.1l6 .9-.2 1.3-6-.9zM5.9 6.8l5.8 1.8-.4 1.3-5.8-1.8zM7 4.6l5.2 3-.6 1.2-5.3-3zM9.2 2.2l4.1 4.3-1 1L8.2 3.1z"
        />
      </>
    ),
  },
  {
    id: 'mdn',
    hosts: ['developer.mozilla.org'],
    // Bold M wordmark initial; currentColor (the brand mark is monochrome).
    glyph: (
      <path
        fill="currentColor"
        d="M2 12.8V3.2h2.4L8 8.6l3.6-5.4H14v9.6h-2.1V6.9L8 12l-3.9-5.1v5.9z"
      />
    ),
  },
  {
    id: 'arxiv',
    hosts: ['arxiv.org'],
    // Stylized X from the arXiv wordmark.
    glyph: (
      <path
        fill="#b31b1b"
        d="M3 3.2h2l3 3.9 3-3.9h2L9.2 8l3.8 4.8h-2L8 9.1l-3 3.7H3L6.8 8z"
      />
    ),
  },
  {
    id: 'x',
    hosts: ['x.com', 'twitter.com'],
    // X logo; currentColor (the brand mark is pure black/white).
    glyph: (
      <path
        fill="currentColor"
        d="M9.5 6.8 14.9.8h-1.4L8.8 6 4.9.8H1.2l5.6 8.1-5.6 6.3h1.4l5-5.8 4 5.8h3.7zM8 8.1l-.6-.9L2.3 1.9h2.1l4.1 5.8.6.9 5.1 7.3h-2.1z"
      />
    ),
  },
  {
    id: 'figma',
    hosts: ['figma.com'],
    // The five-shape Figma mark in its brand colors.
    glyph: (
      <>
        <path fill="#f24e1e" d="M5.2 1.8h3.1v4.3H5.2a2.15 2.15 0 1 1 0-4.3z" />
        <path fill="#ff7262" d="M8.3 1.8h2.5a2.15 2.15 0 1 1 0 4.3H8.3z" />
        <path fill="#a259ff" d="M5.2 6.1h3.1v4.3H5.2a2.15 2.15 0 1 1 0-4.3z" />
        <circle cx="10.45" cy="8.25" r="2.15" fill="#1abcfe" />
        <path fill="#0acf83" d="M5.2 10.4h3.1v2.15a2.15 2.15 0 1 1-3.1-2.15z" />
      </>
    ),
  },
  {
    id: 'gdocs',
    hosts: ['docs.google.com'],
    // Blue page with a folded corner and white text lines.
    glyph: (
      <>
        <path fill="#4285f4" d="M4 1.6h5l3 3v9.8H4z" />
        <path fill="#aecbfa" d="M9 1.6l3 3H9z" />
        <path fill="#fff" d="M5.5 7.8h5v1h-5zM5.5 9.8h5v1h-5zM5.5 11.8h3.5v1H5.5z" />
      </>
    ),
  },
];

// ── File links ──────────────────────────────────────────────────────────────

interface FileExtensionIcon {
  id: string;
  /** 1-2 letter label drawn on the square. */
  label: string;
  bg: string;
  fg: string;
}

/** Extension → colored letter square (Codex/IDE style). Colors are mid-tone
 *  brand hues with white (or, for JS yellow, near-black) lettering so the
 *  square reads on both light and dark themes. */
const FILE_EXTENSION_ICONS: Record<string, FileExtensionIcon> = {
  ts: { id: 'ts', label: 'TS', bg: '#3178c6', fg: '#ffffff' },
  tsx: { id: 'ts', label: 'TS', bg: '#3178c6', fg: '#ffffff' },
  js: { id: 'js', label: 'JS', bg: '#f0db4f', fg: '#323330' },
  jsx: { id: 'js', label: 'JS', bg: '#f0db4f', fg: '#323330' },
  mjs: { id: 'js', label: 'JS', bg: '#f0db4f', fg: '#323330' },
  cjs: { id: 'js', label: 'JS', bg: '#f0db4f', fg: '#323330' },
  json: { id: 'json', label: '{}', bg: '#64748b', fg: '#ffffff' },
  md: { id: 'md', label: 'MD', bg: '#519aba', fg: '#ffffff' },
  css: { id: 'css', label: '#', bg: '#a074c4', fg: '#ffffff' },
  py: { id: 'py', label: 'Py', bg: '#3776ab', fg: '#ffffff' },
  rs: { id: 'rs', label: 'Rs', bg: '#b45309', fg: '#ffffff' },
  go: { id: 'go', label: 'Go', bg: '#00add8', fg: '#ffffff' },
  html: { id: 'html', label: '<>', bg: '#e34c26', fg: '#ffffff' },
  htm: { id: 'html', label: '<>', bg: '#e34c26', fg: '#ffffff' },
  vue: { id: 'vue', label: 'V', bg: '#41b883', fg: '#ffffff' },
  yaml: { id: 'yaml', label: 'Y', bg: '#cb171e', fg: '#ffffff' },
  yml: { id: 'yaml', label: 'Y', bg: '#cb171e', fg: '#ffffff' },
  toml: { id: 'toml', label: 'T', bg: '#9c4221', fg: '#ffffff' },
};

function FileLinkIcon({ path }: { path: string }) {
  const icon = FILE_EXTENSION_ICONS[extensionOf(path) ?? ''];
  if (!icon) {
    // Document with a folded corner.
    return (
      <IconSvg kind="file">
        <path d="M4 1.75h5l3 3v9.5H4z" />
        <path d="M9 1.75v3h3" />
      </IconSvg>
    );
  }
  return (
    <svg
      className="link-kind-icon"
      data-link-icon={`file-${icon.id}`}
      viewBox="0 0 16 16"
      aria-hidden="true"
    >
      <rect x="0.75" y="0.75" width="14.5" height="14.5" rx="3" fill={icon.bg} />
      <text
        x="8"
        y="11.4"
        textAnchor="middle"
        fontFamily="var(--font-mono, monospace)"
        fontSize={icon.label.length > 1 ? 7 : 9}
        fontWeight={700}
        fill={icon.fg}
      >
        {icon.label}
      </text>
    </svg>
  );
}

/** Lowercased extension of the last path segment; null for dotfiles and
 *  extension-less names (Makefile, LICENSE, …). */
function extensionOf(path: string): string | null {
  const base = path.split('/').pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return null;
  return base.slice(dot + 1).toLowerCase();
}

// ── Shared ──────────────────────────────────────────────────────────────────

function IconSvg({ kind, children }: { kind: LinkKind; children: React.ReactNode }) {
  return (
    <svg
      className="link-kind-icon"
      data-link-icon={kind}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}
