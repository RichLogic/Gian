-- New Session native uniqueness is (proxy_plugin_id, native_session_id).
-- Legacy rows whose pluginId is still NULL keep the old executor uniqueness
-- and are not rewritten or fabricated.
DROP INDEX IF EXISTS idx_sessions_native_unique;

CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_native_plugin_unique
  ON sessions(proxy_plugin_id, native_session_id)
  WHERE proxy_plugin_id IS NOT NULL AND native_session_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_native_legacy_unique
  ON sessions(executor, native_session_id)
  WHERE proxy_plugin_id IS NULL AND native_session_id IS NOT NULL;
