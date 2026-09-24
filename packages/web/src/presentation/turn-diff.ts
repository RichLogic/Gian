import type { DiffFile, TranscriptItem } from '../types.js';

export interface TurnDiff {
  turn: number;
  files: DiffFile[];
}

/**
 * Aggregate the file changes of the transcript's current/latest turn.
 * Starting a newer turn therefore clears the previous chip immediately; a
 * new chip appears only after that newer turn produces its first diff.
 *
 * The transcript reducer has already replaced repeated snapshots that share
 * one activity id (Codex's cumulative turn diff). Distinct remaining items
 * are separate edit activities, so repeated edits to one path must add their
 * line counts instead of discarding earlier work.
 */
export function projectTurnDiff(items: TranscriptItem[]): TurnDiff | null {
  // Optimistic user echoes use turn=0 until the canonical user_message
  // arrives. They still mark the next turn boundary immediately in the UI.
  if (items.some(item => item.kind === 'user' && item.pending === true)) return null;
  let turn = 0;
  for (const it of items) {
    if (it.turn > turn) turn = it.turn;
  }
  if (!turn) return null;
  const byPath = new Map<string, DiffFile>();
  for (const it of items) {
    if (it.kind !== 'diff' || it.turn !== turn) continue;
    for (const file of it.files) {
      const previous = byPath.get(file.path);
      byPath.set(file.path, previous
        ? {
            ...file,
            add: previous.add + file.add,
            del: previous.del + file.del,
          }
        : file);
    }
  }
  const files = [...byPath.values()];
  return files.length > 0 ? { turn, files } : null;
}

/**
 * Match a raw transcript diff path (Claude's absolute `file_path`, `a/`-`b/`
 * diff prefixes) against the host-normalized changed-file list, so a
 * TurnDiffChip click anchors the right inspector block even when the turn
 * ran in a different worktree than the one being viewed. Mirrors the host's
 * cleanEventPath + suffix fallback (working-trees.ts lastturn scope).
 */
export function matchChangedFilePath(anchorPath: string, paths: string[]): string | null {
  if (paths.includes(anchorPath)) return anchorPath;
  let cleaned = anchorPath.replaceAll('\\', '/');
  if (!cleaned.startsWith('/') && /^(a|b)\//.test(cleaned)) cleaned = cleaned.slice(2);
  return paths.find(path =>
    path === cleaned || cleaned.endsWith(`/${path}`) || path.endsWith(`/${cleaned}`),
  ) ?? null;
}
