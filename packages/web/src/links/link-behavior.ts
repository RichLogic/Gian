/**
 * Gian Web's `LinkBehavior` — the single record describing what this app can
 * do with a link. Web links open in the in-app Browser under the desktop
 * shell and fall back to `_blank` on plain browser-hosted web, file links
 * open in the Sheet, and unresolved relative markdown links re-resolve
 * against the working tree at click time.
 */

import type { LinkBehavior } from '@gian/chat-ui';

/** Right-click/status-bar href for transcript file links (the local desktop
 *  shell maps them to the editor scheme; clicks themselves route through
 *  `openFile` into the in-app Sheet). encodeURI keeps `/` and `:` intact;
 *  covers spaces and unicode in paths. */
export function fileLinkHref(absPath: string, line?: number): string {
  const encoded = encodeURI(absPath);
  return line ? `vscode://file/${encoded}:${line}` : `vscode://file/${encoded}`;
}

export function createWebLinkBehavior(deps: {
  openFileInSheet: (absPath: string, permanent: boolean, line?: number) => Promise<unknown> | void;
  openRelativeFileHref: (href: string) => void;
  /** Routes an http(s) URL into the desktop shell's in-app Browser. Returns
   *  false when no desktop Browser bridge is available, in which case the
   *  caller falls back to a plain `_blank` window. */
  openUrlInBrowser: (url: string) => boolean;
}): LinkBehavior {
  return {
    openWebUrl: (url) => {
      // LinkAnchor only routes classified http/https links here, but guard
      // anyway: malformed or non-web URLs must never reach the native
      // Browser or a junk window.open.
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return;
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
      // Canonical form so the Browser tab's recorded URL matches what the
      // native side reports back (dedupe for repeat clicks).
      const href = parsed.href;
      if (deps.openUrlInBrowser(href)) return;
      window.open(href, '_blank', 'noopener,noreferrer');
    },
    openFile: (path, line) => {
      void deps.openFileInSheet(path, false, line);
    },
    fileHref: fileLinkHref,
    openRelative: deps.openRelativeFileHref,
  };
}
