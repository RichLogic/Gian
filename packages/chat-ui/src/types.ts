/**
 * Presentation DTOs for `@gian/chat-ui` — the render-side projection of a
 * session transcript. These types intentionally carry ONLY presentation
 * state: text, timestamps, status, and structured display payloads. They
 * must never reference a store, router, Host API, file index, absolute-path
 * opener, or Provider runtime — the owning app projects its canonical state
 * into these DTOs and wires behavior through explicit callbacks/contexts.
 *
 * Field docs that constrain producers live in the original web module; the
 * comments here keep the presentation contract.
 */

export interface MsgItem {
  translation?: import('@gian/shared').TranslationRecord;
  kind: 'user' | 'assistant';
  id: string;
  text: string;
  exec: import('@gian/shared').Executor;
  ts: number;
  turn: number;
  /** Local echo awaiting the canonical user_message (dimmed bubble). */
  pending?: boolean;
  /** Server rejected the send — the bubble is marked failed in place. */
  failed?: boolean;
  /** Attachments to render in the bubble. Images use inline thumbnails;
   *  other files use download chips. */
  attachments?: import('@gian/shared').MessageAttachment[];
  contextItems?: import('@gian/shared').MessageContextItem[];
  composerDocument?: import('@gian/shared').ComposerDocument;
  /** Canonical provenance for a conversation-bound Schedule run. */
  scheduledTask?: {
    schedule_id: string;
    run_id: string;
    schedule_name: string;
  };
}

export interface ToolItem {
  kind: 'tool';
  id: string;
  name: string;
  summary: string;
  status: 'pending' | 'running' | 'success' | 'error';
  output?: string;
  ts: number;
  turn: number;
}

/** Model reasoning content — separate from assistant text. */
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
 * Auto-mode notices. Two variants share one shape:
 *   classifier-denied — informational: the classifier blocked one action.
 *   circuit-breaker   — terminal-ish: the denial threshold tripped.
 *   notice            — generic provider notice.
 */
export interface AutoNoticeItem {
  kind: 'auto-notice';
  id: string;
  variant: 'classifier-denied' | 'circuit-breaker' | 'notice';
  severity?: 'info' | 'warning' | 'error';
  code?: string;
  title?: string;
  message?: string;
  action?: string;
  reason?: string;
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
  /** Terminal presentation state for a turn boundary. Historical rows may
   *  omit it; the transcript then derives failure/stopped from inline errors. */
  outcome?: 'worked' | 'failed' | 'stopped';
  /** Protocol turn identity, only ever present on a 'turn-end' item. Read
   *  VERBATIM by per-turn actions — never derived from rendered text. */
  turn_id?: string;
  source_turn_id?: string;
}

/** Context compaction marker (render-side; no producer emits it yet). */
export interface CompactionItem {
  kind: 'compaction';
  id: string;
  beforeTokens?: number;
  afterTokens?: number;
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
   *  in place of the generic Allow once / Allow session / Decline. */
  planActions?: ('accept_with_auto' | 'accept_with_ask' | 'keep_planning')[];
  /** Exact executor-owned buttons for ACP-native permission requests. */
  nativeOptions?: import('@gian/shared').NativeApprovalOption[];
  nativeOptionId?: string;
  /** gian.proxy/2.0 actions — when present, render these labels/styles as-is. */
  actions?: import('@gian/shared').InteractionAction[];
  /** gian.proxy/2.0 inputs — when present, collect values with the submit action. */
  inputs?: import('@gian/shared').InteractionInput[];
  /** True when `cmd` came from the interaction's `context.subject` (a tool
   *  name / command / path) rather than the prose title — drives mono-block
   *  vs prose-text rendering on the unified interaction card. */
  hasSubject?: boolean;
  /** gian.proxy/2.0 §12 presentation hint — drives the card's kind label. */
  interactionKind?: 'question' | 'choice' | 'confirmation' | 'permission';
  /** gian.proxy/2.0 §12 presentation tone — drives the card's tint. */
  tone?: 'neutral' | 'info' | 'warning' | 'danger';
  /** Validated HTTPS URL for a two-step external authorization interaction. */
  externalUrl?: string;
  /** Timestamp of the lifecycle event that resolved this approval. */
  resolvedAt?: number;
  ts: number;
  turn: number;
}

export interface ApprovalActionContext {
  category?: import('@gian/shared').ApprovalCategory;
  nativeOptionId?: string;
}

/** The decision channel every interaction card reports through. The host app
 *  owns the mutation; the card only returns the Host-given opaque action id
 *  and the collected values. */
export type OnApprove = (
  approvalId: string,
  decision: import('@gian/shared').ApprovalDecision,
  answers?: Record<string, string | boolean | string[]>,
  context?: ApprovalActionContext,
) => void;

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
  | AutoNoticeItem
  | CompactionItem;
