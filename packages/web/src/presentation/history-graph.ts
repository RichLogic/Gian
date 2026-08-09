/**
 * Git History — DAG lane assignment for the narrow (280px) panel-3 timeline.
 *
 * The host returns commits in `--topo-order` with full `parents[]` and does
 * NOT compute pixel lanes (git-history proposal §2). This module turns that
 * list into a per-row render model for the slim graph gutter:
 *
 * - at most `MAX_LANES` (4) vertical lanes fit the 38px gutter
 *   (x = 7 / 15 / 23 / 31);
 * - when the visible window needs more parallelism than that (rare: 5+
 *   concurrent branches inside one page), the extra line collapses onto the
 *   last lane as a dashed "overflow" edge — the row's tooltip stays the
 *   authoritative text form, so nothing depends on decoding the picture;
 * - merge commits emit a curve from their node to the lane that picks up the
 *   second parent; a branch's oldest commit emits the return curve back to
 *   the parent's lane;
 * - a root commit terminates its lane (no downward edge), and the newest row
 *   starts it (no upward stub).
 *
 * COLORS follow the branch chain, not the lane index (Air-style): lane 0's
 * first chain is the main line (palette 0, blue); every time a lane is
 * freshly claimed — a merge's second parent, an overflow collapse, a window
 * start — the chain takes the next palette color and keeps it until the lane
 * ends. Segments/curves/nodes all carry the chain's color index.
 *
 * Pure and synchronous — the inspector maps the rows straight to SVG.
 */

export const HISTORY_MAX_LANES = 4;

export interface HistoryGraphCurve {
  fromLane: number;
  toLane: number;
  /** 'down' = from this row's node to `toLane` at the row's bottom edge
   *  (merge fork / branch return); 'up' = from `fromLane` at the top edge
   *  into this row's node (duplicate-lane collapse). */
  dir: 'down' | 'up';
  /** Dashed = collapsed overflow edge (real lane did not fit the gutter). */
  dashed: boolean;
  /** Chain color index (into the inspector's palette). */
  color: number;
}

export interface HistoryGraphSegment {
  lane: number;
  dashed: boolean;
  /** Chain color index (into the inspector's palette). */
  color: number;
}

export interface HistoryGraphRow {
  sha: string;
  /** Lane the commit node sits on. */
  lane: number;
  /** Node's chain color index. */
  color: number;
  /** True when the node had to share a lane it doesn't own (overflow). */
  overflow: boolean;
  /** Lane segments entering the row from above. */
  linesTop: HistoryGraphSegment[];
  /** Lane segments leaving the row at the bottom. */
  linesBottom: HistoryGraphSegment[];
  /** Node-to-lane curves drawn inside this row (merge / branch return). */
  curves: HistoryGraphCurve[];
}

interface LaneInput {
  sha: string;
  parents: string[];
}

export function assignHistoryLanes(commits: LaneInput[]): HistoryGraphRow[] {
  /** Sha expected at each display lane for the next row (null = lane free). */
  const active: Array<string | null> = Array.from({ length: HISTORY_MAX_LANES }, () => null);
  /** Chain color currently occupying each lane (lane 0 starts as main = 0). */
  const laneColor: number[] = Array.from({ length: HISTORY_MAX_LANES }, () => 0);
  /** Next palette index handed to a freshly claimed chain. */
  let nextColor = 1;
  const claimColor = (lane: number): void => { laneColor[lane] = nextColor++; };
  /** Shas a parent edge pointed at when no lane was free — they render on the
   *  last lane with a dashed edge when they arrive. */
  const overflowExpected = new Set<string>();
  /** Lanes currently drawn dashed (their expected sha arrived via overflow). */
  const dashedLane = new Set<number>();
  const rows: HistoryGraphRow[] = [];

  for (const commit of commits) {
    const linesTop = active.flatMap((sha, lane) =>
      sha !== null ? [{ lane, dashed: dashedLane.has(lane), color: laneColor[lane]! }] : []);
    const curves: HistoryGraphCurve[] = [];

    // Home lane: the lane expecting this sha, a free lane, or the overflow
    // collapse onto the last lane.
    let lane = active.indexOf(commit.sha);
    let overflow = false;
    if (lane === -1) {
      const free = active.indexOf(null);
      if (overflowExpected.has(commit.sha)) {
        overflowExpected.delete(commit.sha);
        lane = HISTORY_MAX_LANES - 1;
        overflow = true;
        claimColor(lane);
      } else if (free !== -1) {
        lane = free;
        // A chain no lane was expecting (window start): lane 0 keeps the main
        // color on the first row, everything else claims a fresh one.
        if (!(lane === 0 && rows.length === 0)) claimColor(lane);
      } else {
        lane = HISTORY_MAX_LANES - 1;
        overflow = true;
        claimColor(lane);
      }
    }
    if (overflow) dashedLane.add(lane);

    // A second lane also expecting this sha (both parents of a merge are the
    // same commit, or a lane collision) collapses into the node and frees.
    for (let l = 0; l < HISTORY_MAX_LANES; l++) {
      if (l !== lane && active[l] === commit.sha) {
        curves.push({ fromLane: l, toLane: lane, dir: 'up', dashed: dashedLane.delete(l), color: laneColor[l]! });
        active[l] = null;
      }
    }

    // First parent continues this lane — unless another lane already expects
    // it, in which case the edge bends over and this lane frees.
    const [firstParent, ...extraParents] = commit.parents;
    if (firstParent) {
      const claimed = active.indexOf(firstParent);
      if (claimed !== -1 && claimed !== lane) {
        curves.push({ fromLane: lane, toLane: claimed, dir: 'down', dashed: overflow, color: laneColor[claimed]! });
        active[lane] = null;
        dashedLane.delete(lane);
      } else {
        active[lane] = firstParent;
      }
    } else {
      // Root commit: the lane ends at the node.
      active[lane] = null;
      dashedLane.delete(lane);
    }

    // Extra parents (merge): hand each a free lane with a merge curve, or
    // record it as overflow when the gutter is full.
    for (const parent of extraParents) {
      if (active.includes(parent) || overflowExpected.has(parent)) continue;
      const free = active.indexOf(null);
      if (free !== -1) {
        active[free] = parent;
        claimColor(free);
        curves.push({ fromLane: lane, toLane: free, dir: 'down', dashed: false, color: laneColor[free]! });
      } else {
        overflowExpected.add(parent);
        curves.push({ fromLane: lane, toLane: HISTORY_MAX_LANES - 1, dir: 'down', dashed: true, color: laneColor[lane]! });
      }
    }

    const linesBottom = active.flatMap((sha, l) =>
      sha !== null ? [{ lane: l, dashed: dashedLane.has(l), color: laneColor[l]! }] : []);
    rows.push({ sha: commit.sha, lane, color: laneColor[lane]!, overflow, linesTop, linesBottom, curves });
  }
  return rows;
}
