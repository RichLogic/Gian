/**
 * Mounts Gian Web's `LinkBehavior` (see links/link-behavior.ts) above a
 * transcript/markdown subtree. Replaces the former FileLinkHref /
 * FileLinkOpen / RelativeLinkOpen provider triple.
 */

import { useMemo } from 'react';
import { LinkBehaviorContext } from '@gian/chat-ui';
import { createWebLinkBehavior } from './link-behavior.js';

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
  return <LinkBehaviorContext.Provider value={behavior}>{children}</LinkBehaviorContext.Provider>;
}
