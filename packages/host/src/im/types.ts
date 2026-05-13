/**
 * rvc 域类型移植 —— 仅抽取 IM 模块直接使用的部分。
 *
 * IM 内部继续用 rvc 方言(SessionRecord、PendingApproval、CodexThread 等),
 * 与 Gian 自有领域类型(Session、ApprovalRecord、…)的互转放在 Phase 6 的
 * `build-options.ts` 适配层里。
 *
 * 如果将来要把 IM 的内部类型也对齐到 Gian,可以让这个文件里的接口逐步
 * 迁移到 `@gian/shared`,然后删除这里的副本。
 */

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

// Originally rvc used 'detailed' / 'less-interruption' / 'full-auto'. We
// realign to Gian's `'plan' | 'ask' | 'auto'` so:
//   - the IM `/alter` flow can offer all three (rvc only listed two)
//   - no rvc↔Gian mode translation in the bridged repo / build-options
//   - IM users see the same vocabulary as the web UI
export type ApprovalMode = 'plan' | 'ask' | 'auto';
export type ApprovalScope = 'once' | 'session';
export type SessionStatus = 'idle' | 'running' | 'needs-approval' | 'error' | 'stale';
export type SessionExecutionMode = 'interactive' | 'job';
export type SessionType = 'code' | 'chat';
export type AgentExecutor = 'codex' | 'claude';
export type SecurityProfile = 'read-only' | 'repo-write' | 'full-host';
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export type TranscriptEventKind = 'user' | 'assistant' | 'tool' | 'status';
export type SessionAttachmentKind = 'image' | 'file' | 'pdf';

export type SessionJobState =
  | 'pending'
  | 'running'
  | 'waiting-approval'
  | 'waiting-input'
  | 'completed'
  | 'failed'
  | 'budget-exhausted';

// Re-exported from `messaging/types.ts` so callers can do
// `import type { MessagingBotStatus } from '../types.js'` like in rvc.
export type { MessagingBotStatus } from './messaging/types.js';
import type { MessagingBotStatus } from './messaging/types.js';
export type DiscordBotStatus = MessagingBotStatus;
export type SlackBotStatus = MessagingBotStatus;

// ---------------------------------------------------------------------------
// User / workspace / model
// ---------------------------------------------------------------------------

