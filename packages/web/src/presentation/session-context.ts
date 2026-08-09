import type { ApprovalItem, AgentSpawnItem, TranscriptItem } from '../types.js';
import { transcriptItemIdentity } from '../transcript/identity.js';

export type PlanDisplayStatus =
  | 'active'
  | 'paused'
  | 'completed'
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
  status: AgentSpawnItem['status'] | 'interrupted';
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
  completedAgents: number;
  failedAgents: number;
  interruptedAgents: number;
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
  planStatus?: 'active' | 'paused' | 'completed';
  planTurn?: number;
  sessionId: string;
  includeAgentHistory?: boolean;
  includePlanHistory?: boolean;
}): SessionContextDisplay {
  const plan = projectPlan(
    params.items,
    params.planText,
    params.sessionId,
    params.planCompleted === true,
    params.planStatus,
    params.planTurn,
    params.includePlanHistory === true,
  );
  const agents = projectAgents(params.items, params.includeAgentHistory);
  return {
    plan,
    agents,
    runningAgents: agents.filter(agent => agent.status === 'running').length,
    completedAgents: agents.filter(agent => agent.status === 'done').length,
    failedAgents: agents.filter(agent => agent.status === 'error').length,
    interruptedAgents: agents.filter(agent => agent.status === 'interrupted').length,
  };
}

function projectPlan(
  items: TranscriptItem[],
  planText: string | undefined,
  sessionId: string,
  planCompleted: boolean,
  planStatus: 'active' | 'paused' | 'completed' | undefined,
  planTurn: number | undefined,
  includeHistory: boolean,
): PlanDisplayItem | null {
  const latestTurn = latestTranscriptTurn(items);
  const nextTurnPending = hasPendingUserTurn(items);
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
    const completion = accepted && resolvedAt != null
      ? items.slice(latestApprovalIndex + 1).find(item =>
        item.kind === 'turn-end' && item.ts >= resolvedAt)
      : undefined;
    // Keep the just-finished plan available for inspection while the session
    // is idle. It becomes history as soon as a newer turn starts.
    if (!includeHistory && completion
        && (nextTurnPending || latestTurn > completion.turn)) return null;
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
  const status = planStatus ?? (planCompleted ? 'completed' : 'active');
  // New lifecycle-aware callers retain a completed plan through the idle
  // boundary and remove it when the next turn begins. Keep the legacy
  // immediate-hide behavior when no lifecycle turn is available.
  if (!includeHistory && status === 'completed'
      && (planTurn == null || nextTurnPending || latestTurn > planTurn)) return null;
  return markdown
    ? planDisplay(`codex-plan-${sessionId}`, markdown, status)
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
  const latestTurn = latestTranscriptTurn(items);
  const nextTurnPending = hasPendingUserTurn(items);
  const terminalTurnAt = new Map<number, number>();
  for (const item of items) {
    if (item.kind !== 'turn-end' && item.kind !== 'error') continue;
    const previous = terminalTurnAt.get(item.turn);
    if (previous == null || item.ts < previous) terminalTurnAt.set(item.turn, item.ts);
  }
  for (const item of items) {
    if (item.kind !== 'agent-spawn') continue;
    const identity = transcriptItemIdentity(item);
    const previous = byId.get(identity);
    const input = item.input
      ? { ...(previous?.input ?? {}), ...item.input }
      : previous?.input;
    const agentType = item.agentType ?? previous?.agentType;
    byId.set(identity, {
      kind: 'agent-run',
      id: identity,
      provider: item.provider,
      agentId: item.agentId ?? previous?.agentId,
      description: item.description
        || previous?.description
        || descriptionFromAgentInput(input)
        || descriptionFromAgentType(agentType)
        || 'Agent task',
      status: item.status,
      agentType,
      model: item.model ?? previous?.model,
      output: item.output ?? previous?.output,
      outputFile: item.outputFile ?? previous?.outputFile,
      taskId: item.taskId ?? previous?.taskId,
      background: item.background ?? previous?.background,
      input,
      startedAt: previous?.startedAt ?? item.startedAt,
      updatedAt: item.updatedAt,
      completedAt: item.completedAt ?? previous?.completedAt,
      turn: item.turn,
    });
  }
  return [...byId.values()].map(agent => {
    const closedAt = terminalTurnAt.get(agent.turn);
    const turnHasMovedOn = latestTurn > agent.turn
      || (nextTurnPending && latestTurn === agent.turn);
    if (agent.status !== 'running' || agent.background === true
        || (closedAt == null && !turnHasMovedOn)) return agent;
    // A foreground child cannot remain live after its parent turn has ended.
    // Do not claim success without a terminal child event; surface the honest
    // fallback state and freeze its duration at the enclosing turn boundary.
    return {
      ...agent,
      status: 'interrupted' as const,
      completedAt: agent.completedAt ?? closedAt ?? agent.updatedAt,
    };
  })
    .filter(agent => includeHistory
      || (!nextTurnPending && agent.turn === latestTurn)
      || (agent.status === 'running' && agent.background === true))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function latestTranscriptTurn(items: TranscriptItem[]): number {
  let latest = 0;
  for (const item of items) if (item.turn > latest) latest = item.turn;
  return latest;
}

function hasPendingUserTurn(items: TranscriptItem[]): boolean {
  return items.some(item => item.kind === 'user' && item.pending === true);
}

function descriptionFromAgentInput(input: Record<string, unknown> | undefined): string {
  if (!input) return '';
  for (const key of ['prompt', 'description', 'task', 'message']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function descriptionFromAgentType(agentType: string | undefined): string {
  if (!agentType) return '';
  const leaf = agentType.split('/').filter(Boolean).pop() ?? agentType;
  const words = leaf.replace(/[_-]+/g, ' ').trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : '';
}
