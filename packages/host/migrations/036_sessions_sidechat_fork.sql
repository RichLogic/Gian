-- 036_sessions_sidechat_fork.sql — persist an unstarted Claude sidechat fork.
--
-- A sidechat's cc-proxy process can disappear before the user sends its first
-- turn. Keep the parent Gian session id until Claude reports the fork's real
-- native id so host rehydration can repeat `--resume <parent> --fork-session`.
-- The column is host-internal and is cleared on `session.rotated`.

ALTER TABLE sessions
ADD COLUMN fork_from_session_id TEXT
  REFERENCES sessions(id) ON DELETE SET NULL;
