/**
 * UI Operation Layer — Message-domain definitions (Phase 2b of
 * `docs/archive/proposals/ui-operation-layer.md`): ordinary + skill send (optimistic
 * echo), steer (pending), and attachment upload (pending, REST).
 *
 * THE SEND ECHO DOES NOT FIT entity+field overlays (proposal §4.3): it is
 * transcript state (`itemsBySession`), not a Session entity field. It is
 * therefore handled through the definition's escape hatches plus an injected
 * sink, documented here per proposal §9:
 *
 * - COMMIT: `dispatchMessageSend()` is the single send path for every entry
 *   point (Composer send/skill, auto first message after session:created,
 *   bubble retry). It dispatches the operation and appends the echo — built
 *   by `createOptimisticEcho`, still the echo constructor — in the same JS
 *   task, tagged with the run id (`sendRunId`) and the retry payload
 *   (`sendRetry`). The definitions' `optimisticWrites` intentionally write
 *   NO overlay (the registry requires the hook for optimistic operations).
 * - SUCCESS: the canonical `user_message` event still replaces the pending
 *   echo (`applyEnvelope` matches by text) while retaining correlation until
 *   operation:result settles the run and removes transient retry metadata.
 * - FAILURE (operation:result ok:false): the definition's `rollback` marks
 *   the echo FAILED IN PLACE via the sink — it is never silently removed —
 *   and the bubble offers a retry affordance that re-dispatches the same
 *   operation (`dispatchMessageSend` again with `item.sendRetry`).
 * - TIMEOUT / DISCONNECT: the echo stays pending (outcome unknown — never a
 *   silent success); the bubble reads the run's `timed-out` phase from the
 *   operation store (`useOperationRun`) and shows the "may not have been
 *   sent" unknown state.
 *
 * The sink is wired once by App with the transcript setters — the operation
 * layer never imports React state directly.
 */
import type { InputItem, MessageContextItem } from '@gian/shared';

import { attachmentInputItem, type ComposerAttachmentPayload } from '../attachments.js';
import { uploadAttachment, type UploadedAttachment } from '../api.js';
import { createOptimisticEcho } from '../transcript/apply.js';
import type { MessageSendPayload, MsgItem, TranscriptItem } from '../types.js';
import type { OperationDispatcher } from './dispatcher.js';
import { registry } from './registry.js';
import { sessionEntityKey } from './session.js';
import type { OperationContext, OperationDefinition } from './types.js';

/** WS round-trips are normally well under this; expiry marks the outcome
 *  unknown (never failed) per proposal §4.3. */
const WS_TIMEOUT_MS = 10_000;
/** Attachment uploads are bounded REST posts (20 MB cap client-side). */
const UPLOAD_TIMEOUT_MS = 30_000;

// ─── Transcript echo sink (injected setters — see header) ─────────────────

export interface MessageEchoSink {
  /** Append a pending echo and raise the session's pending spinner. */
  append(sessionId: string, item: MsgItem): void;
  /** Drop transient correlation/retry metadata after the Host confirms the
   *  send. The canonical transcript item itself remains untouched. */
  markConfirmed(runId: string, sessionId: string): void;
  /** Mark the echo of run `runId` failed in place. No-op after its correlation
   *  was already cleared by a confirmed result. */
  markFailed(runId: string, sessionId: string): void;
  /** Append the pending echo of a translated send BEFORE its dispatch, without
   *  raising the session's pending spinner (no turn is in flight yet — the
   *  bubble's inline Translating row is the progress signal). */
  appendTranslating?(sessionId: string, item: MsgItem): void;
  /** Bind a dispatch to an echo appended earlier by `appendTranslating`:
   *  stamps the run id / retry payload (and the display translation) onto the
   *  existing bubble — or, when that bubble is gone, appends the dispatch echo
   *  in the SAME state update. Adopt-or-append must be one atomic updater:
   *  deriving a "found" boolean from an updater side effect races with React's
   *  eager-evaluation bailout (the dispatch already scheduled a lane on the
   *  owning fiber), which produced duplicate bubbles on 2026-10-09. Raises the
   *  pending spinner. */
  adopt?(sessionId: string, echoId: string, runId: string, payload: MessageSendPayload): void;
  /** Remove a pre-dispatch echo whose translation was abandoned (unmount /
   *  session switch mid-translation). No-op when the echo is gone. */
  remove?(sessionId: string, echoId: string): void;
}

