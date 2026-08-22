/**
 * UI display projections for chat events.
 *
 * These names describe Gian's current cards and page-level views. They are
 * deliberately not a cross-CLI event protocol: provider event names and raw
 * payloads remain the source of truth on {@link ChatEvent}. A provider adapter
 * only decides whether one native event should create one or more projections.
 */

// ---------------------------------------------------------------------------
// Event type discriminant
// ---------------------------------------------------------------------------

export type DisplayEventType =
  | 'message'
  | 'activity.reasoning'
  | 'activity.command'
  | 'activity.file-change'
  | 'activity.file-read'
  | 'activity.file-search'
  | 'activity.web-search'
  | 'activity.tool'
  | 'activity.notice'
  | 'activity.classifier-denied'
  | 'activity.circuit-breaker'
  | 'plan'
  | 'agent'
  | 'interaction.question'
  | 'interaction.approval'
  | 'interaction.resolved'
  | 'state.turn-started'
  | 'state.turn-completed'
  | 'state.error';

// ---------------------------------------------------------------------------
// Per-type data interfaces
// ---------------------------------------------------------------------------

/**
 * AI-generated text reply, streaming or final.
 *
 * from: codex (output.text.delta, streaming) · cc (output.text, full-turn)
 */
export interface AssistantTextData {
  /** Accumulated text for a completed item, or the chunk for a delta. */
  text: string;
  /** True when this event is a streaming fragment rather than a final value. */
  delta: boolean;
  /**
   * Stable ID that groups streaming deltas into one logical message.
   * For cc (non-streaming) this is the call_id of the output.text notification.
   */
  itemId: string;
}

/**
 * Model reasoning content — the "thinking" that precedes/intersperses
 * assistant text. Both full reasoning text and summary forms flow through
 * here; the `kind` field distinguishes them.
 *
 * from: codex (item/reasoning/textDelta and item/reasoning/summaryTextDelta;
 *              parts are delimited by item/reasoning/summaryPartAdded).
 * cc:   not emitted today — Claude exposes only an effort setting, not the
 *       reasoning content stream.
 */
export interface ReasoningData {
  /** Accumulated text for a completed item, or the chunk for a delta. */
  text: string;
  /** True when this event is a streaming fragment rather than a final value. */
  delta: boolean;
  /** Stable ID that groups streaming deltas. */
  itemId: string;
  /**
   * 'summary' = condensed reasoning (item/reasoning/summary*), shown to the
   * user as a high-level "what I'm thinking" recap.
   * 'full'    = raw reasoning trace (item/reasoning/textDelta), much longer.
   * The two streams are distinct items; the UI renders both as ReasoningCard
   * with different headers.
   */
  kind: 'summary' | 'full';
}

/**
 * Page-level plan content update. Provider adapters keep their native
 * protocols and project only the latest displayable plan text here.
 *
 * from: codex (item/plan/delta + structured turn/plan/updated steps)
 *       kimi (ACP TodoList plan snapshot)
 *       cc (plan-file Write fallback; ExitPlanMode remains an approval)
 */
export interface PlanUpdateData {
  /** Full plan markdown so far. UI replaces in place. */
  text: string;
  /** True while the plan is still streaming, false on turn/plan/updated. */
  delta: boolean;
}

/**
 * Shell command executed by the AI.
 *
 * from: codex (commandExecution item + outputDelta stream) · cc (Bash tool_use)
 */
export interface CommandExecutionData {
  command: string;
  cwd?: string;
  status: 'running' | 'success' | 'error';
  exitCode?: number;
  /** Full accumulated stdout; for streaming use stdoutDelta instead. */
  stdout?: string;
  stderr?: string;
  /** Streaming stdout fragment — append to the previous stdout accumulator. */
  stdoutDelta?: string;
  /** Stable ID for streaming delta correlation (mirrors itemId on assistant_text). */
  itemId: string;
}

/**
 * File created, modified, or deleted by the AI.
 *
 * from: codex (diff.updated / turn/diff/updated) · cc (Write/Edit/NotebookEdit tool_use)
 */
export interface FileChangeData {
  files: FileChangeSummary[];
  /** Raw unified diff when available (codex provides it; cc builds it from tool input). */
  diff?: string;
}

export interface FileChangeSummary {
  path: string;
  kind: 'create' | 'update' | 'delete';
  /** Line-level counts when determinable. */
  added?: number;
  removed?: number;
}

/**
 * File read by the AI.
 *
 * from: cc only (Read tool_use)
 * codex: no discrete read events — reads are implicit in thread history.
 */
export interface FileReadData {
  path: string;
  startLine?: number;
  endLine?: number;
}

/**
 * Code search (glob or grep) performed by the AI.
 *
 * from: cc only (Glob / Grep tool_use)
 * codex: no discrete search events.
 */
export interface FileSearchData {
  pattern: string;
  /** 'glob' for filename searches, 'grep' for content searches. */
  kind: 'glob' | 'grep';
  matchCount?: number;
  matches?: string[];
}

/**
 * Web search performed by the AI.
 *
 * from: codex (webSearch item) · cc (WebSearch tool_use)
 */
