-- Occurrence lookup index for the inbox projection hot paths. canonicalOpening,
-- closeExists, bindWaitingCloses, and the terminal-open sweep's NOT EXISTS all
-- probe by (session_id, turn_id, interaction_id, direction); without this index
-- each probe is a table scan over the full projection history.
CREATE INDEX inbox_projection_facts_occurrence
  ON inbox_projection_facts (session_id, turn_id, interaction_id, direction);