type FunctionalSetter<T> = (update: (previous: T) => T) => void;

/** The echo appended for a dispatched send (regular sends, and the adopt
 *  fallback when the pre-dispatch translating echo is gone). The operation
 *  run id is the authoritative correlation, so it keys the rendered item. */
function dispatchEcho(input: MessageSendPayload, runId: string): MsgItem {
  const echo = createOptimisticEcho({
    sessionId: input.sessionId,
    text: input.text,
    exec: input.exec,
    attachments: input.attachments?.map(attachment => ({
      name: attachment.name,
      mime: attachment.mime,
      url: attachment.previewUrl,
      ...(attachment.size !== undefined ? { size: attachment.size } : {}),
    })),
    contextItems: input.contextItems,
    composerDocument: input.composerDocument,
  });
  echo.id = `optimistic:${input.sessionId}:${runId}`;
  echo.sendRunId = runId;
  echo.sendRetry = input;
  if (input.translation) echo.translation = input.translation;
  return echo;
}

/** Production transcript reducer used by App and wire-level tests. Keeping
 * this state transition beside the operation definition prevents tests from
 * proving a copied reducer while the real UI wiring drifts. */
export function createMessageEchoSink(
  setItemsBySession: FunctionalSetter<Record<string, TranscriptItem[]>>,
  setPendingBySession: FunctionalSetter<Record<string, boolean>>,
): MessageEchoSink {
  return {
    append(sessionId, item) {
      setItemsBySession(previous => ({
        ...previous,
        [sessionId]: [...(previous[sessionId] ?? []), item],
      }));
      setPendingBySession(previous => ({ ...previous, [sessionId]: true }));
    },
    markConfirmed(runId, sessionId) {
      setItemsBySession(previous => {
        const items = previous[sessionId];
        if (!items) return previous;
        let touched = false;
        const nextItems = items.map(item => {
          if (item.kind !== 'user' || item.sendRunId !== runId) return item;
          touched = true;
          const {
            sendRunId: _runId,
            sendRetry: _retry,
            sendCanonical: _canonical,
            pending: _pending,
            ...confirmed
          } = item;
          return confirmed;
        });
        return touched ? { ...previous, [sessionId]: nextItems } : previous;
      });
    },
    markFailed(runId, sessionId) {
      setItemsBySession(previous => {
        const items = previous[sessionId];
        if (!items?.some(item => item.kind === 'user' && item.sendRunId === runId)) return previous;
        return {
          ...previous,
          [sessionId]: items.map(item => {
            if (item.kind !== 'user' || item.sendRunId !== runId) return item;
            const { sendCanonical: _canonical, ...failed } = item;
            return { ...failed, pending: false, failed: true };
          }),
        };
      });
      setPendingBySession(previous => ({ ...previous, [sessionId]: false }));
    },
    appendTranslating(sessionId, item) {
      setItemsBySession(previous => ({
        ...previous,
        [sessionId]: [...(previous[sessionId] ?? []), item],
      }));
    },
    adopt(sessionId, echoId, runId, payload) {
      setItemsBySession(previous => {
        const items = previous[sessionId] ?? [];
        let touched = false;
        const nextItems = items.map(item => {
          if (item.kind !== 'user' || item.id !== echoId || !item.pending || item.sendCanonical) return item;
          touched = true;
          const { sendTranslation: _translating, ...rest } = item;
          return {
            ...rest,
            sendRunId: runId,
            sendRetry: payload,
            ...(payload.translation ? { translation: payload.translation } : {}),
          };
        });
        return {
          ...previous,
          [sessionId]: touched ? nextItems : [...items, dispatchEcho(payload, runId)],
        };
      });
      setPendingBySession(previous => ({ ...previous, [sessionId]: true }));
    },
    remove(sessionId, echoId) {
      setItemsBySession(previous => {
        const items = previous[sessionId];
        const target = items?.find(item => item.kind === 'user' && item.id === echoId);
        if (!items || !target) return previous;
        // The echo's attachment previews are blob URLs owned by this entry —
        // the canonical reconcile path will never see them, so revoke here.
        if (target.kind === 'user') {
          for (const attachment of target.attachments ?? []) {
            try { URL.revokeObjectURL(attachment.url); } catch { /* noop */ }
          }
        }
        return { ...previous, [sessionId]: items.filter(item => item.id !== echoId) };
      });
    },
  };
}

let echoSink: MessageEchoSink | null = null;

