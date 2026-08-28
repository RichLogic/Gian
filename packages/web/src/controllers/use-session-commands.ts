import { useMemo, type RefObject } from 'react';
import type {
  ApprovalDecision,
  ApprovalMode,
  ConfigValue,
  ComposerDocument,
  MessageContextItem,
  NativeConfigValue,
  Session,
  ThinkingEffort,
} from '@gian/shared';
import type { ComposerAttachmentPayload } from '../attachments.js';
import type { OperationDispatcher } from '../operations/dispatcher.js';
import { dispatchMessageSend } from '../operations/message.js';
// Side effects: register the Queue/Approval definitions this controller
// dispatches (message.js registers its own via the import above).
import '../operations/queue.js';
import '../operations/approval.js';
import type { ApprovalActionContext } from '../types.js';

export interface SessionCommands {
  onSend: (
    sessionId: string,
    text: string,
    opts?: {
      oneShotBypass?: boolean;
      attachments?: Array<ComposerAttachmentPayload & { previewUrl: string }>;
      contextItems?: MessageContextItem[];
      composerDocument?: ComposerDocument;
    },
  ) => void;
  onSendSkill: (sessionId: string, name: string, path: string) => void;
  onStop: (sessionId: string) => void;
  onApprove: (
    sessionId: string,
    approvalId: string,
    decision: ApprovalDecision,
    answers?: Record<string, string | boolean | string[]>,
    context?: ApprovalActionContext,
  ) => void;
  onQueueAdd: (
    sessionId: string,
    text: string,
    attachments?: ComposerAttachmentPayload[],
    contextItems?: MessageContextItem[],
    composerDocument?: ComposerDocument,
  ) => void;
  onQueueRemove: (sessionId: string, queueId: string) => void;
  onQueueUpdate: (sessionId: string, queueId: string, text: string) => void;
  onQueueClear: (sessionId: string) => void;
  onQueueSendNow: (sessionId: string) => void;
  onSteer: (
    sessionId: string,
    text: string,
    attachments?: ComposerAttachmentPayload[],
    contextItems?: MessageContextItem[],
    composerDocument?: ComposerDocument,
  ) => void;
  onSetMode: (sessionId: string, approvalMode: ApprovalMode) => void;
  onSetModel: (sessionId: string, model: string) => void;
  onSetEffort: (sessionId: string, effort: ThinkingEffort | null) => void;
  onSetServiceTier: (sessionId: string, tier: 'fast' | null) => void;
  onSetNativeConfig: (sessionId: string, configId: string, value: NativeConfigValue) => void;
  onSetTurnConfig: (
    sessionId: string,
    optionId: string,
    value: ConfigValue,
    turnConfig: Record<string, ConfigValue>,
  ) => void;
  onArchive: (sessionId: string, archived: boolean) => void;
  onPin: (sessionId: string, pinned: boolean) => void;
  onDelete: (sessionId: string) => void;
  onRecover: (sessionId: string) => void;
  onMerge: (sessionId: string) => void;
  onDrop: (sessionId: string) => void;
  onRename: (sessionId: string, name: string) => void;
}

interface UseSessionCommandsInput {
  /** Operation dispatcher — EVERY command here routes through the operation
   *  layer (Session in Phase 2a; message/queue/approval in Phase 2b). This
   *  controller deliberately holds no socket reference: transport is private
   *  to the operation layer (proposal §4.1). */
  ops: OperationDispatcher;
  sessionsRef: RefObject<Session[]>;
}

