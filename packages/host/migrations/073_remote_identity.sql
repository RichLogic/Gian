CREATE TABLE remote_enrollments (
  host_id TEXT PRIMARY KEY,
  server_url TEXT NOT NULL,
  server_identity_public_key TEXT NOT NULL,
  server_identity_fingerprint TEXT NOT NULL,
  host_public_key TEXT NOT NULL,
  host_name TEXT NOT NULL,
  enrolled_at TEXT NOT NULL,
  last_confirmed_identity_at TEXT,
  pending_identity_public_key TEXT,
  pending_identity_fingerprint TEXT
);

CREATE TABLE remote_devices (
  id TEXT PRIMARY KEY,
  public_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  role TEXT NOT NULL,
  grants_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  revoked_at TEXT,
  revision INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_remote_devices_revoked ON remote_devices(revoked_at, last_seen_at);

CREATE TABLE remote_pairings (
  id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL UNIQUE,
  code_hash TEXT NOT NULL,
  grant_nonce_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  device_public_key TEXT,
  device_name TEXT,
  platform TEXT,
  user_agent TEXT,
  claimed_network TEXT,
  failure_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  claimed_at TEXT,
  resolved_at TEXT,
  device_id TEXT
);

CREATE INDEX idx_remote_pairings_status_expires ON remote_pairings(status, expires_at);

CREATE TABLE remote_mutation_audit (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  method TEXT NOT NULL,
  command_id TEXT NOT NULL,
  result_category TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_remote_mutation_audit_device
  ON remote_mutation_audit(device_id, created_at DESC);

CREATE TABLE remote_command_ledger (
  command_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  method TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  state TEXT NOT NULL,
  tool_result_json TEXT,
  error_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_remote_command_ledger_device
  ON remote_command_ledger(device_id, updated_at DESC);

CREATE TABLE remote_file_refs (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  content_revision TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX idx_remote_file_refs_device_session
  ON remote_file_refs(device_id, session_id, expires_at);

CREATE TABLE remote_upload_intents (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  received INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  temp_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX idx_remote_upload_intents_expiry
  ON remote_upload_intents(state, expires_at, pinned);
