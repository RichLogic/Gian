import type {
  Schedule,
  ScheduleConfirmation,
  ScheduleConfirmationPayload,
  ScheduleConfirmationStatus,
  ScheduleCreatorKind,
  ScheduleExecutionMode,
  ScheduleForkAnchor,
  ScheduleMisfirePolicy,
  ScheduleOverlapPolicy,
  ScheduleRun,
  ScheduleRunErrorCode,
  ScheduleRunStatus,
  ScheduleStatus,
  ScheduleStatusReason,
  ScheduleTrigger,
} from '@gian/shared';

/**
 * Host-internal row shapes. These mirror the SQLite columns of migration 069
 * and deliberately include dispatch/lease/hash fields that the shared
 * projections (`toSchedule`/`toRun`) must strip before crossing REST/Tool.
 */

export type ScheduleDispatchPhase = 'none' | 'claimed' | 'resolved' | 'dispatched';

export interface ScheduleRow {
  id: string;
  name: string;
  prompt: string;
  status: ScheduleStatus;
  status_reason: ScheduleStatusReason | null;
  trigger_kind: ScheduleTrigger['kind'];
  trigger_json: string;
  timezone: string;
  overlap_policy: ScheduleOverlapPolicy;
  misfire_policy: ScheduleMisfirePolicy;
  next_run_at: string | null;
  last_run_at: string | null;
  control_session_id: string;
  creator_kind: ScheduleCreatorKind;
  creator_actor_id: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  revision: number;
}

export interface ScheduleRunRow {
  id: string;
  schedule_id: string;
  trigger_kind: ScheduleRun['trigger_kind'];
  scheduled_for: string;
  status: ScheduleRunStatus;
  execution_mode: ScheduleExecutionMode | null;
  target_session_id: string | null;
  fork_anchor_json: string | null;
  turn_id: string | null;
  missed_count: number;
  missed_from: string | null;
  missed_until: string | null;
  resolved_config_json: string | null;
  summary: string | null;
  error_code: string | null;
  error_message: string | null;
  dispatch_phase: ScheduleDispatchPhase;
  lease_token: string | null;
  lease_expires_at: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
  revision: number;
}

export interface ScheduleCommandReceiptRow {
  actor_key: string;
  idempotency_key: string;
  method: string;
  input_hash: string;
  status: 'in_progress' | 'succeeded' | 'failed';
  domain_id: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  response_json: string | null;
  error_json: string | null;
  created_at: string;
  updated_at: string;
}

export interface ScheduleConfirmationRow {
  id: string;
  control_session_id: string;
  status: ScheduleConfirmationStatus;
  payload_json: string;
  schedule_id: string | null;
  created_by_actor_id: string;
  tool_request_id: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
}

export const TERMINAL_RUN_STATUSES: ReadonlySet<ScheduleRunStatus> = new Set([
  'succeeded',
  'failed',
  'interrupted',
  'skipped_overlap',
  'missed',
  'unknown',
]);

/** Run statuses that represent queued or in-flight execution. `unknown`
 *  counts as blocking too: until a human resolves it, the Schedule must not
 *  start another Run against possibly-live state. */
export const BLOCKING_RUN_STATUSES: ReadonlySet<ScheduleRunStatus> = new Set([
  'scheduled',
  'starting',
  'running',
  'waiting_interaction',
  'unknown',
]);

/** Statuses counted against the global dispatch capacity. */
export const CAPACITY_RUN_STATUSES: ReadonlySet<ScheduleRunStatus> = new Set([
  'starting',
  'running',
  'waiting_interaction',
]);

/** Read-time display join of the control conversation (contract N). */
export interface ControlSessionDisplay {
  title: string | null;
  agent_id: string | null;
  agent_name: string | null;
  workspace_id: string | null;
  workspace_name: string | null;
}

/** Internal diagnostic for a bounded misfire window (never user-facing). */
export interface DueOutcome {
  scheduleId: string;
  runId: string | null;
  skippedOverlap: boolean;
  nextRunAt: string | null;
  truncated: boolean;
}

export function toSchedule(row: ScheduleRow, display: ControlSessionDisplay): Schedule {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    status_reason: row.status_reason,
    control_session_id: row.control_session_id,
    control_session_title: display.title,
    agent_id: display.agent_id,
    agent_name: display.agent_name,
    workspace_id: display.workspace_id,
    workspace_name: display.workspace_name,
    prompt: row.prompt,
    trigger: JSON.parse(row.trigger_json) as ScheduleTrigger,
    timezone: row.timezone,
    overlap_policy: row.overlap_policy,
    misfire_policy: row.misfire_policy,
    next_run_at: row.next_run_at,
    last_run_at: row.last_run_at,
    creator_kind: row.creator_kind,
    creator_actor_id: row.creator_actor_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    archived_at: row.archived_at,
    revision: row.revision,
  };
}

function parseForkAnchor(json: string | null): ScheduleForkAnchor | null {
  if (!json) return null;
  try {
    const value = JSON.parse(json) as unknown;
    if (value && typeof value === 'object'
      && typeof (value as Record<string, unknown>).turn_id === 'string'
      && typeof (value as Record<string, unknown>).source_turn_id === 'string') {
      return value as ScheduleForkAnchor;
    }
  } catch {
    // Fall through: a corrupt anchor degrades to null instead of failing reads.
  }
  return null;
}

export function toRun(row: ScheduleRunRow): ScheduleRun {
  return {
    id: row.id,
    schedule_id: row.schedule_id,
    trigger_kind: row.trigger_kind,
    scheduled_for: row.scheduled_for,
    status: row.status,
    execution_mode: row.execution_mode,
    target_session_id: row.target_session_id,
    fork_anchor: parseForkAnchor(row.fork_anchor_json),
    turn_id: row.turn_id,
    missed_count: row.missed_count,
    missed_from: row.missed_from,
    missed_until: row.missed_until,
    resolved_config: row.resolved_config_json
      ? JSON.parse(row.resolved_config_json) as Record<string, unknown>
      : null,
    summary: row.summary,
    // Closed-domain cast: the DB column is writer-controlled and validated
    // against SCHEDULE_RUN_ERROR_CODES by every settle/update path.
    error_code: row.error_code as ScheduleRunErrorCode | null,
    error_message: row.error_message,
    created_at: row.created_at,
    started_at: row.started_at,
    finished_at: row.finished_at,
    updated_at: row.updated_at,
    revision: row.revision,
  };
}

export function toConfirmation(row: ScheduleConfirmationRow): ScheduleConfirmation {
  return {
    id: row.id,
    status: row.status,
    payload: JSON.parse(row.payload_json) as ScheduleConfirmationPayload,
    control_session_id: row.control_session_id,
    schedule_id: row.schedule_id,
    expires_at: row.expires_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    resolved_at: row.resolved_at,
  };
}
