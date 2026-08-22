import type {
  ForkAnchor,
  ForkOrigin,
  InitializeResult,
  ReplayEvent,
  SideChatSnapshot,
} from '@gian/proxy-protocol';
import type {
  ConfigOption,
  Executor,
  InputItem,
  ProxyCatalog,
  ProxySession,
  ResolvedProxyCatalog,
  SessionAvailableActions,
} from '@gian/shared';

export type ConfigValue = string | boolean | number | null;

export interface ProxyClient {
  readonly executor: Executor;
  readonly protocolV2?: true;
  isExited(): boolean;
  initialize(): Promise<InitializeResult>;
  catalog(): Promise<ProxyCatalog>;
  createSession(params: CreateSessionParams): Promise<{
    session: ProxySession;
    nativeSessionId: string | null;
    replayEvents?: ReplayEvent[];
    replayStreamId?: string;
    turnConfigOptions?: ConfigOption[];
    turnConfigRevision?: string;
    availableActions?: SessionAvailableActions;
  }>;
  resolveCatalog?(params: {
    catalogRevision: string;
    sessionConfig: Record<string, ConfigValue>;
    turnConfig: Record<string, ConfigValue>;
  }): Promise<ResolvedProxyCatalog>;
  streamId?(): string | null;
  hasAttachedSession?(): boolean;
  startTurn(params: StartTurnParams): Promise<{ session: ProxySession; turn: { id: string } }>;
  interruptTurn(sessionId?: string): Promise<void>;
  steerTurn?(params: SteerTurnParams): Promise<{ ok: true; turnId: string }>;
  respondInteraction(params: RespondInteractionParams): Promise<void>;
  closeSession(sessionId?: string): Promise<void>;
  setName?(name: string): Promise<void>;
  listNativeSessions?(params?: NativeSessionListParams): Promise<unknown>;
  deleteNativeSession?(nativeSessionId: string): Promise<void>;
  replaySession?(): Promise<ProxyReplayResult>;
  createSidechat?(params: { sidechatId: string }): Promise<SideChatSnapshot>;
  resumeSidechat?(params: {
    sidechatId: string;
    resumeRef: { id: string };
  }): Promise<SideChatSnapshot>;
  closeSidechat?(params: {
    sidechatId: string;
    streamId?: string;
    resumeRef: { id: string };
  }): Promise<{ ok: true; sidechatId: string; providerDataDeleted: boolean }>;
  forkSession?(params: {
    sessionId: string;
    anchor: ForkAnchor;
  }): Promise<{ session: ProtocolSessionLike; origin: ForkOrigin; replayEvents?: ReplayEvent[] }>;
  shutdown(): Promise<void>;
  forceKill(): void | Promise<void>;
  onNotification(handler: NotificationHandler): () => void;
  onSessionFault?(handler: (error: Error) => void): () => void;
  onExit(handler: (code: number | null) => void): () => void;
}

export interface ProtocolSessionLike {
  id: string;
  streamId?: string;
  state: ProxySession['state'];
  nativeSession?: { id: string };
  createdAt: string;
  updatedAt: string;
  lastError?: string | null;
  availableActions?: SessionAvailableActions;
}

export interface ProxyReplayResult {
  replayStreamId?: string;
  events: ReplayEvent[];
}

export interface CreateSessionParams {
  cwd: string;
  workspaceRoots?: string[];
  sessionConfig?: Record<string, ConfigValue>;
  nativeSessionId?: string;
  history?: 'none' | 'replay';
  /** @deprecated Map to history=replay. Removed after session manager WP2. */
  resumeMode?: 'load' | 'resume';
}

export interface StartTurnParams {
  sessionId: string;
  turnId: string;
  input: InputItem[];
  config: Record<string, ConfigValue>;
}

export interface SteerTurnParams {
  sessionId?: string;
  turnId?: string;
  input: InputItem[];
}

export interface RespondInteractionParams {
  sessionId: string;
  interactionId: string;
  responseId: string;
  actionId: string;
  values: Record<string, string | boolean | string[]>;
  turnId?: string;
}

export interface NativeSessionListParams {
  cwd?: string;
  cursor?: string | null;
  limit?: number;
}

export type NotificationHandler = (notification: import('@gian/proxy-protocol').ProxyNotification) => void;
