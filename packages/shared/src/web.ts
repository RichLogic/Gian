import type {
  Approval,
  ApprovalCategory,
  ApprovalMode,
  ApprovalResolvedBy,
  ApprovalStatus,
  Executor,
  QueueEntry,
  Session,
  SystemConfig,
  Task,
  TaskStatus,
  Workspace,
} from './model.js';
import type { InputItem } from './proxy.js';

export interface AuthMessage {
  type: 'auth';
  token: string;
}

export interface AuthOkMessage {
  type: 'auth_ok';
  user: string;
}

export interface RunnerInfo {
  host: string;
  latency: number;
  started_ago: string;
  agents: number;
  disk: string;
  codex_version: string;
  cc_version: string;
  ws_root: string;
}

export interface StateSyncMessage {
  type: 'state_sync';
  runner: RunnerInfo;
  sessions: Session[];
  workspaces: Workspace[];
  tasks: Task[];
  approvals: Approval[];
  config: SystemConfig;
}

export interface EventEnvelope {
  session_id: string;
  turn: number;
  call_id: string;
  event: string;
  ts: number;
  data: Record<string, unknown>;
  /** Provider that emitted `event`. Omitted on historical Gian rows. */
  provider?: Executor;
  /** UI-only projection. Omitted on historical pre-projection rows. */
  display?: import('./events.js').ChatDisplay;
}

export interface EventMessage extends EventEnvelope {
  type: 'event';
}

export interface SessionUpdatedMessage {
  type: 'session:updated';
  session: Pick<Session, 'id'> & Partial<Session>;
}

export interface SessionCreatedMessage {
  type: 'session:created';
  session: Session;
}

export interface SessionDeletedMessage {
  type: 'session:deleted';
  session_id: string;
}

// ── Tasks (PRD-v3) ──────────────────────────────────────────────────────────
export interface TaskCreatedMessage {
  type: 'task:created';
  task: Task;
}

export interface TaskUpdatedMessage {
  type: 'task:updated';
  task: Pick<Task, 'id'> & Partial<Task>;
}

export interface TaskDeletedMessage {
  type: 'task:deleted';
  task_id: string;
}

export interface TaskCreateMessage {
  type: 'task:create';
  name: string;
  description?: string;
  /** Correlation id — see `OperationResultMessage`. */
  request_id?: string;
}

export interface TaskUpdateMessage {
  type: 'task:update';
  task_id: string;
  name?: string;
  description?: string;
  status?: TaskStatus;
  /** Pin / unpin the task. Independent of the content fields above; the host
   *  stamps `pinned_at` (pin) or clears it (unpin) without bumping updated_at. */
  pinned?: boolean;
  /** Correlation id — see `OperationResultMessage`. */
  request_id?: string;
}

export interface TaskDeleteMessage {
  type: 'task:delete';
  task_id: string;
  /** Correlation id — see `OperationResultMessage`. */
  request_id?: string;
}

export interface ApprovalCreatedMessage {
  type: 'approval:created';
  approval: {
    id: string;
    session_id: string;
    category: ApprovalCategory;
    description: string;
    status: ApprovalStatus;
    native_options?: import('./model.js').NativeApprovalOption[];
  };
}

export interface ApprovalUpdatedMessage {
  type: 'approval:updated';
  approval: {
    id: string;
    status: ApprovalStatus;
    resolved_by: ApprovalResolvedBy;
    resolved_at: string;
  };
}

export interface QueueUpdatedMessage {
  type: 'queue:updated';
  session_id: string;
  /** Items carry the entry's attachments (localImage/localFile) so the queue
   *  drawer can render thumbnails without a second fetch. */
  queue: Array<Pick<QueueEntry, 'id' | 'text'> & { items?: InputItem[] }>;
}

export interface RunnerUpdatedMessage {
  type: 'runner:updated';
  runner: Partial<RunnerInfo>;
}

/**
 * Server-side dispatch error feedback. Sent when an inbound client message
 * (most commonly `message:send`) throws on the host. Without this, failures
 * inside `sendMessage` / `respondApproval` etc. were silently swallowed and
 * the user only saw "no reply".
 */
