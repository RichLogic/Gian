/**
 * Conversation-bound Schedule contract shared by the Host REST API and the
 * Gian Tool (Issue #51). Every Schedule is bound to one immutable control
 * Session: creation derives the binding from the caller's Session-scoped Gian
 * MCP credential, runs execute inside that conversation (idle → a new Turn;
 * busy → a hidden `session.fork.atTurn` Fork), and no Agent-native or
 * controller-owned schedule exists in v1.
 */

export const MAX_NON_ARCHIVED_SCHEDULES = 200;
export const MAX_CONCURRENT_SCHEDULE_RUNS = 2;
export const MAX_DUE_SCHEDULES_PER_PULSE = 50;
export const MAX_DUE_ENUMERATION = 1_000;
export const MIN_INTERVAL_MS = 300_000;
export const MAX_INTERVAL_MS = 31_536_000_000;
export const MAX_PROMPT_BYTES = 32_768;
export const MAX_NAME_CODEPOINTS = 120;
export const MAX_PAGE_SIZE = 200;
export const REST_IDEMPOTENCY_KEY_BYTES = 256;
export const MISFIRE_GRACE_MS = 60_000;
/** Number of future occurrences the Tool preview returns by default. */
export const SCHEDULE_PREVIEW_LIMIT = 10;
/** Minimum future occurrences a preview must return when any exist. */
export const SCHEDULE_PREVIEW_MIN_OCCURRENCES = 3;
/** Cron guard: any adjacent gap between the next 32 occurrences below 5 minutes rejects the definition. */
export const SCHEDULE_FREQUENT_GUARD_OCCURRENCES = 32;
/** Hard cap for the pure trigger enumeration helpers; misfire windows stay bounded above it. */
export const SCHEDULE_ENUMERATION_HARD_CAP = 1_000;
/** Pending create confirmations expire after this long without a user decision. */
export const SCHEDULE_CONFIRMATION_TTL_MS = 30 * 60_000;
/** Bounded summary kept in the durable run log (stable indexes only). */
export const SCHEDULE_RUN_SUMMARY_MAX_CHARS = 500;

export type ScheduleStatus = 'active' | 'paused' | 'completed' | 'archived';
export type ScheduleStatusReason =
  | 'manual'
  | 'unknown_run'
  | 'lifecycle_blocked'
  | 'invalid_definition';
export type ScheduleOverlapPolicy = 'skip';
export type ScheduleMisfirePolicy = 'skip' | 'run_once';

export type ScheduleTrigger =
  | { kind: 'once'; at: string }
  | { kind: 'cron'; expression: string }
  | { kind: 'interval'; every_ms: number; anchor_at: string };

export type ScheduleCreatorKind = 'internal_session';

export type ScheduleExecutionMode = 'bound_session' | 'fork';

export interface ScheduleForkAnchor {
  turn_id: string;
  source_turn_id: string;
}

export interface Schedule {
  id: string;
  name: string;
  status: ScheduleStatus;
  status_reason: ScheduleStatusReason | null;
  /** Immutable conversation binding, derived from the creator credential. */
  control_session_id: string;
  /** Live display join of the control conversation (read-time, may lag). */
  control_session_title: string | null;
  agent_id: string | null;
  agent_name: string | null;
  workspace_id: string | null;
  workspace_name: string | null;
  prompt: string;
  trigger: ScheduleTrigger;
  timezone: string;
  overlap_policy: ScheduleOverlapPolicy;
  misfire_policy: ScheduleMisfirePolicy;
  next_run_at: string | null;
  last_run_at: string | null;
  creator_kind: ScheduleCreatorKind;
  creator_actor_id: string | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  revision: number;
}

export type ScheduleRunStatus =
  | 'scheduled'
  | 'starting'
  | 'running'
  | 'waiting_interaction'
  | 'succeeded'
  | 'failed'
  | 'interrupted'
  | 'skipped_overlap'
  | 'missed'
  | 'unknown';

export type ScheduleRunTriggerKind = 'scheduled' | 'manual';

