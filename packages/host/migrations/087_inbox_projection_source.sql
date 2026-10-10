-- Explicit fact source and owner generation for Host-local facts. Native
-- provider event ids are opaque strings: a `local:` prefix is not proof of
-- ownership, so the source of every fact is persisted instead of inferred.
-- The primary key gains the source column so a legitimate native event id can
-- never be deduplicated against a Host-generated local fact with the same id.
--
-- Data limitation (unreleased draft only): rows written before this column
-- existed carry no trustworthy source evidence. They are migrated as
-- source='native' with owner_generation NULL — including any draft-round
-- Host-local rows, which therefore are NOT claimed as local and are never
-- ghost-cancelled by string guessing. No automatic repair is fabricated for
-- that draft data; discard pre-087 draft databases if a clean slate is needed.
CREATE TABLE inbox_projection_facts_new (
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
  -- 'native': the provider event stream. 'local': a Host-local approval with
  -- no provider event (browser capture). Never inferred from the id text.
  source TEXT NOT NULL DEFAULT 'native' CHECK (source IN ('native', 'local')),
  -- Host process generation that wrote a local fact. NULL for native facts.
  owner_generation TEXT,
  -- Fact writer. 'provider': a real provider event, looked up and stamped by
  -- its raw event id. 'host': a Host-synthesized fact (terminal-turn close,
  -- local approval open/close). Provider event ids are opaque and may equal a
  -- Host-synthesized id string; the writer column keeps the two from ever
  -- deduplicating or marking each other.
  writer TEXT NOT NULL DEFAULT 'provider' CHECK (writer IN ('provider', 'host')),
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
  user_pending INTEGER NOT NULL DEFAULT 0 CHECK (user_pending IN (0, 1)),
  user_source INTEGER NOT NULL DEFAULT 0 CHECK (user_source IN (0, 1)),
  applied INTEGER NOT NULL DEFAULT 0 CHECK (applied IN (0, 1)),
  PRIMARY KEY (session_id, source, writer, provider_event_id)
);

INSERT INTO inbox_projection_facts_new (
  session_id, provider_event_id, turn_id, interaction_id, direction,
  occurrence_event_id, generation, bound, origin, source, owner_generation,
  writer,
  projected, outcome, decision, action_id, title, description, subject,
  category, tool_name, turn_number, user_pending, user_source, applied
)
SELECT
  session_id, provider_event_id, turn_id, interaction_id, direction,
  occurrence_event_id, generation, bound, origin,
  -- No trustworthy source evidence exists for pre-087 rows: keep them native.
  'native',
  NULL,
  'provider',
  projected, outcome, decision, action_id, title, description, subject,
  category, tool_name, turn_number, user_pending, user_source, applied
FROM inbox_projection_facts;

DROP TABLE inbox_projection_facts;
ALTER TABLE inbox_projection_facts_new RENAME TO inbox_projection_facts;

CREATE INDEX inbox_projection_facts_unapplied
  ON inbox_projection_facts (applied);
CREATE INDEX inbox_projection_facts_occurrence
  ON inbox_projection_facts (session_id, turn_id, interaction_id, direction);
