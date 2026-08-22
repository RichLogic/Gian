-- Session-scoped Turn-bound catalog replacement (WP4, contract §9.4).
-- When set (including an explicit empty array), these options replace the
-- process catalog's turn-bound subset. Revision is required whenever the
-- options column is non-NULL.
ALTER TABLE sessions ADD COLUMN turn_config_options_json TEXT;
ALTER TABLE sessions ADD COLUMN turn_config_revision TEXT;
