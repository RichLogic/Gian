-- 032_sessions_service_tier.sql — codex "Fast" service tier per session.
--
-- The composer's "Fast" toggle (codex only) maps to codex's Fast service tier.
-- codex-proxy already forwards `serviceTier` on turn/start (app-server client)
-- but the host never set it. This column persists the choice per session so it
-- rides every subsequent codex turn (applies next turn, like /fast).
--
-- Values: 'fast' when on, NULL when off. ('flex' is a valid codex tier too but
-- the UI only exposes Fast for now.)
ALTER TABLE sessions ADD COLUMN service_tier TEXT;   -- 'fast' | NULL
