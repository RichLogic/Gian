/**
 * Changes inspector — "attach diff as context".
 *
 * Assembles the CURRENT diff view (the use-changes-diff store's file list +
 * per-file patches for the active scope) into one `pastedText` composer
 * context item and drops it into the session's composer as a chip, next to
 * the existing commit/push prompt actions. The user reviews and sends —
 * nothing is auto-sent.
 *
 * Shape decision: reuse `pastedText` rather than a new context-item variant.
 * The Host enforces MAX_PASTED_TEXT_BYTES (64 KiB) on pastedText at the send
 * boundary, so the 100 KiB file/session-reference budget cannot apply without
 * a protocol change; 64 KiB (~15k tokens) is a sensible diff budget. Larger
 * diffs are cut at a line boundary and end with a `[truncated]` marker (the
 * same marker the Host's file/session reference compile uses). The first line
 * carries an English scope descriptor (`Diff · …`) — it doubles as the chip
 * label (contextReferenceLabel takes the text's flattened head) and tells the
 * model which comparison it is looking at, so it stays English regardless of
 * UI locale.
 */
import { MAX_PASTED_TEXT_BYTES, type PastedTextContextItem } from '@gian/shared';
import type { ChangedEntry } from '../api.js';
import { injectComposerContextItems } from '../components/Composer.js';
import {
  getChangesDiffState,
  loadAllChangesDiffPatches,
  type ChangesDiffPatch,
  type ChangesDiffState,
} from './use-changes-diff.js';

export const DIFF_CONTEXT_TRUNCATED_MARKER = '[truncated]';

/** English, model-facing descriptor of the active comparison, e.g.
 *  "Last turn (turn 3)" or "Branch (vs origin/main)". */
export function changesDiffScopeLabel(
  state: Pick<ChangesDiffState, 'scope' | 'commitSha' | 'baseBranch' | 'branchList' | 'lastTurn'>,
): string {
  switch (state.scope) {
    case 'all': return 'All changes (working tree)';
    case 'unstaged': return 'Unstaged changes';
    case 'staged': return 'Staged changes';
    case 'commit':
      return state.commitSha ? `Commit ${state.commitSha.slice(0, 7)}` : 'Latest commit';
    case 'branch': {
      const base = state.baseBranch ?? state.branchList?.base;
      return base ? `Branch (vs ${base})` : 'Branch';
    }
    case 'lastturn':
      return state.lastTurn ? `Last turn (turn ${state.lastTurn.turn})` : 'Last turn';
  }
}

const encoder = new TextEncoder();
function byteSize(text: string): number {
  return encoder.encode(text).byteLength;
}

export interface AssembledDiffContext {
  text: string;
  truncated: boolean;
  /** Files whose patch could not be loaded (errored); omitted from the body. */
  unavailable: string[];
}

/**
 * Join the loaded per-file patches into one diff document under the
 * pastedText byte budget. File order follows the changed-file list. A file
 * the Host already truncated keeps its body plus an inline marker. When the
 * budget runs out mid-document the current file is cut at a line boundary,
 * the marker is appended, and the remaining files are dropped. Returns null
 * when no file contributes any diff text (empty scope or every load failed).
 */
export function assembleChangesDiffContextText(
  scopeLabel: string,
  files: ChangedEntry[],
  patches: Record<string, ChangesDiffPatch | undefined>,
): AssembledDiffContext | null {
  const header = `Diff · ${scopeLabel}\n\n`;
  const sections: string[] = [];
  const unavailable: string[] = [];
  for (const file of files) {
    const patch = patches[file.path];
    if (patch?.status === 'error' || !patch || patch.status !== 'loaded') {
      if (patch?.status === 'error') unavailable.push(file.path);
      continue;
    }
    const diff = (patch.diff ?? '').replace(/\n+$/, '');
    if (diff.length === 0) continue;
    sections.push(patch.truncated ? `${diff}\n${DIFF_CONTEXT_TRUNCATED_MARKER}` : diff);
  }
  if (sections.length === 0) return null;

  // Reserve room for the header and a possible trailing marker line.
  const budget = MAX_PASTED_TEXT_BYTES - byteSize(header) - DIFF_CONTEXT_TRUNCATED_MARKER.length - 2;
  const kept: string[] = [];
  let used = 0;
  let truncated = false;
  for (const section of sections) {
    const cost = byteSize(section) + (kept.length > 0 ? 2 : 0); // '\n\n' join
    if (used + cost <= budget) {
      kept.push(section);
      used += cost;
      continue;
    }
    // Cut this section at a line boundary so the cut can never split a
    // multi-byte UTF-8 sequence; later sections are dropped entirely.
    const lines: string[] = [];
    let lineBytes = 0;
    for (const line of section.split('\n')) {
      const lineCost = byteSize(line) + (lines.length > 0 ? 1 : 0);
      if (used + (kept.length > 0 ? 2 : 0) + lineBytes + lineCost > budget) break;
      lines.push(line);
      lineBytes += lineCost;
    }
    if (lines.length > 0) kept.push(lines.join('\n'));
    truncated = true;
    break;
  }
  if (kept.length === 0) return null;
  let text = header + kept.join('\n\n');
  if (truncated) text += `\n${DIFF_CONTEXT_TRUNCATED_MARKER}`;
  return { text, truncated, unavailable };
}

export type AttachDiffResult = 'attached' | 'empty' | 'full' | 'stale';

/**
 * Load any missing per-file patches for the current scope, assemble the diff
 * document and inject it as one pastedText context chip into `sessionId`'s
 * composer. Returns:
 *  - 'attached'  chip injected
 *  - 'empty'     nothing to attach (no files or no diff text)
 *  - 'full'      the draft already holds MAX_MESSAGE_CONTEXT_ITEMS chips
 *  - 'stale'     the scope changed while patches loaded — nothing injected
 */
export async function attachChangesDiffContext(
  workingTreeId: string,
  sessionId: string,
): Promise<AttachDiffResult> {
  const scopeSettled = await loadAllChangesDiffPatches(workingTreeId, sessionId);
  if (!scopeSettled) return 'stale';
  const state = getChangesDiffState(workingTreeId, sessionId);
  const assembled = assembleChangesDiffContextText(
    changesDiffScopeLabel(state),
    state.files,
    state.patches,
  );
  if (!assembled) return 'empty';
  const item: PastedTextContextItem = {
    type: 'pastedText',
    id: crypto.randomUUID(),
    text: assembled.text,
    lineCount: assembled.text.split('\n').length,
    byteSize: byteSize(assembled.text),
  };
  return injectComposerContextItems(sessionId, [item]) ? 'attached' : 'full';
}
