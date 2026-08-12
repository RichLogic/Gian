import type {
  ExecutorConfigState,
  Executor,
  InitializeResult,
  InputItem,
  NativeConfigOption,
  NativeConfigValue,
  ProxyCapabilities,
  ProxyNotification,
  ProxySession,
} from '@gian/shared';

export interface ProxyClient {
  readonly executor: Executor;
  /** Present only on clients speaking the vendor-neutral gian.proxy/1 contract. */
  readonly protocolV1?: true;
  /** Synchronous lifecycle snapshot used to make cache publication atomic
   * with respect to Node's single-threaded exit callbacks. */
  isExited(): boolean;
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
  ): Promise<{
    session: ProxySession;
    nativeSessionId: string;
    configOptions?: NativeConfigOption[];
    replayUpdates?: unknown[];
    replayStreamId?: string;
  }>;
  startTurn(params: StartTurnParams): Promise<{ session: ProxySession; turn: { id: string } }>;
  interruptTurn(sessionId: string): Promise<void>;
  /** Append user input to the in-flight turn (codex `turn/steer`). Only
   *  executors with a native non-interrupting steer primitive implement it;
   *  absent means "busy sessions can only queue". `input` follows the same
   *  InputItem shape as StartTurnParams. */
  steerTurn?(params: { sessionId: string; input: import('@gian/shared').InputItem[] }): Promise<{ ok: true; turnId: string }>;
  respondApproval(params: RespondApprovalParams): Promise<void>;
  closeSession(sessionId: string): Promise<void>;
  /**
   * Set the underlying native session's display name (SESSION-NAME-001).
   * codex-proxy implements this via the app-server `thread/name/set` RPC so
   * the name shows in `codex resume` / Codex app listings. gian.proxy/1
   * cc-proxy implements `session.rename` and owns Claude's `custom-title`
   * storage detail. Legacy cc-proxy still uses Host-side compatibility code.
   */
  setName?(name: string): Promise<void>;
  /** Executor-native session configuration (Kimi ACP today). */
  getNativeConfig?(): Promise<{
    state: ExecutorConfigState;
    options: NativeConfigOption[];
  }>;
  setNativeConfig?(configId: string, value: NativeConfigValue): Promise<{
    state: ExecutorConfigState;
    options: NativeConfigOption[];
  }>;
  /** Executor-native session discovery (Kimi ACP session/list today). */
  listNativeSessions?(params?: { cwd?: string; cursor?: string }): Promise<unknown>;
  /** Reload normalized native history after a protocol-v1 plugin reports that
   * its attached native history changed outside Gian. */
  replaySession?(): Promise<unknown[] | ProxyReplayResult>;
  shutdown(): Promise<void>;
  /**
   * Tear the proxy session down without waiting on a graceful RPC. cc-proxy
   * SIGKILLs its node child + child Claude process; shared Codex/Kimi hosts
   * fire a non-awaited per-session close so their other sessions stay up.
   * Used by SessionManager.forceRecover when interruptTurn cannot unstick a
   * session.
   */
  forceKill(): void | Promise<void>;
  onNotification(handler: NotificationHandler): () => void;
  onExit(handler: (code: number | null) => void): () => void;
}

export interface ProxyReplayResult {
  replayStreamId?: string;
  events: unknown[];
}

export interface CreateSessionParams {
  cwd: string;
  model?: string | null;
  /** codex-only: start a thread that should not be materialized on disk. */
  ephemeral?: boolean;
  /** Adopt an existing native session: claudeSessionId for cc, threadId for
   *  Codex, or nativeSessionId for ACP-backed executors. */
  claudeSessionId?: string;
  threadId?: string;
  /** Generic native id for executors whose protocol is not cc/codex. */
  nativeSessionId?: string;
  /** `load` replays history for first adoption; `resume` only reattaches. */
  resumeMode?: 'load' | 'resume';
  /** ACP MCP declarations. Empty in Gian's first Kimi slice. */
  mcpServers?: unknown[];
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
  /** Host-owned stable turn identity used by gian.proxy/1 clients. Legacy
   * proxies ignore it and continue returning their provider turn id. */
  turnId?: string;
  input: InputItem[];
  /** Codex runtime workspace roots in addition to the session cwd. The Host
   *  uses this for the session-owned attachment directory. */
  additionalWorkspaceRoots?: string[];
  model?: string | null;
  /** Reasoning effort. Proxies translate this to their native effort flag. */
  thinking?: import('@gian/shared').ThinkingEffort | null;

  // codex-only
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access' | null;
  /** Restore the config.toml-derived Codex policy captured on attach. */
  useConfiguredPermissions?: boolean;
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
  /** Exact executor-owned option ID for ACP-native approvals. */
  nativeOptionId?: string;
}

export type NotificationHandler = (notification: ProxyNotification) => void;
