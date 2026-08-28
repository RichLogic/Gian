CREATE TABLE tool_credentials (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  actor_kind TEXT NOT NULL
    CHECK (actor_kind IN ('internal_session', 'external_controller')),
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  client_id TEXT,
  caller_id TEXT NOT NULL CHECK (length(caller_id) BETWEEN 1 AND 256),
  grants_json TEXT NOT NULL CHECK (json_valid(grants_json)),
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  CHECK (
    (actor_kind = 'internal_session' AND session_id IS NOT NULL AND client_id IS NULL)
    OR
    (actor_kind = 'external_controller' AND session_id IS NULL AND client_id IS NOT NULL)
  )
);

CREATE INDEX idx_tool_credentials_session
  ON tool_credentials(session_id) WHERE session_id IS NOT NULL;
CREATE INDEX idx_tool_credentials_expiry
  ON tool_credentials(expires_at) WHERE revoked_at IS NULL;
