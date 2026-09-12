import { describe, it, expect } from 'vitest';
import {
  assignHistoryLanes,
  graphRowWidth,
  graphWidthFor,
} from '../src/presentation/history-graph.js';

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
    expect(m!.curves).toEqual([{ fromLane: 0, toLane: 1, dir: 'down', color: 1 }]);
    expect(b!.linesTop.map(l => l.lane).sort()).toEqual([0, 1]); // lane 1 passes through
    expect(f!.lane).toBe(1);
    expect(f!.curves).toEqual([{ fromLane: 1, toLane: 0, dir: 'down', color: 0 }]);
    expect(c!.linesTop.map(l => l.lane)).toEqual([0]); // lane 1 freed after F
  });

  it('colors follow the chain: main stays palette 0, each fresh branch claims the next', () => {
    // A → M(merge: B,F) → B → F → C — the branch chain on lane 1 keeps its
    // claimed color end to end (segments, fork curve, node).
    const rows = assignHistoryLanes([
      C('A', ['M']),
      C('M', ['B', 'F']),
      C('B', ['C']),
      C('F', ['C']),
      C('C', []),
    ]);
    const [a, m, b, f] = rows;
    expect(a!.color).toBe(0);
    expect(m!.color).toBe(0);
    expect(m!.curves[0]!.color).toBe(1);   // fork curve takes the branch color
    expect(b!.color).toBe(0);
    expect(b!.linesTop.find(l => l.lane === 1)?.color).toBe(1);
    expect(f!.color).toBe(1);
    expect(f!.linesTop.find(l => l.lane === 1)?.color).toBe(1);
    // A second, independent chain claims the next palette slot.
    const rows2 = assignHistoryLanes([
      C('T', []),
      C('x', []),
    ]);
    expect(rows2[1]!.color).toBe(1);
  });

  it('unlimited lanes: a fifth and sixth concurrent chain each get their own lane', () => {
    // T → M1(M2, X, Y, Z, W, V) → M2(A) → A → X → Y → Z → W → V — W needs a
    // 5th lane and V a 6th; both grow the gutter instead of collapsing.
    const rows = assignHistoryLanes([
      C('T', ['M1']),
      C('M1', ['M2', 'X', 'Y', 'Z', 'W', 'V']),
      C('M2', ['A']),
      C('A', []),
      C('X', []),
      C('Y', []),
      C('Z', []),
      C('W', []),
      C('V', []),
    ]);
    const m1 = rows[1]!;
    expect(m1.curves.map(c => c.toLane)).toEqual([1, 2, 3, 4, 5]);
    expect(m1.curves.every(c => c.dir === 'down')).toBe(true);
    expect(rows[4]!.lane).toBe(1); // X
    expect(rows[7]!.lane).toBe(4); // W
    expect(rows[8]!.lane).toBe(5); // V
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

describe('graphRowWidth', () => {
  it('hugs the row\'s own rightmost lane — node, segment, or curve endpoint', () => {
    // A → B → M(merge: C, X, Y, Z) → C → X → Y → Z: the linear rows above the
    // 4-way merge use only lane 0 and stay narrow; only the merge row and the
    // rows where the extra lanes are still alive widen.
    const rows = assignHistoryLanes([
      C('A', ['B']),
      C('B', ['M']),
      C('M', ['C', 'X', 'Y', 'Z']),
      C('C', []),
      C('X', []),
      C('Y', []),
      C('Z', []),
    ]);
    expect(graphWidthFor(0)).toBe(14); // laneX(0) + 7
    expect(graphRowWidth(rows[0]!)).toBe(graphWidthFor(0)); // A: lane 0 only
    expect(graphRowWidth(rows[1]!)).toBe(graphWidthFor(0)); // B: lane 0 only, directly above the merge
    expect(graphRowWidth(rows[2]!)).toBe(graphWidthFor(3)); // M: merge curves reach lane 3
    expect(graphRowWidth(rows[6]!)).toBe(graphWidthFor(3)); // Z sits on lane 3
  });

  it('a lane-0-only row keeps width graphWidthFor(0) regardless of other rows', () => {
    const rows = assignHistoryLanes([
      C('a', ['b']),
      C('b', []),
    ]);
    expect(rows.map(graphRowWidth)).toEqual([graphWidthFor(0), graphWidthFor(0)]);
  });
});
