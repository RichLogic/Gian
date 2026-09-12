/**
 * Trimmed structured logging for the schedule domain: only
 * schedule/run/session/turn identifiers, phase transitions, durations, and
 * error codes. Prompt, config, and raw Provider payloads never reach the log.
 */

export function markScheduleLog(message: string): void {
  console.log(`[schedule] ${message}`);
}

export function markScheduleWarn(message: string, error?: unknown): void {
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : undefined;
  if (detail) console.warn(`[schedule] ${message} (${detail})`);
  else console.warn(`[schedule] ${message}`);
}
