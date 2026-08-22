-- Next-turn Turn-bound config snapshot (WP6). Host still reads
-- approval_mode / model / thinking_effort as fallbacks until Composer
-- writes this column exclusively (D8).
ALTER TABLE sessions ADD COLUMN turn_config_json TEXT;
