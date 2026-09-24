/**
 * Web adapter over `@gian/chat-ui`'s `Transcript`. The pure renderer (turn
 * work blocks, history states, scroll-follow, item dispatch) lives in the
 * shared package; this wrapper injects the web-only concerns:
 *
 * - the send-echo lifecycle and approval resolving state (Operation Layer)
 *   via the `renderItem` override;
 * - the Gian working mascot;
 * - the per-turn Fork control (gian.proxy/2.0 §10.6) on terminal results;
 * - the selection-actions overlay.
 *
 * Local Web and Remote Web render the same components — this file only maps
 * web state onto chat-ui's DTOs/callbacks.
 */
import { useMemo, type ReactNode } from 'react';
import type { ApprovalDecision } from '@gian/shared';
import {
  renderChatItem,
  transcriptItemIdentity,
  Transcript as ChatTranscript,
  type RenderItemContext,
  type TranscriptExtra,
} from '@gian/chat-ui';
import type { TranscriptHistoryError } from '../controllers/use-transcript-hydration.js';
import { useT } from '../i18n/index.js';
import type { ApprovalActionContext, StatusItem, TranscriptItem } from '../types.js';
import { ApprovalCard, UserMessage } from './items.js';
import { GianMascot } from '../components/GianMascot.js';
import { ForkFromTurnControl } from '../components/ForkControls.js';
import type { ActionControlState } from '../components/action-gating.js';
import {
  TranscriptSelectionActions,
  type TranscriptSelectionActionsConfig,
} from './TranscriptSelectionActions.js';
import { EventFeedRow } from './EventFeed.js';
import type { TranslationController } from '../translation/use-translation.js';
import { TranslationButton, TranslationResult } from '../translation/TranslationControls.js';

// Pure transcript machinery re-exported for existing import paths.
export {
  groupIntoBlocks,
  terminalResultByTurn,
  terminalState,
  TurnWorkBlock,
  type RenderableItem,
  type RenderItemContext,
  type TranscriptExtra,
  type TurnWorkState,
} from '@gian/chat-ui';

/** Web renderItem: the two operation-aware cards (user echo, approval) go
 *  through the adapters in `./items.tsx`; everything else renders through
 *  chat-ui's default renderer. */
export function renderItem(item: TranscriptItem, ctx: RenderItemContext): ReactNode {
  const identity = transcriptItemIdentity(item);
  switch (item.kind) {
    case 'user': {
      if (ctx.isCurrentUser && ctx.currentUserRef) {
        return (
          <div key={identity} ref={ctx.currentUserRef} data-current-user="true">
            <UserMessage item={item} />
          </div>
        );
      }
      return <UserMessage key={identity} item={item} />;
    }
    case 'approval':
      return <ApprovalCard key={identity} item={item} onApprove={ctx.onApprove} />;
    default:
      return renderChatItem(item, ctx);
  }
}

export function Transcript({
  items, pending, onApprove, hiddenApprovalId, extras, hydrated = true,
  hasOlder = false, loadingOlder = false, onLoadOlder, historyError, onRetryHistory,
  forkAtTurn, selectionActions, inlineEventDetails = false,
  scheduleFocus = null, onConsumeScheduleFocus,
  translation,
}: {
  items: TranscriptItem[];
  pending: boolean;
  onApprove: (
    approvalId: string,
    decision: ApprovalDecision,
    answers?: Record<string, string | boolean | string[]>,
    context?: ApprovalActionContext,
  ) => void;
  /** Approval id pinned elsewhere (e.g. the Beta question dock). Suppress its
   *  inline transcript card so a pending question isn't shown twice. */
  hiddenApprovalId?: string;
  /** Extra nodes interleaved among the items by timestamp (Manager subtask cards). */
  extras?: TranscriptExtra[];
  /** False while the session's history is still being fetched. The empty
   *  state is gated on this so switching to an unhydrated session doesn't
   *  flash "no messages" before the history arrives. */
  hydrated?: boolean;
  hasOlder?: boolean;
  loadingOlder?: boolean;
  onLoadOlder?: () => void;
  historyError?: TranscriptHistoryError | null;
  onRetryHistory?: () => void;
  /** Per-turn Fork affordance (gian.proxy/2.0 §10.6): when present, every
   *  Terminal Turn result footer renders the standard control beside Copy,
   *  greyed per `state` and the item's Host-flowed turn identity. Text-free,
   *  failed, and stopped turns use a compact fallback footer. Absent on
   *  surfaces that can never be a fork source (Side Chat panels). */
  forkAtTurn?: {
    sourceSessionId: string;
    state: ActionControlState;
  } | null;
  /** Context actions exposed only for selections contained in one visible
   *  user/assistant message. Side Chat transcripts omit this prop. */
  selectionActions?: TranscriptSelectionActionsConfig;
  /** Side Chat already owns Panel 2, so process rows expand in place. */
  inlineEventDetails?: boolean;
  /** Timer request to reveal the canonical message for one Schedule Run. */
  scheduleFocus?: { runId: string } | null;
  onConsumeScheduleFocus?: () => void;
  translation?: TranslationController;
}) {
  const t = useT();
  const selectionSourceIds = useMemo(
    () => new Set(items
      .filter(item => item.kind === 'user' || item.kind === 'assistant')
      .map(transcriptItemIdentity)),
    [items],
  );
  return (
    <ChatTranscript
      items={items}
      pending={pending}
      onApprove={onApprove}
      hiddenApprovalId={hiddenApprovalId}
      extras={extras}
      hydrated={hydrated}
      hasOlder={hasOlder}
      loadingOlder={loadingOlder}
      onLoadOlder={onLoadOlder}
      historyError={historyError}
      onRetryHistory={onRetryHistory}
      renderItem={renderItem}
      workingIndicator={<GianMascot size={36} state="working" title={t('transcript.workingEllipsis')} />}
      renderAssistantFooterActions={(item, turnEnd: StatusItem | undefined) => <>
          {forkAtTurn && <ForkFromTurnControl
            sourceSessionId={forkAtTurn.sourceSessionId}
            turn={item.turn}
            turnId={turnEnd?.turn_id}
            sourceTurnId={turnEnd?.source_turn_id}
            state={forkAtTurn.state}
          />}
          {translation && <TranslationButton item={item} controller={translation} />}
        </>}
      renderAssistantTranslation={translation ? item => <TranslationResult
        value={translation.result(`turn:${item.turn}`, item.text)}
        onRetry={() => void translation.read(item.text, `turn:${item.turn}`)} /> : undefined}
      renderTurnEndFooter={forkAtTurn
        ? (item: StatusItem) => (
          <ForkFromTurnControl
            sourceSessionId={forkAtTurn.sourceSessionId}
            turn={item.turn}
            turnId={item.turn_id}
            sourceTurnId={item.source_turn_id}
            state={forkAtTurn.state}
          />
        )
        : undefined}
      renderOverlay={selectionActions
        ? rootRef => (
          <TranscriptSelectionActions
            rootRef={rootRef}
            actions={selectionActions}
            validSourceIds={selectionSourceIds}
          />
        )
        : undefined}
      renderInlineEventDetails={inlineEventDetails
        ? item => <EventFeedRow item={item} />
        : undefined}
      scheduleFocus={scheduleFocus}
      onConsumeScheduleFocus={onConsumeScheduleFocus}
    />
  );
}
