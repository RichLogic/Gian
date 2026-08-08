/**
 * UI Operation Layer — Queue-domain definitions (Phase 2b of
 * `docs/archive/proposals/ui-operation-layer.md`).
 *
 * OVERLAY MODEL — the queue is an ORDERED ARRAY, not an entity field, so it
 * cannot use the per-field overlay shape one-to-one. The choice made here:
 * the overlay's entityFieldKey is `session:<id>:queue` and its value is the
 * FULL expected array, computed from the current rendered array — canonical
 * plus any in-flight queue overlay — read through the injected canonical
 * reader (`wireCanonicalQueueReader`). Chaining on the rendered array (not
 * bare canonical) is what makes two rapid queue edits compose: the second
 * overlay is computed from the first one's result.
 *
 * Settlement:
 * - SUCCESS: the host broadcasts `queue:updated` before the operation:result
 *   (§4.4 ordering), so when the result absorbs the overlay the canonical
 *   array underneath is already current. The defensive Object.is absorption
 *   never fires for arrays (fresh references per broadcast) — result
 *   arrival is the absorption path, as §4.3 allows.
 * - FAILURE: the overlay is removed, revealing the untouched canonical
 *   array; the host's `error` envelope surfaces the toast (ws-handler sends
 *   it before the operation:result).
 * - TIMEOUT/DISCONNECT: the overlay is marked `unresolved`, never rolled
 *   back — the next queue operation supersedes it in place.
 *
 * `queue.sendNow` is pending: the duplicate guard blocks repeat clicks and
 * ⌘Enter while one drain is in flight.
 */
import type { InputItem } from '@gian/shared';

import { attachmentInputItem, type ComposerAttachmentPayload } from '../attachments.js';
import type { QueueEntry } from '../types.js';
import { registry } from './registry.js';
import { sessionEntityKey } from './session.js';
import type { OperationDefinition } from './types.js';

/** WS round-trips are normally well under this; expiry marks the outcome
 *  unknown (never failed) per proposal §4.3. */
const WS_TIMEOUT_MS = 10_000;

/** Field name of the whole-array queue overlay (`session:<id>:queue`). */
export const QUEUE_OVERLAY_FIELD = 'queue';

/**
 * Reads the current RENDERED queue for one session (canonical + any queue
 * overlay). Wired by App, which has access to both the canonical
 * `queueBySession` state and the operation store.
 */
let canonicalQueueReader: ((sessionId: string) => QueueEntry[]) | null = null;

export function wireCanonicalQueueReader(reader: ((sessionId: string) => QueueEntry[]) | null): void {
  canonicalQueueReader = reader;
}

function currentQueue(sessionId: string): QueueEntry[] {
  return canonicalQueueReader?.(sessionId) ?? [];
}

interface QueueSessionInput {
  sessionId: string;
}

const queueAdd: OperationDefinition<QueueSessionInput & { text: string; attachments?: ComposerAttachmentPayload[] }> = {
  policy: 'optimistic',
  entityKey: input => sessionEntityKey(input.sessionId),
  optimisticWrites: input => {
    const items: InputItem[] = (input.attachments ?? []).map(attachmentInputItem);
    return [{
      field: QUEUE_OVERLAY_FIELD,
      value: [...currentQueue(input.sessionId), {
        id: `optimistic:queue:${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`,
        text: input.text,
        ...(items.length > 0 ? { items } : {}),
      }],
    }];
  },
  buildMessage: input => {
    const items: InputItem[] = [];
    if (input.text.trim()) items.push({ type: 'text', text: input.text });
    for (const attachment of input.attachments ?? []) items.push(attachmentInputItem(attachment));
    return {
      type: 'queue:add' as const,
      session_id: input.sessionId,
      text: input.text,
      ...(items.length > 0 ? { items } : {}),
    };
  },
  timeoutMs: WS_TIMEOUT_MS,
};

const queueUpdate: OperationDefinition<QueueSessionInput & { queueId: string; text: string }> = {
  policy: 'optimistic',
  entityKey: input => sessionEntityKey(input.sessionId),
  optimisticWrites: input => [{
    field: QUEUE_OVERLAY_FIELD,
    value: currentQueue(input.sessionId).map(entry =>
      entry.id === input.queueId ? { ...entry, text: input.text } : entry),
  }],
  buildMessage: input => ({
    type: 'queue:update' as const,
    session_id: input.sessionId,
    queue_id: input.queueId,
    text: input.text,
  }),
  timeoutMs: WS_TIMEOUT_MS,
};

const queueRemove: OperationDefinition<QueueSessionInput & { queueId: string }> = {
  policy: 'optimistic',
  entityKey: input => sessionEntityKey(input.sessionId),
  optimisticWrites: input => [{
    field: QUEUE_OVERLAY_FIELD,
    value: currentQueue(input.sessionId).filter(entry => entry.id !== input.queueId),
  }],
  buildMessage: input => ({
    type: 'queue:remove' as const,
    session_id: input.sessionId,
    queue_id: input.queueId,
  }),
  timeoutMs: WS_TIMEOUT_MS,
};

const queueClear: OperationDefinition<QueueSessionInput> = {
  policy: 'optimistic',
  entityKey: input => sessionEntityKey(input.sessionId),
  optimisticWrites: () => [{ field: QUEUE_OVERLAY_FIELD, value: [] }],
  buildMessage: input => ({ type: 'queue:clear' as const, session_id: input.sessionId }),
  timeoutMs: WS_TIMEOUT_MS,
};

const queueSendNow: OperationDefinition<QueueSessionInput> = {
  policy: 'pending',
  entityKey: input => sessionEntityKey(input.sessionId),
  buildMessage: input => ({ type: 'queue:send_now' as const, session_id: input.sessionId }),
  timeoutMs: WS_TIMEOUT_MS,
};

registry.register('queue.add', queueAdd);
registry.register('queue.update', queueUpdate);
registry.register('queue.remove', queueRemove);
registry.register('queue.clear', queueClear);
registry.register('queue.sendNow', queueSendNow);
