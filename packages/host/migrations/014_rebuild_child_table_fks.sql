-- migration:no-transaction
-- (toggle pragmas + manage transaction ourselves; foreign_keys can't be
-- changed inside a transaction.)
--
-- Migration 013 had a bug in an earlier iteration: ALTER TABLE sessions
-- RENAME TO sessions_old caused SQLite to silently rewrite the FK
-- references in events / turns / queue / approvals to point at
-- sessions_old. We then DROP sessions_old, leaving those FKs dangling.
-- Any INSERT into events / turns / etc. then fails with
-- `no such table: main.sessions_old`.
--
-- 013 is now fixed (uses legacy_alter_table=1 to suppress the rewrite),
-- but DBs that already applied the broken version still have corrupted
-- FKs. This migration rebuilds the four child tables so their FKs point
-- at sessions(id) again. Idempotent — on a fresh DB the result is
-- identical to the original schema.

PRAGMA legacy_alter_table = 1;
PRAGMA foreign_keys = OFF;

BEGIN TRANSACTION;

-- ============ turns ============
CREATE TABLE turns_new (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_number  INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'running',
  summary      TEXT,
  ops          INTEGER DEFAULT 0,
  tokens       INTEGER DEFAULT 0,
  duration_ms  INTEGER,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);
INSERT INTO turns_new (id, session_id, turn_number, status, summary, ops, tokens, duration_ms, created_at, completed_at)
SELECT id, session_id, turn_number, status, summary, ops, tokens, duration_ms, created_at, completed_at FROM turns;
DROP TABLE turns;
ALTER TABLE turns_new RENAME TO turns;
CREATE INDEX idx_turns_session ON turns(session_id, turn_number);

-- ============ events ============
CREATE TABLE events_new (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id     TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  call_id     TEXT NOT NULL,
  type        TEXT NOT NULL,
  data        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO events_new (id, session_id, turn_id, call_id, type, data, created_at)
SELECT id, session_id, turn_id, call_id, type, data, created_at FROM events;
DROP TABLE events;
ALTER TABLE events_new RENAME TO events;
CREATE INDEX idx_events_session ON events(session_id, created_at);
CREATE INDEX idx_events_turn ON events(turn_id);
CREATE INDEX idx_events_call ON events(call_id);

-- ============ queue ============
CREATE TABLE queue_new (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  text        TEXT NOT NULL,
  sort_order  INTEGER NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO queue_new (id, session_id, text, sort_order, created_at)
SELECT id, session_id, text, sort_order, created_at FROM queue;
DROP TABLE queue;
ALTER TABLE queue_new RENAME TO queue;
CREATE INDEX idx_queue_session ON queue(session_id, sort_order);

-- ============ approvals ============
CREATE TABLE approvals_new (
  id           TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id      TEXT NOT NULL REFERENCES turns(id),
  category     TEXT NOT NULL,
  title        TEXT NOT NULL,
  command      TEXT NOT NULL,
  reason       TEXT,
  status       TEXT NOT NULL DEFAULT 'pending',
  resolved_by  TEXT,
  resolved_at  TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO approvals_new (id, session_id, turn_id, category, title, command, reason, status, resolved_by, resolved_at, created_at)
SELECT id, session_id, turn_id, category, title, command, reason, status, resolved_by, resolved_at, created_at FROM approvals;
DROP TABLE approvals;
ALTER TABLE approvals_new RENAME TO approvals;
CREATE INDEX idx_approvals_session ON approvals(session_id);
CREATE INDEX idx_approvals_pending ON approvals(status) WHERE status = 'pending';

COMMIT;

PRAGMA legacy_alter_table = 0;
PRAGMA foreign_keys = ON;
PRAGMA foreign_key_check;
