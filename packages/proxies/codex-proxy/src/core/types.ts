// Provider-native per-turn configuration primitives. These map 1:1 to
// Codex app-server TurnStartParams fields and remain independent controls.
//
// `SandboxMode`        — what writes / network the sandbox allows
// `ApprovalPolicy`     — when codex asks for approval
// `ApprovalsReviewer`  — who reviews approvals (user vs auto_review subagent)
// `CollaborationModeKind` — the Gian catalog choice.
// `CollaborationMode`     — the structured app-server v2 payload.
//
// The gian.proxy/2 catalog exposes them directly; Gian does not bundle them
// into a cross-provider permission mode.

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';

export type ApprovalPolicy =
  | 'untrusted'
  | 'on-failure'
  | 'on-request'
  | 'never'
  | {
    granular: {
      sandbox_approval: boolean;
      rules: boolean;
      skill_approval: boolean;
      request_permissions: boolean;
      mcp_elicitations: boolean;
    };
  };

export type ApprovalsReviewer = 'user' | 'auto_review' | 'guardian_subagent';

export type CollaborationModeKind = 'plan' | 'default';

export interface CollaborationMode {
  mode: CollaborationModeKind;
  settings: {
    model: string;
    reasoning_effort: ThinkingLevel | null;
    developer_instructions: string | null;
  };
}

export type SessionStatus = 'idle' | 'running' | 'needs-approval' | 'stale' | 'closed' | 'error';
/** Opaque Codex effort id returned by model/list. */
export type ThinkingLevel = string;
export type ApprovalScope = 'once' | 'session';
export type ApprovalDecision = 'accept' | 'decline';

export interface SandboxPolicy {
  type: string;
  [key: string]: unknown;
}

export interface ConfiguredPermissions {
  approvalPolicy: ApprovalPolicy;
  approvalsReviewer: ApprovalsReviewer;
  permissions?: string;
  sandboxPolicy?: SandboxPolicy;
}

export interface TextInputItem {
  type: 'text';
  text: string;
}

export interface LocalImageInputItem {
  type: 'localImage';
  path: string;
}

/** Skill / slash invocation. Sent to codex's `turn/start` as
 *  `{type:'skill', name, path}` — codex resolves the skill markdown and
 *  runs it as the prompt. */
export interface SkillInputItem {
  type: 'skill';
  name: string;
  path: string;
}

export type InputItem = TextInputItem | LocalImageInputItem | SkillInputItem;