export interface ScheduleRun {
  id: string;
  schedule_id: string;
  trigger_kind: ScheduleRunTriggerKind;
  scheduled_for: string;
  status: ScheduleRunStatus;
  /** How this Run executed. Null until the dispatcher claims and decides. */
  execution_mode: ScheduleExecutionMode | null;
  /** Bound Session (bound_session) or hidden Fork Session (fork) identity. */
  target_session_id: string | null;
  /** Fork source Turn anchor; null for bound_session runs. */
  fork_anchor: ScheduleForkAnchor | null;
  turn_id: string | null;
  missed_count: number;
  missed_from: string | null;
  missed_until: string | null;
  /** Resolved Model/Thinking/Approval snapshot taken when the Turn started. */
  resolved_config: Record<string, unknown> | null;
  /** Stable index + bounded summary; full transcripts stay in the Session. */
  summary: string | null;
  /** Stable code from SCHEDULE_RUN_ERROR_CODES. */
  error_code: ScheduleRunErrorCode | null;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
  revision: number;
}

/** Error codes written into the durable run log. */
export const SCHEDULE_RUN_ERROR_CODES = [
  'SCHEDULE_OVERLAP_SKIPPED',
  'SCHEDULE_ARCHIVED',
  'SCHEDULE_NOT_FOUND',
  'SCHEDULE_DISPATCH_UNKNOWN',
  'SCHEDULE_CONTROL_SESSION_NOT_FOUND',
  'SCHEDULE_CONTROL_SESSION_ARCHIVED',
  'SCHEDULE_CONTROL_SESSION_BLOCKED',
  'SCHEDULE_FORK_UNSUPPORTED',
  'SCHEDULE_NO_STABLE_FORK_POINT',
  'SCHEDULE_FORK_FAILED',
  'SCHEDULE_SEND_FAILED',
  'AGENT_DELETED',
  'INTERNAL_ERROR',
] as const;

export type ScheduleRunErrorCode = (typeof SCHEDULE_RUN_ERROR_CODES)[number];

/** REST domain error codes. The Gian Tool reuses the overlapping subset from
 *  `GIAN_TOOL_ERROR_CODES`; REST keeps the full Schedule domain surface. */
export const SCHEDULE_ERROR_CODES = [
  'SCHEDULE_NOT_FOUND',
  'SCHEDULE_RUN_NOT_FOUND',
  'SCHEDULE_ARCHIVED',
  'SCHEDULE_COMPLETED',
  'SCHEDULE_REVISION_CONFLICT',
  'SCHEDULE_LIMIT_REACHED',
  'SCHEDULE_TRIGGER_INVALID',
  'SCHEDULE_TIMEZONE_INVALID',
  'SCHEDULE_INTERVAL_TOO_FREQUENT',
  'SCHEDULE_HAS_NO_FUTURE_OCCURRENCE',
  'SCHEDULE_OVERLAP_SKIPPED',
  'SCHEDULE_DISPATCH_UNKNOWN',
  'SCHEDULE_CONTROL_SESSION_NOT_FOUND',
  'SCHEDULE_CONTROL_SESSION_BLOCKED',
  'SCHEDULE_FORK_UNSUPPORTED',
  'SCHEDULE_NO_STABLE_FORK_POINT',
  'SCHEDULE_FORK_FAILED',
  'SCHEDULE_CONFIRMATION_NOT_FOUND',
  'SCHEDULE_CONFIRMATION_EXPIRED',
  'SCHEDULE_CREATE_REJECTED',
  'AGENT_DELETED',
  'IDEMPOTENCY_CONFLICT',
  'INVALID_ARGUMENT',
  'INTERNAL_ERROR',
] as const;

export type ScheduleErrorCode = (typeof SCHEDULE_ERROR_CODES)[number];

/** Uniform REST error envelope for the schedules API. */
export interface ScheduleRestError {
  error: {
    code: ScheduleErrorCode;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  };
}

export interface ScheduleListResponse {
  schedules: Schedule[];
  next_cursor: string | null;
}

export interface ScheduleRunListResponse {
  runs: ScheduleRun[];
  next_cursor: string | null;
}

export interface SchedulePreviewRequest {
  trigger: ScheduleTrigger;
  timezone: string;
  after?: string;
  limit?: number;
}

