-- Open Session plugin identity and exact-binding scaffolding.
-- Backfill pluginId from the official executor alias table. Do not invent
-- version, digest, protocol, scope, or Runtime facts — binding stays NULL.
ALTER TABLE sessions ADD COLUMN proxy_plugin_id TEXT;
ALTER TABLE sessions ADD COLUMN proxy_binding_json TEXT;

UPDATE sessions
SET proxy_plugin_id = CASE executor
  WHEN 'claude' THEN 'claude'
  WHEN 'codex' THEN 'codex'
  WHEN 'kimi' THEN 'kimi'
  WHEN 'grok' THEN 'grok'
  WHEN 'dsh' THEN 'ai.deepseek.harness'
  WHEN 'zcode' THEN 'com.zhipu.zcode'
  ELSE NULL
END
WHERE proxy_plugin_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_sessions_proxy_plugin_id
  ON sessions(proxy_plugin_id);
