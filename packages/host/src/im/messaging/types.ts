import type {
  AgentExecutor,
  ApprovalMode,
  ApprovalScope,
  CodexThread,
  ModelOption,
  PendingApproval,
  SessionRecord,
  UserRecord,
  WorkspaceSummary,
} from '../types.js';

// ---------------------------------------------------------------------------
// Platform identity
// ---------------------------------------------------------------------------

export type MessagingPlatformId = 'discord' | 'slack' | (string & {});

export type MessagingBotStatus = 'disabled' | 'connecting' | 'connected' | 'error';

// ---------------------------------------------------------------------------
// Session mode (shared across platforms)
// ---------------------------------------------------------------------------

// MessagingSessionMode == ApprovalMode 1:1. Originally rvc's IM only
// surfaced 'detailed' / 'full-auto' (a 3→2 projection); we realigned to
// Gian's three-mode vocabulary ('plan'|'ask'|'auto') so the IM `/alter`
// flow can offer the same modes the web UI does. See im/types.ts.
export type MessagingSessionMode = ApprovalMode;

// ---------------------------------------------------------------------------
// Bot record — base fields every platform stores
// ---------------------------------------------------------------------------

export interface MessagingBotRecord {
  id: string;
  ownerUserId: string;
  ownerUsername: string;
  label: string;
  tokenCiphertext: string;
  selectedWorkspaceId: string | null;
  selectedSessionId: string | null;
  enabled: boolean;
  status: MessagingBotStatus;
  lastError: string | null;
  lastConnectedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminMessagingBotRecord {
  id: string;
  ownerUserId: string;
  ownerUsername: string;
  label: string;
  selectedWorkspaceId: string | null;
  enabled: boolean;
  hasToken: boolean;
  status: MessagingBotStatus;
  lastError: string | null;
  lastConnectedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Session create input (platform managers call this to create sessions)
// ---------------------------------------------------------------------------

export interface MessagingSessionCreateInput {
  title?: string;
  mode?: MessagingSessionMode;
  executor?: SessionRecord['executor'];
}

// ---------------------------------------------------------------------------
// Inbound prompt — normalized message from any platform
// ---------------------------------------------------------------------------

export interface InboundPromptInput {
  botId: string;
  messageId: string;
  channelId: string;
  authorId: string;
  content: string;
  attachmentCount: number;
  threadTs?: string | null;
  reply: (content: string) => Promise<{ messageId: string | null }>;
}

// ---------------------------------------------------------------------------
// MessagingPlatform — the interface server.ts programs against
// ---------------------------------------------------------------------------

export interface MessagingPlatform {
  readonly platformId: MessagingPlatformId;

  /** Start all enabled bots for this platform. */
  startAll(): Promise<void>;

  /** Sync a specific bot (start if enabled, stop if disabled/missing). */
  syncBot(botId: string): Promise<void>;

  /** Stop a specific bot. */
  stopBot(botId: string): Promise<void>;

  /** Gracefully shut down all bots. */
  shutdown(): Promise<void>;

  /** Notify the platform user that a turn has completed. */
  sendTurnCompletion(
    session: SessionRecord,
    thread: CodexThread | null,
    turnId: string | null,
  ): Promise<void>;

  /** Notify the platform user that an approval is needed. */
  sendApprovalRequested(
    session: SessionRecord,
    approval: PendingApproval,
  ): Promise<void>;

  /** Notify the platform user of a session error. */
  sendSessionError(
    session: SessionRecord,
    message: string,
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// Shared dependencies — options every platform manager receives from server.ts
// ---------------------------------------------------------------------------

export interface MessagingPlatformOptions {
  log: {
    info(message: string): unknown;
    warn(message: string): unknown;
  };
  decryptToken: (ciphertext: string) => Promise<string>;
  listUsers: () => UserRecord[];
  listUserWorkspaces: (username: string, userId: string) => Promise<WorkspaceSummary[]>;
  listSessionsForWorkspace: (userId: string, workspaceId: string) => Promise<SessionRecord[]>;
  getWorkspaceForUser: (workspaceId: string, userId: string) => Promise<WorkspaceSummary | null>;
  createSession: (
    currentUser: UserRecord,
    workspace: WorkspaceSummary,
    botId: string,
    input?: MessagingSessionCreateInput,
  ) => Promise<SessionRecord>;
  startTurnWithAutoRestart: (
    session: SessionRecord,
    prompt: string | null,
    attachments: [],
  ) => Promise<{ turn: unknown; session: SessionRecord }>;
  queueTurn: (session: SessionRecord, prompt: string | null) => Promise<void>;
  getApprovals: (sessionId: string) => PendingApproval[];
  resolveApproval: (
    session: SessionRecord,
    approvalId: string,
    input: { decision: 'approve' | 'decline'; scope?: ApprovalScope },
  ) => Promise<void>;
  listModelOptions: (executor?: SessionRecord['executor']) => ModelOption[];
  currentDefaultModel: (executor?: SessionRecord['executor']) => string;
  findModelOption: (model: string | null | undefined, executor?: SessionRecord['executor']) => ModelOption | null;
  normalizeReasoningEffort: (value: unknown) => SessionRecord['reasoningEffort'] | null;
  preferredReasoningEffortForModel: (modelOption: ModelOption) => SessionRecord['reasoningEffort'];
  restartSessionThread: (session: SessionRecord, summary?: string) => Promise<SessionRecord>;
  interruptTurn: (session: SessionRecord, threadId: string, turnId: string) => Promise<unknown>;
  isThreadUnavailableError: (error: unknown) => boolean;
  staleSessionMessage: string;
  errorMessage: (error: unknown) => string;
  availableExecutors: () => AgentExecutor[];
  normalizeExecutor: (value: unknown) => AgentExecutor;
}
