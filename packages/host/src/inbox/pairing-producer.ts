import type { Db } from '../storage/db.js';

/** One pairing request is one Inbox generation. A new request id is the next item. */
const PAIRING_INBOX_GENERATION = 1;

export interface PairingInboxSink {
  applySignal(input: unknown): unknown;
}

export interface PairingInboxObserver {
  opened(subject: { id: string; deviceName: string | null }): void;
  closed(
    id: string,
    outcome: 'resolved' | 'rejected' | 'expired',
    actor: 'user' | 'system',
  ): void;
}

/**
 * Inbox mirror for a pairing request that has reached pending_confirmation.
 * A missing Inbox row is left missing: closing must not invent a tombstone
 * for a code that was never shown. The pairing code is not part of the item.
 */
export function pairingInboxObserver(db: Db, inbox: PairingInboxSink): PairingInboxObserver {
  return {
    opened(subject) {
      inbox.applySignal({
        kind: 'system.pairing',
        request_id: subject.id,
        generation: PAIRING_INBOX_GENERATION,
        title: 'Confirm pairing',
        summary: pairingSummary(subject.deviceName),
      });
    },
    closed(id, outcome, actor) {
      const pending = db.prepare(
        `SELECT 1 AS ok FROM inbox_items
          WHERE source_key = ? AND status = 'pending'`,
      ).get(pairingSourceKey(id)) as { ok: number } | undefined;
      if (!pending) return;
      inbox.applySignal({
        kind: 'system.pairing.closed',
        request_id: id,
        generation: PAIRING_INBOX_GENERATION,
        outcome,
        actor,
      });
    },
  };
}

function pairingSourceKey(id: string): string {
  return `system.pairing:${id}`;
}

function pairingSummary(deviceName: string | null): string {
  const cleaned = (deviceName ?? '')
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!cleaned) return 'A device is waiting for confirmation';
  return `Confirm ${Array.from(cleaned).slice(0, 200).join('')}`;
}