/** App wires the transcript setters here on mount; tests substitute a fake. */
export function wireMessageEchoSink(sink: MessageEchoSink | null): void {
  echoSink = sink;
}

/**
 * The single send path: dispatch the operation, then commit the optimistic
 * echo synchronously (same JS task — proposal §2's local-feedback rule).
 * Returns the run so callers/tests can correlate.
 *
 * A translated send (auto-translate on) committed its echo earlier through
 * `beginTranslationEcho` and passes `input.echoId`: the sink ADOPTS that
 * bubble (run id + retry payload + display translation), atomically falling
 * back to appending the dispatch echo when the bubble is gone.
 */
export function dispatchMessageSend(
  dispatch: OperationDispatcher['dispatch'],
  input: MessageSendPayload,
): ReturnType<OperationDispatcher['dispatch']> {
  input = { ...input, sendId: input.sendId ?? globalThis.crypto?.randomUUID?.() ?? `send:${Date.now()}:${Math.random()}` };
  if (input.oneShotBypass && input.exec !== 'claude') {
    throw new Error(`One-shot bypass is only supported for Claude sessions; got ${input.exec}.`);
  }
  const run = dispatch(input.skill ? 'message.sendSkill' : 'message.send', input);
  if (input.echoId && echoSink?.adopt) {
    echoSink.adopt(input.sessionId, input.echoId, run.id, input);
    return run;
  }
  echoSink?.append(input.sessionId, dispatchEcho(input, run.id));
  return run;
}

/**
 * Optimistic up-screen for a translated send (auto-translate on): append the
 * pending user bubble IMMEDIATELY, before the translation round-trip, marked
 * `sendTranslation` so the transcript renders the inline Translating row.
 * The real dispatch later adopts this echo via `MessageSendPayload.echoId`;
 * the Host's canonical `user_message` then reconciles it exactly like any
 * other echo (FIFO text/attachment match in applyEnvelope).
 *
 * Returns null when no echo sink is wired (tests without the App shell) — the
 * send flow then behaves as before, sans optimistic bubble.
 */
