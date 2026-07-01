-- 028_task_loops_actions.sql — Loop authorization + action idempotency ledger.
--
-- Foundations for the Gian action protocol (proposal gian-task-pm-engineer
-- §4A.A). Agents emit `<<gian:action>>` envelopes in their FINAL text; the host
-- parses, deduplicates, authorizes, and executes them. Two additive tables:
--
--   task_loops   — per-Task authorization context: which methods / workspaces /
--                  executors are allowed, the round budget, and the current
--                  step. The loop contract (§4.5) fills this; the executor gate
--                  (§4A.A execution contract ④) reads it. Empty / no active loop
--                  ⇒ actions can only be `staged` (user confirm), never run
--                  unattended.
--   task_actions — one row per parsed action, keyed by a DETERMINISTIC
--                  action_id = hash(session_id + source_turn_key + payload_hash).
--                  JSONL replay / restart re-parse / stream+final double-reads /
--                  retry injection therefore never execute the same action twice.
--
-- Array-valued columns (allowed_methods / allowed_workspaces / allowed_executors)
-- are stored as JSON TEXT. Both tables are new — additive, no backfill. FKs
-- cascade from tasks/sessions so deleting a Task or session cleans up its loop
-- and action rows.

CREATE TABLE IF NOT EXISTS task_loops (
  id                       TEXT PRIMARY KEY,
  task_id                  TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  status                   TEXT NOT NULL DEFAULT 'active',   -- active | paused | done
  allowed_methods          TEXT NOT NULL DEFAULT '[]',       -- JSON GianActionMethod[]
  allowed_workspaces       TEXT NOT NULL DEFAULT '[]',       -- JSON workspace_id[]
  allowed_executors        TEXT NOT NULL DEFAULT '[]',       -- JSON Executor[]
  round                    INTEGER NOT NULL DEFAULT 0,
  max_rounds               INTEGER NOT NULL DEFAULT 0,
  current_step             TEXT,
  current_step_session_id  TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  expected_role            TEXT,                             -- individual | engineer | pm
  created_at               TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at               TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_task_loops_task ON task_loops(task_id);

CREATE TABLE IF NOT EXISTS task_actions (
  action_id        TEXT PRIMARY KEY,  -- hash(session_id + source_turn_key + payload_hash)
  task_id          TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  session_id       TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  host_turn_id     TEXT,              -- host DB turn UUID (nullable: a TTY Stop may lack one)
  source_turn_key  TEXT,              -- runtime-native turn key the block parsed from
  method           TEXT NOT NULL,     -- create_subtask | message_subtask | submit_step
  payload_hash     TEXT NOT NULL,     -- hash of the verbatim action block text
  payload          TEXT NOT NULL,     -- normalized {method, params} JSON
  status           TEXT NOT NULL DEFAULT 'parsed',
                   -- parsed|validated|staged|queued|authorized|executing|done|failed|rejected
  result           TEXT,              -- JSON, e.g. {"subtask_id":"…"} once executed
  error            TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_task_actions_task ON task_actions(task_id);
CREATE INDEX IF NOT EXISTS idx_task_actions_session ON task_actions(session_id);
CREATE INDEX IF NOT EXISTS idx_task_actions_status ON task_actions(status);
