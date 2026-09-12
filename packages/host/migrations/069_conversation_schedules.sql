-- Conversation-bound scheduled automations (Issue #51, ADR-0053).
--
-- Numbering note: migration 068 (`068_scheduled_automations.sql`) belonged to
-- the reverted 2026-06 schedule implementation and was withdrawn from main.
-- Developer databases may still carry that filename in the ledger AND the
-- three same-named tables it created, so 068 is retired and must never be
-- reused. This migration is self-contained and does not depend on any 068
-- state.
--
-- Upgrade rule: databases that actually executed 068 hold `schedules`,
-- `schedule_runs`, and `schedule_command_receipts` with the withdrawn,
-- non-conversation-bound schema (workspace/agent-owned, pinned config
-- strategy, no control_session_id). That data can never satisfy the frozen
-- Issue #51 contract and the implementation was never a released product,
-- so those tables are dropped here before the new schema is created. The
-- ScheduleRepository owns every table created below.

DROP TABLE IF EXISTS schedule_command_receipts;
DROP TABLE IF EXISTS schedule_runs;
DROP TABLE IF EXISTS schedules;

CREATE TABLE schedules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'completed', 'archived')),
  status_reason TEXT
    CHECK (status_reason IS NULL OR status_reason IN
      ('manual', 'unknown_run', 'lifecycle_blocked', 'invalid_definition')),
  trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('once', 'interval', 'cron')),
  trigger_json TEXT NOT NULL,
  timezone TEXT NOT NULL,
  misfire_policy TEXT NOT NULL DEFAULT 'skip' CHECK (misfire_policy IN ('skip', 'run_once')),
  overlap_policy TEXT NOT NULL DEFAULT 'skip' CHECK (overlap_policy = 'skip'),
  next_run_at TEXT,
  last_run_at TEXT,
  -- Immutable conversation binding. Deliberately no FK: deleting the control
  -- Session must stay possible; lifecycle checks pause the Schedule instead.
  control_session_id TEXT NOT NULL,
  creator_kind TEXT NOT NULL CHECK (creator_kind = 'internal_session'),
  creator_actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX schedules_due_idx
  ON schedules(status, next_run_at)
  WHERE status = 'active' AND next_run_at IS NOT NULL;
CREATE INDEX schedules_control_session_idx ON schedules(control_session_id, updated_at);

CREATE TABLE schedule_runs (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE RESTRICT,
  trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('scheduled', 'manual')),
  scheduled_for TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'scheduled', 'starting', 'running', 'waiting_interaction',
    'succeeded', 'failed', 'interrupted', 'skipped_overlap', 'missed', 'unknown')),
  execution_mode TEXT CHECK (execution_mode IS NULL OR execution_mode IN ('bound_session', 'fork')),
  -- Bound Session (bound_session) or hidden Fork Session (fork) identity.
  target_session_id TEXT,
  fork_anchor_json TEXT,
  turn_id TEXT,
  missed_count INTEGER NOT NULL DEFAULT 0 CHECK (missed_count >= 0),
  missed_from TEXT,
  missed_until TEXT,
  resolved_config_json TEXT,
  summary TEXT,
  error_code TEXT,
  error_message TEXT,
  lease_token TEXT,
  lease_expires_at TEXT,
  dispatch_phase TEXT NOT NULL DEFAULT 'none'
    CHECK (dispatch_phase IN ('none', 'claimed', 'resolved', 'dispatched')),
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX schedule_runs_schedule_idx ON schedule_runs(schedule_id, created_at DESC, id DESC);
-- Final duplicate boundary: one scheduled occurrence materializes at most once.
CREATE UNIQUE INDEX schedule_runs_occurrence_unique
  ON schedule_runs(schedule_id, scheduled_for)
  WHERE trigger_kind = 'scheduled';
CREATE INDEX schedule_runs_status_idx ON schedule_runs(status, created_at);

CREATE TABLE schedule_command_receipts (
  actor_key TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  method TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('in_progress', 'succeeded', 'failed')),
  domain_id TEXT,
  lease_token TEXT,
  lease_expires_at TEXT,
  response_json TEXT,
  error_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (actor_key, idempotency_key)
);

CREATE INDEX schedule_command_receipts_prune_idx
  ON schedule_command_receipts(status, updated_at);

CREATE TABLE schedule_confirmations (
  id TEXT PRIMARY KEY,
  control_session_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  payload_json TEXT NOT NULL,
  -- Pre-allocated Schedule id (from the Tool idempotency ledger) so an
  -- approved confirmation commits exactly one Schedule across retries.
  schedule_id TEXT,
  created_by_actor_id TEXT NOT NULL,
  tool_request_id TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE INDEX schedule_confirmations_session_idx
  ON schedule_confirmations(control_session_id, created_at DESC);
CREATE INDEX schedule_confirmations_tool_request_idx ON schedule_confirmations(tool_request_id);

-- Hidden Fork Sessions: durable `session.fork.atTurn` children that execute
-- schedule prompts outside the main conversation. They are real Session rows
-- (full transcript/approval/recovery semantics) but are excluded from the
-- Session rail, Session management lists, and Task/Subtask listings.
ALTER TABLE sessions ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0
  CHECK (hidden IN (0, 1));
CREATE INDEX sessions_hidden_idx ON sessions(hidden, updated_at);
