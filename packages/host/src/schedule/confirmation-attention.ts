import { createHash } from 'node:crypto';
import {
  ATTENTION_EVENT_KINDS,
  ATTENTION_EVENT_LABELS,
  attentionSessionName,
  isProxyPluginId,
} from '@gian/shared';
import type {
  AttentionInboxRef,
  AttentionMessage,
  ScheduleConfirmation,
  ScheduleConfirmationAttentionMessage,
} from '@gian/shared';
import type { Db } from '../storage/db.js';

export interface ScheduleConfirmationAttentionPublish {
  db: Db;
  claim: (id: string, generation: number) => { emit: boolean };
  broadcast: (message: AttentionMessage) => void;
  gate?: (kind: AttentionMessage['kind']) => boolean;
  confirmation: ScheduleConfirmation;
  inbox: AttentionInboxRef;
}

/**
 * One OS notification after a newly inserted unread pending confirmation row.
 * Claim records the generation even when the preference gate is off, so a
 * later enable does not replay it. Restore, repair, and reconcile do not
 * call this. A failed broadcast does not roll the claim back.
 * The frame omits `turn`. The confirmation id and inbox ref are the target.
 */
export function publishFreshScheduleConfirmationAttention(
  input: ScheduleConfirmationAttentionPublish,
): void {
  const message = confirmationAttentionMessage(input);
  if (!message) return;
  const claim = input.claim(input.inbox.id, input.inbox.generation);
  if (!claim.emit) return;
  if (input.gate && !input.gate(message.kind)) return;
  try {
    input.broadcast(message);
  } catch (error) {
    console.error('[attention] schedule confirmation broadcast failed', error);
  }
}

function confirmationAttentionMessage(
  input: ScheduleConfirmationAttentionPublish,
): ScheduleConfirmationAttentionMessage | null {
  if (input.inbox.generation !== 1) return null;
  const row = input.db.prepare(
    'SELECT name, executor FROM sessions WHERE id = ?',
  ).get(input.confirmation.control_session_id) as { name?: unknown; executor?: unknown } | undefined;
  if (!row || !isProxyPluginId(row.executor)) {
    console.error(
      `[attention] schedule confirmation has no session session=${input.confirmation.control_session_id}`,
    );
    return null;
  }
  const name = attentionSessionName(row.name);
  const message: ScheduleConfirmationAttentionMessage = {
    type: 'attention',
    id: `gian:attention:${createHash('sha256')
      .update(JSON.stringify([
        input.confirmation.id,
        input.inbox.generation,
        'approval_needed',
      ]))
      .digest('base64url')}`,
    session_id: input.confirmation.control_session_id,
    kind: ATTENTION_EVENT_KINDS.approval_needed,
    timestamp: Date.now(),
    title: name,
    body: ATTENTION_EVENT_LABELS.approval_needed,
    provider: row.executor,
    event: 'approval_needed',
    session_name: name,
    target: {
      type: 'schedule_confirmation',
      confirmation_id: input.confirmation.id,
    },
    inbox_ref: { id: input.inbox.id, generation: input.inbox.generation },
  };
  return message;
}
