/**
 * Mounts Gian Web's `LinkBehavior` (see links/link-behavior.ts) above a
 * transcript/markdown subtree. Replaces the former FileLinkHref /
 * FileLinkOpen / RelativeLinkOpen provider triple. Also mounts the
 * `LinkPreviewContext` so web links unfurl on hover; Remote Web mounts
 * neither and keeps plain anchors.
 */

import { useMemo } from 'react';
import { LinkBehaviorContext, LinkPreviewContext } from '@gian/chat-ui';
import { createWebLinkBehavior } from './link-behavior.js';
import { createLinkPreviewClient } from './link-preview-client.js';

export function LinkBehaviorProvider({
  openFileInSheet,
  openRelativeFileHref,
  openUrlInBrowser,
  children,
}: {
  openFileInSheet: (absPath: string, permanent: boolean, line?: number) => Promise<unknown> | void;
  openRelativeFileHref: (href: string) => void;
  openUrlInBrowser: (url: string) => boolean;
  children: React.ReactNode;
}) {
  const behavior = useMemo(
    () => createWebLinkBehavior({ openFileInSheet, openRelativeFileHref, openUrlInBrowser }),
    [openFileInSheet, openRelativeFileHref, openUrlInBrowser],
  );
  const preview = useMemo(() => createLinkPreviewClient(), []);
  return (
    <LinkBehaviorContext.Provider value={behavior}>
      <LinkPreviewContext.Provider value={preview}>{children}</LinkPreviewContext.Provider>
    </LinkBehaviorContext.Provider>
  );
}
