CREATE TABLE remote_execution_bindings (
  local_session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  server_origin TEXT NOT NULL,
  server_identity_fingerprint TEXT NOT NULL,
  account_id TEXT NOT NULL,
  host_id TEXT NOT NULL,
  remote_session_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  execution_started_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (server_origin, server_identity_fingerprint, account_id, host_id, remote_session_id)
);
