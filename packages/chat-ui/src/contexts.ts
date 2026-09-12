/**
 * Behavior-injection contexts for `@gian/chat-ui`. Every side effect a
 * presentational component can trigger arrives through one of these
 * app-provided callbacks (or an explicit prop); the package itself never
 * touches a router, store, file index, or OS-level opener.
 */

import { createContext } from 'react';
import type { MessageAttachment } from '@gian/shared';
import type { DiffItem } from './types.js';

/** Routes ordinary web links (http/https) — e.g. to an in-app browser
 *  surface. Null: links open in a new tab via the plain anchor. */
export const BrowserLinkOpenContext = createContext<
  ((url: string) => void) | null
>(null);

/** Detail requests a chat-ui component can ask the host app to open in its
 *  own detail surface (Gian Web: panel 2). The app may widen this union with
 *  its own kinds; chat-ui only ever emits these. */
export type ChatUiPanelRequest =
  | { kind: 'agent'; id: string }
  | {
      kind: 'transcript-detail';
      title: string;
      text: string;
      sourceId?: string;
    }
  | {
      /** The turn's live process-event feed; `anchorId` is a transcript item
       *  identity (`transcriptItemIdentity`) to expand/scroll to/flash. */
      kind: 'event-feed';
      turn: number;
      anchorId?: string;
    };

/** Opens detail that belongs to the chat. Null: rows that would route to the
 *  detail surface fall back to in-place expansion (or stay inert). */
export const ChatPanelOpenContext = createContext<
  ((request: ChatUiPanelRequest) => void) | null
>(null);

/**
 * File-link clicks. The host app decides what "open" means (an in-app preview
 * surface, typically). The package never constructs an absolute-path or
 * editor-scheme opener itself: when null, a file link renders inert — clicks
 * are prevented so the SPA never navigates to a synthesized URL.
 */
export const FileLinkOpenContext = createContext<
  ((path: string, line?: number) => void) | null
>(null);

/**
 * Optional href factory for file links (right-click → Copy Link Address,
 * status-bar preview). The host app owns any scheme it emits (Gian Web maps
 * to its editor scheme); the package itself never synthesizes one.
 */
export const FileLinkHrefContext = createContext<
  ((path: string, line?: number) => string) | null
>(null);

/** Opens an image in the host app's lightbox. Null: thumbnails keep their
 *  plain `href` (new tab) behavior. */
export const ImageZoomContext = createContext<
  ((src: string, alt?: string) => void) | null
>(null);

/** Opens a message attachment through an app-owned secure transport. Null
 * keeps the ordinary URL/image rendering used by local Gian Web. */
export const MessageAttachmentOpenContext = createContext<
  ((attachment: MessageAttachment) => void) | null
>(null);

/** Pushes a DiffItem into the host app's detail surface when the diff is too
 *  large for inline expansion. Null: the row stays inert. */
export const DiffOpenContext = createContext<((item: DiffItem) => void) | null>(null);

/** Opens a Schedule detail from a scheduled-message provenance tag. */
export const ScheduleOpenContext = createContext<((scheduleId: string) => void) | null>(null);

/** Compatibility path for transcript plan entries that open the chat-owned
 *  panel. */
export interface PlanOpenPayload {
  /** Stable id used as the detail tab key. */
  id: string;
  title: string;
  markdown: string;
}
export const PlanOpenContext = createContext<
  ((payload: PlanOpenPayload) => void) | null
>(null);

/**
 * Click-time fallback for relative-path markdown links that the render-time
 * linkify pass did NOT resolve. Null: clicks are swallowed so the SPA never
 * navigates to a junk relative URL.
 */
export const RelativeLinkOpenContext = createContext<
  ((href: string) => void) | null
>(null);

/**
 * An app-supplied rehype plugin (typically bound to a file index) that
 * linkifies file references in transcript markdown. Null: markdown renders
 * with no file linkification.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const FileRefRehypeContext = createContext<null | (() => (tree: any) => void)>(null);
