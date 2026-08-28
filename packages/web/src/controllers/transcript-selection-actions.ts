import type { OperationDispatcher } from '../operations/dispatcher.js';
import type { OperationRun } from '../operations/types.js';
import type { ChatPanelRequest } from '../presentation/chat-panel.js';
import {
  discardComposerDraft,
  injectComposerContextItems,
} from '../components/Composer.js';
import {
  createSelectedTextContextItem,
  mintSelectionSideChatId,
  type TranscriptTextSelection,
} from '../transcript/selection-context.js';

export function addTranscriptSelectionToDraft(
  sessionId: string,
  selection: TranscriptTextSelection,
): boolean {
  const item = createSelectedTextContextItem(selection);
  return item ? injectComposerContextItems(sessionId, [item]) : false;
}

export function startTranscriptSelectionSideChat(input: {
  parentSessionId: string;
  selection: TranscriptTextSelection;
  dispatch: OperationDispatcher['dispatch'];
  openChatPanel: (request: ChatPanelRequest) => void;
  sidechatId?: string;
}): { run: OperationRun; sidechatId: string } | null {
  const item = createSelectedTextContextItem(input.selection);
  if (!item) return null;
  const sidechatId = input.sidechatId ?? mintSelectionSideChatId();
  if (!injectComposerContextItems(sidechatId, [item])) return null;
  try {
    const run = input.dispatch('sidechat.create', {
      parentSessionId: input.parentSessionId,
      sidechatId,
    });
    input.openChatPanel({ kind: 'sidechat' });
    return { run, sidechatId };
  } catch (error) {
    discardComposerDraft(sidechatId);
    throw error;
  }
}
