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
import type { ApprovalDecision } from '@gian/shared';

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
  answers?: Record<string, string | string[]>;
  /** Exact executor option for ACP-native approvals. */
  nativeOptionId?: string;
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
  }),
  timeoutMs: WS_TIMEOUT_MS,
};

registry.register('approval.resolve', approvalResolve);
