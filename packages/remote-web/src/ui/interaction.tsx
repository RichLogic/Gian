/**
 * Remote interaction projection (B7): wire `RemoteInteraction` → chat-ui
 * `ApprovalItem`, rendered by the shared `ApprovalCard`. The card reports
 * back ONLY the Host-given opaque action id (`nativeOptionId`) plus the
 * collected input values; the UI never constructs decisions or risk itself.
 */

import type { ApprovalItem, OnApprove } from '@gian/chat-ui';
import type { ApprovalCategory, InteractionAction, InteractionInput } from '@gian/shared';
import type { RemoteInteraction } from '@gian/remote-protocol';
import type { InteractionPhase } from '../controller/types.js';

function mapKind(interaction: RemoteInteraction): ApprovalItem['interactionKind'] {
  switch (interaction.kind) {
    case 'question': return 'question';
    case 'native_choice': return 'choice';
    case 'exit_plan_mode': return 'confirmation';
    default: return 'permission';
  }
}

function mapCategory(interaction: RemoteInteraction): ApprovalCategory {
  switch (interaction.kind) {
    case 'question': return 'question';
    case 'exit_plan_mode': return 'exit_plan_mode';
    default: return 'command';
  }
}

export function projectInteraction(
  interaction: RemoteInteraction,
  phase: InteractionPhase,
  phaseLabel?: string,
): ApprovalItem {
  const p = interaction.presentation;
  // Terminal phases render the compressed resolved line (ApprovalLine); the
  // question shape is used so the phase label surfaces as the note.
  if (phase !== 'pending' && phase !== 'responding') {
    return {
      kind: 'approval',
      id: `interaction-${interaction.id}`,
      approvalId: interaction.id,
      title: p.title,
      reason: '',
      cmd: '',
      risk: p.risk,
      status: 'approved-once',
      category: 'question',
      answeredWith: phaseLabel,
      ts: Date.parse(interaction.created_at) || Date.now(),
      turn: 0,
    };
  }
  const actions: InteractionAction[] = p.actions.map((a) => ({
    id: a.id,
    label: a.label,
    style: a.tone === 'danger' ? 'danger' : 'secondary',
  }));
  const inputs: InteractionInput[] | undefined = p.inputs?.map((input) => ({
    id: input.id,
    type: input.type,
    label: input.label,
    required: false,
    choices: input.options?.map((o) => ({ value: o.value, displayName: o.label })),
  }));
  return {
    kind: 'approval',
    id: `interaction-${interaction.id}`,
    approvalId: interaction.id,
    title: p.title,
    reason: p.description,
    cmd: p.subject ?? p.title,
    hasSubject: p.subject !== undefined,
    risk: p.risk,
    // Responding stays pending-shaped (buttons disabled); terminal phases
    // render the compressed resolved line (handled above).
    status: 'pending',
    category: mapCategory(interaction),
    actions,
    inputs,
    interactionKind: mapKind(interaction),
    ts: Date.parse(interaction.created_at) || Date.now(),
    turn: 0,
  };
}

/** Build the onApprove callback for the transcript: only the opaque action
 *  id + collected values cross the boundary. A missing action id (a crafted
 *  or legacy-shaped callback) is refused here and again in the controller. */
export function interactionResponder(
  respond: (interactionId: string, actionId: string, values?: Record<string, string | boolean | string[]>) => void,
): OnApprove {
  return (approvalId, _decision, answers, context) => {
    const actionId = context?.nativeOptionId;
    if (!actionId) return;
    respond(approvalId, actionId, answers);
  };
}
