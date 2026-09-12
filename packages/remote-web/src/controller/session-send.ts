import type { RemoteSession } from '@gian/remote-protocol';
import type { DraftState } from './types.js';

export function sessionSendParams(
  sessionId: string,
  draft: DraftState,
  session?: RemoteSession,
): {
  session_id: string;
  text: string;
  busy?: 'queue';
  items?: Array<{ type: 'text'; text: string } | { type: 'attachment'; attachment_id: string }>;
  context_items?: Array<{ type: 'pasted_text'; text: string } | { type: 'file_ref'; handle_id: string }>;
  composer_document?: { type: 'document'; nodes: Array<{ type: 'text'; text: string } | { type: 'reference'; handle_id: string }> };
} {
  const items = [
    ...(draft.text.trim() ? [{ type: 'text' as const, text: draft.text }] : []),
    ...draft.attachments.map((attachment) => ({
      type: 'attachment' as const,
      attachment_id: attachment.id,
    })),
  ];
  const contextItems = draft.contextItems.map((item) => (
    item.kind === 'file_ref'
      ? { type: 'file_ref' as const, handle_id: item.id }
      : { type: 'pasted_text' as const, text: item.label || item.id }
  ));
  const document = draft.document
    ? {
      type: 'document' as const,
      nodes: [
        ...(draft.text.trim() ? [{ type: 'text' as const, text: draft.text }] : []),
        { type: 'reference' as const, handle_id: draft.document.id },
      ],
    }
    : undefined;
  return {
    session_id: sessionId,
    text: draft.text,
    ...(session?.active_turn ? { busy: 'queue' as const } : {}),
    ...(items.length ? { items } : {}),
    ...(contextItems.length ? { context_items: contextItems } : {}),
    ...(document ? { composer_document: document } : {}),
  };
}
