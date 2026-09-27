/** Loose inner result shapes for ZCode CLI 0.16.9 (upstream commit
 *  328c1a0c0ffaa5a4f65e8fa199af5e4c20706e5f). Only fields the adapter consumes
 *  are typed; everything else stays opaque and is never surfaced raw.
 *
 *  Key 0.16.9 facts this file encodes (packages/shared/src/zcode-protocol*):
 *  - `workspace/readState` no longer exists; the side-effect-free workspace
 *    read is `workspace/readPresentation` ({workspace, mode, slashCommands}).
 *  - Session snapshots report only the CURRENT model
 *    (`modelAvailability: "current"` in server-operations.ts), plus the full
 *    thoughtLevel list and permission mode.
 *  - Session info carries `sessionKind` and `parentSessionId`. */

export interface InnerModelRef {
  providerId: string;
  modelId: string;
  options?: { reasoningLevel?: string };
}

export interface InnerReasoningLevel {
  value: string;
  label?: string;
}

export interface InnerModelInfo {
  ref?: InnerModelRef;
  label?: string;
  providerLabel?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsImages?: boolean;
  supportsPdf?: boolean;
  supportsVideo?: boolean;
  reasoning?: {
    enabled?: boolean;
    levels?: InnerReasoningLevel[];
    defaultLevel?: string;
  };
}

export interface InnerSettings {
  mode?: { current?: string };
  model?: {
    available?: InnerModelInfo[];
    current?: InnerModelRef;
    lastUsed?: InnerModelRef;
  };
  permission?: { mode?: string };
  thoughtLevel?: {
    available?: InnerReasoningLevel[];
    current?: string;
    defaultLevel?: string;
    enabled?: boolean;
  };
}

export interface InnerSlashCommand {
  name?: string;
  description?: string;
  source?: string;
  inputHint?: string;
}

/** `workspace/readPresentation` result (0.16.9; no model facts). */
export interface InnerPresentation {
  workspace?: { workspacePath?: string; workspaceKey?: string };
  mode?: string;
  slashCommands?: InnerSlashCommand[];
}

export interface InnerSessionInfo {
  sessionId?: string;
  mode?: string;
  status?: string;
  model?: InnerModelRef;
  title?: string;
  titleSource?: string;
  sessionKind?: string;
  parentSessionId?: string;
  createdAt?: number;
  updatedAt?: number;
  workspace?: { workspacePath?: string; workspaceKey?: string };
}

export interface InnerTodoItem {
  content?: string;
  status?: string;
  priority?: string;
}

export interface InnerReadState {
  session?: InnerSessionInfo;
  settings?: InnerSettings;
  slashCommands?: InnerSlashCommand[];
  todos?: InnerTodoItem[];
  messages?: Array<unknown>;
  protocol?: { name?: string; version?: number };
}

export interface InnerSessionSummary {
  sessionId?: string;
  title?: string;
  status?: string;
  sessionKind?: string;
  parentSessionId?: string;
  updatedAt?: number;
  workspace?: { workspacePath?: string; workspaceKey?: string };
}

export interface InnerNativeEvent {
  eventId?: string;
  seq?: number;
  type?: string;
  timestamp?: number;
  payload?: Record<string, unknown>;
}

/** Normalized tool permission option (WP0 G2 schema). */
export interface InnerPermissionOption {
  optionId?: string;
  kind?: string;
  name?: string;
  description?: string;
  response?: Record<string, unknown>;
}

export interface InnerPermissionRequest {
  requestId?: string;
  sessionId?: string;
  turnId?: string;
  toolCallId?: string;
  toolName?: string;
  reason?: string;
  riskLevel?: string;
  input?: unknown;
  origin?: Record<string, unknown>;
  options?: InnerPermissionOption[];
}

/** `interaction/requestUserInput` question (shared/zp/index.ts:2356). */
export interface InnerUserInputQuestion {
  question?: string;
  header?: string;
  options?: Array<{
    value?: string;
    label?: string;
    description?: string;
    preview?: string;
  }>;
  multiSelect?: boolean;
}

export interface InnerUserInputRequest {
  requestId?: string;
  sessionId?: string;
  turnId?: string;
  toolCallId?: string;
  toolName?: string;
  prompt?: string;
  questions?: InnerUserInputQuestion[];
  input?: unknown;
  origin?: Record<string, unknown>;
  /** `schema.toolName` / `schema.interaction === "plan_approval"` identify the
   *  ExitPlanMode approval flow (interaction-broker.ts:301). */
  schema?: Record<string, unknown>;
}

/** `session/subagents` entry (shared/zp/index.ts:1521). */
export interface InnerSubagentEntry {
  childSessionId?: string;
  agentId?: string;
  toolCallId?: string;
  subagentType?: string;
  title?: string;
  summary?: string;
  startedAt?: number;
  endedAt?: number;
  status?: string;
}

export interface InnerSubagentsResult {
  revision?: number;
  childSessionIds?: string[];
  running?: InnerSubagentEntry[];
  ended?: { total?: number; items?: InnerSubagentEntry[]; nextCursor?: string };
}

/** `skills/referenceCatalog` entry (shared/zp/index.ts:2653). */
export interface InnerSkillEntry {
  id?: string;
  name?: string;
  description?: string;
  path?: string;
  scope?: string;
  enabled?: boolean;
  pluginName?: string;
}

/** `mcp/list` status snapshot (shared/zp/index.ts:687). */
export interface InnerMcpServerStatus {
  status?: string;
  transport?: string;
  toolCount?: number;
  updatedAt?: string;
  error?: string;
  failureKind?: string;
}

/** v4 conversation row base (zcode-protocol-v4/rows.ts rowBaseFields). */
export interface InnerConversationRow {
  rowId?: number;
  turnId?: string;
  entityId?: string;
  productTurnId?: string;
  kind?: string;
  state?: string;
  text?: string;
  toolName?: string;
  toolCallId?: string;
  subagentType?: string;
  childSessionId?: string;
  status?: string;
  actions?: { canFork?: true; canEdit?: true; canRetry?: true };
}

export interface InnerRowsRangeResult {
  rows?: InnerConversationRow[];
  atSeq?: number;
  atRevision?: number;
  atLogEpoch?: string;
  hasMore?: boolean;
}

/** v4 CommandAck (zcode-protocol-v4/command.ts:419). */
export interface InnerCommandAck {
  commandId?: string;
  status?: 'accepted' | 'rejected' | 'stale' | 'duplicate' | 'noop' | 'failed';
  reasonCode?: string;
  message?: string;
  revisionAtDecision?: number;
  result?: Record<string, unknown>;
}

export function innerProtocolMatches(state: InnerReadState | null | undefined): boolean {
  return state?.protocol?.name === 'ZCode Protocol' && state?.protocol?.version === 1;
}
