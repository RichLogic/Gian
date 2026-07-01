// Authorization for a parsed Gian action (proposal §4A.A execution contract ④).
// Pure and side-effect-free — decides execute / staged / rejected from the
// sender's role, the action, and the task's active loop (if any). No DB, no IO.
//
//   • Role hard gate: create_subtask / message_subtask are PM-only; submit_step
//     is engineer-only. A mismatch is REJECTED (anti-privilege-escalation).
//   • submit_step writes only the sender's own summary, so it always executes
//     once past the role gate — but if a loop pins the current step to a
//     specific session, a different session's submit_step is rejected (spoof).
//   • create_subtask / message_subtask have cross-session effects: they execute
//     only inside an active loop that authorizes them; otherwise they are STAGED
//     for a one-click user confirm (the everyday no-loop path). Empty allowlists
//     mean "no restriction" — an active loop already encodes user intent.

import type { GianAction, GianActionMethod, Role, TaskLoop } from '@gian/shared';

export type AuthDecision = 'execute' | 'staged' | 'rejected';

export interface AuthResult {
  decision: AuthDecision;
  reason: string;
}

/** Which role is allowed to emit each method. */
export const METHOD_REQUIRED_ROLE: Record<GianActionMethod, Role> = {
  create_subtask: 'pm',
  message_subtask: 'pm',
  submit_step: 'engineer',
};

export interface AuthorizeInput {
  action: GianAction;
  /** Role of the session that emitted the action. */
  senderRole: Role;
  senderSessionId: string;
  /** The task's active loop, or null when none is running. */
  loop: TaskLoop | null;
  /** Canonical workspace id resolved from a create_subtask's `workspace` param
   *  (execution contract ⑧). Null when it did not resolve. */
  workspaceId?: string | null;
}

export function authorizeAction(input: AuthorizeInput): AuthResult {
  const { action, senderRole, senderSessionId, loop, workspaceId } = input;
  const required = METHOD_REQUIRED_ROLE[action.method];

  // 1. Role hard gate.
  if (senderRole !== required) {
    return {
      decision: 'rejected',
      reason: `${action.method} may only be sent by ${required} (sender is ${senderRole})`,
    };
  }

  // 2. submit_step — the engineer reporting its own step.
  if (action.method === 'submit_step') {
    if (loop && loop.current_step_session_id && loop.current_step_session_id !== senderSessionId) {
      return { decision: 'rejected', reason: 'submit_step from a session that is not the current step' };
    }
    return { decision: 'execute', reason: 'submit_step by the step owner' };
  }

  // 3. create_subtask / message_subtask — need an authorizing active loop, else
  //    stage for user confirm.
  if (!loop || loop.status !== 'active') {
    return { decision: 'staged', reason: loop ? `loop is ${loop.status}` : 'no active loop — awaiting user confirm' };
  }
  if (loop.allowed_methods.length > 0 && !loop.allowed_methods.includes(action.method)) {
    return { decision: 'staged', reason: `${action.method} not in loop.allowed_methods` };
  }
  if (loop.max_rounds > 0 && loop.round >= loop.max_rounds) {
    return { decision: 'staged', reason: 'loop round budget exhausted' };
  }
  if (action.method === 'create_subtask') {
    if (loop.allowed_executors.length > 0 && !loop.allowed_executors.includes(action.params.executor)) {
      return { decision: 'staged', reason: `executor ${action.params.executor} not allowed by loop` };
    }
    if (loop.allowed_workspaces.length > 0 && (!workspaceId || !loop.allowed_workspaces.includes(workspaceId))) {
      return { decision: 'staged', reason: 'workspace not allowed by loop' };
    }
  }
  return { decision: 'execute', reason: 'authorized by active loop' };
}
