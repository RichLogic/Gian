import type {
  AvailableCommand,
  McpServer,
  PermissionOption,
  SessionConfigOption,
} from '@agentclientprotocol/sdk';

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
  mimeType?: string;
}

export type InputItem = TextInputItem | LocalImageInputItem;

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
  mcpServers?: McpServer[];
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
