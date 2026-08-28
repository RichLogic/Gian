/**
 * Everything needed to (re)dispatch a message send through the operation
 * layer — stored on the optimistic echo (`MsgItem.sendRetry`) so a failed
 * send's retry affordance re-dispatches the SAME operation (proposal §9).
 */
export interface MessageSendPayload {
  sessionId: string;
  text: string;
  exec: import('@gian/shared').Executor;
  oneShotBypass?: boolean;
  /** Uploaded attachments for this turn; `previewUrl` (blob) is reused by the
   *  retry echo's thumbnails — it is only revoked on canonical reconcile. */
  attachments?: Array<import('./attachments.js').ComposerAttachmentPayload & { previewUrl: string }>;
  contextItems?: import('@gian/shared').MessageContextItem[];
  composerDocument?: import('@gian/shared').ComposerDocument;
  /** Atomic Side Chat next-turn draft; omitted for ordinary Sessions. */
  turnConfig?: Record<string, import('@gian/shared').ConfigValue>;
  /** Skill invocation: `text` is `/<name>` and the wire items carry the
   *  typed skill item instead of a text item. */
  skill?: { name: string; path: string };
}

export interface MsgItem {
  kind: 'user' | 'assistant';
  id: string;
  text: string;
  exec: import('@gian/shared').Executor;
  ts: number;
  turn: number;
  /** Local-only user echo awaiting the correlated operation result. The Host
   *  can publish the canonical `user_message` before that result, so this may
   *  remain true briefly after the canonical bubble has replaced the echo. */
  pending?: boolean;
  /** Server rejected the send (e.g. `MESSAGE_SEND_FAILED`). */
  failed?: boolean;
  /** Operation run id of the send that produced this echo — the bubble
   *  derives the unknown-outcome ("may not have been sent") state from the
   *  run's `timed-out` phase in the operation store. */
  sendRunId?: string;
  /** The canonical `user_message` has replaced this echo, but its correlated
   *  operation result is still outstanding. Excludes the item from the FIFO
   *  matcher when another compatible canonical message arrives. */
  sendCanonical?: boolean;
  /** Re-dispatch payload for the failed echo's retry affordance. */
  sendRetry?: MessageSendPayload;
  /** Attachments to render in the bubble. Images use inline thumbnails;
   *  other files use download chips. Pending echoes carry a blob URL until
   *  the server confirms with its permanent attachment URL. */
  attachments?: import('@gian/shared').MessageAttachment[];
  contextItems?: import('@gian/shared').MessageContextItem[];
  composerDocument?: import('@gian/shared').ComposerDocument;
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
  variant: 'classifier-denied' | 'circuit-breaker' | 'notice';
  severity?: 'info' | 'warning' | 'error';
  code?: string;
  title?: string;
  message?: string;
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
  /** Terminal presentation state for a turn boundary. Historical rows may
   *  omit it; the transcript then derives failure/stopped from inline errors. */
  outcome?: 'worked' | 'failed' | 'stopped';
  /** Protocol turn identity (gian.proxy/2.0 §10.6), only ever present on a
   *  'turn-end' item when the Host flows the exact Gian `turn_id` and the
   *  Proxy-stable `source_turn_id` of that Terminal Turn. The per-turn Fork
   *  control reads them VERBATIM — the web never derives them from rendered
   *  text and never falls back to an adjacent turn or to `head`. Hosts that
   *  predate the fork amendment omit both, and the control stays greyed. */
  turn_id?: string;
  source_turn_id?: string;
}

/**
 * Context compaction marker (P2, render-side only for now). No display event
 * carries compaction into the transcript yet — host parses
 * `token_usage.updated` for the composer stats side channel and drops its
 * `reason: 'compact_started'` (packages/host/src/session/token-usage.ts), so
 * nothing produces this item today. The type + row exist so the display
 * layer has a mapping target once host emits a compaction display event
 * (needs before/after token counts).
 */
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
   *  in place of the generic Allow once / Allow session / Decline. Maps to
   *  ApprovalDecision variants 1:1. */
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
  | AutoNoticeItem
  | CompactionItem;

/** Queue entry mirror of QueueUpdatedMessage payload (host/src/queue). */
export interface QueueEntry {
  id: string;
  text: string;
  /** Structured input items carried with the message — localImage/localFile
   *  attachments render as thumbnails in the queue drawer. */
  items?: import('@gian/shared').InputItem[];
  context_items?: import('@gian/shared').MessageContextItem[];
  composer_document?: import('@gian/shared').ComposerDocument;
}
