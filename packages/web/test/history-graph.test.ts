import { describe, it, expect } from 'vitest';
import { assignHistoryLanes } from '../src/presentation/history-graph.js';

const C = (sha: string, parents: string[] = []) => ({ sha, parents });

describe('assignHistoryLanes', () => {
  it('linear history: single lane, tip has nothing above, root nothing below', () => {
    const rows = assignHistoryLanes([
      C('a', ['b']),
      C('b', ['c']),
      C('c', []),
    ]);
    expect(rows.map(r => r.lane)).toEqual([0, 0, 0]);
    expect(rows[0]!.linesTop).toEqual([]);            // tip: no stub above
    expect(rows[0]!.linesBottom.map(l => l.lane)).toEqual([0]);
    expect(rows[1]!.linesTop.map(l => l.lane)).toEqual([0]);
    expect(rows[2]!.linesBottom).toEqual([]);          // root: lane ends
    expect(rows.every(r => r.curves.length === 0)).toBe(true);
  });

  it('merge: second parent gets lane 1 with a down-curve; branch base returns to lane 0', () => {
    // A → M(merge: B,F) → B → F → C  (F's first parent C is already on lane 0)
    const rows = assignHistoryLanes([
      C('A', ['M']),
      C('M', ['B', 'F']),
      C('B', ['C']),
      C('F', ['C']),
      C('C', []),
    ]);
    const [a, m, b, f, c] = rows;
    expect(a!.lane).toBe(0);
    expect(m!.lane).toBe(0);
    expect(m!.curves).toEqual([{ fromLane: 0, toLane: 1, dir: 'down', dashed: false }]);
    expect(b!.linesTop.map(l => l.lane).sort()).toEqual([0, 1]); // lane 1 passes through
    expect(f!.lane).toBe(1);
    expect(f!.curves).toEqual([{ fromLane: 1, toLane: 0, dir: 'down', dashed: false }]);
    expect(c!.linesTop.map(l => l.lane)).toEqual([0]); // lane 1 freed after F
  });

  it('overflow: a third concurrent parent collapses onto the last lane, dashed', () => {
    // T → M1(M2, X) → M2(A, Y) → A → X → Y  — Y needs a third lane
    const rows = assignHistoryLanes([
      C('T', ['M1']),
      C('M1', ['M2', 'X']),
      C('M2', ['A', 'Y']),
      C('A', []),
      C('X', []),
      C('Y', []),
    ]);
    const m2 = rows[2]!;
    expect(m2.curves.some(c => c.dashed && c.toLane === 1)).toBe(true);
    const y = rows[5]!;
    expect(y.overflow).toBe(true);
    expect(y.lane).toBe(1);
  });

  it('a commit expected on two lanes collapses the duplicate into its node', () => {
    // Both parents of the merge are the same commit (degenerate but legal).
    const rows = assignHistoryLanes([
      C('M', ['B', 'B']),
      C('B', []),
    ]);
    // extra parent 'B' is already tracked on lane 0 → no second lane claimed
    expect(rows[0]!.curves).toEqual([]);
    expect(rows[1]!.lane).toBe(0);
  });

  it('paged windows: a commit whose child is not loaded just starts a lane', () => {
    const rows = assignHistoryLanes([C('x', ['y']), C('y', ['z'])]);
    expect(rows[0]!.linesTop).toEqual([]);
    expect(rows[1]!.linesBottom.map(l => l.lane)).toEqual([0]); // z expected below
  });
});
