import type {
  AuthenticateRequest,
  AuthenticateResponse,
  ContentBlock,
  InitializeResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  McpServer,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  ResumeSessionRequest,
  ResumeSessionResponse,
  SessionConfigOption,
  SessionNotification,
} from '@agentclientprotocol/sdk';

export type ConfigValue = string | number | boolean | null;
export type ConfigValues = Record<string, ConfigValue>;
export type JsonRecord = Record<string, unknown>;

export interface RuntimeStopped {
  code: number | null;
  signal: NodeJS.Signals | null;
  expected: boolean;
  error?: Error;
}

export type PermissionHandler = (
  request: RequestPermissionRequest,
) => Promise<RequestPermissionResponse>;

export interface AntigravityRuntimeClient {
  readonly negotiated: InitializeResponse | null;
  ensureStarted(): Promise<InitializeResponse>;
  setPermissionHandler(handler: PermissionHandler | null): void;
  on(event: 'sessionUpdate', listener: (notification: SessionNotification) => void): this;
  on(event: 'runtimeStopped', listener: (event: RuntimeStopped) => void): this;
  newSession(params: NewSessionRequest): Promise<NewSessionResponse>;
  loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse>;
  resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse>;
  listSessions(params?: ListSessionsRequest): Promise<ListSessionsResponse>;
  dispatchPrompt(params: PromptRequest): Promise<{ response: Promise<PromptResponse> }>;
  cancel(sessionId: string): Promise<void>;
  setConfigOption(params: { sessionId: string; configId: string; value: string }): Promise<unknown>;
  authenticate(params: AuthenticateRequest): Promise<AuthenticateResponse>;
  stop(): Promise<void>;
}

export type SessionState = 'idle' | 'running' | 'waiting_interaction' | 'stale' | 'closed' | 'error';

export interface ServiceSession {
  id: string;
  nativeSessionId: string;
  cwd: string;
  state: SessionState;
  activeTurnId: string | null;
  configOptions: SessionConfigOption[];
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateServiceSession {
  sessionId: string;
  cwd: string;
  nativeSessionId?: string;
  resumeMode?: 'load' | 'resume';
  mcpServers?: McpServer[];
  config?: ConfigValues;
}

export interface StartServiceTurn {
  sessionId: string;
  turnId: string;
  prompt: ContentBlock[];
  config?: ConfigValues;
}

export type InteractionOutcome = 'submitted' | 'cancelled' | 'expired' | 'turn_ended' | 'runtime_ended';

export type ServiceEvent =
  | { kind: 'session.changed'; session: ServiceSession }
  | {
    kind: 'native.update';
    sessionId: string;
    turnId?: string;
    notification: SessionNotification;
    replay: boolean;
  }
  | { kind: 'turn.started'; sessionId: string; turnId: string }
  | { kind: 'turn.completed'; sessionId: string; turnId: string; response: PromptResponse }
  | { kind: 'turn.failed'; sessionId: string; turnId: string; error: Error }
  | {
    kind: 'permission.requested';
    sessionId: string;
    turnId: string;
    interactionId: string;
    request: RequestPermissionRequest;
  }
  | {
    kind: 'permission.resolved';
    sessionId: string;
    turnId: string;
    interactionId: string;
    outcome: InteractionOutcome;
    optionId?: string;
  }
  | { kind: 'runtime.stopped'; event: RuntimeStopped };

export interface AntigravityService {
  setEventSink(sink: (event: ServiceEvent) => void): void;
  initialize(): Promise<InitializeResponse>;
  createSession(params: CreateServiceSession): Promise<ServiceSession>;
  getSession(sessionId: string): ServiceSession;
  startTurn(params: StartServiceTurn): Promise<{ turnId: string }>;
  interruptTurn(sessionId: string, turnId?: string): Promise<void>;
  respondPermission(params: {
    sessionId: string;
    interactionId: string;
    optionId?: string;
    cancelled?: boolean;
  }): void;
  closeSession(sessionId: string): Promise<void>;
  listNativeSessions(params?: ListSessionsRequest): Promise<ListSessionsResponse>;
  close(): Promise<void>;
}

export interface WireEventDraft {
  method: string;
  data: JsonRecord;
}

export interface ProjectionContext {
  sessionId: string;
  turnId: string;
  text: Map<string, string>;
  activities: Map<string, JsonRecord>;
  usage: JsonRecord;
}

export interface GianConfigOption {
  id: string;
  displayName: string;
  description?: string;
  binding: 'session' | 'turn';
  role?: string;
  modeKind?: 'gian-preset' | 'provider-native';
  control: 'select' | 'boolean' | 'number' | 'text';
  required: boolean;
  defaultValue: ConfigValue;
  choices?: Array<{ value: ConfigValue; displayName: string; description?: string }>;
}
