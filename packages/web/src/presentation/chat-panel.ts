import { createContext } from 'react';
import type { TraceItem } from '../trace/types.js';

export type ChatPanelRequest =
  | { kind: 'plan'; id: string }
  | { kind: 'agent'; id: string }
  | { kind: 'trace-item'; item: TraceItem }
  | {
      kind: 'transcript-detail';
      title: string;
      text: string;
      sourceId?: string;
    }
  | {
      /** The Side Chat surface (gian.proxy/2.0 proposal §10.5): renders the
       *  active parent session's Side Chats as panel 2 via ChatContextPanel.
       *  `sessionId` on the target is the PARENT session id. */
      kind: 'sidechat';
    };

export type ChatPanelTarget = ChatPanelRequest & { sessionId: string };

/** Opens detail that belongs to the chat, rather than to a workbench rail. */
export const ChatPanelOpenContext = createContext<
  ((request: ChatPanelRequest) => void) | null
>(null);

/** Routes ordinary web links to the Browser rail. */
export const BrowserLinkOpenContext = createContext<
  ((url: string) => void) | null
>(null);
