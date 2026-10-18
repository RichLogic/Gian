import { createHash } from 'node:crypto';
import {
  ATTENTION_EVENT_KINDS,
  ATTENTION_EVENT_LABELS,
  DEFAULT_NOTIFICATION_PREFERENCES,
  attentionSessionName,
  isProxyPluginId,
} from '@gian/shared';
import type {
  ApprovalRequestedData,
  AttentionEvent,
  AttentionKind,
  AttentionMessage,
  ChatEvent,
  NotificationPreferences,
} from '@gian/shared';
import type { FreshSessionAttention } from '../inbox/session-adapter.js';
import type { Db } from '../storage/db.js';
import type { WsBroadcaster } from '../web/ws-broadcast.js';

const ATTENTION_DEDUPE_LIMIT = 1_024;

function attentionEventForDisplay(event: ChatEvent): AttentionEvent | null {
  const display = event.display;
  if (!display) return null;
  switch (display.type) {
    case 'state.turn-completed':
      // Failed and explicitly stopped turns are not successful completions.
      // The failure already has its own error attention. A user stop stays quiet.
      if (event.data.status === 'error' || event.data.status === 'stopped') return null;
      return 'turn_complete';
    case 'interaction.approval': {
      const data = display.data as ApprovalRequestedData;
      return data.category === 'exit_plan_mode' ? 'plan_review_needed' : 'approval_needed';
    }
    case 'interaction.question':
      return 'answer_needed';
    case 'state.error':
      return 'turn_failed';
    default:
      return null;
  }
}

