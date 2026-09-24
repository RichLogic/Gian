CREATE TABLE remote_controller_environments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  server_origin TEXT NOT NULL,
  server_identity_fingerprint TEXT NOT NULL,
  host_id TEXT NOT NULL,
  browser_id TEXT NOT NULL,
  device_id TEXT,
  crypto_connection_id TEXT,
  host_public_key_json TEXT,
  pairing_id TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (server_origin, host_id)
);

ALTER TABLE sessions ADD COLUMN remote_environment_id TEXT REFERENCES remote_controller_environments(id);
ALTER TABLE sessions ADD COLUMN remote_repository_id TEXT;
ALTER TABLE sessions ADD COLUMN remote_repository_name TEXT;
ALTER TABLE sessions ADD COLUMN remote_worktree_root TEXT;

CREATE TABLE remote_execution_create_requests (
  request_id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL REFERENCES remote_controller_environments(id),
  command_id TEXT NOT NULL UNIQUE,
  input_json TEXT NOT NULL,
  params_json TEXT,
  browser_id TEXT NOT NULL,
  repository_name TEXT NOT NULL,
  result_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE remote_execution_send_requests (
  request_id TEXT PRIMARY KEY,
  local_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  binding_revision INTEGER NOT NULL,
  browser_id TEXT NOT NULL,
  command_id TEXT NOT NULL UNIQUE,
  input_json TEXT NOT NULL,
  params_json TEXT NOT NULL,
  result_json TEXT,
  created_at INTEGER NOT NULL
);