export interface WebSearchData {
  query: string;
  resultCount?: number;
}

/**
 * Generic executor tool event used when a tool cannot be represented without
 * loss by one of the specialized cards above.
 */
export interface ToolExecutionData {
  itemId: string;
  title: string;
  kind?: string;
  status: 'pending' | 'running' | 'success' | 'error';
  input?: unknown;
  output?: unknown;
  locations?: Array<{ path: string; line?: number }>;
}

/**
 * Persistent sub-agent run display state.
 *
 * from: cc (Agent/Task tool_use + native task lifecycle)
 *       codex (collabAgentToolCall / subAgentActivity)
 *       kimi (ACP Agent tool lifecycle)
 */
export interface AgentSpawnData {
  /** Executor-native agent identity when one exists (Claude task id, Codex
   *  child thread id). `call_id` remains the stable display-row identity. */
  agentId?: string;
  description: string;
  status: 'running' | 'done' | 'error';
  /** Executor-native agent kind / role, kept as display metadata rather than
   *  forced into a cross-provider enum. */
  agentType?: string;
  /** Model requested or resolved for this agent, when the CLI reports it. */
  model?: string;
  /** Terminal native summary. Full child transcripts stay provider-owned. */
  output?: string;
  outputFile?: string;
  /** Provider-native task identity, when distinct from the child agent id. */
  taskId?: string;
  /** Whether the provider launched the child without blocking its parent. */
  background?: boolean;
  startedAt?: number;
  completedAt?: number;
  /** tool_use input block for reference. */
  input?: Record<string, unknown>;
}

/**
 * Approval request — executor is blocked until resolved.
 *
 * from: codex (approval.requested in unsafe-agent mode) · cc (approval.requested)
 */
export interface ApprovalRequestedData {
  approvalId: string;
  category:
    | 'command'
    | 'network'
    | 'file_write_outside_ws'
    | 'exit_plan_mode'
    | 'question'
    | 'other';
  risk: 'low' | 'medium' | 'high';
  title: string;
  description: string;
  /**
   * Executor-specific: command text for command approvals, file path for
   * file_write_outside_ws, URL for network, full plan markdown for
   * exit_plan_mode, etc.
   */
  subject?: string;
  scopeOptions: ('once' | 'session')[];
  /**
   * Tool name reported by the proxy (cc-proxy passes this as `toolName`).
   * Used by the Claude display adapter to identify AskUserQuestion;
   * surfaced for diagnostics on the UI side.
   */
  toolName?: string;
  /**
   * Structured question payload. Set when `category === 'question'`,
   * currently only by the cc AskUserQuestion bridge. The UI renders a
   * QuestionCard with these options instead of generic allow/decline.
   */
  questions?: AskQuestion[];
  /**
   * Three-way action set for `category === 'exit_plan_mode'`. When present,
   * the UI replaces the standard once/session/decline buttons with one
   * button per listed action, matching Claude Code's native plan-mode-exit
   * prompt. Decisions map back via {@link ApprovalDecision}:
   *
   *   'accept_with_auto'  → accept the plan, future turns run in auto mode
   *   'accept_with_ask'   → accept the plan, future turns prompt per write
   *   'keep_planning'     → reject; agent stays in plan mode for more input
   */
  planActions?: ('accept_with_auto' | 'accept_with_ask' | 'keep_planning')[];
  /** Exact choices supplied by the executor. When present the UI must return
   *  one `optionId` rather than translating through Gian ApprovalDecision. */
  nativeOptions?: import('./model.js').NativeApprovalOption[];
  /** gian.proxy/2.0 interaction actions, rendered as-is when present. */
  actions?: InteractionAction[];
  /** gian.proxy/2.0 interaction inputs, rendered as-is when present. */
  inputs?: InteractionInput[];
}

export interface InteractionAction {
  id: string;
  label: string;
  style: 'primary' | 'secondary' | 'danger';
}

export interface InteractionInputChoice {
  value: string;
  displayName: string;
}

export interface InteractionInput {
  id: string;
  type: 'text' | 'multiline_text' | 'single_select' | 'multi_select' | 'boolean';
  label: string;
  required: boolean;
  description?: string;
  choices?: InteractionInputChoice[];
  sensitive?: boolean;
  placeholder?: string;
  multiline?: boolean;
}

export interface AskQuestionOption {
  label: string;
  description?: string;
}

export interface AskQuestion {
  question: string;
  /** Short header shown as a chip; comes from AskUserQuestion's `header`. */
  header?: string;
  /** When true, multiple options can be selected. */
  multiSelect: boolean;
  options: AskQuestionOption[];
}

/**
 * Approval resolved — executor unblocked.
 *
 * from: codex (approval.resolved) · cc (approval.resolved)
 */
export interface ApprovalResolvedData {
  approvalId: string;
  decision: 'allow_once' | 'allow_session' | 'decline';
  /** True when the proxy resolved automatically (safe-agent mode, low-risk auto-approve, etc.). */
  auto: boolean;
  /** AskUserQuestion only: the answers the user picked, keyed by question
   *  text. Lets a resolved question card show "answered with …" both live and
   *  when a transcript is rebuilt from persisted events. */
  answers?: Record<string, string | string[]>;
  nativeOptionId?: string | null;
}

