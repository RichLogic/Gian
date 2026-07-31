-- Session runtimes are structured-only. Workbench terminals use the separate
-- term:* protocol and are unaffected by this compatibility migration.
--
-- The legacy columns remain in the SQLite table because SQLite cannot drop
-- them without rebuilding the sessions table. Normalize old rows so older
-- databases cannot retain an unreachable TTY or multi-turn Job state.
UPDATE sessions
SET runtime_mode = 'structured',
    turns = 1,
    tty_turn_seq = 0
WHERE runtime_mode <> 'structured'
   OR turns <> 1
   OR tty_turn_seq <> 0;
