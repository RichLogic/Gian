-- Sessions bind a user Agent (agents.json schema v2). No SQL FK: Agents
-- live outside SQLite and may be deleted; agent_name/agent_color are
-- snapshots so a deleted Agent's sessions still render its name and color
-- (read-only, no new turns). NULL agent_id = pre-migration session, resolved
-- through the kind's default Agent at runtime.
ALTER TABLE sessions ADD COLUMN agent_id TEXT;
ALTER TABLE sessions ADD COLUMN agent_name TEXT;
ALTER TABLE sessions ADD COLUMN agent_color TEXT;
