// Per-Task Manager (PRD-v3). codex-proxy has no system/instructions channel
// (CreateSessionParams / StartTurnParams carry no such field), so the Manager's
// system prompt is prepended to its FIRST user message, wrapped in these
// sentinels. The web strips the wrapped block when rendering the Manager
// transcript (stripManagerSystemPrefix) — the prompt still reaches codex, but is
// not shown to the user. The strip happens at render time and keys on the
// sentinels, so it is robust to the codex JSONL watcher re-reading the raw
// payload (text-match reconciliation would otherwise re-surface the prompt).

export const MANAGER_SYS_OPEN = '<<gian:manager-system>>';
export const MANAGER_SYS_CLOSE = '<<gian:manager-system-end>>';

/** Strip the sentinel-wrapped Manager system prefix from a message, if present.
 *  Returns the text unchanged when no sentinels are found. */
export function stripManagerSystemPrefix(text: string): string {
  const open = text.indexOf(MANAGER_SYS_OPEN);
  if (open === -1) return text;
  const close = text.indexOf(MANAGER_SYS_CLOSE, open);
  if (close === -1) return text;
  return text.slice(close + MANAGER_SYS_CLOSE.length).replace(/^\s+/, '');
}
