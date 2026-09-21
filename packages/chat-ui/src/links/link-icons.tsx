/**
 * Per-kind inline icons shown before link text inside `LinkAnchor`. Tiny
 * hand-rolled stroke SVGs (currentColor, toned down via CSS opacity) — no
 * icon library. Fragment links carry no icon: they are in-page jumps and an
 * extra glyph would only add noise to heading prose.
 */

import type { LinkKind } from './classify.js';

export function LinkKindIcon({ kind }: { kind: LinkKind }) {
  switch (kind) {
    case 'web':
      // Globe: circle + meridian ellipse + equator.
      return (
        <IconSvg kind={kind}>
          <circle cx="8" cy="8" r="6.25" />
          <ellipse cx="8" cy="8" rx="2.75" ry="6.25" />
          <path d="M1.75 8h12.5" />
        </IconSvg>
      );
    case 'file':
    case 'relative':
      // Document with a folded corner.
      return (
        <IconSvg kind={kind}>
          <path d="M4 1.75h5l3 3v9.5H4z" />
          <path d="M9 1.75v3h3" />
        </IconSvg>
      );
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
