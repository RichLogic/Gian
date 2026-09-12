import type { Context } from 'react';
import {
  BrowserLinkOpenContext as ChatUiBrowserLinkOpenContext,
  ChatPanelOpenContext as ChatUiChatPanelOpenContext,
  type ChatUiPanelRequest,
} from '@gian/chat-ui';
import type { TraceItem } from '../trace/types.js';

/**
 * Panel-2 requests. The chat-ui kinds (agent / transcript-detail /
 * event-feed) come from `@gian/chat-ui`; the web app widens the union with
 * its own plan / trace-item / sidechat kinds. The CONTEXT OBJECT is shared
 * with chat-ui (single identity) so components from either side see the same
 * provider — only the type is widened here.
 */
export type ChatPanelRequest =
  | ChatUiPanelRequest
  | { kind: 'plan'; id: string }
  | { kind: 'trace-item'; item: TraceItem }
  | {
      /** The Side Chat surface (gian.proxy/2.0 proposal §10.5): renders the
       *  active parent session's Side Chats as panel 2 via ChatContextPanel.
       *  `sessionId` on the target is the PARENT session id. */
      kind: 'sidechat';
    };

export type ChatPanelTarget = ChatPanelRequest & { sessionId: string };

/** Opens detail that belongs to the chat, rather than to a workbench rail. */
export const ChatPanelOpenContext = ChatUiChatPanelOpenContext as unknown as Context<
  ((request: ChatPanelRequest) => void) | null
>;

/** Routes ordinary web links to the Browser rail. */
export const BrowserLinkOpenContext = ChatUiBrowserLinkOpenContext;