export function beginTranslationEcho(input: {
  sessionId: string;
  text: string;
  exec: import('@gian/shared').Executor;
  attachments?: Array<import('../attachments.js').ComposerAttachmentPayload & { previewUrl: string }>;
  contextItems?: MessageContextItem[];
  composerDocument?: import('@gian/shared').ComposerDocument;
}): MsgItem | null {
  if (!echoSink?.appendTranslating) return null;
  const echo = createOptimisticEcho({
    sessionId: input.sessionId,
    text: input.text,
    exec: input.exec,
    attachments: input.attachments?.map(attachment => ({
      name: attachment.name,
      mime: attachment.mime,
      url: attachment.previewUrl,
      ...(attachment.size !== undefined ? { size: attachment.size } : {}),
    })),
    contextItems: input.contextItems,
    composerDocument: input.composerDocument,
  });
  echo.id = `optimistic:${input.sessionId}:translating:${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}:${Math.random()}`}`;
  echo.sendTranslation = true;
  echoSink.appendTranslating(input.sessionId, echo);
  return echo;
}

/** Drop a pre-dispatch translation echo whose send was abandoned. */
export function removeTranslationEcho(sessionId: string, echoId: string): void {
  echoSink?.remove?.(sessionId, echoId);
}

/** Structured input items for a text+attachments payload (pre-migration
 *  `inputItems` from use-session-commands.ts, unchanged). */
function inputItems(text: string, attachments: ComposerAttachmentPayload[]): InputItem[] {
  const items: InputItem[] = [];
  if (text.trim()) items.push({ type: 'text', text });
  for (const attachment of attachments) items.push(attachmentInputItem(attachment));
  return items;
}

function buildSendMessage(input: MessageSendPayload) {
  // Skill sends go out as a typed skill item so codex resolves the skill
  // markdown; ordinary sends carry text + attachment items. The wire shape
  // matches the pre-migration sends exactly.
  const items = input.skill
    ? [{ type: 'skill', name: input.skill.name, path: input.skill.path } as InputItem]
    : inputItems(input.text, input.attachments ?? []);
  return {
    type: 'message:send' as const,
    ...(input.sendId ? { send_id: input.sendId } : {}),
    ...(input.translationId ? { translation_id: input.translationId } : {}),
    session_id: input.sessionId,
    text: input.text,
    ...(items.length > 0 ? { items } : {}),
    ...(input.contextItems && input.contextItems.length > 0
      ? { context_items: input.contextItems }
      : {}),
    ...(input.composerDocument ? { composer_document: input.composerDocument } : {}),
    ...(input.turnConfig ? { turn_config: input.turnConfig } : {}),
    ...(input.oneShotBypass ? { oneShotBypass: true } : {}),
  };
}

function echoSessionId(context: OperationContext): string {
  return context.entityKey.startsWith('session:')
    ? context.entityKey.slice('session:'.length)
    : context.entityKey;
}

function confirmEcho(context: OperationContext): void {
  echoSink?.markConfirmed(context.runId, echoSessionId(context));
}

function failEchoInPlace(context: OperationContext): void {
  echoSink?.markFailed(context.runId, echoSessionId(context));
}

const messageSend: OperationDefinition<MessageSendPayload> = {
  policy: 'optimistic',
  entityKey: input => sessionEntityKey(input.sessionId),
  // No overlay — the echo is transcript state (see header).
  optimisticWrites: () => [],
  buildMessage: buildSendMessage,
  reconcile: (_result, context) => confirmEcho(context),
  rollback: (_error, context) => failEchoInPlace(context),
  timeoutMs: WS_TIMEOUT_MS,
};

const messageSendSkill: OperationDefinition<MessageSendPayload> = {
  policy: 'optimistic',
  entityKey: input => sessionEntityKey(input.sessionId),
  optimisticWrites: () => [],
  buildMessage: buildSendMessage,
  reconcile: (_result, context) => confirmEcho(context),
  rollback: (_error, context) => failEchoInPlace(context),
  timeoutMs: WS_TIMEOUT_MS,
};

interface SteerInput {
  sessionId: string;
  text: string;
  attachments?: ComposerAttachmentPayload[];
  contextItems?: MessageContextItem[];
  composerDocument?: import('@gian/shared').ComposerDocument;
}

const messageSteer: OperationDefinition<SteerInput> = {
  policy: 'pending',
  entityKey: input => sessionEntityKey(input.sessionId),
  buildMessage: input => {
    const items = inputItems(input.text, input.attachments ?? []);
    return {
      type: 'message:steer' as const,
      session_id: input.sessionId,
      text: input.text,
      ...(items.length > 0 ? { items } : {}),
      ...(input.contextItems && input.contextItems.length > 0
        ? { context_items: input.contextItems }
        : {}),
      ...(input.composerDocument ? { composer_document: input.composerDocument } : {}),
    };
  },
  timeoutMs: WS_TIMEOUT_MS,
};

export interface UploadAttachmentInput {
  sessionId: string;
  blob: Blob;
  filename: string;
  /** Component callbacks — the REST promise settles the run; these deliver
   *  the outcome to the pending-file chip (spinner → path / error flag). */
  onUploaded: (result: UploadedAttachment) => void;
  onFailed: (message: string) => void;
}

/** Promise facade for controller-level flows that must upload before they can
 * continue (screenshot routing and a new Session's first message). The actual
 * REST mutation still runs exclusively inside message.uploadAttachment. */
export function dispatchAttachmentUpload(
  dispatch: OperationDispatcher['dispatch'],
  input: Pick<UploadAttachmentInput, 'sessionId' | 'blob' | 'filename'>,
): Promise<UploadedAttachment> {
  return new Promise((resolve, reject) => {
    try {
      dispatch('message.uploadAttachment', {
        ...input,
        onUploaded: resolve,
        onFailed: (message: string) => reject(new Error(message)),
      });
    } catch (thrown) {
      reject(thrown);
    }
  });
}

const messageUploadAttachment: OperationDefinition<UploadAttachmentInput, UploadedAttachment> = {
  policy: 'pending',
  // Each upload is its own entity: two different files upload concurrently
  // and must never read as duplicate submissions (proposal §4.3).
  entityKey: () =>
    `pending:message.uploadAttachment:${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`,
  execute: async input => {
    try {
      const result = await uploadAttachment(input.sessionId, input.blob, input.filename);
      input.onUploaded(result);
      return result;
    } catch (thrown) {
      input.onFailed(thrown instanceof Error ? thrown.message : String(thrown));
      throw thrown;
    }
  },
  timeoutMs: UPLOAD_TIMEOUT_MS,
};

registry.register('message.send', messageSend);
registry.register('message.sendSkill', messageSendSkill);
registry.register('message.steer', messageSteer);
registry.register('message.uploadAttachment', messageUploadAttachment);
