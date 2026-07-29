-- Session-scoped token state. Current context is replaceable and may be
-- invalidated around compaction; conversation totals are shown only when the
-- host knows it has observed the whole native session.

ALTER TABLE sessions ADD COLUMN context_tokens_used INTEGER;
ALTER TABLE sessions ADD COLUMN context_window_tokens INTEGER;
ALTER TABLE sessions ADD COLUMN context_usage_updated_at TEXT;
ALTER TABLE sessions ADD COLUMN conversation_input_tokens INTEGER;
ALTER TABLE sessions ADD COLUMN conversation_output_tokens INTEGER;
ALTER TABLE sessions ADD COLUMN conversation_cached_input_tokens INTEGER;
ALTER TABLE sessions ADD COLUMN conversation_total_tokens INTEGER;
ALTER TABLE sessions ADD COLUMN conversation_usage_complete INTEGER NOT NULL DEFAULT 0;
