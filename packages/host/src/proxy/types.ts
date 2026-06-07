import type {
  Executor,
  InitializeResult,
  InputItem,
  ProxyCapabilities,
  ProxyNotification,
  ProxySession,
} from '@gian/shared';

export interface ProxyClient {
  readonly executor: Executor;
  initialize(): Promise<InitializeResult>;
  capabilities(): Promise<ProxyCapabilities>;
  /** List slash commands. Built-in + user-level always; project-level
   *  requires `cwd`. */
  listSlashCommands(cwd?: string): Promise<import('@gian/shared').SlashListResult>;
  /**
   * Create a proxy-side session and return both the `ProxySession` envelope
   * and the executor-native id that host persists to `sessions.native_session_id`.
   *
   * The native id is extracted by each client wrapper from the executor-specific
   * field on the wire response:
   *   - cc-proxy:    `session.claudeSessionId`
   *   - codex-proxy: `session.threadId`
   *
   * Wrappers must throw a clear error if the proxy response is missing the
   * native id field; never return `undefined` silently.
   *
   * As of PR2 the proxies are stateless across restarts — there's no
   * `getSessionByKey` recovery path. To resume an existing on-disk native
   * session, host passes `claudeSessionId` / `threadId` in `CreateSessionParams`
   * and the proxy adopts it.
   */
  createSession(
    params: CreateSessionParams,
  ): Promise<{ session: ProxySession; nativeSessionId: string }>;
  startTurn(params: StartTurnParams): Promise<{ session: ProxySession; turn: { id: string } }>;
  interruptTurn(sessionId: string): Promise<void>;
  respondApproval(params: RespondApprovalParams): Promise<void>;
  closeSession(sessionId: string): Promise<void>;
  /**
   * Set the underlying native session's display name (SESSION-NAME-001).
   * codex-proxy implements this via the app-server `thread/name/set` RPC so
   * the name shows in `codex resume` / Codex app listings. cc-proxy does NOT
   * implement it — Claude's display name is set host-side (a `--name` flag on
   * the first turn / TTY spawn, or by appending a `custom-title` line to the
   * session JSONL on rename), so the method is optional.
   */
  setName?(name: string): Promise<void>;
  shutdown(): Promise<void>;
  /**
   * Tear the proxy session down hard, bypassing any graceful RPC. cc-proxy
   * SIGKILLs its node child + child claude process; codex-proxy fires a
   * non-awaited `session.close` to the shared host so the rest of the codex
   * sessions stay up. Used by SessionManager.forceRecover when a session is
   * wedged in a way that interruptTurn can't unstick.
   */
  forceKill(): void;
  onNotification(handler: NotificationHandler): () => void;
  onExit(handler: (code: number | null) => void): () => void;
}

export interface CreateSessionParams {
  cwd: string;
  model?: string | null;
  /** codex-only: start a thread that should not be materialized on disk. */
  ephemeral?: boolean;
  /** Adopt an existing native session: claudeSessionId for cc, threadId for
   *  codex. When set, the proxy resumes the on-disk session instead of
   *  generating a fresh id. */
  claudeSessionId?: string;
  threadId?: string;
}

/**
 * Per-turn execution policy. Mostly empty for plain conversational turns;
 * populated by SessionManager when starting a turn so each executor receives
 * the right primitives for its native protocol:
 *
 *   - codex-proxy reads `sandbox` / `approvalPolicy` / `approvalsReviewer`
 *     / `collaborationMode` (codex `turn/start` overrides).
 *   - cc-proxy reads `permissionMode` and `thinking`
 *     (Claude CLI `--permission-mode` / `--effort`).
 *
 * Each proxy ignores fields it doesn't use. The translation from host's
 * `ApprovalMode` to these primitives lives in `SessionManager.startTurn`.
 */
export interface StartTurnParams {
  sessionId: string;
  input: InputItem[];
  model?: string | null;
  /** Reasoning effort. Proxies translate this to their native effort flag. */
  thinking?: import('@gian/shared').ThinkingEffort | null;

  // codex-only
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access' | null;
  approvalPolicy?: 'untrusted' | 'on-failure' | 'on-request' | 'never' | null;
  approvalsReviewer?: 'user' | 'auto_review' | null;
  collaborationMode?: 'plan' | 'default' | null;
  reasoningSummary?: 'none' | 'auto' | 'concise' | 'detailed' | null;
  serviceTier?: 'fast' | 'flex' | null;

  // cc-only
  permissionMode?: 'plan' | 'default' | 'auto' | 'bypassPermissions' | null;
  /** cc-only (SESSION-NAME-001): Claude session display name. cc-proxy applies
   *  it as `--name` only on the first (`--session-id`) turn; later turns ignore
   *  it (renames are propagated host-side by writing the JSONL `custom-title`). */
  displayName?: string | null;
}

export interface RespondApprovalParams {
  sessionId: string;
  approvalId: string;
  decision: 'accept' | 'decline';
  scope?: 'once' | 'session';
  /** Structured answers for AskUserQuestion-flavored approvals. cc-proxy
   *  uses these to feed the agent back via the `updatedInput.answers`
   *  channel; codex-proxy ignores. */
  answers?: Record<string, string | string[]>;
}

export type NotificationHandler = (notification: ProxyNotification) => void;
