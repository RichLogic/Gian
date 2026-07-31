/** Shared view models used by the Slack and Discord adapters. */

export type ApprovalMode = 'plan' | 'ask' | 'auto';
export type ApprovalScope = 'once' | 'session';
export type SessionStatus = 'idle' | 'running' | 'needs-approval' | 'error' | 'stale';
export type AgentExecutor = 'codex' | 'claude';
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export type { MessagingBotStatus } from './messaging/types.js';
import type { MessagingBotStatus } from './messaging/types.js';
export type DiscordBotStatus = MessagingBotStatus;
export type SlackBotStatus = MessagingBotStatus;

export interface UserRecord {
  id: string;
  username: string;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  path: string;
  visible: boolean;
  sortOrder: number;
}

export interface ModelOption {
  id: string;
  displayName: string;
  model: string;
  description: string;
  isDefault: boolean;
  hidden: boolean;
  defaultReasoningEffort: ReasoningEffort;
  supportedReasoningEfforts: ReasoningEffort[];
}

/**
 * Canonical Gian session projected into the fields required by chat
 * platforms. Platform ownership lives on each bot's selected_session_id;
 * it is deliberately not duplicated here.
 */
export interface MessagingSession {
  id: string;
  ownerUserId: string;
  ownerUsername: string;
  sessionType: 'code';
  executor: AgentExecutor;
  workspaceId: string;
  threadId: string;
  activeTurnId: string | null;
  title: string;
  autoTitle: boolean;
  workspace: string;
  archivedAt: string | null;
  approvalMode: ApprovalMode;
  status: SessionStatus;
  lastIssue: string | null;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  createdAt: string;
  updatedAt: string;
}

export interface PendingApproval {
  id: string;
  sessionId: string;
  rpcRequestId: number | string;
  method: string;
  title: string;
  risk: string;
  scopeOptions: ApprovalScope[];
  source: AgentExecutor;
  payload: unknown;
  createdAt: string;
}

export interface CodexAgentMessageItem {
  type: 'agentMessage';
  id: string;
  text: string;
  phase: string | null;
}

export interface CodexGenericItem {
  type: string;
  id: string;
  [key: string]: unknown;
}

export type CodexThreadItem = CodexAgentMessageItem | CodexGenericItem;

export interface CodexTurn {
  id: string;
  status: string;
  error: { message?: string } | null;
  items: CodexThreadItem[];
}

export interface CodexThread {
  id: string;
  preview: string;
  cwd: string;
  name: string | null;
  status: { type: string; activeFlags?: string[] } | string;
  updatedAt: number;
  turns: CodexTurn[];
}
