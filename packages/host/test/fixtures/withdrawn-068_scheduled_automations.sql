-- 068_scheduled_automations.sql — Gian Schedule backend Phase 1 (Issue #51).
--
-- Three ledgers, all owned by packages/host/src/schedule/repository.ts:
--   schedules                 definition source of truth (no provider mirror)
--   schedule_runs             execution ledger, reconciled from canonical
--                             sessions/turns/proxy_interactions
--   schedule_command_receipts REST Idempotency-Key receipts (30s command
--                             lease, bounded prune like the Tool ledger)
--
-- Agent identity lives in agents.json, so agent_id carries no SQL FK; the
-- agent_name snapshot keeps history readable after an Agent is deleted.
-- Runs survive Schedule archive; session/turn evidence is SET NULL because
-- both rows may legitimately disappear (user delete / cold transcript sweep)
-- without erasing the run's terminal outcome.

CREATE TABLE schedules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','paused','completed','archived')),
  status_reason TEXT CHECK (
    status_reason IS NULL OR status_reason IN ('manual','unknown_run','invalid_definition')
  ),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  agent_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('once','cron','interval')),
  trigger_json TEXT NOT NULL,
  timezone TEXT NOT NULL,
  config_strategy TEXT NOT NULL CHECK (config_strategy IN ('agent_defaults','pinned')),
  executor_config_json TEXT NOT NULL,
  overlap_policy TEXT NOT NULL CHECK (overlap_policy = 'skip'),
  misfire_policy TEXT NOT NULL CHECK (misfire_policy IN ('skip','run_once')),
  next_run_at TEXT,
  last_run_at TEXT,
  creator_kind TEXT NOT NULL CHECK (
    creator_kind IN ('user','internal_session','external_controller')
  ),
  creator_actor_id TEXT,
  creator_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX schedules_due_idx
  ON schedules(status, next_run_at)
  WHERE status = 'active' AND next_run_at IS NOT NULL;
CREATE INDEX schedules_agent_idx ON schedules(agent_id, status);
CREATE INDEX schedules_workspace_idx ON schedules(workspace_id, status);

CREATE TABLE schedule_runs (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE RESTRICT,
  trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('scheduled','manual','retry')),
  scheduled_for TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'scheduled','starting','running','waiting_interaction','succeeded','failed',
    'interrupted','skipped_overlap','missed','unknown'
  )),
  dispatch_phase TEXT NOT NULL CHECK (dispatch_phase IN (
    'none','reserved','session_created','turn_requested','accepted'
  )),
  lease_token TEXT,
  lease_expires_at TEXT,
  -- No SQL FK on purpose: §9.2 step 1 persists the pre-allocated session
  -- UUID at `reserved`, before SessionManager creates the canonical row
  -- (Proxy create crosses first). With foreign_keys=ON an FK here would
  -- reject that write; the §9.3 recovery matrix handles a missing Session
  -- row as `unknown`, which preserves the integrity guarantee in behavior.
  -- UNIQUE still guarantees one Session per Run.
  session_id TEXT UNIQUE,
  turn_id TEXT UNIQUE REFERENCES turns(id) ON DELETE SET NULL,
  retry_of_run_id TEXT REFERENCES schedule_runs(id) ON DELETE SET NULL,
  missed_count INTEGER NOT NULL DEFAULT 0 CHECK (missed_count >= 0),
  missed_from TEXT,
  missed_until TEXT,
  resolved_config_json TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1
);

CREATE UNIQUE INDEX schedule_runs_occurrence_unique
  ON schedule_runs(schedule_id, scheduled_for)
  WHERE trigger_kind = 'scheduled';
CREATE INDEX schedule_runs_dispatch_idx ON schedule_runs(status, created_at);
CREATE INDEX schedule_runs_schedule_idx ON schedule_runs(schedule_id, created_at DESC);

CREATE TABLE schedule_command_receipts (
  actor_key TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  method TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('in_progress','succeeded','failed')),
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
