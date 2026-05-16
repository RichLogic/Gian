import type {
  Approval,
  ApprovalCategory,
  ApprovalMode,
  ApprovalResolvedBy,
  ApprovalStatus,
  Bot,
  Executor,
  QueueEntry,
  RuntimeMode,
  Session,
  SystemConfig,
  Workspace,
} from './model.js';
import type { InputItem } from './proxy.js';

export type WsClose = 4001 | 4002 | 4003;

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
  bots: Bot[];
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

export interface ApprovalCreatedMessage {
  type: 'approval:created';
  approval: {
    id: string;
    session_id: string;
    category: ApprovalCategory;
    description: string;
    status: ApprovalStatus;
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
  queue: Array<Pick<QueueEntry, 'id' | 'text'>>;
}

export interface BotUpdatedMessage {
  type: 'bot:updated';
  bot: Pick<Bot, 'id'> & Partial<Bot> & { online?: boolean; last_msg?: string };
}

export interface RunnerUpdatedMessage {
  type: 'runner:updated';
  runner: Partial<RunnerInfo>;
}

export interface TranscriptHistoryMessage {
  type: 'transcript:history';
  session_id: string;
  events: EventEnvelope[];
  has_more: boolean;
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
  /** Short machine-readable code, e.g. `MESSAGE_SEND_FAILED`. */
  code: string;
  /** Human-readable message; safe to surface in UI. */
  message: string;
}

/**
 * Server-pushed PTY output chunk. Sent every time the underlying CLI writes
 * to stdout/stderr while the session is in `tty` runtime mode. `data` is
 * base64-encoded raw bytes — the xterm side decodes and writes(uint8).
 *
 * Base64 (not binary frames) so this rides the same JSON broadcast pipe as
 * every other ws message — no separate binary plumbing through
 * `WsBroadcaster`. The overhead is ~33%, acceptable for human-typing TTY.
 */
export interface PtyOutputMessage {
  type: 'pty:output';
  session_id: string;
  /** Base64-encoded chunk. */
  data: string;
}

/**
 * Replay buffer for a session that just connected (or just switched to TTY).
 * `chunks` are appended in order, each base64-encoded. The client writes
 * them to xterm before subscribing to live `pty:output`. Truncated to the
 * runtime ring buffer cap (default ~1MB).
 */
export interface PtyReplayMessage {
  type: 'pty:replay';
  session_id: string;
  chunks: string[];
  /** True when the live PTY process is actually running. False means the
   *  buffer is historical (e.g. process died) so the UI can show a
   *  reconnect hint. */
  alive: boolean;
}

export interface SessionRuntimeSwitchedMessage {
  type: 'session:runtime-switched';
  session_id: string;
  runtime_mode: RuntimeMode;
}

export type ServerToClientMessage =
  | AuthOkMessage
  | StateSyncMessage
  | EventMessage
  | SessionUpdatedMessage
  | SessionCreatedMessage
  | SessionDeletedMessage
  | ApprovalCreatedMessage
  | ApprovalUpdatedMessage
  | QueueUpdatedMessage
  | BotUpdatedMessage
  | RunnerUpdatedMessage
  | TranscriptHistoryMessage
  | PtyOutputMessage
  | PtyReplayMessage
  | SessionRuntimeSwitchedMessage
  | ErrorMessage;

export interface SessionCreateMessage {
  type: 'session:create';
  name?: string;
  workspace_id: string;
  executor: Executor;
  model?: string;
  approval_mode: ApprovalMode;
  /** When 'worktree', host creates a dedicated branch + working directory
   *  before spawning the proxy. */
  mode?: 'regular' | 'worktree';
  /** Override the auto-detected base branch (e.g. 'main'). Worktree mode only. */
  base_branch?: string;
  /** Override the auto-generated branch name. Worktree mode only. */
  branch?: string;
}

export interface SessionSelectMessage {
  type: 'session:select';
  session_id: string;
}

export interface TranscriptLoadMoreMessage {
  type: 'transcript:load_more';
  session_id: string;
  before: string;
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
}

export interface SessionStopMessage {
  type: 'session:stop';
  session_id: string;
}

/**
 * Last-resort recovery: ask host to forcibly tear down whatever proxy /
 * spawned process backs this session and reset the row to `'done'`. Used
 * when `session:stop` either fails or didn't unstick the spinner.
 */
export interface SessionRecoverMessage {
  type: 'session:recover';
  session_id: string;
}

export interface SessionResetMessage {
  type: 'session:reset';
  session_id: string;
}

export interface SessionRenameMessage {
  type: 'session:rename';
  session_id: string;
  name: string;
}

export interface SessionArchiveMessage {
  type: 'session:archive';
  session_id: string;
  archived: boolean;
}

export interface SessionDeleteMessage {
  type: 'session:delete';
  session_id: string;
}

export interface SessionSetModeMessage {
  type: 'session:set_mode';
  session_id: string;
  approval_mode: ApprovalMode;
  turns?: number;
}

export interface SessionSetModelMessage {
  type: 'session:set_model';
  session_id: string;
  model: string;
}

export interface SessionSetEffortMessage {
  type: 'session:set_effort';
  session_id: string;
  /** Null clears (use model default). See `ThinkingEffort`. */
  effort: import('./model.js').ThinkingEffort | null;
}

export interface SessionTakeoverMessage {
  type: 'session:takeover';
  session_id: string;
}

export interface SlashExecuteMessage {
  type: 'slash:execute';
  session_id: string;
  command: string;
}

export interface QueueAddMessage {
  type: 'queue:add';
  session_id: string;
  text: string;
}

export interface QueueRemoveMessage {
  type: 'queue:remove';
  session_id: string;
  queue_id: string;
}

export interface QueueReorderMessage {
  type: 'queue:reorder';
  session_id: string;
  order: string[];
}

export interface QueueSendNowMessage {
  type: 'queue:send_now';
  session_id: string;
}

export interface QueueClearMessage {
  type: 'queue:clear';
  session_id: string;
}

/**
 * Request a runtime-mode switch for a session (Structured ↔ TTY). Allowed
 * only while the session is idle (no in-flight turn, no pending approval,
 * no TTY-side permission prompt). On success the host emits
 * `session:runtime-switched` and a follow-up `session:updated`.
 *
 * Failure cases (busy / closed / unsupported) come back as a regular
 * `ErrorMessage` with `code = 'SWITCH_BLOCKED'`.
 */
export interface SessionSwitchRuntimeMessage {
  type: 'session:switch-runtime';
  session_id: string;
  target: RuntimeMode;
}

/**
 * Keystroke (or paste) headed for the PTY stdin. `data` is base64-encoded
 * raw bytes. Ignored when the session is not currently in `tty` mode.
 */
export interface PtyInputMessage {
  type: 'pty:input';
  session_id: string;
  data: string;
}

/**
 * Terminal size change. Cols and rows in character cells.
 */
export interface PtyResizeMessage {
  type: 'pty:resize';
  session_id: string;
  cols: number;
  rows: number;
}

/**
 * Replay-buffer request. Sent after a fresh socket connects or the user
 * navigates back to a TTY session. Server replies with `PtyReplayMessage`.
 */
export interface PtyReplayRequestMessage {
  type: 'pty:replay-request';
  session_id: string;
}

export type ClientToServerMessage =
  | AuthMessage
  | SessionCreateMessage
  | SessionSelectMessage
  | TranscriptLoadMoreMessage
  | MessageSendMessage
  | ApprovalResolveMessage
  | SessionStopMessage
  | SessionRecoverMessage
  | SessionResetMessage
  | SessionRenameMessage
  | SessionArchiveMessage
  | SessionDeleteMessage
  | SessionSetModeMessage
  | SessionSetModelMessage
  | SessionSetEffortMessage
  | SessionTakeoverMessage
  | SlashExecuteMessage
  | QueueAddMessage
  | QueueRemoveMessage
  | QueueReorderMessage
  | QueueSendNowMessage
  | QueueClearMessage
  | SessionSwitchRuntimeMessage
  | PtyInputMessage
  | PtyResizeMessage
  | PtyReplayRequestMessage;
