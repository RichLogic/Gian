/**
 * Behavior + policy injection for links. One context replaces the former
 * `BrowserLinkOpenContext` / `RelativeLinkOpenContext` / `FileLinkOpenContext`
 * / `FileLinkHrefContext` stack: the host app describes everything it can do
 * with a link as a single `LinkBehavior` record. Every member is nullable —
 * a missing capability renders an inert span with a tooltip (never a dead
 * `<a>`, never a silently swallowed click), except `openWebUrl`, whose
 * fallback is the plain `target="_blank"` anchor (Desktop routes that to the
 * system browser).
 */

import { createContext, useContext } from 'react';
import { transcriptPolicy, type LinkPolicy } from './policy.js';

export interface LinkBehavior {
  /** Routes http/https links to a host-owned surface (e.g. an in-app
   *  browser). Null/undefined: plain `_blank` anchor. */
  openWebUrl?: ((url: string) => void) | null;
  /** Opens an absolute file path (the host decides what "open" means —
   *  typically an in-app preview). Null/undefined: file links render inert. */
  openFile?: ((path: string, line?: number) => void) | null;
  /** Optional href factory for file links (right-click → Copy Link Address,
   *  status-bar preview). The host owns any scheme it emits. */
  fileHref?: ((path: string, line?: number) => string) | null;
  /** Click-time fallback for relative-path links the render-time linkify
   *  pass did not resolve. Null/undefined: relative links render inert so
   *  the SPA never navigates to a junk relative URL. */
  openRelative?: ((href: string) => void) | null;
}

export const LinkBehaviorContext = createContext<LinkBehavior | null>(null);

export function useLinkBehavior(): LinkBehavior | null {
  return useContext(LinkBehaviorContext);
}

/** What the surface allows, defaulting to the transcript policy. Catalog and
 *  other restricted surfaces wrap their subtree in this provider. */
export const LinkPolicyContext = createContext<LinkPolicy>(transcriptPolicy);

export function useLinkPolicy(): LinkPolicy {
  return useContext(LinkPolicyContext);
}