/**
 * Auto-mode classifier denied an action. Informational — the agent receives
 * the deny reason and tries an alternative approach automatically. UI should
 * surface this as a non-blocking notice so the user can see what was blocked
 * and (optionally) retry it manually via the approval card.
 *
 * from: cc only (--permission-mode auto + classifier soft_deny)
 * codex: classifier-style denials run inside the auto_review subagent and do
 *        not surface as discrete events.
 */
export interface AutoClassifierDeniedData {
  /** Tool / action the classifier blocked. */
  action: string;
  /** Classifier's reason for denying (the rule it matched). */
  reason: string;
  /** Consecutive denials so far (for circuit-breaker visibility). */
  consecutive: number;
  /** Total denials in the session so far. */
  total: number;
}

/**
 * Auto-mode circuit breaker tripped. cc-proxy emits this when 3 consecutive
 * or 20 total classifier denials accumulate; in `claude -p` mode the session
 * aborts. UI should surface a recovery card (retry / switch to ask / abort).
 *
 * from: cc only
 */
export interface AutoCircuitBreakerData {
  /** Which threshold tripped. */
  trigger: 'consecutive' | 'total';
  consecutive: number;
  total: number;
}

/**
 * Turn started — a signal for UI to flip the "thinking" / pending state.
 * Carries no transcript content; frontend `applyEnvelope` ignores it for
 * folding purposes but App-level listeners use it to drive pendingBySession.
 *
 * from: codex (turn.started) · cc (turn.started)
 */
export interface TurnStartedData {
  turnId: string;
}

/**
 * Turn finished normally.
 *
 * from: codex (turn.completed) · cc (turn.completed)
 */
export interface TurnCompletedData {
  turnId: string;
  /** Proxy-stable identity for the same native Turn, used with turnId as an
   *  exact session.fork.atTurn boundary. */
  sourceTurnId?: string;
  /** Final assistant text for the turn, when available (codex summary.assistantText). */
  summary?: string;
}

/**
 * Executor-level error: process crash, API failure, timeout, etc.
 *
 * from: codex (runtime.error / turn.failed) · cc (turn.failed / process exit)
 */
export interface SessionErrorData {
  message: string;
  /** True when a client-initiated retry might recover the session. */
  retryable: boolean;
  /** Raw error code from the proxy, when available. */
  code?: string;
}

export interface NoticeData {
  severity: 'info' | 'warning' | 'error';
  code: string;
  title: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Lookup map: display selector → view-data interface
// ---------------------------------------------------------------------------

export type DisplayDataByType = {
  message: AssistantTextData;
  'activity.reasoning': ReasoningData;
  plan: PlanUpdateData;
  'activity.command': CommandExecutionData;
  'activity.file-change': FileChangeData;
  'activity.file-read': FileReadData;
  'activity.file-search': FileSearchData;
  'activity.web-search': WebSearchData;
  'activity.tool': ToolExecutionData;
  'activity.notice': NoticeData;
  agent: AgentSpawnData;
  'interaction.question': ApprovalRequestedData;
  'interaction.approval': ApprovalRequestedData;
  'interaction.resolved': ApprovalResolvedData;
  'activity.classifier-denied': AutoClassifierDeniedData;
  'activity.circuit-breaker': AutoCircuitBreakerData;
  'state.turn-started': TurnStartedData;
  'state.turn-completed': TurnCompletedData;
  'state.error': SessionErrorData;
};

// ---------------------------------------------------------------------------
// Typed envelope
// ---------------------------------------------------------------------------

/**
 * A UI projection produced by one provider adapter. It has no provider event
 * name of its own; `type` is strictly a display selector.
 */
export interface DisplayEvent<T extends DisplayEventType = DisplayEventType> {
  session_id: string;
  /** 1-based turn counter for the session. */
  turn: number;
  /** Stable call-site ID (maps to EventEnvelope.call_id). */
  call_id: string;
  /** Unix ms timestamp. */
  ts: number;
  type: T;
  data: DisplayDataByType[T];
}

export type ChatDisplay<T extends DisplayEventType = DisplayEventType> = {
  [K in T]: { type: K; data: DisplayDataByType[K] }
}[T];

/**
 * Source-of-truth event shape used by the host and browser.
 *
 * `event` and `data` are the provider-native method and payload. `display` is
 * Gian's replaceable answer to “which current UI should render this?”. The
 * same native event may yield multiple ChatEvents when it affects multiple UI
 * surfaces (for example a Claude plan-file write is both file activity and a
 * page-level plan update).
 */
export interface ChatEvent<T extends DisplayEventType = DisplayEventType> {
  session_id: string;
  turn: number;
  call_id: string;
  ts: number;
  provider: import('./model.js').Executor;
  event: string;
  data: Record<string, unknown>;
  /** Missing means the native event is retained for diagnostics/replay but has no UI. */
  display?: ChatDisplay<T>;
}
