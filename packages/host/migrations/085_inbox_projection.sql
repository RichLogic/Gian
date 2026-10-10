-- Durable main-session question/approval projection intents.
-- One row is written in the same transaction as the provider event it names.
-- Recovery applies unapplied rows only. It does not scan the transcript.
-- No foreign key: a deleted session must still be able to expire its inbox
-- row after the sessions row is gone. applied=1 is not a deletion.
CREATE TABLE inbox_projection_facts (
  session_id TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  interaction_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('open', 'close')),
  -- Provider event id of the request that opened this occurrence.
  -- Empty only when a resolved event could not be bound.
  occurrence_event_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 0),
  -- 0: this resolved event has no matching occurrence. Do not close.
  bound INTEGER NOT NULL CHECK (bound IN (0, 1)),
  origin TEXT NOT NULL CHECK (origin IN ('live', 'replay')),
  projected TEXT CHECK (projected IS NULL OR projected IN ('question', 'approval')),
  outcome TEXT,
  decision TEXT,
  action_id TEXT,
  title TEXT,
  description TEXT,
  subject TEXT,
  category TEXT,
  tool_name TEXT,
  turn_number INTEGER,
  -- 1 only for an opening that registerPending would keep. Auto-approve is 0
  -- and applied at insert, so a crash cannot recover it as a user todo.
  user_pending INTEGER NOT NULL DEFAULT 0 CHECK (user_pending IN (0, 1)),
  -- 1 only when the committing process already had a web, im, or tool source.
  -- Unknown, auto, and replay recovery stay 0. There is no web fallback.
  user_source INTEGER NOT NULL DEFAULT 0 CHECK (user_source IN (0, 1)),
  applied INTEGER NOT NULL DEFAULT 0 CHECK (applied IN (0, 1)),
  PRIMARY KEY (session_id, provider_event_id)
);

-- applied=0 is the recovery set. Insert order stays ORDER BY rowid in that
-- scan. rowid is not a real column and cannot be an index key.
CREATE INDEX inbox_projection_facts_unapplied
  ON inbox_projection_facts (applied);
