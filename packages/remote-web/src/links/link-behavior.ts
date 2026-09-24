/**
 * Remote Web's `LinkBehavior`. Remote can open files (through the encrypted
 * file transport) but has no in-app browser, no relative-link file index,
 * and no editor-scheme href factory — those members stay null and the
 * shared `LinkAnchor` degrades them visibly: web links keep the plain
 * `_blank` anchor (Remote Web runs in a real browser tab), relative links
 * render as inert spans with a tooltip instead of swallowing the click.
 */

import type { LinkBehavior } from '@gian/chat-ui';

export function createRemoteLinkBehavior(deps: {
  openFile: (path: string) => void;
}): LinkBehavior {
  return {
    openWebUrl: null,
    openFile: deps.openFile,
    fileHref: null,
    openRelative: href => deps.openFile(href),
  };
}
