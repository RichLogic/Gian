import { useMemo, type Dispatch, type RefObject, type SetStateAction } from 'react';
import type {
  ApprovalDecision,
  ApprovalMode,
  InputItem,
  NativeConfigValue,
  Session,
  ThinkingEffort,
} from '@gian/shared';
import { dropSession, mergeSession } from '../api.js';
import { attachmentInputItem, type ComposerAttachmentPayload } from '../attachments.js';
import { toast } from '../feedback.js';
import { createOptimisticEcho } from '../transcript/apply.js';
import type { ApprovalActionContext, TranscriptItem } from '../types.js';
import type { GianWs } from '../ws.js';

export interface SessionCommands {
  onSend: (
    sessionId: string,
    text: string,
    opts?: {
      oneShotBypass?: boolean;
      attachments?: Array<ComposerAttachmentPayload & { previewUrl: string }>;
    },
  ) => void;
  onSendSkill: (sessionId: string, name: string, path: string) => void;
  onStop: (sessionId: string) => void;
  onApprove: (
    sessionId: string,
    approvalId: string,
    decision: ApprovalDecision,
    answers?: Record<string, string | string[]>,
    context?: ApprovalActionContext,
  ) => void;
  onQueueAdd: (
    sessionId: string,
    text: string,
    attachments?: ComposerAttachmentPayload[],
  ) => void;
  onQueueRemove: (sessionId: string, queueId: string) => void;
  onQueueReorder: (sessionId: string, order: string[]) => void;
  onQueueClear: (sessionId: string) => void;
  onQueueSendNow: (sessionId: string) => void;
  onSteer: (
    sessionId: string,
    text: string,
    attachments?: ComposerAttachmentPayload[],
  ) => void;
  onSetMode: (sessionId: string, approvalMode: ApprovalMode) => void;
  onSetModel: (sessionId: string, model: string) => void;
  onSetEffort: (sessionId: string, effort: ThinkingEffort | null) => void;
  onSetServiceTier: (sessionId: string, tier: 'fast' | null) => void;
  onSetNativeConfig: (sessionId: string, configId: string, value: NativeConfigValue) => void;
  onArchive: (sessionId: string, archived: boolean) => void;
  onDelete: (sessionId: string) => void;
  onRecover: (sessionId: string) => void;
  onMerge: (sessionId: string) => Promise<void>;
  onDrop: (sessionId: string) => Promise<void>;
  onRename: (sessionId: string, name: string) => void;
}

interface UseSessionCommandsInput {
  ws: GianWs;
  sessionsRef: RefObject<Session[]>;
  setItemsBySession: Dispatch<SetStateAction<Record<string, TranscriptItem[]>>>;
  setPendingBySession: Dispatch<SetStateAction<Record<string, boolean>>>;
}

function inputItems(
  text: string,
  attachments: ComposerAttachmentPayload[],
): InputItem[] {
  const items: InputItem[] = [];
  if (text.trim()) items.push({ type: 'text', text });
  for (const attachment of attachments) items.push(attachmentInputItem(attachment));
  return items;
}

export function useSessionCommands({
  ws,
  sessionsRef,
  setItemsBySession,
  setPendingBySession,
}: UseSessionCommandsInput): SessionCommands {
  return useMemo(() => ({
    onSend: (sessionId, text, opts) => {
      const exec = sessionsRef.current?.find(session => session.id === sessionId)?.executor
        ?? 'claude';
      const attachments = opts?.attachments ?? [];
      const optimistic = createOptimisticEcho({
        sessionId,
        text,
        exec,
        attachments: attachments.length > 0
          ? attachments.map(attachment => ({
              name: attachment.name,
              mime: attachment.mime,
              url: attachment.previewUrl,
              ...(attachment.size !== undefined ? { size: attachment.size } : {}),
            }))
          : undefined,
      });
      setItemsBySession(previous => ({
        ...previous,
        [sessionId]: [...(previous[sessionId] ?? []), optimistic],
      }));
      setPendingBySession(previous => ({ ...previous, [sessionId]: true }));

      const items = inputItems(text, attachments);
      ws.send({
        type: 'message:send',
        session_id: sessionId,
        text,
        ...(items.length > 0 ? { items } : {}),
        ...(opts?.oneShotBypass ? { oneShotBypass: true } : {}),
      });
    },
    onSendSkill: (sessionId, name, path) => ws.send({
      type: 'message:send',
      session_id: sessionId,
      text: `/${name}`,
      items: [{ type: 'skill', name, path }],
    }),
    onStop: sessionId => ws.send({ type: 'session:stop', session_id: sessionId }),
    onApprove: (sessionId, approvalId, decision, answers, context) => ws.send({
      type: 'approval:resolve',
      session_id: sessionId,
      approval_id: approvalId,
      decision,
      ...(answers ? { answers } : {}),
      ...(context?.nativeOptionId ? { native_option_id: context.nativeOptionId } : {}),
    }),
    onQueueAdd: (sessionId, text, attachments = []) => {
      const items = inputItems(text, attachments);
      ws.send({
        type: 'queue:add',
        session_id: sessionId,
        text,
        ...(items.length > 0 ? { items } : {}),
      });
    },
    onQueueRemove: (sessionId, queueId) =>
      ws.send({ type: 'queue:remove', session_id: sessionId, queue_id: queueId }),
    onQueueReorder: (sessionId, order) =>
      ws.send({ type: 'queue:reorder', session_id: sessionId, order }),
    onQueueClear: sessionId =>
      ws.send({ type: 'queue:clear', session_id: sessionId }),
    onQueueSendNow: sessionId =>
      ws.send({ type: 'queue:send_now', session_id: sessionId }),
    onSteer: (sessionId, text, attachments = []) => {
      const items = inputItems(text, attachments);
      ws.send({
        type: 'message:steer',
        session_id: sessionId,
        text,
        ...(items.length > 0 ? { items } : {}),
      });
    },
    onSetMode: (sessionId, approvalMode) =>
      ws.send({ type: 'session:set_mode', session_id: sessionId, approval_mode: approvalMode }),
    onSetModel: (sessionId, model) =>
      ws.send({ type: 'session:set_model', session_id: sessionId, model }),
    onSetEffort: (sessionId, effort) =>
      ws.send({ type: 'session:set_effort', session_id: sessionId, effort }),
    onSetServiceTier: (sessionId, tier) =>
      ws.send({ type: 'session:set_service_tier', session_id: sessionId, service_tier: tier }),
    onSetNativeConfig: (sessionId, configId, value) => ws.send({
      type: 'session:set_native_config',
      session_id: sessionId,
      config_id: configId,
      value,
    }),
    onArchive: (sessionId, archived) =>
      ws.send({ type: 'session:archive', session_id: sessionId, archived }),
    onDelete: sessionId =>
      ws.send({ type: 'session:delete', session_id: sessionId }),
    onRecover: sessionId =>
      ws.send({ type: 'session:recover', session_id: sessionId }),
    onMerge: async sessionId => {
      const result = await mergeSession(sessionId);
      if (!result.ok) toast({ kind: 'error', message: result.error ?? 'merge failed' });
    },
    onDrop: async sessionId => {
      const result = await dropSession(sessionId);
      if (!result.ok) toast({ kind: 'error', message: result.error ?? 'drop failed' });
    },
    onRename: (sessionId, name) =>
      ws.send({ type: 'session:rename', session_id: sessionId, name }),
  }), [sessionsRef, setItemsBySession, setPendingBySession, ws]);
}
