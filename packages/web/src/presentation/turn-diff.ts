import type { DiffFile, TranscriptItem } from '../types.js';

export interface TurnDiff {
  turn: number;
  files: DiffFile[];
}

/**
 * Aggregate the file changes of the most recent turn that produced any —
 * the data behind the underbar "Last turn" diff chip.
 *
 * Multiple diff items per turn merge by path, LAST ONE WINS. Codex re-emits
 * the turn-cumulative unified diff on every `diff.updated`, so the last
 * event already carries the final per-file numbers (summing would double
 * count); claude/kimi emit one event per edit, where per-path last-wins
 * still surfaces every touched file.
 */
export function projectTurnDiff(items: TranscriptItem[]): TurnDiff | null {
  let turn = 0;
  for (const it of items) {
    if (it.kind === 'diff' && it.turn > turn) turn = it.turn;
  }
  if (!turn) return null;
  const byPath = new Map<string, DiffFile>();
  for (const it of items) {
    if (it.kind !== 'diff' || it.turn !== turn) continue;
    for (const f of it.files) byPath.set(f.path, f);
  }
  return { turn, files: [...byPath.values()] };
}