export interface SchedulePreviewResponse {
  trigger: ScheduleTrigger;
  timezone: string;
  occurrences: string[];
}

/** Host-enforced create confirmation shown to the user before a Tool-created
 *  Schedule commits (contract L). The pending object is durable and its
 *  decision is the only path to committing the Schedule. */
export type ScheduleConfirmationStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export interface ScheduleConfirmationPayload {
  name: string;
  /** Full durable prompt; the Schedule stores it verbatim on approval. */
  prompt: string;
  /** Compact rendering for the confirmation card. */
  prompt_summary: string;
  trigger: ScheduleTrigger;
  trigger_summary: string;
  timezone: string;
  misfire_policy: ScheduleMisfirePolicy;
  /** At least the next three future occurrences at creation time. */
  next_occurrences: string[];
  control_session: {
    id: string;
    title: string | null;
    agent_name: string | null;
    workspace_name: string | null;
  };
  /** Fixed risk note about conversation-bound permissions and quota use. */
  risk_note: string;
}

export interface ScheduleConfirmation {
  id: string;
  status: ScheduleConfirmationStatus;
  payload: ScheduleConfirmationPayload;
  control_session_id: string;
  schedule_id: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

const SCHEDULE_STATUSES = ['active', 'paused', 'completed', 'archived'] as const;
const SCHEDULE_STATUS_REASONS = [
  'manual',
  'unknown_run',
  'lifecycle_blocked',
  'invalid_definition',
] as const;
const TRIGGER_KINDS = ['once', 'cron', 'interval'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRfc3339Instant(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value);
}

export function isScheduleStatus(value: unknown): value is ScheduleStatus {
  return typeof value === 'string' && (SCHEDULE_STATUSES as readonly string[]).includes(value);
}

export function isScheduleStatusReason(value: unknown): value is ScheduleStatusReason {
  return typeof value === 'string' && (SCHEDULE_STATUS_REASONS as readonly string[]).includes(value);
}

export function isScheduleTrigger(value: unknown): value is ScheduleTrigger {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case 'once':
      return Object.keys(value).length === 2 && isRfc3339Instant(value.at);
    case 'cron':
      return Object.keys(value).length === 2 && typeof value.expression === 'string';
    case 'interval':
      return Object.keys(value).length === 3
        && Number.isInteger(value.every_ms)
        && (value.every_ms as number) >= MIN_INTERVAL_MS
        && (value.every_ms as number) <= MAX_INTERVAL_MS
        && isRfc3339Instant(value.anchor_at);
    default:
      return false;
  }
}

export function isScheduleTriggerKind(value: unknown): value is ScheduleTrigger['kind'] {
  return typeof value === 'string' && (TRIGGER_KINDS as readonly string[]).includes(value);
}

/** Exact canonical key sets. Internal columns (dispatch_phase, lease token,
 *  request hash, raw Provider data) must never cross REST/WS/Tool, so the
 *  guards reject any payload carrying unknown keys. */
const SCHEDULE_KEYS = new Set([
  'id', 'name', 'status', 'status_reason', 'control_session_id',
  'control_session_title', 'agent_id', 'agent_name', 'workspace_id',
  'workspace_name', 'prompt', 'trigger', 'timezone', 'overlap_policy',
  'misfire_policy', 'next_run_at', 'last_run_at', 'creator_kind',
  'creator_actor_id', 'created_at', 'updated_at', 'archived_at', 'revision',
]);

const SCHEDULE_RUN_KEYS = new Set([
  'id', 'schedule_id', 'trigger_kind', 'scheduled_for', 'status',
  'execution_mode', 'target_session_id', 'fork_anchor', 'turn_id',
  'missed_count', 'missed_from', 'missed_until', 'resolved_config', 'summary',
  'error_code', 'error_message', 'created_at', 'started_at', 'finished_at',
  'updated_at', 'revision',
]);

const CONFIRMATION_KEYS = new Set([
  'id', 'status', 'payload', 'control_session_id', 'schedule_id',
  'expires_at', 'created_at', 'updated_at', 'resolved_at',
]);

function hasExactKeys(value: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(value).every(key => allowed.has(key));
}

