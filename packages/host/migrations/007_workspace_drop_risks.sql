-- Approval risk levels were stored on the workspace, but the approval pipeline
-- never read them: ApprovalManager pulls risk from the unified event's
-- `data.risk` (set by the proxy normalizer per request) and applies the
-- session's approval_mode + allow_session memory. Per-workspace defaults add
-- conceptual weight without behavioral effect — risk decisions are now
-- session-level only.

ALTER TABLE workspaces DROP COLUMN risk_command;
ALTER TABLE workspaces DROP COLUMN risk_network;
ALTER TABLE workspaces DROP COLUMN risk_file_write_outside_ws;
ALTER TABLE workspaces DROP COLUMN risk_other;

UPDATE config SET value = '7' WHERE key = 'schema_version';
