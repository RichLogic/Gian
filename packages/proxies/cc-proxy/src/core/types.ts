export type SessionStatus = 'idle' | 'running' | 'needs-approval' | 'stale' | 'closed' | 'error';

/** Claude CLI's `--permission-mode` accepted values. Passed through verbatim
 *  to the spawned `claude -p` per turn. */
export type PermissionMode = 'plan' | 'default' | 'auto' | 'bypassPermissions';

export interface TextInputItem {
  type: 'text';
  text: string;
}

export interface LocalImageInputItem {
  type: 'localImage';
  path: string;
}

export type InputItem = TextInputItem | LocalImageInputItem;

export interface SessionRecord {
  id: string;
  cwd: string;
  /** Claude Code session ID used with --session-id / --resume. */
  claudeSessionId: string;
  model: string | null;
  status: SessionStatus;
  activeTurnId: string | null;
  lastError: string | null;
  /** Whether the Claude Code process is currently alive for this session. */
  processAlive: boolean;
  /** Runtime-only hint: true when the host supplied a claudeSessionId at
   *  createSession time (adoption / reconnect). The first spawn must use
   *  `--resume <id>` to pick up the existing on-disk JSONL; later spawns
   *  also use `--resume`. Never persisted — the proxy is stateless. */
  wasResumed: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ToolUseRecord {
  toolName: string;
  input: Record<string, unknown>;
}

export interface PendingApproval {
  approvalId: string;
  sessionId: string;
  requestId: string;
  toolName: string;
  description: string;
  inputPreview: string;
  createdAt: string;
  /** Optional discriminator surfaced to the host so it can pick a specialized
   *  UI without re-deriving from toolName. Currently used for
   *  `'exit_plan_mode'` — set when toolName === 'ExitPlanMode'. */
  category?: string;
}

export interface InitializePayload {
  mode: 'spawn';
  protocolVersion: string;
  methods: string[];
}

export interface CapabilitiesPayload {
  protocolVersion: string;
  models: ModelCapabilities[];
  slashCommands: import('@gian/shared').SlashCommand[];
}

/** Claude CLI's `--effort` accepted values (5 levels). Order from cheapest
 *  to most expensive: low → medium → high → xhigh → max. */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ModelCapabilities {
  id: string;
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  isDefault: boolean;
  defaultEffort: EffortLevel;
  supportedEfforts: EffortLevel[];
}

export interface CreateSessionParams {
  cwd: string;
  model?: string | null;
  /** When set, the proxy uses this as the Claude Code session id and marks
   *  the session as `--resume`-ready (adoption / host reconnect flow).
   *  When omitted, the proxy generates a fresh UUID and the next spawn
   *  uses `--session-id <new>` for a clean conversation. */
  claudeSessionId?: string;
}

export interface GetSessionParams {
  sessionId: string;
}

export interface StartTurnParams {
  sessionId: string;
  input: InputItem[];
  model?: string | null;
  /** Claude CLI `--permission-mode` value. Passed through verbatim. */
  permissionMode?: PermissionMode | null;
  /** Reasoning effort. Maps to Claude CLI `--effort <level>`. Field is named
   *  `thinking` to match the shared host-facing convention used across
   *  executors; translated internally to `--effort`. */
  thinking?: EffortLevel | null;
}

export interface InterruptTurnParams {
  sessionId: string;
}

export interface ApprovalResponseParams {
  sessionId: string;
  approvalId: string;
  behavior: 'allow' | 'deny';
  /** Structured answers for an AskUserQuestion-flavored approval. Keyed
   *  by question text; values are the user's selected option label(s).
   *  When present, the proxy resolves with `{ updatedInput: { answers } }`
   *  per the Claude Code SDK `approval_prompt` contract. */
  answers?: Record<string, string | string[]>;
}

export interface SessionSnapshotParams {
  sessionId: string;
}

export interface CloseSessionParams {
  sessionId: string;
}

export interface JsonRpcLikeRequest {
  id?: number | string;
  method?: string;
  params?: unknown;
}
