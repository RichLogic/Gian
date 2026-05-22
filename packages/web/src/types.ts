export interface MsgItem {
  kind: 'user' | 'assistant';
  id: string;
  text: string;
  exec: 'claude' | 'codex';
  ts: number;
  turn: number;
  /** Local-only user echo awaiting the server's `user_message` event. */
  pending?: boolean;
  /** Server rejected the send (e.g. `MESSAGE_SEND_FAILED`). */
  failed?: boolean;
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
  description: string;
  status: 'running' | 'done' | 'error';
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
  /** Which scope buttons to surface — drives whether `Allow session` appears.
   *  Defaults to `['once']` (only "Allow once"). */
  scopeOptions?: ('once' | 'session')[];
  /** When `category === 'exit_plan_mode'`, the three-way action set to show
   *  in place of the generic Allow once / Allow session / Decline. Maps to
   *  ApprovalDecision variants 1:1. */
  planActions?: ('accept_with_auto' | 'accept_with_ask' | 'keep_planning')[];
  ts: number;
  turn: number;
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

export interface TokenUsage {
  total: number;
  input: number;
  output: number;
  cached: number;
  /**
   * Estimate of the conversation tokens sent on the most recent turn — i.e.
   * what's currently in the model's context window. Drops after a /compact
   * because the next turn ships a condensed history. The context bar should
   * divide this by `contextWindow`, NOT `total`: for codex `total` is the
   * session-lifetime cumulative sum and quickly exceeds `contextWindow`,
   * pegging the bar at 100% forever.
   */
  contextUsed: number;
  contextWindow?: number;
}

export type View = 'coding' | 'files' | 'workspaces' | 'bots';

/** Queue entry mirror of QueueUpdatedMessage payload (host/src/queue). */
export interface QueueEntry {
  id: string;
  text: string;
}
