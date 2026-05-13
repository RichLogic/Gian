-- The Workspace.executor field was a UI default for the New Session form,
-- but the field was never actually consumed: SessionManager.createSession
-- only reads the executor from the request, not from the workspace row.
-- The CodingView sidebar's inline form even hardcoded 'claude' regardless.
-- Executor is a per-Session concern; the directory itself doesn't have one.

ALTER TABLE workspaces DROP COLUMN executor;

UPDATE config SET value = '6' WHERE key = 'schema_version';