export interface ErrorMessage {
  type: 'error';
  /** Optional — the session the failing operation referenced. */
  session_id?: string;
  /** Original client message type. Lets the UI settle operation-specific
   *  loading state even when `code` is an executor-native error such as
   *  `AUTH_REQUIRED`. */
  request_type?: ClientToServerMessage['type'];
  /** Correlation id of the failed request, when it carried one. */
  request_id?: string;
  /** Short machine-readable code, e.g. `MESSAGE_SEND_FAILED`. */
  code: string;
  /** Human-readable message; safe to surface in UI. */
  message: string;
}

/**
 * Per-request ack for a mutating client message (ui-operation-layer §4.4).
 * Sent only to the originating socket, after the Host command handler has
 * completed — and after any canonical broadcast caused by that command has
 * been fanned out to this socket, so a success result never arrives ahead of
 * the state it confirms. Canonical entity/event broadcasts remain the source
 * of durable state; the result only correlates the request and ends the
 * local pending/optimistic phase.
 */
export interface OperationResultMessage {
  type: 'operation:result';
  request_id: string;
  request_type: ClientToServerMessage['type'];
  ok: boolean;
  error?: { code: string; message: string };
}

/**
 * Coarse-grained "the workspace's git state may have changed" ping. Sent
 * after fetch / branch create / merge / drop / worktree teardown — anything
 * that could shift the branches table, ahead-behind counts, or worktree
 * occupancy. Receivers (Workspace → Git tab) re-pull `loadBranches` /
 * `loadRemoteBranches` / `loadWorkspaceTrees` rather than diff-applying.
 *
 * Coarse is intentional: granular events (branch:created, branch:deleted)
 * would couple host event taxonomy to UI concerns that may change as the
 * panel evolves. The payload is small, refreshes are cheap.
 */
export interface WorkspaceGitUpdatedMessage {
  type: 'workspace:git-updated';
  workspace_id: string;
  /** Free-form reason — shown in dev console when debugging refresh storms. */
  reason: 'fetch' | 'branch-created' | 'merge' | 'drop' | 'session-deleted';
}

/**
 * Workbench-terminal channel — independent of any Gian session. Each tab
 * in the workbench terminal pane has a client-minted `term_id` that
 * scopes its PTY.
 */
export interface TermOutputMessage {
  type: 'term:output';
  term_id: string;
  /** Base64-encoded raw bytes. */
  data: string;
}

export interface TermReplayMessage {
  type: 'term:replay';
  term_id: string;
  chunks: string[];
  alive: boolean;
}

export interface TermExitedMessage {
  type: 'term:exited';
  term_id: string;
  code: number | null;
  signal: string | null;
}

export type ServerToClientMessage =
  | AuthOkMessage
  | StateSyncMessage
  | EventMessage
  | SessionUpdatedMessage
  | SessionCreatedMessage
  | SessionDeletedMessage
  | TaskCreatedMessage
  | TaskUpdatedMessage
  | TaskDeletedMessage
  | ApprovalCreatedMessage
  | ApprovalUpdatedMessage
  | QueueUpdatedMessage
  | RunnerUpdatedMessage
  | TermOutputMessage
  | TermReplayMessage
  | TermExitedMessage
  | SessionNativeConfigMessage
  | SessionSlashCommandsMessage
  | WorkspaceGitUpdatedMessage
  | OperationResultMessage
  | ErrorMessage;

export interface SessionCreateMessage {
  type: 'session:create';
  name?: string;
  workspace_id: string;
  executor: Executor;
  model?: string;
  /** Required for Claude/Codex. Kimi uses executor-native configuration. */
  approval_mode?: ApprovalMode;
  /** Correlation id — see `OperationResultMessage`. */
  request_id?: string;
}

/** Select the one transcript whose full event payloads this client needs. */
export interface EventSubscribeMessage {
  type: 'events:subscribe';
  session_id: string | null;
}

export interface MessageSendMessage {
  type: 'message:send';
  session_id: string;
  text: string;
  attachments?: unknown[];
  /**
   * Optional structured input items. When present, replaces `text` for the
   * proxy turn payload (text remains for transcript / queue display). Used
   * for slash invocations that need typed dispatch — e.g. codex skills go
   * out as `[{type:'skill', name, path}]` so codex resolves the skill
   * markdown rather than receiving the slash as plain text.
   */
  items?: InputItem[];
  /**
   * Single-turn bypass: when true, this turn runs with all approvals skipped
   * regardless of session.approval_mode. Does NOT mutate the stored mode —
   * the next turn returns to whatever approval_mode the session had. UI
   * surfaces this as the ⚡ button next to the PLAN/ASK/AUTO segmented control.
   */
  oneShotBypass?: boolean;
  /** Correlation id — see `OperationResultMessage`. */
  request_id?: string;
}

