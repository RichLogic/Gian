ALTER TABLE workspaces ADD COLUMN risk_command              TEXT NOT NULL DEFAULT 'medium' CHECK (risk_command IN ('low','medium','high'));
ALTER TABLE workspaces ADD COLUMN risk_network              TEXT NOT NULL DEFAULT 'medium' CHECK (risk_network IN ('low','medium','high'));
ALTER TABLE workspaces ADD COLUMN risk_file_write_outside_ws TEXT NOT NULL DEFAULT 'high'   CHECK (risk_file_write_outside_ws IN ('low','medium','high'));
ALTER TABLE workspaces ADD COLUMN risk_other                TEXT NOT NULL DEFAULT 'medium' CHECK (risk_other IN ('low','medium','high'));

UPDATE config SET value = '2' WHERE key = 'schema_version';
