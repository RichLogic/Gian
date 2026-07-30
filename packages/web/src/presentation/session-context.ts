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
  startedAt: number;
  updatedAt: number;
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
  sessionId: string;
}): SessionContextDisplay {
  const plan = projectPlan(params.items, params.planText, params.sessionId);
  const agents = projectAgents(params.items);
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
): PlanDisplayItem | null {
  let latestApproval: ApprovalItem | null = null;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item?.kind === 'approval' && item.category === 'exit_plan_mode') {
      latestApproval = item;
      break;
    }
  }

  if (latestApproval) {
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

function projectAgents(items: TranscriptItem[]): AgentRunDisplayItem[] {
  const byId = new Map<string, AgentRunDisplayItem>();
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
      startedAt: previous?.startedAt ?? item.startedAt,
      updatedAt: item.updatedAt,
    });
  }
  return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}