export function useSessionCommands({
  ops,
  sessionsRef,
}: UseSessionCommandsInput): SessionCommands {
  return useMemo(() => {
    const executorOf = (sessionId: string) =>
      sessionsRef.current?.find(session => session.id === sessionId)?.executor ?? 'claude';
    return {
      // Message sends share one path (dispatchMessageSend): dispatch +
      // synchronous optimistic echo commit. Failure marks the echo failed in
      // place with a retry affordance — see operations/message.ts.
      onSend: (sessionId, text, opts) => {
        dispatchMessageSend(ops.dispatch, {
          sessionId,
          text,
          exec: executorOf(sessionId),
          ...(opts?.oneShotBypass ? { oneShotBypass: true } : {}),
          ...(opts?.attachments && opts.attachments.length > 0 ? { attachments: opts.attachments } : {}),
          ...(opts?.contextItems && opts.contextItems.length > 0 ? { contextItems: opts.contextItems } : {}),
          ...(opts?.composerDocument ? { composerDocument: opts.composerDocument } : {}),
        });
      },
      onSendSkill: (sessionId, name, path) => {
        dispatchMessageSend(ops.dispatch, {
          sessionId,
          text: `/${name}`,
          exec: executorOf(sessionId),
          skill: { name, path },
        });
      },
      onStop: sessionId => ops.dispatch('session.stop', { sessionId }),
      onApprove: (sessionId, approvalId, decision, answers, context) =>
        ops.dispatch('approval.resolve', {
          sessionId,
          approvalId,
          decision,
          ...(answers ? { answers } : {}),
          ...(context?.nativeOptionId ? { nativeOptionId: context.nativeOptionId } : {}),
        }),
      // Queue operations render through the whole-array overlay
      // (`session:<id>:queue` — see operations/queue.ts); the canonical
      // queue:updated broadcast + operation:result settle them.
      onQueueAdd: (sessionId, text, attachments = [], contextItems = [], composerDocument) =>
        ops.dispatch('queue.add', {
          sessionId,
          text,
          ...(attachments.length > 0 ? { attachments } : {}),
          ...(contextItems.length > 0 ? { contextItems } : {}),
          ...(composerDocument ? { composerDocument } : {}),
        }),
      onQueueRemove: (sessionId, queueId) => ops.dispatch('queue.remove', { sessionId, queueId }),
      onQueueUpdate: (sessionId, queueId, text) => ops.dispatch('queue.update', { sessionId, queueId, text }),
      onQueueClear: sessionId => ops.dispatch('queue.clear', { sessionId }),
      onQueueSendNow: sessionId => ops.dispatch('queue.sendNow', { sessionId }),
      onSteer: (sessionId, text, attachments = [], contextItems = [], composerDocument) =>
        ops.dispatch('message.steer', {
          sessionId,
          text,
          ...(attachments.length > 0 ? { attachments } : {}),
          ...(contextItems.length > 0 ? { contextItems } : {}),
          ...(composerDocument ? { composerDocument } : {}),
        }),
      // Session-domain commands dispatch through the operation layer: the
      // optimistic ones render via overlays (canonical session state is never
      // patched locally anymore), the pending ones get their duplicate guard
      // and result correlation from the dispatcher.
      onSetMode: (sessionId, approvalMode) => ops.dispatch('session.setMode', { sessionId, approvalMode }),
      onSetModel: (sessionId, model) => ops.dispatch('session.setModel', { sessionId, model }),
      onSetEffort: (sessionId, effort) => ops.dispatch('session.setEffort', { sessionId, effort }),
      onSetServiceTier: (sessionId, tier) => ops.dispatch('session.setServiceTier', { sessionId, tier }),
      onSetNativeConfig: (sessionId, configId, value) =>
        ops.dispatch('session.setNativeConfig', { sessionId, configId, value }),
      onSetTurnConfig: (sessionId, optionId, value, turnConfig) =>
        ops.dispatch('session.setTurnConfig', { sessionId, optionId, value, turnConfig }),
      onArchive: (sessionId, archived) => ops.dispatch('session.archive', { sessionId, archived }),
      onPin: (sessionId, pinned) => ops.dispatch('session.pin', { sessionId, pinned }),
      onDelete: sessionId => ops.dispatch('session.delete', { sessionId }),
      onRecover: sessionId => ops.dispatch('session.recover', { sessionId }),
      onMerge: sessionId => { ops.dispatch('session.merge', { sessionId }); },
      onDrop: sessionId => { ops.dispatch('session.drop', { sessionId }); },
      onRename: (sessionId, name) => ops.dispatch('session.rename', { sessionId, name }),
    };
  }, [ops, sessionsRef]);
}
