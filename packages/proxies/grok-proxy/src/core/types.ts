import type {
  AvailableCommand,
  McpServer,
  PermissionOption,
  SessionConfigOption,
} from '@agentclientprotocol/sdk';

import type { GrokPermissionMode } from './permissions.js';
import type { GrokSandboxProfile } from './sandbox.js';

export type SessionStatus =
  | 'idle'
  | 'running'
  | 'needs-approval'
  | 'stale'
  | 'closed'
  | 'error';

export interface TextInputItem {
  type: 'text';
  text: string;
}

export interface LocalImageInputItem {
  type: 'localImage';
  path: string;
  name?: string;
  mimeType?: string;
  size?: number;
}

export interface LocalFileInputItem {
  type: 'localFile';
  path: string;
  name?: string;
  mimeType?: string;
  size?: number;
}

export type InputItem = TextInputItem | LocalImageInputItem | LocalFileInputItem;

export interface SessionRecord {
  id: string;
  cwd: string;
  nativeSessionId: string;
  status: SessionStatus;
  activeTurnId: string | null;
  configOptions: SessionConfigOption[];
  slashCommands: AvailableCommand[];
  mcpServers: McpServer[];
  attached: boolean;
  lastError: string | null;
  /**
   * This session's model/effort. Seeded from evidenced native responses or
   * inherited from the fork parent; null means the native session has not
   * reported one (e.g. right after a load/resume of foreign history).
   */
  model: string | null;
  effort: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InitializePayload {
  mode: 'spawn';
  protocolVersion: 'acp/1';
  methods: string[];
}

export interface CreateSessionParams {
  cwd: string;
  nativeSessionId?: string;
  resumeMode?: 'load' | 'resume';
  /** Only admitted Host Streamable HTTP servers may be passed (see
   *  mcp-isolation.ts); other transports are rejected at admission. */
  mcpServers?: McpServer[];
  /** Internal Side Chat reattach path; ordinary session.create remains one
   *  per session-scoped Proxy process. */
  allowAdditional?: boolean;
  /** Turn draft applied in session `_meta` and again before each prompt. */
  permissionMode?: GrokPermissionMode;
  /** Requested child sandbox. Fixed once the process has started. */
  sandboxProfile?: GrokSandboxProfile;
  /** Internal fork/Side Chat inheritance: the parent session's model/effort at
   *  fork time. Never taken from the process-wide default for a resumed
   *  foreign session. */
  initialModel?: string;
  initialEffort?: string;
}

export interface GetSessionParams {
  sessionId: string;
}

export interface StartTurnParams {
  sessionId: string;
  input: InputItem[];
}

export interface InterruptTurnParams {
  sessionId: string;
}

export interface ApprovalResponseParams {
  sessionId: string;
  approvalId: string;
  nativeOptionId?: string;
}

export interface SetConfigOptionParams {
  sessionId: string;
  configId: string;
  value: string | boolean;
}

export interface SessionSnapshotParams {
  sessionId: string;
}

export interface CloseSessionParams {
  sessionId: string;
}

export interface ListNativeSessionsParams {
  cwd?: string;
  cursor?: string;
}

export interface JsonRpcLikeRequest {
  id?: number | string;
  method?: string;
  params?: unknown;
}

export interface PendingApproval {
  approvalId: string;
  sessionId: string;
  turnId: string | null;
  options: PermissionOption[];
  resolve(response: {
    outcome:
      | { outcome: 'selected'; optionId: string }
      | { outcome: 'cancelled' };
  }): void;
}

/** Reverse x.ai/* request mapped to a Gian interaction. */
export type QuestionOutcome =
  | { kind: 'cancelled' }
  | {
    kind: 'submitted';
    answers: Record<string, string[]>;
    annotations?: Record<string, { preview?: string; notes?: string }>;
  }
  | { kind: 'chat_about_this'; partialAnswers: Record<string, string> }
  | { kind: 'skip_interview'; partialAnswers: Record<string, string> }
  | { kind: 'plan_approved' }
  | { kind: 'plan_cancelled'; feedback?: string }
  | { kind: 'elicit_accept'; content: unknown }
  | { kind: 'elicit_decline' };

export interface PendingQuestion {
  questionId: string;
  /** 'question' = ask_user_question, 'plan' = exit_plan_mode, 'elicit' = mcp/elicit. */
  kind: 'question' | 'plan' | 'elicit';
  sessionId: string;
  turnId: string | null;
  nativeRequestId: string;
  mode: 'default' | 'plan';
  questions: unknown[];
  actionIds: string[];
  responses: Map<string, { actionId: string; values: Record<string, unknown> }>;
  resolve(outcome: QuestionOutcome): void;
}

export interface ProxyEventEnvelope<T = Record<string, unknown>> {
  requestId?: number | string;
  sessionId: string;
  turnId?: string;
  data: T;
  rawRuntimeEvent?: {
    method: string;
    params?: unknown;
  };
}
