import { createContext } from 'react';

export type ChatPanelRequest =
  | { kind: 'plan'; id: string }
  | { kind: 'agent'; id: string };

export type ChatPanelTarget = ChatPanelRequest & { sessionId: string };

/** Opens detail that belongs to the chat, rather than to a workbench rail. */
export const ChatPanelOpenContext = createContext<
  ((request: ChatPanelRequest) => void) | null
>(null);

/** Routes ordinary web links to the Browser rail. */
export const BrowserLinkOpenContext = createContext<
  ((url: string) => void) | null
>(null);
