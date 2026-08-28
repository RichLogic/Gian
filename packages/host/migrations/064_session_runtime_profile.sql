-- Immutable Agent runtime selected when a Session is created. The JSON
-- snapshot lives with the Session because saved Agents are user-owned mutable
-- configuration outside SQLite and may change path later.
ALTER TABLE sessions ADD COLUMN runtime_profile_json TEXT;
