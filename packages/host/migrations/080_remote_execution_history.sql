ALTER TABLE remote_devices ADD COLUMN account_id TEXT;
ALTER TABLE remote_pairings ADD COLUMN account_id TEXT;

CREATE TABLE remote_execution_exports (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  stream_id TEXT NOT NULL UNIQUE,
  sequence INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE remote_execution_events (
  session_id TEXT NOT NULL REFERENCES remote_execution_exports(session_id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  event_json TEXT NOT NULL,
  PRIMARY KEY (session_id, sequence)
);
CREATE TABLE remote_execution_replicas (
  local_session_id TEXT PRIMARY KEY REFERENCES remote_execution_bindings(local_session_id) ON DELETE CASCADE,
  stream_id TEXT NOT NULL,
  cursor INTEGER NOT NULL DEFAULT 0,
  snapshot_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE remote_execution_replica_events (
  local_session_id TEXT NOT NULL REFERENCES remote_execution_replicas(local_session_id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  item_json TEXT NOT NULL,
  PRIMARY KEY (local_session_id, sequence)
);
