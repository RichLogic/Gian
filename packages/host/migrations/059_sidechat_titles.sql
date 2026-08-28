-- Side Chat tab identity is Host-owned and survives transient route recovery.
-- Existing records receive a stable creation-order ordinal per parent.
ALTER TABLE sidechat_transients ADD COLUMN ordinal INTEGER;
ALTER TABLE sidechat_transients ADD COLUMN name TEXT;

WITH ranked AS (
  SELECT sidechat_id,
         ROW_NUMBER() OVER (
           PARTITION BY parent_session_id
           ORDER BY created_at, sidechat_id
         ) AS ordinal
  FROM sidechat_transients
)
UPDATE sidechat_transients
SET ordinal = (
  SELECT ranked.ordinal
  FROM ranked
  WHERE ranked.sidechat_id = sidechat_transients.sidechat_id
);
