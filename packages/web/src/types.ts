/**
 * Web transcript types. The presentation DTOs are owned by `@gian/chat-ui`
 * (single source of truth — the shared renderer consumes them); this module
 * re-exports them and adds the web-only operation-layer fields on MsgItem
 * (send echo lifecycle: run id, canonical replacement, retry payload).
 */

import type {
  AgentSpawnItem,
  ApprovalItem,
  AutoNoticeItem,
  CommandItem,
  CompactionItem,
  DiffItem,
  FileReadItem,
  FileSearchItem,
  MsgItem as ChatMsgItem,
  ReasoningItem,
  StatusItem,
  ToolItem,
  WebSearchItem,
} from '@gian/chat-ui';

export type {
  AgentSpawnItem,
  ApprovalActionContext,
  ApprovalItem,
  AutoNoticeItem,
  CommandItem,
  CompactionItem,
  DiffFile,
  DiffItem,
  FileReadItem,
  FileSearchItem,
  ReasoningItem,
  StatusItem,
  ToolItem,
  WebSearchItem,
} from '@gian/chat-ui';

/**
 * Everything needed to (re)dispatch a message send through the operation
 * layer — stored on the optimistic echo (`MsgItem.sendRetry`) so a failed
 * send's retry affordance re-dispatches the SAME operation (proposal §9).
 */
export interface MessageSendPayload {
  sessionId: string;
  text: string;
  exec: import('@gian/shared').Executor;
  oneShotBypass?: boolean;
  /** Uploaded attachments for this turn; `previewUrl` (blob) is reused by the
   *  retry echo's thumbnails — it is only revoked on canonical reconcile. */
  attachments?: Array<import('./attachments.js').ComposerAttachmentPayload & { previewUrl: string }>;
  contextItems?: import('@gian/shared').MessageContextItem[];
  composerDocument?: import('@gian/shared').ComposerDocument;
  /** Atomic Side Chat next-turn draft; omitted for ordinary Sessions. */
  turnConfig?: Record<string, import('@gian/shared').ConfigValue>;
  /** Skill invocation: `text` is `/<name>` and the wire items carry the
   *  typed skill item instead of a text item. */
  skill?: { name: string; path: string };
}

export interface MsgItem extends ChatMsgItem {
  kind: 'user' | 'assistant';
  /** Operation run id of the send that produced this echo — the bubble
   *  derives the unknown-outcome ("may not have been sent") state from the
   *  run's `timed-out` phase in the operation store. */
  sendRunId?: string;
  /** The canonical `user_message` has replaced this echo, but its correlated
   *  operation result is still outstanding. Excludes the item from the FIFO
   *  matcher when another compatible canonical message arrives. */
  sendCanonical?: boolean;
  /** Re-dispatch payload for the failed echo's retry affordance. */
  sendRetry?: MessageSendPayload;
}

export type TranscriptItem =
  | MsgItem
  | ReasoningItem
  | ToolItem
  | StatusItem
  | ApprovalItem
  | DiffItem
  | CommandItem
  | FileReadItem
  | FileSearchItem
  | WebSearchItem
  | AgentSpawnItem
  | AutoNoticeItem
  | CompactionItem;

/** Queue entry mirror of QueueUpdatedMessage payload (host/src/queue). */
export interface QueueEntry {
  id: string;
  text: string;
  /** Structured input items carried with the message — localImage/localFile
   *  attachments render as thumbnails in the queue drawer. */
  items?: import('@gian/shared').InputItem[];
  context_items?: import('@gian/shared').MessageContextItem[];
  composer_document?: import('@gian/shared').ComposerDocument;
}
