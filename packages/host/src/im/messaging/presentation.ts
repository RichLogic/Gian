import { basename } from 'node:path';
import type {
  ApprovalScope,
  CodexThread,
  MessagingSession,
  PendingApproval,
  WorkspaceSummary,
} from '../types.js';

export function isBusySession(session: MessagingSession | null): boolean {
  return Boolean(
    session
    && (session.activeTurnId || session.status === 'running' || session.status === 'needs-approval'),
  );
}

export function trimPrompt(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function workspaceDisplayName(
  workspace: Pick<WorkspaceSummary, 'name' | 'path'>,
): string {
  return workspace.name || basename(workspace.path) || workspace.path;
}

export function sessionWorkspaceDisplayName(
  session: Pick<MessagingSession, 'workspace'>,
): string {
  return basename(session.workspace) || session.workspace;
}

export function sessionDisplayName(
  session: Pick<MessagingSession, 'title' | 'id'>,
): string {
  return session.title.trim() || `Session ${session.id.slice(0, 8)}`;
}

export function sessionStatusLabel(session: MessagingSession | null): string {
  return session?.status ?? 'not-started';
}

export function summarizeTurn(thread: CodexThread, turnId: string): {
  assistantText: string | null;
  errorMessage: string | null;
} {
  const turn = thread.turns.find(entry => entry.id === turnId);
  if (!turn) {
    return { assistantText: null, errorMessage: null };
  }
  const assistantText = turn.items
    .filter((item): item is Extract<typeof turn.items[number], { type: 'agentMessage' }> =>
      item.type === 'agentMessage')
    .map(item => item.text)
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join('\n\n')
    .trim();
  return {
    assistantText: assistantText || null,
    errorMessage: turn.error?.message ?? null,
  };
}

export function chunkMessage(content: string, limit: number): string[] {
  const normalized = content.trim();
  if (normalized.length <= limit) return [normalized];

  const chunks: string[] = [];
  let remaining = normalized;
  while (remaining.length > limit) {
    const boundary = remaining.lastIndexOf('\n', limit);
    const nextIndex = boundary > Math.floor(limit * 0.5) ? boundary : limit;
    chunks.push(remaining.slice(0, nextIndex).trimEnd());
    remaining = remaining.slice(nextIndex).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export function isInterruptedMessage(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return false;
  return [
    'interrupt',
    'interrupted',
    'stopped',
    'cancelled',
    'canceled',
    '停止',
    '中断',
    '取消',
  ].some(fragment => normalized.includes(fragment));
}

export function approvalReplyAction(
  prompt: string,
): { decision: 'approve' | 'decline'; scope?: ApprovalScope } | null {
  const trimmed = prompt.trim().toLowerCase();
  if (!trimmed) return null;
  const normalized = trimmed.startsWith('/') ? trimmed.slice(1) : trimmed;
  switch (normalized) {
    case '1':
    case 'a':
      return { decision: 'approve', scope: 'once' };
    case '2':
    case 'b':
      return { decision: 'approve', scope: 'session' };
    case '3':
    case 'c':
      return { decision: 'decline', scope: 'once' };
    default:
      return null;
  }
}

export function approvalSupportsSessionScope(
  approval: Pick<PendingApproval, 'scopeOptions'>,
): boolean {
  return approval.scopeOptions.includes('session');
}

export function approvalMessageBody(
  approval: PendingApproval,
  summary?: string | null,
): string {
  const nextSummary = summary?.trim() ?? '';
  const title = approval.title.trim();
  const risk = approval.risk.trim();
  const lines: string[] = [];

  if (nextSummary && nextSummary !== risk) lines.push(nextSummary);
  if (title) lines.push(`审批请求：${title}`);
  if (risk && risk !== title) lines.push(risk);
  lines.push('', '回复 1 或 a：批准一次');
  if (approvalSupportsSessionScope(approval)) {
    lines.push('回复 2 或 b：当前 session 持续批准');
  }
  lines.push('回复 3 或 c：拒绝');
  return lines.join('\n').trim();
}
