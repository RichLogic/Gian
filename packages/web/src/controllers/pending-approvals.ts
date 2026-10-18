/**
 * Pending approvals read model (0.6.7, Inbox issue #1): the canonical
 * `native_options` of each pending approval, so Inbox decisions can bind the
 * exact executor option id the Host validates. Interaction ids are unique
 * only within a session, so records key on (session_id, approval id) and
 * carry turn/status identity. A missing record means NOT SYNCED — never
 * treat it as "no native options": the caller must not dispatch a decision
 * that would fail Host-side validation. Fed by `state_sync.approvals`,
 * upserted by `approval:created`, removed when `approval:updated` leaves
 * pending.
 */
import type { Approval, NativeApprovalOption } from '@gian/shared';

export interface PendingApprovalRecord {
  sessionId: string;
  status: string;
  turn_number?: number;
  native_options?: NativeApprovalOption[];
}

let records = new Map<string, PendingApprovalRecord>();

function keyOf(sessionId: string, approvalId: string): string {
  // Interaction ids are only unique within their session, and plain
  // concatenation collides ('a'+'bc' vs 'ab'+'c') — length-prefix instead.
  return `${sessionId.length}:${sessionId}${approvalId}`;
}

/** Rebuild from the state_sync approval list (reconnect authority). */
export function syncPendingApprovals(approvals: Approval[]): void {
  records = new Map(
    approvals
      .filter(approval => approval.status === 'pending')
      .map(approval => [
        keyOf(approval.session_id, approval.id),
        {
          sessionId: approval.session_id,
          status: approval.status,
          ...(approval.turn_number !== undefined ? { turn_number: approval.turn_number } : {}),
          ...(approval.native_options !== undefined ? { native_options: approval.native_options } : {}),
        },
      ]),
  );
}

/** One approval frame: pending upserts, anything else drops the record. */
export function upsertPendingApproval(approval: {
  id: string;
  session_id?: string;
  status: string;
  native_options?: NativeApprovalOption[];
  turn_number?: number;
}): void {
  const sessionId = approval.session_id;
  if (!sessionId) return;
  const key = keyOf(sessionId, approval.id);
  if (approval.status === 'pending') {
    records.set(key, {
      sessionId,
      status: approval.status,
      ...(approval.turn_number !== undefined ? { turn_number: approval.turn_number } : {}),
      ...(approval.native_options !== undefined ? { native_options: approval.native_options } : {}),
    });
    return;
  }
  records.delete(key);
}

/** The record for one pending approval — undefined means NOT SYNCED (never
 *  "no native options"; the caller distinguishes the two). */
export function peekPendingApproval(
  sessionId: string,
  approvalId: string,
): PendingApprovalRecord | undefined {
  return records.get(keyOf(sessionId, approvalId));
}

/** Test helper. */
export function __resetPendingApprovals(): void {
  records = new Map();
}
