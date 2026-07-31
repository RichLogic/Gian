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
 *  Returns the text unchanged when no sentinels are found. The first turn can
 *  carry MULTIPLE stacked leading blocks — the host wraps its system prompt, and
 *  the web may prepend a `create_subtask` context note (`wrapManagerContextNote`)
 *  in the SAME sentinels — so strip every leading block, not just one. Only
 *  leading blocks are stripped, so a sentinel literal later in the user's own
 *  text is left intact. */
export function stripManagerSystemPrefix(text: string): string {
  let out = text.replace(/^\s+/, '');
  while (out.startsWith(MANAGER_SYS_OPEN)) {
    const close = out.indexOf(MANAGER_SYS_CLOSE);
    if (close === -1) break;
    out = out.slice(close + MANAGER_SYS_CLOSE.length).replace(/^\s+/, '');
  }
  return out;
}

/** Wrap an out-of-band context note that the web prepends to a Manager user
 *  message — e.g. "the user manually created subtask X". Reuses the
 *  system-prefix sentinels so `stripManagerSystemPrefix` hides it from the
 *  transcript while the raw text still reaches the Manager. Returns `userText`
 *  unchanged when there are no notes. */
export function wrapManagerContextNote(notes: string[], userText: string): string {
  if (notes.length === 0) return userText;
  return `${MANAGER_SYS_OPEN}\n${notes.join('\n')}\n${MANAGER_SYS_CLOSE}\n\n${userText}`;
}

// ── Legacy Manager `create_subtask` proposal protocol (spec 2026-06-28 §A2) ──
// Kept only to strip older transcripts. Current Manager-authored subtasks
// use the surface-agnostic `<<gian:action>>` envelope, executed by the host after
// natural-language confirmation in the conversation.
export const CREATE_SUBTASK_OPEN = '<<gian:create_subtask>>';
export const CREATE_SUBTASK_CLOSE = '<</gian:create_subtask>>';

/** Remove every legacy create_subtask block from Manager assistant text so the
 *  user sees clean prose, not the raw JSON block. */
export function stripCreateSubtaskBlocks(text: string): string {
  let out = text;
  for (;;) {
    const open = out.indexOf(CREATE_SUBTASK_OPEN);
    if (open === -1) break;
    const close = out.indexOf(CREATE_SUBTASK_CLOSE, open);
    if (close === -1) { out = out.slice(0, open).trimEnd(); break; }
    out = out.slice(0, open) + out.slice(close + CREATE_SUBTASK_CLOSE.length);
  }
  return out.replace(/\n{3,}/g, '\n\n').trim();
}
