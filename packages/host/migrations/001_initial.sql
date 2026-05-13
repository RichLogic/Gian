-- Initial schema for Gian. See doc/data-model.md.

CREATE TABLE workspaces (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  path        TEXT NOT NULL UNIQUE,
  executor    TEXT NOT NULL DEFAULT 'codex',
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sessions (
  id              TEXT PRIMARY KEY,
  name            TEXT,
  type            TEXT NOT NULL DEFAULT 'coding',
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id),
  executor        TEXT NOT NULL,
  model           TEXT,
  approval_mode   TEXT NOT NULL DEFAULT 'default',
  turns           INTEGER NOT NULL DEFAULT 1,
  active_channel  TEXT DEFAULT 'web',
  status          TEXT NOT NULL DEFAULT 'new',
  archived        INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_sessions_status ON sessions(status);
CREATE INDEX idx_sessions_workspace ON sessions(workspace_id);
CREATE INDEX idx_sessions_updated ON sessions(updated_at DESC);

CREATE TABLE turns (
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

CREATE INDEX idx_turns_session ON turns(session_id, turn_number);

CREATE TABLE events (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id     TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
  call_id     TEXT NOT NULL,
  type        TEXT NOT NULL,
  data        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_events_session ON events(session_id, created_at);
CREATE INDEX idx_events_turn ON events(turn_id);
CREATE INDEX idx_events_call ON events(call_id);

CREATE TABLE approvals (
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

CREATE INDEX idx_approvals_session ON approvals(session_id);
CREATE INDEX idx_approvals_pending ON approvals(status) WHERE status = 'pending';

CREATE TABLE queue (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  text        TEXT NOT NULL,
  sort_order  INTEGER NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_queue_session ON queue(session_id, sort_order);

CREATE TABLE bots (
  id                TEXT PRIMARY KEY,
  label             TEXT NOT NULL,
  platform          TEXT NOT NULL,
  workspace_id      TEXT REFERENCES workspaces(id),
  mode              TEXT NOT NULL DEFAULT 'read-only',
  allowed_user_id   TEXT,
  enabled           INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'disabled',
  last_error        TEXT,
  last_connected_at TEXT,
  extra             TEXT NOT NULL DEFAULT '{}',
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE config (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

INSERT INTO config (key, value) VALUES
  ('schema_version',    '1'),
  ('host',              '127.0.0.1'),
  ('port',              '8990'),
  ('workspace_root',    '~/Coding'),
  ('public_url',        ''),
  ('tunnel_mode',       'none'),
  ('tunnel_id',         ''),
  ('force_https',       'false'),
  ('theme',             'warm'),
  ('accent',            'plum'),
  ('density',           'cozy'),
  ('locale',            'zh-CN'),
  ('auth_username',     ''),
  ('auth_password_hash', '');
