// projectTurnDiff (underbar "Last turn" diff chip): aggregates the most
// current/latest transcript turn. Codex's cumulative snapshot is already
// upserted by activity id; distinct Claude/Kimi edits add by path.

import { describe, it, expect } from 'vitest';
import { matchChangedFilePath, projectTurnDiff } from '../src/presentation/turn-diff.js';
import type { DiffFile, DiffItem, TranscriptItem } from '../src/types.js';

function file(path: string, add: number, del: number): DiffFile {
  return { path, add, del, hunks: [] };
}

function diff(id: string, turn: number, files: DiffFile[]): DiffItem {
  return { kind: 'diff', id, files, ts: turn * 1000, turn };
}

function user(id: string): TranscriptItem {
  return { kind: 'user', id, text: 'hi', ts: 0, turn: 1 } as TranscriptItem;
}

describe('projectTurnDiff', () => {
  it('returns null when no turn produced a diff', () => {
    expect(projectTurnDiff([])).toBeNull();
    expect(projectTurnDiff([user('u1')])).toBeNull();
  });

  it('collects every file of a multi-event turn (claude/kimi shape)', () => {
    const items: TranscriptItem[] = [
      diff('d1', 1, [file('a.ts', 3, 1)]),
      diff('d2', 1, [file('b.ts', 5, 0)]),
    ];
    const out = projectTurnDiff(items);
    expect(out?.turn).toBe(1);
    expect(out?.files.map(f => f.path).sort()).toEqual(['a.ts', 'b.ts']);
  });

  it('uses the current cumulative Codex snapshot without double counting it', () => {
    const items: TranscriptItem[] = [
      diff('codex-turn-diff', 1, [file('a.ts', 8, 2), file('b.ts', 4, 0)]),
    ];
    const out = projectTurnDiff(items);
    expect(out?.files).toHaveLength(2);
    expect(out?.files.find(f => f.path === 'a.ts')).toMatchObject({ add: 8, del: 2 });
  });

  it('adds distinct edit activities that touch the same path', () => {
    const items: TranscriptItem[] = [
      diff('edit-1', 1, [file('a.ts', 3, 1)]),
      diff('edit-2', 1, [file('a.ts', 5, 2)]),
    ];
    expect(projectTurnDiff(items)?.files).toEqual([file('a.ts', 8, 3)]);
  });

  it('uses the most recent turn that produced a diff', () => {
    const items: TranscriptItem[] = [
      diff('d1', 1, [file('old.ts', 1, 1)]),
      diff('d2', 2, [file('new.ts', 2, 2)]),
    ];
    const out = projectTurnDiff(items);
    expect(out?.turn).toBe(2);
    expect(out?.files.map(f => f.path)).toEqual(['new.ts']);
  });

  it('clears the previous diff as soon as a newer turn starts', () => {
    const items: TranscriptItem[] = [
      diff('d1', 1, [file('old.ts', 1, 1)]),
      { kind: 'user', id: 'u2', text: 'Next turn', ts: 2000, turn: 2 },
    ];
    expect(projectTurnDiff(items)).toBeNull();
  });

  it('clears immediately for an optimistic next-turn user echo', () => {
    const items: TranscriptItem[] = [
      diff('d1', 1, [file('old.ts', 1, 1)]),
      {
        kind: 'user', id: 'pending', text: 'Next turn', ts: 2000, turn: 0,
        pending: true,
      },
    ];
    expect(projectTurnDiff(items)).toBeNull();
  });
});

// TurnDiffChip sends the RAW transcript path (absolute for Claude, possibly
// `a/`-`b/` prefixed for diff-derived cards) while the Changes inspector
// list carries host-normalized paths; the anchor must still resolve.
describe('matchChangedFilePath', () => {
  const paths = ['src/app.ts', 'docs/new.md'];

  it('matches exact paths', () => {
    expect(matchChangedFilePath('src/app.ts', paths)).toBe('src/app.ts');
  });

  it('matches an absolute transcript path against the normalized list path', () => {
    expect(matchChangedFilePath('/repo/task-worktree/src/app.ts', paths)).toBe('src/app.ts');
  });

  it('matches an absolute path whose file lived in a deleted worktree', () => {
    // The host keeps unmappable entries under their absolute path.
    expect(matchChangedFilePath('/repo/gone/out.txt', ['/repo/gone/out.txt'])).toBe('/repo/gone/out.txt');
  });

  it('strips a/ b/ diff prefixes', () => {
    expect(matchChangedFilePath('b/docs/new.md', paths)).toBe('docs/new.md');
    expect(matchChangedFilePath('a/src/app.ts', paths)).toBe('src/app.ts');
  });

  it('matches when the list path is longer than the chip path', () => {
    expect(matchChangedFilePath('app.ts', paths)).toBe('src/app.ts');
  });

  it('returns null when nothing matches', () => {
    expect(matchChangedFilePath('other/thing.ts', paths)).toBeNull();
  });
});
