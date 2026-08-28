-- Side Chat keeps an independent next-turn draft and the exact Proxy-advertised
-- Turn-bound option subset. Session-bound config remains inherited/immutable.
ALTER TABLE sidechat_transients
  ADD COLUMN turn_config_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE sidechat_transients
  ADD COLUMN turn_config_options_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE sidechat_transients
  ADD COLUMN turn_config_revision TEXT;