export interface SessionRecord {
  id: string;
  cwd: string;
  threadId: string;
  configuredPermissions: ConfiguredPermissions;
  model: string | null;
  thinking: ThinkingLevel | null;
  status: SessionStatus;
  activeTurnId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PendingApproval {
  approvalId: string;
  sessionId: string;
  rpcRequestId: number | string;
  method: string;
  title: string;
  /**
   * Human-readable reason describing what codex is asking for (e.g. the
   * shell command, the file change reason, or the permission rationale).
   * Was historically stuffed into `risk`; kept separate so downstream
   * normalizers can use it as a description without confusing it with
   * severity.
   */
  reason: string;
  /**
   * True severity bucket. Codex's app-server protocol doesn't currently emit
   * a severity field of its own; this is heuristic — command/file-change
   * approvals default to `medium`, network-only permission grants stay
   * `low`. Downstream maps this to the unified `risk` field.
   */
  severity: 'low' | 'medium' | 'high';
  /**
   * For `item/permissions/requestApproval`, the kind of permission codex
   * wants. `network` when the request is purely web/network access; `file`
   * when only filesystem paths are involved; `mixed` / `other` otherwise.
   * Downstream uses this to map permission requests to the correct unified
   * category (`network` vs `file_write_outside_ws`) instead of `other`.
   */
  permissionsKind?: 'network' | 'file' | 'mixed' | 'other';
  /**
   * @deprecated kept for binary-compat with existing event payload consumers;
   * mirrors `reason`. Will be dropped once host/web stop reading
   * `data.risk` as prose. New code should read `reason` + `severity`.
   */
  risk: string;
  scopeOptions: ApprovalScope[];
  payload: unknown;
  createdAt: string;
}

export interface InitializePayload {
  mode: 'spawn';
  protocolVersion: string;
  methods: string[];
}

export interface ModelCapabilities {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  isDefault: boolean;
  defaultThinking: ThinkingLevel | null;
  supportedThinking: ThinkingLevel[];
}

export interface CapabilitiesPayload {
  protocolVersion: string;
  models: ModelCapabilities[];
  modes: import('@gian/shared').ProxyModeCapabilities[];
  slashCommands: import('@gian/shared').SlashCommand[];
}

export interface CreateSessionParams {
  cwd: string;
  model?: string | null;
  thinking?: ThinkingLevel | null;
  /** Start a codex thread that should not be materialized on disk. */
  ephemeral?: boolean;
  /** When set, proxy resumes this existing codex thread (via thread/resume)
   *  instead of starting a fresh thread. Used by Gian's "adopt native
   *  session" flow so the on-disk rollout JSONL stays the source of truth. */
  threadId?: string;
}

export interface GetSessionParams {
  sessionId: string;
}

/** SESSION-NAME-001: set the codex thread's user-facing display name. */
export interface SetNameParams {
  sessionId: string;
  name: string;
}

/** Per-turn override of codex's execution policy. All fields are optional —
 *  if omitted, the values from `thread/start` (or codex defaults) apply. */
export interface StartTurnParams {
  sessionId: string;
  input: InputItem[];
  /** Absolute roots that participate in Codex's runtime workspace for this
   *  turn and subsequent steers (for Gian, the session attachment store). */
  additionalWorkspaceRoots?: string[];
  model?: string | null;
  thinking?: ThinkingLevel | null;
  /** Sandbox layer (filesystem / network access boundary). */
  sandbox?: SandboxMode | null;
  /** Restore the config.toml-derived policy captured when this thread was
   *  attached. Used by the Codex "Custom" composer mode. */
  useConfiguredPermissions?: boolean;
  /** When codex should ask for approval. */
  approvalPolicy?: ApprovalPolicy | null;
  /** Who reviews approvals — `user` relays to host, `auto_review` is a codex
   *  subagent that decides without surfacing to host. */
  approvalsReviewer?: ApprovalsReviewer | null;
  /** Codex's behavioral mode. `plan` constrains the agent to exploration +
   *  planning even when the sandbox would allow writes. */
  collaborationMode?: CollaborationModeKind | null;
  reasoningSummary?: 'none' | 'auto' | 'concise' | 'detailed' | null;
  serviceTier?: 'fast' | 'flex' | null;
}

export interface InterruptTurnParams {
  sessionId: string;
}

export interface SteerTurnParams {
  sessionId: string;
  input: InputItem[];
}

export interface ApprovalResponseParams {
  sessionId: string;
  approvalId: string;
  decision: ApprovalDecision;
  scope?: ApprovalScope;
  /** Structured answers returned by Gian's question card, keyed by Codex's
   *  stable question ids from `item/tool/requestUserInput`. */
  answers?: Record<string, string | string[]>;
}

export interface SessionSnapshotParams {
  sessionId: string;
}

export interface CloseSessionParams {
  sessionId: string;
  /** Recovery-only: interrupt the runtime's actual in-progress turn before
   * detaching, even when proxy-local turn state has drifted. */
  force?: boolean;
}

export interface JsonRpcLikeRequest {
  id?: number | string;
  method?: string;
  params?: unknown;
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

export interface CommandExecutionSummary {
  id: string;
  command: string;
  cwd: string;
  status: string;
  exitCode: number | null;
  aggregatedOutput: string | null;
}

export interface FileChangeSummary {
  id: string;
  status: string;
  changes: Array<{
    path: string;
    kind: string;
    diff: string | null;
  }>;
}

export interface CompletedTurnSummary {
  turnId: string;
  status: string;
  assistantText: string;
  commands: CommandExecutionSummary[];
  fileChanges: FileChangeSummary[];
  threadPreview: string | null;
}
