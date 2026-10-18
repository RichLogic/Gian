/**
 * UI Operation Layer — Approval-domain definition (Phase 2b of
 * `docs/archive/proposals/ui-operation-layer.md`).
 *
 * `approval.resolve` is pending (proposal §5): clicking any decision
 * immediately disables the submitted card and labels it resolving — the card
 * derives that state from the in-flight run (`useOperationPending` keyed by
 * `approval:<approvalId>`). The canonical settle is the `interaction.resolved`
 * transcript envelope (approval:created/approval:updated carry no session
 * routing for the transcript); the operation:result ends the pending phase.
 * Failure settles the run as failed — the card re-enables — and the host's
 * `error` envelope surfaces the toast.
 *
 * The entity key includes the approval id so resolving two DIFFERENT
 * approvals never trips the duplicate pending guard; re-clicking the SAME
 * approval while in flight is blocked.
 */
import type { ApprovalDecision, NativeApprovalOption } from '@gian/shared';

import { registry } from './registry.js';
import type { OperationDefinition } from './types.js';

/** WS round-trips are normally well under this; expiry marks the outcome
 *  unknown (never failed) per proposal §4.3. */
const WS_TIMEOUT_MS = 10_000;

export interface ApprovalResolveInput {
  sessionId: string;
  approvalId: string;
  decision: ApprovalDecision;
  /** Structured answers for AskUserQuestion-flavored approvals. */
  answers?: Record<string, string | boolean | string[]>;
  /** Exact executor option for ACP-native approvals. */
  nativeOptionId?: string;
  /** Inbox-originated decisions carry the exact occurrence the user saw
   *  (0.6.7): the Host checks that row/session/interaction/turn before any
   *  resolve and answers a mismatch with PRECONDITION_FAILED. Non-Inbox
   *  callers omit it, preserving the existing contract. */
  expectedInbox?: { id: string; generation: number };
}

/** Map a Gian decision intent to the exact native option for ACP-native
 *  approvals: ONLY allow_once → allow_once and decline → reject_once (plan
 *  decisions and everything else never map). Opaque ids are never guessed,
 *  nothing widens to allow_always, and multiple same-kind options are never
 *  picked arbitrarily — null means the caller shows the canonical card. */
export function nativeOptionForDecision(
  options: NativeApprovalOption[] | undefined,
  decision: ApprovalDecision,
): NativeApprovalOption | null {
  if (!options || options.length === 0) return null;
  const wanted = decision === 'allow_once'
    ? 'allow_once'
    : decision === 'decline'
      ? 'reject_once'
      : null;
  if (!wanted) return null;
  const matches = options.filter(option => option.kind === wanted);
  return matches.length === 1 ? matches[0]! : null;
}

const approvalResolve: OperationDefinition<ApprovalResolveInput> = {
  policy: 'pending',
  entityKey: input => `approval:${input.approvalId}`,
  buildMessage: input => ({
    type: 'approval:resolve' as const,
    session_id: input.sessionId,
    approval_id: input.approvalId,
    decision: input.decision,
    ...(input.answers ? { answers: input.answers } : {}),
    ...(input.nativeOptionId ? { native_option_id: input.nativeOptionId } : {}),
    ...(input.expectedInbox ? { expected_inbox: input.expectedInbox } : {}),
  }),
  timeoutMs: WS_TIMEOUT_MS,
};

registry.register('approval.resolve', approvalResolve);
