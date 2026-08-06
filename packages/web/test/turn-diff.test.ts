// projectTurnDiff (underbar "Last turn" diff chip): aggregates the most
// recent change-producing turn, merging per-path last-one-wins so codex's
// turn-cumulative diff.updated events don't double count while claude/kimi
// per-edit events still surface every file.

import { describe, it, expect } from 'vitest';
import { projectTurnDiff } from '../src/presentation/turn-diff.js';
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

  it('per-path last-wins: cumulative events report final numbers (codex shape)', () => {
    const items: TranscriptItem[] = [
      diff('d1', 1, [file('a.ts', 3, 1)]),
      diff('d2', 1, [file('a.ts', 8, 2), file('b.ts', 4, 0)]),
    ];
    const out = projectTurnDiff(items);
    expect(out?.files).toHaveLength(2);
    expect(out?.files.find(f => f.path === 'a.ts')).toMatchObject({ add: 8, del: 2 });
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
});
