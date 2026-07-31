export interface MsgItem {
  kind: 'user' | 'assistant';
  id: string;
  text: string;
  exec: import('@gian/shared').Executor;
  ts: number;
  turn: number;
  /** Local-only user echo awaiting the server's `user_message` event. */
  pending?: boolean;
  /** Server rejected the send (e.g. `MESSAGE_SEND_FAILED`). */
  failed?: boolean;
  /** Attachments to render in the bubble. Images use inline thumbnails;
   *  other files use download chips. Pending echoes carry a blob URL until
   *  the server confirms with its permanent attachment URL. */
  attachments?: import('@gian/shared').MessageAttachment[];
}

export interface ToolItem {
  kind: 'tool';
  id: string;
  name: string;
  summary: string;
  ts: number;
  turn: number;
}

/**
 * Model reasoning content — separate from assistant text. Streams in via
 * `reasoning` unified events. Codex emits two flavors:
 *   - 'summary' — condensed "what I'm about to do" recap
 *   - 'full'    — raw reasoning trace
 * Rendered as a collapsible ReasoningCard.
 */
export interface ReasoningItem {
  kind: 'reasoning';
  id: string;
  text: string;
  variant: 'summary' | 'full';
  ts: number;
  turn: number;
}

export interface CommandItem {
  kind: 'command';
  id: string;
  command: string;
  cwd?: string;
  status: 'running' | 'success' | 'error';
  exitCode?: number;
  stdout: string;
  stderr?: string;
  ts: number;
  turn: number;
}

export interface FileReadItem {
  kind: 'file-read';
  id: string;
  path: string;
  startLine?: number;
  endLine?: number;
  ts: number;
  turn: number;
}

export interface FileSearchItem {
  kind: 'file-search';
  id: string;
  pattern: string;
  searchKind: 'glob' | 'grep';
  matchCount?: number;
  matches?: string[];
  ts: number;
  turn: number;
}

export interface WebSearchItem {
  kind: 'web-search';
  id: string;
  query: string;
  resultCount?: number;
  ts: number;
  turn: number;
}

export interface AgentSpawnItem {
  kind: 'agent-spawn';
  id: string;
  /** Executor remains presentation metadata; provider-native roles/statuses
   *  are not collapsed into a global agent protocol. */
  provider: import('@gian/shared').Executor;
  agentId?: string;
  description: string;
  status: 'running' | 'done' | 'error';
  agentType?: string;
  model?: string;
  output?: string;
  outputFile?: string;
  taskId?: string;
  background?: boolean;
  input?: Record<string, unknown>;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  ts: number;
  turn: number;
}

/**
 * cc-only auto-mode notices. Two variants share one shape:
 *
 *   classifier-denied — informational: the classifier blocked one action,
 *                       the agent will retry a different approach.
 *   circuit-breaker   — terminal-ish: 3 consecutive or 20 total denials
 *                       tripped; in `claude -p` mode the session aborts.
 *
 * Schema (shared/events.ts) hints at a recovery card with retry / switch
 * to ask / abort actions; we render the notice now and leave the action
 * wiring for when host gains the corresponding control channel.
 */
export interface AutoNoticeItem {
  kind: 'auto-notice';
  id: string;
  variant: 'classifier-denied' | 'circuit-breaker';
  /** What the classifier blocked (classifier-denied only). */
  action?: string;
  /** Classifier rule text (classifier-denied only). */
  reason?: string;
  /** Which threshold tripped (circuit-breaker only). */
  trigger?: 'consecutive' | 'total';
  consecutive: number;
  total: number;
  ts: number;
  turn: number;
}

export interface StatusItem {
  kind: 'status' | 'error' | 'turn-start' | 'turn-end';
  id: string;
  text: string;
  ts: number;
  turn: number;
}

export interface ApprovalItem {
  kind: 'approval';
  id: string;
  approvalId: string;
  title: string;
  reason: string;
  cmd: string;
  risk: 'low' | 'medium' | 'high';
  status: 'pending' | 'approved-once' | 'approved-session' | 'declined';
  /** 'question' = AskUserQuestion-flavored approval; UI renders structured
   *  options instead of generic allow/decline. Otherwise undefined. */
  category?: import('@gian/shared').ApprovalCategory;
  /** Structured questions when `category === 'question'`. */
  questions?: import('@gian/shared').AskQuestion[];
  /** Human-readable summary of what the user picked, set when a `question`
   *  approval resolves. Drives the resolved card's "answered with …" line. */
  answeredWith?: string;
  /** Which scope buttons to surface — drives whether `Allow session` appears.
   *  Defaults to `['once']` (only "Allow once"). */
  scopeOptions?: ('once' | 'session')[];
  /** When `category === 'exit_plan_mode'`, the three-way action set to show
   *  in place of the generic Allow once / Allow session / Decline. Maps to
   *  ApprovalDecision variants 1:1. */
  planActions?: ('accept_with_auto' | 'accept_with_ask' | 'keep_planning')[];
  /** Exact executor-owned buttons for ACP-native permission requests. */
  nativeOptions?: import('@gian/shared').NativeApprovalOption[];
  nativeOptionId?: string;
  /** Timestamp of the lifecycle event that resolved this approval. */
  resolvedAt?: number;
  ts: number;
  turn: number;
}

export interface ApprovalActionContext {
  category?: import('@gian/shared').ApprovalCategory;
  nativeOptionId?: string;
}

export interface DiffFile {
  path: string;
  add: number;
  del: number;
  hunks: Array<{ header: string; lines: Array<{ kind: 'add' | 'del' | 'ctx'; text: string }> }>;
}

export interface DiffItem {
  kind: 'diff';
  id: string;
  files: DiffFile[];
  ts: number;
  turn: number;
}

export type TranscriptItem =
  | MsgItem
  | ReasoningItem
  | ToolItem
  | StatusItem
  | ApprovalItem
  | DiffItem
  | CommandItem
  | FileReadItem
  | FileSearchItem
  | WebSearchItem
  | AgentSpawnItem
  | AutoNoticeItem;

/** Queue entry mirror of QueueUpdatedMessage payload (host/src/queue). */
export interface QueueEntry {
  id: string;
  text: string;
}
