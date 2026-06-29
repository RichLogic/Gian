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

// ── Manager `create_subtask` proposal protocol (spec 2026-06-28 §A2) ──
// codex-proxy has no tool/schema channel for the Manager, so it PROPOSES a
// subtask by emitting an ASCII-delimited block in its reply; the web parses it
// into an editable confirm card and hides the raw block from the transcript.
export const CREATE_SUBTASK_OPEN = '<<gian:create_subtask>>';
export const CREATE_SUBTASK_CLOSE = '<</gian:create_subtask>>';

export interface CreateSubtaskProposal {
  /** Short title (optional). */
  name?: string;
  /** Workspace name or absolute path — resolved to a workspace_id on the web. */
  workspace?: string;
  executor?: 'claude' | 'codex';
  /** Initial instruction for the subtask; required (empty proposals ignored). */
  prompt: string;
}

/** Parse the LAST `<<gian:create_subtask>> {json} <</gian:create_subtask>>`
 *  block from Manager assistant text. Returns null when absent, malformed, or
 *  missing a non-empty `prompt` (so half-typed/streaming blocks don't render a
 *  card prematurely). */
export function parseCreateSubtaskProposal(text: string): CreateSubtaskProposal | null {
  const open = text.lastIndexOf(CREATE_SUBTASK_OPEN);
  if (open === -1) return null;
  const close = text.indexOf(CREATE_SUBTASK_CLOSE, open);
  if (close === -1) return null;
  const json = text.slice(open + CREATE_SUBTASK_OPEN.length, close).trim();
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
  const prompt = typeof obj.prompt === 'string' ? obj.prompt : '';
  if (!prompt.trim()) return null;
  const executor = obj.executor === 'claude' || obj.executor === 'codex' ? obj.executor : undefined;
  return {
    prompt,
    ...(typeof obj.name === 'string' && obj.name.trim() ? { name: obj.name } : {}),
    ...(typeof obj.workspace === 'string' && obj.workspace.trim() ? { workspace: obj.workspace } : {}),
    ...(executor ? { executor } : {}),
  };
}

/** Remove every create_subtask block from Manager assistant text so the user
 *  sees clean prose, not the raw JSON block. */
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
