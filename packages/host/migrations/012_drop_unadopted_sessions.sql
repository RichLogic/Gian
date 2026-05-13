-- From now on every Gian session is bound to a native cc/codex session id
-- (the JSONL on disk is the source of truth). Pre-existing rows that
-- predate this rule have native_session_id IS NULL and are dropped here.
--
-- CASCADE will clean events / turns / queue / approvals automatically
-- (foreign_keys=ON, see db.ts).

DELETE FROM sessions WHERE native_session_id IS NULL;