/**
 * User's response to an approval request.
 *
 * Standard tool approvals use `allow_once | allow_session | decline`. The
 * three `*_plan_*` variants are specific to `category === 'exit_plan_mode'`
 * approvals (Claude's "I'm done planning, may I proceed?" prompt):
 *
 *   accept_with_auto — accept the plan + flip session.approval_mode to 'auto'
 *                      (Claude runs tools autonomously on subsequent turns).
 *   accept_with_ask  — accept the plan + flip session.approval_mode to 'ask'
 *                      (each write tool prompts the user from now on).
 *   keep_planning    — reject the plan and stay in plan mode for further
 *                      discussion. Mapped to `behavior=deny` on the proxy.
 *
 * The plan-mode-exit ceremony in SessionManager.respondApproval consumes
 * these to set the correct downstream behavior.
 */
export type ApprovalDecision =
  | 'allow_once'
  | 'allow_session'
  | 'decline'
  | 'accept_with_auto'
  | 'accept_with_ask'
  | 'keep_planning';

export interface ApprovalResolveMessage {
  type: 'approval:resolve';
  session_id: string;
  approval_id: string;
  decision: ApprovalDecision;
  /**
   * Structured answers for AskUserQuestion-flavored approvals
   * (category='question'). Keyed by the question text; the value is the
   * selected option label (single-select) or labels (multi-select).
   * Forwarded by host into cc-proxy's `approval.respond.answers` which
   * piggybacks on the Claude SDK `updatedInput.answers` channel.
   */
  answers?: Record<string, string | string[]>;
  /** Exact executor option for ACP-native approvals. */
  native_option_id?: string;
  /** Correlation id — see `OperationResultMessage`. */
  request_id?: string;
}

export interface SessionStopMessage {
  type: 'session:stop';
  session_id: string;
  /** Correlation id — see `OperationResultMessage`. */
  request_id?: string;
}

/**
 * Last-resort recovery: ask host to forcibly tear down whatever proxy /
 * spawned process backs this session and reset the row to `'done'`. Used
 * when `session:stop` either fails or didn't unstick the spinner.
 */
export interface SessionRecoverMessage {
  type: 'session:recover';
  session_id: string;
  /** Correlation id — see `OperationResultMessage`. */
  request_id?: string;
}

export interface SessionRenameMessage {
  type: 'session:rename';
  session_id: string;
  name: string;
  /** Correlation id — see `OperationResultMessage`. */
  request_id?: string;
}

export interface SessionArchiveMessage {
  type: 'session:archive';
  session_id: string;
  archived: boolean;
  /** Correlation id — see `OperationResultMessage`. */
  request_id?: string;
}

export interface SessionPinMessage {
  type: 'session:pin';
  session_id: string;
  pinned: boolean;
  /** Correlation id — see `OperationResultMessage`. */
  request_id?: string;
}

export interface SessionDeleteMessage {
  type: 'session:delete';
  session_id: string;
  /** Correlation id — see `OperationResultMessage`. */
  request_id?: string;
}

/**
 * Toggle a session's unread marker. `unread: false` is the "mark read" path
 * fired when the user opens/views the session; `unread: true` is the manual
 * "Mark as unread" menu action. Does not bump `updated_at` host-side, so the
 * sidebar order is unaffected.
 */
export interface SessionSetUnreadMessage {
  type: 'session:set_unread';
  session_id: string;
  unread: boolean;
  /** Correlation id — see `OperationResultMessage`. */
  request_id?: string;
}

export interface SessionSetModeMessage {
  type: 'session:set_mode';
  session_id: string;
  approval_mode: ApprovalMode;
  /** Correlation id — see `OperationResultMessage`. */
  request_id?: string;
}

export interface SessionSetModelMessage {
  type: 'session:set_model';
  session_id: string;
  model: string;
  /** Correlation id — see `OperationResultMessage`. */
  request_id?: string;
}

export interface SessionSetEffortMessage {
  type: 'session:set_effort';
  session_id: string;
  /** Null clears (use model default). See `ThinkingEffort`. */
  effort: import('./model.js').ThinkingEffort | null;
  /** Correlation id — see `OperationResultMessage`. */
  request_id?: string;
}

