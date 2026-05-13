-- Per-session thinking effort (passed to codex turn.start as `thinking`,
-- ignored by cc-proxy which doesn't expose reasoning effort via CLI).
-- Null = use the model's defaultEffort from capabilities.

ALTER TABLE sessions ADD COLUMN thinking_effort TEXT
  CHECK (thinking_effort IS NULL OR thinking_effort IN
    ('off','minimal','low','medium','high','max','xhigh'));

UPDATE config SET value = '9' WHERE key = 'schema_version';
