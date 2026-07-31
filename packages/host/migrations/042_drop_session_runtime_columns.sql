-- Session execution is proxy-structured only. The Workbench terminal has its
-- own term:* protocol and stores no session runtime state.
ALTER TABLE sessions DROP COLUMN runtime_mode;
ALTER TABLE sessions DROP COLUMN turns;
ALTER TABLE sessions DROP COLUMN tty_turn_seq;
