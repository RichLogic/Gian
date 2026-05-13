/**
 * Unified event taxonomy for Gian.
 *
 * All Executors (cc / codex) normalize their raw proxy notifications into one
 * of these discriminated types before the event reaches any subscriber.
 * Normalization happens in `packages/host/src/event/normalize-{cc,codex}.ts`.
 *
 * Keep this file in sync with PRD §一 and `doc/protocol-proxy.md`.
 *
 * Note: PRD §一 lists `thinking` as event #2, but no proxy currently emits it
 * (codex doesn't support it; cc exposes only an `effort` model setting, not
 * thinking content via the proxy boundary). Per the project rule "skip events
 * no proxy emits", `thinking` is omitted here. Re-add if cc-proxy starts
 * surfacing thinking blocks as a notification.
 */

// ---------------------------------------------------------------------------
// Event type discriminant
// ---------------------------------------------------------------------------

export type EventType =
  | 'assistant_text'
  | 'command_execution'
  | 'file_change'
  | 'file_read'
  | 'file_search'
  | 'web_search'
  | 'agent_spawn'
  | 'approval_requested'
  | 'approval_resolved'
  | 'auto_classifier_denied'
  | 'auto_circuit_breaker'
  | 'turn_completed'
  | 'session_error';

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
 * Sub-agent spawned by the AI.
 *
 * from: cc only (Agent tool_use)
 * codex: not supported.
 */
export interface AgentSpawnData {
  description: string;
  status: 'running' | 'done' | 'error';
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
   * Currently used by the host normalizer to identify AskUserQuestion;
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
 * Turn finished normally.
 *
 * from: codex (turn.completed) · cc (turn.completed)
 */
export interface TurnCompletedData {
  turnId: string;
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

// ---------------------------------------------------------------------------
// Lookup map: EventType → data interface
// ---------------------------------------------------------------------------

export type EventDataByType = {
  assistant_text: AssistantTextData;
  command_execution: CommandExecutionData;
  file_change: FileChangeData;
  file_read: FileReadData;
  file_search: FileSearchData;
  web_search: WebSearchData;
  agent_spawn: AgentSpawnData;
  approval_requested: ApprovalRequestedData;
  approval_resolved: ApprovalResolvedData;
  auto_classifier_denied: AutoClassifierDeniedData;
  auto_circuit_breaker: AutoCircuitBreakerData;
  turn_completed: TurnCompletedData;
  session_error: SessionErrorData;
};

// ---------------------------------------------------------------------------
// Typed envelope
// ---------------------------------------------------------------------------

/**
 * The canonical event shape that flows through EventRouter and out to the
 * WebSocket layer. Replaces the untyped EventEnvelope for all internal usage.
 * EventEnvelope in web.ts remains the wire format sent to the browser.
 */
export interface UnifiedEvent<T extends EventType = EventType> {
  session_id: string;
  /** 1-based turn counter for the session. */
  turn: number;
  /** Stable call-site ID (maps to EventEnvelope.call_id). */
  call_id: string;
  /** Unix ms timestamp. */
  ts: number;
  type: T;
  data: EventDataByType[T];
}
