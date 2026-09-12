/**
 * Transcript item renderers — the pure presentation components live in
 * `@gian/chat-ui` (shared with Remote Web); this module re-exports them so
 * existing import paths keep working, and adds the web-only adapters that
 * wire the Operation Layer into the two stateful cards:
 *
 * - `UserMessage` derives the echo's unknown-outcome state from the operation
 *   store (`useOperationRun`) and wires the failed send's retry affordance
 *   (`dispatchMessageSend`, re-dispatching the SAME operation — proposal §9);
 * - `ApprovalCard` derives the resolving state from the pending
 *   `approval.resolve` run (`useOperationPending`).
 *
 * Both degrade gracefully without an operation store (tests render the cards
 * standalone): no retry button, no resolving state — matching the previous
 * behavior.
 */
import type { ApprovalItem, MsgItem } from '../types.js';
import type { OnApprove } from '@gian/chat-ui';
import {
  ApprovalCard as ChatApprovalCard,
  UserMessage as ChatUserMessage,
} from '@gian/chat-ui';
import { dispatchMessageSend } from '../operations/message.js';
import { useOperationDispatchOptional, useOperationPending, useOperationRun } from '../operations/use-operations.js';

export {
  AgentSpawnRow,
  AssistantMessage,
  AutoNoticeCard,
  Caret,
  CommandCard,
  CompactionRow,
  CopyButton,
  DiffCard,
  FileReadCard,
  FileSearchCard,
  FileLink,
  INLINE_OUTPUT_LINES,
  MarkdownText,
  MinimalErrorCard,
  ReasoningCard,
  RunningMeta,
  ToolEvent,
  WebSearchRow,
  ApprovalLine,
  formatElapsed,
  measureToolDetail,
  useStableExpand,
  TRow,
} from '@gian/chat-ui';

// Behavior-injection contexts — provided once at the App root; the actual
// context objects live in @gian/chat-ui so local and remote consumers share
// one identity.
export {
  BrowserLinkOpenContext,
  ChatPanelOpenContext,
  DiffOpenContext,
  FileLinkHrefContext,
  FileLinkOpenContext,
  FileRefRehypeContext,
  ImageZoomContext,
  PlanOpenContext,
  RelativeLinkOpenContext,
  ScheduleOpenContext,
} from '@gian/chat-ui';
export type { PlanOpenPayload } from '@gian/chat-ui';

/** User bubble with the web send-echo lifecycle wired in. */
export function UserMessage({ item }: { item: MsgItem }) {
  const dispatch = useOperationDispatchOptional();
  const sendRun = useOperationRun(item.sendRunId);
  // Echo lifecycle (proposal §9): `pending` until the server emits its
  // `user_message`; `failed` marks a rejected send IN PLACE with a retry
  // affordance; a still-pending echo whose operation run timed out (or
  // disconnected) shows the unknown-outcome "may not have been sent" state —
  // never a silent success.
  const sendUnknown = Boolean(item.pending && item.sendRunId && sendRun?.phase === 'timed-out');
  return (
    <ChatUserMessage
      item={item}
      sendUnknown={sendUnknown}
      onRetrySend={item.failed && item.sendRetry && dispatch
        ? () => dispatchMessageSend(dispatch, item.sendRetry!)
        : undefined}
    />
  );
}

/** Approval card with the pending `approval.resolve` run wired in (Phase 2b,
 *  proposal §5): clicking any decision immediately disables the submitted
 *  card and labels it resolving; failure re-enables it and the host's error
 *  envelope surfaces the error. */
export function ApprovalCard({
  item,
  onApprove,
}: {
  item: ApprovalItem;
  onApprove: OnApprove;
}) {
  const resolving = useOperationPending(`approval:${item.approvalId}`, 'approval.resolve');
  return <ChatApprovalCard item={item} onApprove={onApprove} resolving={resolving} />;
}
