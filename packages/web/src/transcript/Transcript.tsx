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
import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
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
import { TranslationButton, TranslationEchoPendingRow, TranslationResult, TranslationSendRow } from '../translation/TranslationControls.js';

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

function focusRequestKeyOf(focus: {
  nonce: number;
  messageId?: string;
  interactionId?: string;
  turn?: number;
  turnId?: string;
  documentId?: string;
  textRevision?: string;
} | null): string {
  if (!focus) return '';
  return [
    focus.nonce,
    focus.messageId ?? '',
    focus.interactionId ?? '',
    focus.turn ?? '',
    focus.turnId ?? '',
    focus.documentId ?? '',
    focus.textRevision ?? '',
  ].join('\0');
}

export function Transcript({
  items, pending, onApprove, hiddenApprovalId, extras, hydrated = true,
  hasOlder = false, loadingOlder = false, onLoadOlder, historyError, onRetryHistory,
  forkAtTurn, selectionActions, inlineEventDetails = false,
  scheduleFocus = null, onConsumeScheduleFocus,
  messageFocus = null, onConsumeMessageFocus, onLoadMessageContext, findActive = false,
  returnToLatestGeneration = 0,
  approvalsLockedReason = null,
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
  /** Exact message navigation (Issue #168): when the target is not in the
   *  loaded window, `onLoadMessageContext` fetches the bounded context
   *  window (Host search context route); chat-ui scrolls once it renders. */
  messageFocus?: {
    messageId?: string;
    interactionId?: string;
    turn?: number;
    nonce: number;
    turnId?: string;
    documentId?: string;
    textRevision?: string;
  } | null;
  onConsumeMessageFocus?: () => void;
  onLoadMessageContext?: (focus: {
    turnId?: string;
    turn?: number;
    documentId?: string;
    textRevision?: string;
  }) => Promise<boolean>;
  /** Explicit Back-to-latest generation from the history layer. A newer value
   *  retires the in-flight context load for the current focus and does not
   *  start another one for that same focus. */
  returnToLatestGeneration?: number;
  /** Conversation find owns the scroll position — suppress re-pinning. */
  findActive?: boolean;
  /** Read-only transcript (archived, Issue #168): approval/question cards
   *  render but cannot submit; the reason replaces the resolving note. */
  approvalsLockedReason?: string | null;
  translation?: TranslationController;
}) {
  const t = useT();
  // Exact message/interaction navigation: the target may sit outside the
  // loaded window. Load its bounded context window (Host search context
  // route) instead of walking older pages; chat-ui scrolls once the target
  // renders. A failed load (stale text revision, unavailable target)
  // consumes the focus — the caller surfaces the error.
  const messageFocusLoaded = messageFocus
    ? messageFocus.messageId
      ? items.some(item => transcriptItemIdentity(item) === messageFocus.messageId)
      : messageFocus.interactionId
        ? items.some(item => item.kind === 'approval' && item.approvalId === messageFocus.interactionId)
        : messageFocus.turn !== undefined
          ? items.some(item => item.turn === messageFocus.turn)
          : true
    : true;
  const contextRequestRef = useRef<number>(0);
  // App and CodingView rebuild this object and the load callback on every
  // render. The context route bumps a navigation token per call, so an effect
  // that re-fires on those identities discards every response and leaves the
  // transcript blank. Key the request on the focus primitives and read the
  // callbacks from refs.
  const messageFocusRef = useRef(messageFocus);
  messageFocusRef.current = messageFocus;
  const onLoadMessageContextRef = useRef(onLoadMessageContext);
  onLoadMessageContextRef.current = onLoadMessageContext;
  const onConsumeMessageFocusRef = useRef(onConsumeMessageFocus);
  onConsumeMessageFocusRef.current = onConsumeMessageFocus;
  const focusRequestKey = focusRequestKeyOf(messageFocus);
  // Back to latest retires the load that belongs to the focus currently on
  // screen. A later focus is a new request. A false from the retired load
  // must not consume that newer focus, and this effect must not ask for the
  // old window again while the same focus is still current.
  const returnGenerationRef = useRef(returnToLatestGeneration);
  const returnBlockedKeyRef = useRef<string | null>(null);
  if (returnToLatestGeneration !== returnGenerationRef.current) {
    returnGenerationRef.current = returnToLatestGeneration;
    contextRequestRef.current += 1;
    returnBlockedKeyRef.current = focusRequestKey;
  } else if (returnBlockedKeyRef.current && returnBlockedKeyRef.current !== focusRequestKey) {
    returnBlockedKeyRef.current = null;
  }
  useEffect(() => {
    const focus = messageFocusRef.current;
    const load = onLoadMessageContextRef.current;
    if (returnBlockedKeyRef.current === focusRequestKey) return;
    if (!focus || messageFocusLoaded || !load) return;
    // The context route locates by turn_id/turn + document_id; without any
    // of them there is no bounded window to fetch.
    if (!focus.turnId && focus.turn === undefined && !focus.documentId) return;
    const requestId = ++contextRequestRef.current;
    const requestKey = focusRequestKey;
    let alive = true;
    void load({
      turnId: focus.turnId,
      turn: focus.turn,
      documentId: focus.documentId,
      textRevision: focus.textRevision,
    }).then(ok => {
      if (!alive || contextRequestRef.current !== requestId) return;
      // The parent may already have installed a newer focus during render,
      // before this effect's cleanup runs. A stale false belongs to the
      // request above, not to that newer focus.
      if (focusRequestKeyOf(messageFocusRef.current) !== requestKey) return;
      if (ok) return;
      // Return-to-latest already retired this focus. A superseded false must
      // not clear it. A false for a focus that is still current is the
      // bounded-window failure: consume that focus and let the history error
      // retry the same locator.
      if (returnBlockedKeyRef.current === requestKey) return;
      onConsumeMessageFocusRef.current?.();
    });
    return () => { alive = false; };
  }, [focusRequestKey, messageFocusLoaded, returnToLatestGeneration]);
  const chatMessageFocus = useMemo(() => (
    messageFocus ? {
      messageId: messageFocus.messageId,
      interactionId: messageFocus.interactionId,
      turn: messageFocus.turn,
      nonce: messageFocus.nonce,
    } : null
  ), [
    messageFocus?.messageId,
    messageFocus?.interactionId,
    messageFocus?.turn,
    messageFocus?.nonce,
  ]);
  const selectionSourceIds = useMemo(
    () => new Set(items
      .filter(item => item.kind === 'user' || item.kind === 'assistant')
      .map(transcriptItemIdentity)),
    [items],
  );
  // The send-echo's inline translation progress row needs the per-session
  // TranslationController, so the item renderer is a closure over it: a
  // `sendTranslation`-marked echo (appended by beginTranslationEcho before
  // its dispatch exists) renders the row under its bubble. Composer sends
  // carry controller send state (error/retry affordances); flows without it
  // (the new-session first message) still get the bare Translating row.
  const renderWithTranslation = useCallback((item: TranscriptItem, ctx: RenderItemContext): ReactNode => {
    if (item.kind !== 'user' || !translation || !item.sendTranslation) return renderItem(item, ctx);
    const identity = transcriptItemIdentity(item);
    const row = translation.sending
      ? <TranslationSendRow controller={translation} />
      : <TranslationEchoPendingRow />;
    const message = <UserMessage item={item} sendStatus={row} />;
    if (ctx.isCurrentUser && ctx.currentUserRef) {
      return (
        <div key={identity} ref={ctx.currentUserRef} data-current-user="true">
          {message}
        </div>
      );
    }
    return <UserMessage key={identity} item={item} sendStatus={row} />;
  }, [translation]);
  // Read-only transcripts (archived): approval/question cards render their
  // state but cannot submit — the lock replaces the live onApprove path.
  const renderWithLock = useCallback((item: TranscriptItem, ctx: RenderItemContext): ReactNode => {
    if (item.kind === 'approval' && approvalsLockedReason) {
      return <ApprovalCard key={transcriptItemIdentity(item)} item={item} onApprove={ctx.onApprove} lockedReason={approvalsLockedReason} />;
    }
    return renderWithTranslation(item, ctx);
  }, [approvalsLockedReason, renderWithTranslation]);
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
      renderItem={renderWithLock}
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
        expanded={translation.isReadExpanded(`turn:${item.turn}`)}
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
      messageFocus={chatMessageFocus}
      onConsumeMessageFocus={onConsumeMessageFocus}
      findActive={findActive}
    />
  );
}