function interactionIdForAttention(event: ChatEvent, attentionEvent: AttentionEvent): string | null {
  if (attentionEvent === 'turn_complete' || attentionEvent === 'turn_failed') return null;
  const data = event.display?.data;
  if (!data || typeof data !== 'object') return null;
  const id = (data as { approvalId?: unknown }).approvalId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/**
 * OS copy is the safe conversation name plus the English event label.
 * Provider prose, commands, paths, and the internal turn number stay in the transcript.
 * Actionable messages from this helper have no `inbox_ref`. The fresh Inbox
 * publisher adds that ref and is the only path that may broadcast them.
 */
export function attentionMessageForEvent(
  event: ChatEvent,
  sessionName?: unknown,
): AttentionMessage | null {
  const attentionEvent = attentionEventForDisplay(event);
  if (!attentionEvent) return null;
  const name = attentionSessionName(sessionName);
  const kind = ATTENTION_EVENT_KINDS[attentionEvent];
  return {
    type: 'attention',
    id: `gian:attention:${createHash('sha256')
      .update(JSON.stringify([event.session_id, event.turn, kind, event.call_id]))
      .digest('base64url')}`,
    session_id: event.session_id,
    turn: event.turn,
    kind,
    timestamp: event.ts,
    title: name,
    body: ATTENTION_EVENT_LABELS[attentionEvent],
    provider: event.provider,
    event: attentionEvent,
    session_name: name,
    target: {
      type: 'session',
      session_id: event.session_id,
      turn: event.turn,
      interaction_id: interactionIdForAttention(event, attentionEvent),
    },
  };
}

export interface FreshAttentionPublish {
  db: Db;
  claim: (id: string, generation: number) => { emit: boolean };
  broadcast: (message: AttentionMessage) => void;
  gate?: AttentionGate;
  fresh: FreshSessionAttention;
}

/**
 * One OS notification after the canonical Inbox row exists.
 * `claim` records the generation even when the preference gate is off, so a
 * later enable does not replay it. A failed broadcast does not roll the claim back.
 */
export function publishFreshSessionAttention(input: FreshAttentionPublish): void {
  const event: AttentionEvent = input.fresh.sourceKind === 'session.question'
    ? 'answer_needed'
    : input.fresh.category === 'plan'
      ? 'plan_review_needed'
      : 'approval_needed';
  const turn = input.fresh.turn;
  if (turn === null) {
    console.error(`[attention] fresh occurrence has no turn session=${input.fresh.sessionId}`);
    return;
  }
  const row = input.db.prepare(
    'SELECT name, executor FROM sessions WHERE id = ?',
  ).get(input.fresh.sessionId) as { name?: unknown; executor?: unknown } | undefined;
  if (!row || !isProxyPluginId(row.executor)) {
    console.error(`[attention] fresh occurrence has no session session=${input.fresh.sessionId}`);
    return;
  }
  const name = attentionSessionName(row.name);
  const kind = ATTENTION_EVENT_KINDS[event];
  const message: AttentionMessage = {
    type: 'attention',
    id: `gian:attention:${createHash('sha256')
      .update(JSON.stringify([
        input.fresh.sessionId,
        input.fresh.interactionId,
        input.fresh.generation,
        event,
      ]))
      .digest('base64url')}`,
    session_id: input.fresh.sessionId,
    turn,
    kind,
    timestamp: Date.now(),
    title: name,
    body: ATTENTION_EVENT_LABELS[event],
    provider: row.executor,
    event,
    session_name: name,
    target: {
      type: 'session',
      session_id: input.fresh.sessionId,
      turn,
      interaction_id: input.fresh.interactionId,
    },
    inbox_ref: { id: input.fresh.itemId, generation: input.fresh.generation },
  };
  const claim = input.claim(input.fresh.itemId, input.fresh.generation);
  if (!claim.emit) return;
  if (input.gate && !input.gate(kind)) return;
  try {
    input.broadcast(message);
  } catch (error) {
    console.error('[attention] fresh occurrence broadcast failed', error);
  }
}

/**
 * User-level notification gating (ADR-0078). The Host applies this BEFORE
 * any `attention` broadcast so every delivery end — native (Electron main)
 * and the renderer fallback — sees the exact same gated signal and no
 * per-device preference drift is possible.
 */
export function attentionKindEnabled(
  prefs: NotificationPreferences,
  kind: AttentionKind,
): boolean {
  if (!prefs.enabled) return false;
  if (kind === 'turn-completed') return prefs.session_done;
  if (kind === 'approval' || kind === 'question') return prefs.approval_needed;
  return prefs.errors;
}

export type AttentionGate = (kind: AttentionKind) => boolean;

/** Gate reading fresh preferences on every call (settings can change at
 *  runtime via PATCH /api/settings). Missing config means defaults-on. */
export function attentionGateForPreferences(
  read: () => NotificationPreferences | undefined,
): AttentionGate {
  return kind => attentionKindEnabled(read() ?? DEFAULT_NOTIFICATION_PREFERENCES, kind);
}

/**
 * Process-wide attention projection and bounded de-duplication. The Host
 * shares one instance across proxy events, protocol replay and JSONL Live
 * Sync so one persisted event cannot produce multiple native notifications.
 */
export class AttentionDispatcher {
  private recentIds = new Set<string>();

  constructor(
    private broadcaster: WsBroadcaster,
    private gate?: AttentionGate,
    private readSessionName?: (sessionId: string) => unknown,
  ) {}

  claim(event: ChatEvent): AttentionMessage | null {
    const message = attentionMessageForEvent(event, this.readSessionName?.(event.session_id));
    if (!message || this.recentIds.has(message.id)) return null;
    this.recentIds.add(message.id);
    if (this.recentIds.size > ATTENTION_DEDUPE_LIMIT) {
      const oldest = this.recentIds.values().next().value as string | undefined;
      if (oldest !== undefined) this.recentIds.delete(oldest);
    }
    // Gated-off kinds are still claimed (one persisted event → one claim) so
    // re-enabling a preference never replays a suppressed signal.
    if (this.gate && !this.gate(message.kind)) return null;
    return message;
  }

  broadcast(event: ChatEvent): AttentionMessage | null {
    const message = this.claim(event);
    // Questions, approvals, and plan review become an OS notification only
    // from publishFreshSessionAttention, after the canonical Inbox occurrence
    // exists. This path must not invent an inbox_ref. An automatic decision
    // never reaches that publisher, so it does not become a notification.
    if (
      !message
      || message.inbox_ref
      || message.kind === 'approval'
      || message.kind === 'question'
    ) {
      return null;
    }
    this.broadcaster.broadcast(message);
    return message;
  }
}
