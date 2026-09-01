/** Loose inner result shapes (WP0-frozen). Only fields the adapter consumes
 *  are typed; everything else stays opaque and is never surfaced raw. */

export interface InnerModelRef {
  providerId: string;
  modelId: string;
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

export interface InnerReadState {
  session?: {
    sessionId?: string;
    mode?: string;
    status?: string;
    model?: InnerModelRef;
    title?: string;
    createdAt?: number;
    updatedAt?: number;
    workspace?: { workspacePath?: string; workspaceKey?: string };
  };
  settings?: InnerSettings;
  slashCommands?: InnerSlashCommand[];
  protocol?: { name?: string; version?: number };
}

export interface InnerSessionSummary {
  sessionId?: string;
  title?: string;
  status?: string;
  sessionKind?: string;
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

export function innerProtocolMatches(state: InnerReadState | null | undefined): boolean {
  return state?.protocol?.name === 'ZCode Protocol' && state?.protocol?.version === 1;
}