/** Runtime guard for payloads crossing REST/WS. Internal dispatch/lease/hash
 *  fields must never appear here. */
export function isSchedule(value: unknown): value is Schedule {
  if (!isRecord(value) || !hasExactKeys(value, SCHEDULE_KEYS)) return false;
  return typeof value.id === 'string'
    && typeof value.name === 'string'
    && isScheduleStatus(value.status)
    && (value.status_reason === null || isScheduleStatusReason(value.status_reason))
    && typeof value.control_session_id === 'string'
    && (value.control_session_title === null || typeof value.control_session_title === 'string')
    && (value.agent_id === null || typeof value.agent_id === 'string')
    && (value.agent_name === null || typeof value.agent_name === 'string')
    && (value.workspace_id === null || typeof value.workspace_id === 'string')
    && (value.workspace_name === null || typeof value.workspace_name === 'string')
    && typeof value.prompt === 'string'
    && isScheduleTrigger(value.trigger)
    && typeof value.timezone === 'string'
    && value.overlap_policy === 'skip'
    && (value.misfire_policy === 'skip' || value.misfire_policy === 'run_once')
    && (value.next_run_at === null || typeof value.next_run_at === 'string')
    && (value.last_run_at === null || typeof value.last_run_at === 'string')
    && value.creator_kind === 'internal_session'
    && (value.creator_actor_id === null || typeof value.creator_actor_id === 'string')
    && typeof value.created_at === 'string'
    && typeof value.updated_at === 'string'
    && (value.archived_at === null || typeof value.archived_at === 'string')
    && Number.isSafeInteger(value.revision);
}

export function isScheduleRun(value: unknown): value is ScheduleRun {
  if (!isRecord(value) || !hasExactKeys(value, SCHEDULE_RUN_KEYS)) return false;
  return typeof value.id === 'string'
    && typeof value.schedule_id === 'string'
    && (value.trigger_kind === 'scheduled' || value.trigger_kind === 'manual')
    && typeof value.scheduled_for === 'string'
    && (typeof value.status === 'string'
      && ['scheduled', 'starting', 'running', 'waiting_interaction', 'succeeded', 'failed',
        'interrupted', 'skipped_overlap', 'missed', 'unknown'].includes(value.status))
    && (value.execution_mode === null
      || value.execution_mode === 'bound_session'
      || value.execution_mode === 'fork')
    && (value.target_session_id === null || typeof value.target_session_id === 'string')
    && (value.fork_anchor === null || isScheduleForkAnchor(value.fork_anchor))
    && (value.turn_id === null || typeof value.turn_id === 'string')
    && Number.isInteger(value.missed_count)
    && (value.missed_count as number) >= 0
    && (value.missed_from === null || typeof value.missed_from === 'string')
    && (value.missed_until === null || typeof value.missed_until === 'string')
    && (value.resolved_config === null || isRecord(value.resolved_config))
    && (value.summary === null || typeof value.summary === 'string')
    && (value.error_code === null || typeof value.error_code === 'string')
    && (value.error_message === null || typeof value.error_message === 'string')
    && typeof value.created_at === 'string'
    && (value.started_at === null || typeof value.started_at === 'string')
    && (value.finished_at === null || typeof value.finished_at === 'string')
    && typeof value.updated_at === 'string'
    && Number.isSafeInteger(value.revision);
}

export function isScheduleForkAnchor(value: unknown): value is ScheduleForkAnchor {
  return isRecord(value)
    && typeof value.turn_id === 'string'
    && typeof value.source_turn_id === 'string';
}

export function isScheduleConfirmation(value: unknown): value is ScheduleConfirmation {
  if (!isRecord(value) || !hasExactKeys(value, CONFIRMATION_KEYS)) return false;
  return typeof value.id === 'string'
    && (value.status === 'pending'
      || value.status === 'approved'
      || value.status === 'rejected'
      || value.status === 'expired')
    && typeof value.control_session_id === 'string'
    && (value.schedule_id === null || typeof value.schedule_id === 'string')
    && typeof value.expires_at === 'string'
    && typeof value.created_at === 'string'
    && typeof value.updated_at === 'string'
    && (value.resolved_at === null || typeof value.resolved_at === 'string');
}
