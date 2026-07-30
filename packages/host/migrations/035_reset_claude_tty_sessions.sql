-- 035_reset_claude_tty_sessions.sql — Claude TTY mode removal.
--
-- Claude TTY runtime (claude TUI inside a PTY, driven via cc-proxy
-- tty.start/input/resize/replay/kill + Stop hooks) was removed; Claude is
-- structured-only now. Any claude session row still carrying
-- runtime_mode='tty' would be stuck: the web can no longer render its TTY
-- surface and SessionManager.switchRuntime refuses claude targets with
-- SWITCH_BLOCKED. Flip those rows back to 'structured' so the next open
-- lands in Chat. Codex TTY rows are untouched — that runtime still exists.

UPDATE sessions SET runtime_mode = 'structured'
WHERE executor = 'claude' AND runtime_mode = 'tty';
