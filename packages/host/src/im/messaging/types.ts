import type {
  AgentExecutor,
  ApprovalMode,
  ApprovalScope,
  CodexThread,
  ModelOption,
  PendingApproval,
  MessagingSession,
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

export type MessagingSessionMode = ApprovalMode;

// ---------------------------------------------------------------------------
// Session create input (platform managers call this to create sessions)
// ---------------------------------------------------------------------------

export interface MessagingSessionCreateInput {
  title?: string;
  mode?: MessagingSessionMode;
  executor?: MessagingSession['executor'];
}

export type MessagingSessionPatch = Partial<Pick<
  MessagingSession,
  'approvalMode' | 'archivedAt' | 'model' | 'reasoningEffort' | 'title'
>>;

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
    session: MessagingSession,
    thread: CodexThread | null,
    turnId: string | null,
  ): Promise<void>;

  /** Notify the platform user that an approval is needed. */
  sendApprovalRequested(
    session: MessagingSession,
    approval: PendingApproval,
  ): Promise<void>;

  /** Notify the platform user of a session error. */
  sendSessionError(
    session: MessagingSession,
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
  listWorkspaces: () => Promise<WorkspaceSummary[]>;
  listSessionsForWorkspace: (workspaceId: string) => Promise<MessagingSession[]>;
  getSession: (sessionId: string) => Promise<MessagingSession | null>;
  updateSession: (sessionId: string, patch: MessagingSessionPatch) => Promise<MessagingSession | null>;
  getWorkspace: (workspaceId: string) => Promise<WorkspaceSummary | null>;
  createSession: (
    workspace: WorkspaceSummary,
    input?: MessagingSessionCreateInput,
  ) => Promise<MessagingSession>;
  startTurn: (
    session: MessagingSession,
    prompt: string | null,
  ) => Promise<void>;
  queueTurn: (session: MessagingSession, prompt: string | null) => Promise<void>;
  getQueueLength: (sessionId: string) => number;
  clearQueue: (sessionId: string) => void;
  getApprovals: (sessionId: string) => PendingApproval[];
  resolveApproval: (
    session: MessagingSession,
    approvalId: string,
    input: { decision: 'approve' | 'decline'; scope?: ApprovalScope },
  ) => Promise<void>;
  listModelOptions: (executor?: MessagingSession['executor']) => ModelOption[];
  currentDefaultModel: (executor?: MessagingSession['executor']) => string;
  findModelOption: (model: string | null | undefined, executor?: MessagingSession['executor']) => ModelOption | null;
  preferredReasoningEffortForModel: (modelOption: ModelOption) => MessagingSession['reasoningEffort'];
  interruptTurn: (session: MessagingSession, threadId: string, turnId: string) => Promise<unknown>;
  isThreadUnavailableError: (error: unknown) => boolean;
  errorMessage: (error: unknown) => string;
  availableExecutors: () => AgentExecutor[];
  normalizeExecutor: (value: unknown) => AgentExecutor;
}
