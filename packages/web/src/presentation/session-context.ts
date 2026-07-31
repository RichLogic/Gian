import type { ApprovalItem, AgentSpawnItem, TranscriptItem } from '../types.js';

export type PlanDisplayStatus =
  | 'active'
  | 'awaiting-review'
  | 'accepted'
  | 'revision-requested';

export interface PlanDisplayItem {
  kind: 'plan';
  id: string;
  markdown: string;
  status: PlanDisplayStatus;
  completedSteps: number;
  totalSteps: number;
}

export interface AgentRunDisplayItem {
  kind: 'agent-run';
  id: string;
  provider: AgentSpawnItem['provider'];
  agentId?: string;
  description: string;
  status: AgentSpawnItem['status'];
  agentType?: string;
  model?: string;
  output?: string;
  outputFile?: string;
  taskId?: string;
  background?: boolean;
  input?: Record<string, unknown>;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  turn: number;
}

export interface SessionContextDisplay {
  plan: PlanDisplayItem | null;
  agents: AgentRunDisplayItem[];
  runningAgents: number;
  failedAgents: number;
}

/**
 * The intentionally small cross-provider boundary: transcript rendering and
 * each CLI adapter may stay native, while this selector exposes only the two
 * persistent page objects that need to outlive an individual event row.
 */
export function projectSessionContext(params: {
  items: TranscriptItem[];
  planText?: string;
  planCompleted?: boolean;
  sessionId: string;
  includeAgentHistory?: boolean;
  includePlanHistory?: boolean;
}): SessionContextDisplay {
  const plan = projectPlan(
    params.items,
    params.planText,
    params.sessionId,
    params.planCompleted === true,
    params.includePlanHistory === true,
  );
  const agents = projectAgents(params.items, params.includeAgentHistory);
  return {
    plan,
    agents,
    runningAgents: agents.filter(agent => agent.status === 'running').length,
    failedAgents: agents.filter(agent => agent.status === 'error').length,
  };
}

function projectPlan(
  items: TranscriptItem[],
  planText: string | undefined,
  sessionId: string,
  planCompleted: boolean,
  includeHistory: boolean,
): PlanDisplayItem | null {
  let latestApproval: ApprovalItem | null = null;
  let latestApprovalIndex = -1;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item?.kind === 'approval' && item.category === 'exit_plan_mode') {
      latestApproval = item;
      latestApprovalIndex = i;
      break;
    }
  }

  if (latestApproval) {
    const accepted = latestApproval.status === 'approved-once'
      || latestApproval.status === 'approved-session';
    const resolvedAt = latestApproval.resolvedAt;
    const completedAfterAcceptance = accepted
      && resolvedAt != null
      && items.slice(latestApprovalIndex + 1).some(item =>
        item.kind === 'turn-end' && item.ts >= resolvedAt);
    if (!includeHistory && completedAfterAcceptance) return null;
    return planDisplay(
      latestApproval.approvalId,
      latestApproval.cmd,
      latestApproval.status === 'pending'
        ? 'awaiting-review'
        : latestApproval.status === 'declined'
          ? 'revision-requested'
          : 'accepted',
    );
  }

  const markdown = planText?.trim();
  if (!includeHistory && planCompleted) return null;
  return markdown
    ? planDisplay(`codex-plan-${sessionId}`, markdown, 'active')
    : null;
}

function planDisplay(
  id: string,
  markdown: string,
  status: PlanDisplayStatus,
): PlanDisplayItem {
  const checklist = markdown.match(/^\s*[-*]\s+\[([ xX])\]\s+/gm) ?? [];
  const completedSteps = checklist.filter(line => /\[[xX]\]/.test(line)).length;
  return {
    kind: 'plan',
    id,
    markdown,
    status,
    completedSteps,
    totalSteps: checklist.length,
  };
}

function projectAgents(
  items: TranscriptItem[],
  includeHistory = false,
): AgentRunDisplayItem[] {
  const byId = new Map<string, AgentRunDisplayItem>();
  const completedTurns = new Set(
    items.filter(item => item.kind === 'turn-end').map(item => item.turn),
  );
  for (const item of items) {
    if (item.kind !== 'agent-spawn') continue;
    const previous = byId.get(item.id);
    byId.set(item.id, {
      kind: 'agent-run',
      id: item.id,
      provider: item.provider,
      agentId: item.agentId ?? previous?.agentId,
      description: item.description || previous?.description || 'Agent task',
      status: item.status,
      agentType: item.agentType ?? previous?.agentType,
      model: item.model ?? previous?.model,
      output: item.output ?? previous?.output,
      outputFile: item.outputFile ?? previous?.outputFile,
      taskId: item.taskId ?? previous?.taskId,
      background: item.background ?? previous?.background,
      input: item.input
        ? { ...(previous?.input ?? {}), ...item.input }
        : previous?.input,
      startedAt: previous?.startedAt ?? item.startedAt,
      updatedAt: item.updatedAt,
      completedAt: item.completedAt ?? previous?.completedAt,
      turn: item.turn,
    });
  }
  return [...byId.values()]
    .filter(agent =>
      includeHistory
      || agent.status === 'running'
      || !completedTurns.has(agent.turn))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}
