ALTER TABLE tool_credentials ADD COLUMN role TEXT NOT NULL DEFAULT 'standard'
  CHECK (role IN ('standard', 'admin'));

ALTER TABLE sessions ADD COLUMN created_by_actor_kind TEXT
  CHECK (created_by_actor_kind IS NULL OR created_by_actor_kind IN ('internal_session', 'external_controller'));
ALTER TABLE sessions ADD COLUMN created_by_actor_id TEXT;
ALTER TABLE sessions ADD COLUMN created_by_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL;

CREATE INDEX idx_sessions_tool_creator
  ON sessions(created_by_actor_kind, created_by_actor_id)
  WHERE created_by_actor_kind IS NOT NULL AND created_by_actor_id IS NOT NULL;
CREATE INDEX idx_sessions_created_by_session
  ON sessions(created_by_session_id)
  WHERE created_by_session_id IS NOT NULL;
