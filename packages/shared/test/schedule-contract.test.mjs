// Conversation-bound schedule contract guards (Issue #51, ADR-0053).

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MIN_INTERVAL_MS,
  SCHEDULE_ERROR_CODES,
  isSchedule,
  isScheduleConfirmation,
  isScheduleForkAnchor,
  isScheduleRun,
  isScheduleTrigger,
} from '../dist/schedule.js';

const TRIGGER = { kind: 'cron', expression: '30 9 * * *' };

const VALID_SCHEDULE = {
  id: 'schedule-1',
  name: 'Nightly',
  status: 'active',
  status_reason: null,
  control_session_id: 'session-1',
  control_session_title: 'Bound conversation',
  agent_id: 'agent-1',
  agent_name: 'Agent',
  workspace_id: 'workspace-1',
  workspace_name: 'Workspace',
  prompt: 'Run checks',
  trigger: TRIGGER,
  timezone: 'UTC',
  overlap_policy: 'skip',
  misfire_policy: 'skip',
  next_run_at: '2026-09-02T09:30:00.000Z',
  last_run_at: null,
  creator_kind: 'internal_session',
  creator_actor_id: 'internal-session:session-1',
  created_at: '2026-09-01T12:00:00.000Z',
  updated_at: '2026-09-01T12:00:00.000Z',
  archived_at: null,
  revision: 1,
};

const VALID_RUN = {
  id: 'run-1',
  schedule_id: 'schedule-1',
  trigger_kind: 'scheduled',
  scheduled_for: '2026-09-02T09:30:00.000Z',
  status: 'running',
  execution_mode: 'bound_session',
  target_session_id: 'session-1',
  fork_anchor: null,
  turn_id: 'turn-1',
  missed_count: 0,
  missed_from: null,
  missed_until: null,
  resolved_config: { model: 'sonnet' },
  summary: null,
  error_code: null,
  error_message: null,
  created_at: '2026-09-01T12:00:00.000Z',
  started_at: '2026-09-01T12:00:00.000Z',
  finished_at: null,
  updated_at: '2026-09-01T12:00:00.000Z',
  revision: 1,
};

test('schedules are conversation-bound with a closed field surface', () => {
  assert.equal(isSchedule(VALID_SCHEDULE), true);
  // Internal columns from the reverted design never reappear.
  for (const forbidden of ['workspace_id_owner', 'execution', 'agent_id_required', 'session_id', 'retry_of_run_id', 'config_strategy']) {
    assert.equal(isSchedule({ ...VALID_SCHEDULE, [forbidden]: 'x' }), false, forbidden);
  }
  assert.equal(isSchedule({ ...VALID_SCHEDULE, creator_kind: 'external_controller' }), false);
  assert.equal(isSchedule({ ...VALID_SCHEDULE, overlap_policy: 'queue' }), false);
});

test('runs carry execution mode, fork anchor, and bounded summary only', () => {
  assert.equal(isScheduleRun(VALID_RUN), true);
  assert.equal(isScheduleRun({
    ...VALID_RUN,
    execution_mode: 'fork',
    target_session_id: 'fork-1',
    fork_anchor: { turn_id: 't1', source_turn_id: 's1' },
  }), true);
  assert.equal(isScheduleRun({ ...VALID_RUN, execution_mode: 'new_session' }), false);
  assert.equal(isScheduleRun({ ...VALID_RUN, trigger_kind: 'retry' }), false);
  assert.equal(isScheduleForkAnchor({ turn_id: 't', source_turn_id: 's' }), true);
  assert.equal(isScheduleForkAnchor({ turn_id: 't' }), false);
  // Internal dispatch/lease columns must never cross the boundary.
  assert.equal(isScheduleRun({ ...VALID_RUN, dispatch_phase: 'claimed' }), false);
  assert.equal(isScheduleRun({ ...VALID_RUN, lease_token: 'secret' }), false);
});

test('confirmations expose the decision payload without internals', () => {
  const confirmation = {
    id: 'conf-1',
    status: 'pending',
    payload: {
      name: 'Nightly',
      prompt: 'full prompt',
      prompt_summary: 'full prompt',
      trigger: TRIGGER,
      trigger_summary: 'Cron `30 9 * * *`',
      timezone: 'UTC',
      next_occurrences: ['2026-09-02T09:30:00.000Z', '2026-09-03T09:30:00.000Z', '2026-09-04T09:30:00.000Z'],
      control_session: { id: 'session-1', title: 'T', agent_name: 'A', workspace_name: 'W' },
      risk_note: 'Runs use the bound conversation quota.',
    },
    control_session_id: 'session-1',
    schedule_id: null,
    expires_at: '2026-09-01T12:30:00.000Z',
    created_at: '2026-09-01T12:00:00.000Z',
    updated_at: '2026-09-01T12:00:00.000Z',
    resolved_at: null,
  };
  assert.equal(isScheduleConfirmation(confirmation), true);
  assert.equal(isScheduleConfirmation({ ...confirmation, status: 'nope' }), false);
});

test('trigger guards keep the five-minute pace bound', () => {
  assert.equal(isScheduleTrigger(TRIGGER), true);
  assert.equal(isScheduleTrigger({ kind: 'interval', every_ms: MIN_INTERVAL_MS, anchor_at: '2026-09-01T12:00:00.000Z' }), true);
  assert.equal(isScheduleTrigger({ kind: 'interval', every_ms: MIN_INTERVAL_MS - 1, anchor_at: '2026-09-01T12:00:00.000Z' }), false);
  assert.equal(isScheduleTrigger({ kind: 'once', at: 'nope' }), false);
});

test('the REST error surface includes the frozen fork and confirmation codes', () => {
  for (const code of [
    'SCHEDULE_FORK_UNSUPPORTED',
    'SCHEDULE_NO_STABLE_FORK_POINT',
    'SCHEDULE_FORK_FAILED',
    'SCHEDULE_CONFIRMATION_NOT_FOUND',
    'SCHEDULE_CONFIRMATION_EXPIRED',
    'SCHEDULE_CREATE_REJECTED',
    'SCHEDULE_CONTROL_SESSION_BLOCKED',
  ]) {
    assert.ok(SCHEDULE_ERROR_CODES.includes(code), code);
  }
});
