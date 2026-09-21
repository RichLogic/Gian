/**
 * Link display policies — what a surface ALLOWS, independent of what the
 * host can DO (that is `LinkBehavior`). `LinkAnchor` combines both:
 * policy first, behavior second.
 */

import type { LinkKind, LinkTarget } from './classify.js';

/** `anchor`: render a navigable/routable link. `inert`: render as a
 *  non-interactive span with an explanatory tooltip. `text`: render the
 *  link text as plain text (no link affordance at all). */
export type LinkDisplay = 'anchor' | 'inert' | 'text';

export interface LinkPolicy {
  display(target: LinkTarget): LinkDisplay;
  /** Whether this surface linkifies this kind at all (used by plain-text
   *  linkification to decide whether a detected URL becomes a link). */
  allowScheme(kind: LinkKind): boolean;
}

/** Transcript prose: everything classifiable renders as a link; `unsafe`
 *  never does (LinkAnchor enforces that regardless of policy). */
export const transcriptPolicy: LinkPolicy = {
  display: target => (target.kind === 'unsafe' ? 'text' : 'anchor'),
  allowScheme: kind => kind !== 'unsafe',
};

/** Catalog documents: `https:` links only. Plain `http:` and every other
 *  scheme or relative href degrade to plain text (the Catalog contract only
 *  permits https; the client stays fail-closed). */
export const strictHttpsPolicy: LinkPolicy = {
  display: target =>
    target.kind === 'web' && /^https:\/\//i.test(target.href) ? 'anchor' : 'text',
  allowScheme: kind => kind === 'web',
};

/** No links at all — every target renders as plain text. */
export const plainTextPolicy: LinkPolicy = {
  display: () => 'text',
  allowScheme: () => false,
};
