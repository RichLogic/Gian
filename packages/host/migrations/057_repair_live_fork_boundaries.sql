-- Live gian.proxy/2 turns were provisionally recorded with the Host turn id
-- as provider_turn_id. The terminal transcript projection already retained
-- the real sourceTurnId, so repair those rows for durable Fork anchors.
WITH candidates AS (
  SELECT replay.session_id,
         replay.turn_id,
         (
           SELECT json_extract(events.data, '$.display.data.sourceTurnId')
           FROM events
           WHERE events.session_id = replay.session_id
             AND events.turn_id = replay.turn_id
             AND json_type(events.data, '$.display.data.sourceTurnId') = 'text'
           ORDER BY events.created_at DESC, events.id DESC
           LIMIT 1
         ) AS source_turn_id
  FROM proxy_replay_turns AS replay
  WHERE replay.replay_owned = 0
    AND replay.provider_turn_id = replay.turn_id
)
UPDATE proxy_replay_turns
SET provider_turn_id = (
  SELECT candidates.source_turn_id
  FROM candidates
  WHERE candidates.session_id = proxy_replay_turns.session_id
    AND candidates.turn_id = proxy_replay_turns.turn_id
)
WHERE EXISTS (
  SELECT 1
  FROM candidates
  WHERE candidates.session_id = proxy_replay_turns.session_id
    AND candidates.turn_id = proxy_replay_turns.turn_id
    AND candidates.source_turn_id IS NOT NULL
    AND candidates.source_turn_id <> proxy_replay_turns.provider_turn_id
    AND NOT EXISTS (
      SELECT 1
      FROM proxy_replay_turns AS conflict
      WHERE conflict.session_id = candidates.session_id
        AND conflict.provider_turn_id = candidates.source_turn_id
        AND conflict.turn_id <> candidates.turn_id
    )
);