export interface SessionSetServiceTierMessage {
  type: 'session:set_service_tier';
  session_id: string;
  /** 'fast' turns the codex Fast tier on; null turns it off. codex-only. */
  service_tier: 'fast' | null;
  /** Correlation id — see `OperationResultMessage`. */
  request_id?: string;
}

export interface SessionSetNativeConfigMessage {
  type: 'session:set_native_config';
  session_id: string;
  config_id: string;
  value: import('./model.js').NativeConfigValue;
  /** Correlation id — see `OperationResultMessage`. */
  request_id?: string;
}

export interface SessionNativeConfigMessage {
  type: 'session:native-config';
  session_id: string;
  state: import('./model.js').ExecutorConfigState;
  options: import('./model.js').NativeConfigOption[];
}

export interface SessionSlashCommandsMessage {
  type: 'session:slash-commands';
  session_id: string;
  commands: import('./proxy.js').SlashCommand[];
}

export interface QueueAddMessage {
  type: 'queue:add';
  session_id: string;
  text: string;
  /** Structured input items (image attachments) carried with the message —
   *  same shape as MessageSendMessage.items. */
  items?: InputItem[];
  /** Correlation id — see `OperationResultMessage`. */
  request_id?: string;
}

export interface QueueRemoveMessage {
  type: 'queue:remove';
  session_id: string;
  queue_id: string;
  /** Correlation id — see `OperationResultMessage`. */
  request_id?: string;
}

export interface QueueUpdateMessage {
  type: 'queue:update';
  session_id: string;
  queue_id: string;
  /** New text for the entry. Position in the queue is kept; attachments
   *  (items) are not editable — remove and re-queue to change those. */
  text: string;
  /** Correlation id — see `OperationResultMessage`. */
  request_id?: string;
}

export interface QueueSendNowMessage {
  type: 'queue:send_now';
  session_id: string;
  /** Correlation id — see `OperationResultMessage`. */
  request_id?: string;
}

export interface QueueClearMessage {
  type: 'queue:clear';
  session_id: string;
  /** Correlation id — see `OperationResultMessage`. */
  request_id?: string;
}

/** Codex-only mid-turn injection: append the message to the session's ACTIVE
 *  turn via `turn/steer` instead of queueing it for the next one. Other
 *  executors reject — they have no native steer primitive. */
export interface MessageSteerMessage {
  type: 'message:steer';
  session_id: string;
  text: string;
  items?: InputItem[];
  /** Correlation id — see `OperationResultMessage`. */
  request_id?: string;
}

/**
 * Workbench terminal — client → server messages, keyed by `term_id` and
 * routed to the host's WorkbenchTerminalManager.
 */
export interface TermSpawnMessage {
  type: 'term:spawn';
  term_id: string;
  /** Optional cwd; falls back to $HOME server-side. */
  cwd?: string;
  cols: number;
  rows: number;
  /** Optional override of the shell binary (default = $SHELL). */
  shell?: string;
  /** Correlation id — see `OperationResultMessage`. */
  request_id?: string;
}

export interface TermInputMessage {
  type: 'term:input';
  term_id: string;
  data: string;
}

export interface TermResizeMessage {
  type: 'term:resize';
  term_id: string;
  cols: number;
  rows: number;
}

export interface TermReplayRequestMessage {
  type: 'term:replay-request';
  term_id: string;
}

export interface TermCloseMessage {
  type: 'term:close';
  term_id: string;
  /** Correlation id — see `OperationResultMessage`. */
  request_id?: string;
}

export type ClientToServerMessage =
  | AuthMessage
  | EventSubscribeMessage
  | SessionCreateMessage
  | MessageSendMessage
  | MessageSteerMessage
  | ApprovalResolveMessage
  | SessionStopMessage
  | SessionRecoverMessage
  | SessionRenameMessage
  | SessionArchiveMessage
  | SessionPinMessage
  | SessionDeleteMessage
  | TaskCreateMessage
  | TaskUpdateMessage
  | TaskDeleteMessage
  | SessionSetUnreadMessage
  | SessionSetModeMessage
  | SessionSetModelMessage
  | SessionSetEffortMessage
  | SessionSetServiceTierMessage
  | SessionSetNativeConfigMessage
  | QueueAddMessage
  | QueueRemoveMessage
  | QueueUpdateMessage
  | QueueSendNowMessage
  | QueueClearMessage
  | TermSpawnMessage
  | TermInputMessage
  | TermResizeMessage
  | TermReplayRequestMessage
  | TermCloseMessage;
