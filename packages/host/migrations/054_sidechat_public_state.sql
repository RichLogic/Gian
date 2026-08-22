-- Persist Side Chat public state as a transient field. The 200-event buffer
-- is a render window, not the state machine.
ALTER TABLE sidechat_transients ADD COLUMN public_state TEXT NOT NULL DEFAULT 'idle';

UPDATE sidechat_transients SET public_state = 'stale' WHERE status = 'closing';
UPDATE sidechat_transients SET public_state = 'error' WHERE status = 'unavailable';