export interface UserRecord {
  id: string;
  username: string;
  /** rvc has a richer role model; Gian is single-user. We keep the field
   *  names so the IM code paths don't need to know. */
  roles: Array<'user' | 'developer' | 'admin'>;
  preferredMode: 'chat' | 'developer' | 'claude' | null;
  isAdmin: boolean;
  allowedSessionTypes: SessionType[];
  canUseFullHost: boolean;
  createdAt: string;
  updatedAt: string;
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

// ---------------------------------------------------------------------------
// Sessions / turns
// ---------------------------------------------------------------------------

export interface BaseTurnRecord {
  id: string;
  ownerUserId: string;
  ownerUsername: string;
  sessionType: SessionType;
  threadId: string;
  activeTurnId: string | null;
  title: string;
  autoTitle: boolean;
  workspace: string;
  archivedAt: string | null;
  securityProfile: SecurityProfile;
  approvalMode: ApprovalMode;
  networkEnabled: boolean;
  fullHostEnabled: boolean;
  status: SessionStatus;
  lastIssue: string | null;
  hasTranscript: boolean;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  createdAt: string;
  updatedAt: string;
}

export interface SessionRecord extends BaseTurnRecord {
  sessionType: 'code';
  executor: AgentExecutor;
  workspaceId: string;
  origin?: 'web' | 'discord' | 'slack' | (string & {});
  botId?: string | null;
  executionMode?: SessionExecutionMode;
  job?: SessionJobRecord | null;
}

export interface SessionJobRecord {
  id: string;
  state: SessionJobState;
  goal: string;
  round: number;
  maxRounds: number;
  startedAt: string;
  updatedAt: string;
  latestSummary: string | null;
  waitingReason: string | null;
  finalOutput: string | null;
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

// ---------------------------------------------------------------------------
// Codex thread shape — used by sendTurnCompletion to summarise turns.
// IM consumers only read these fields; we don't fabricate codex semantics
// in Gian, the build-options adapter passes `null` for now.
// ---------------------------------------------------------------------------

export interface CodexThreadTextInput {
  type: 'text';
  text: string;
  text_elements: unknown[];
}

export interface CodexThreadLocalImageInput {
  type: 'localImage';
  path: string;
}

export type CodexThreadInput = CodexThreadTextInput | CodexThreadLocalImageInput;

export interface CodexUserMessageItem {
  type: 'userMessage';
  id: string;
  content: CodexThreadInput[];
}

export interface CodexAgentMessageItem {
  type: 'agentMessage';
  id: string;
  text: string;
  phase: string | null;
}

export interface CodexPlanItem {
  type: 'plan';
  id: string;
  text: string;
}

export interface CodexReasoningItem {
  type: 'reasoning';
  id: string;
  summary: string[];
  content: string[];
}

export interface CodexCommandExecutionItem {
  type: 'commandExecution';
  id: string;
  command: string;
  cwd: string;
  status: string;
  aggregatedOutput: string | null;
  exitCode: number | null;
}

export interface CodexFileChangeItem {
  type: 'fileChange';
  id: string;
  status: string;
  changes: Array<{
    path: string;
    kind: { type?: string };
    diff?: string | null;
  }>;
}

export interface CodexGenericItem {
  type: string;
  id: string;
  [key: string]: unknown;
}

export type CodexThreadItem =
  | CodexUserMessageItem
  | CodexAgentMessageItem
  | CodexPlanItem
  | CodexReasoningItem
  | CodexCommandExecutionItem
  | CodexFileChangeItem
  | CodexGenericItem;

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
  path?: string | null;
  cliVersion?: string | null;
  source?: string | null;
  modelProvider?: string | null;
  gitInfo?: {
    sha?: string;
    branch?: string;
    originUrl?: string;
  };
  status: { type: string; activeFlags?: string[] } | string;
  updatedAt: number;
  turns: CodexTurn[];
}

// ---------------------------------------------------------------------------
// Admin views — IM repositories surface these to REST endpoints
// ---------------------------------------------------------------------------

export interface AdminDiscordBotRecord {
  id: string;
  ownerUserId: string;
  ownerUsername: string;
  label: string;
  applicationId: string | null;
  botUserId: string | null;
  allowedDiscordUserId: string | null;
  selectedWorkspaceId: string | null;
  directChannelId: string | null;
  enabled: boolean;
  hasToken: boolean;
  status: DiscordBotStatus;
  lastError: string | null;
  lastConnectedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminSlackBotRecord {
  id: string;
  ownerUserId: string;
  ownerUsername: string;
  label: string;
  teamId: string | null;
  botUserId: string | null;
  allowedSlackUserId: string | null;
  selectedWorkspaceId: string | null;
  directChannelId: string | null;
  commandPrefix: string | null;
  enabled: boolean;
  hasBotToken: boolean;
  hasAppToken: boolean;
  hasConfigToken: boolean;
  status: SlackBotStatus;
  lastError: string | null;
  lastConnectedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Transcript / event records (used by manager when summarising completion)
// ---------------------------------------------------------------------------

export interface SessionAttachmentSummary {
  id: string;
  kind: SessionAttachmentKind;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  url: string;
  createdAt: string;
}

export interface SessionFileChange {
  path: string;
  kind: string;
  diff: string | null;
}

export interface SessionTranscriptEntry {
  id: string;
  index: number;
  kind: TranscriptEventKind;
  body: string;
  markdown: boolean;
  label: string | null;
  title: string | null;
  meta: string | null;
  attachments: SessionAttachmentSummary[];
  fileChanges?: SessionFileChange[];
}

export interface SessionCommandEvent {
  id: string;
  index: number;
  command: string;
  cwd: string;
  status: string;
  exitCode: number | null;
  output: string;
}

export interface SessionFileChangeEvent {
  id: string;
  index: number;
  path: string;
  kind: string;
  status: string;
  diff: string | null;
}
