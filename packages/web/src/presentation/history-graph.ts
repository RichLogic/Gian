/**
 * Git History — DAG lane assignment for the narrow (280px) panel-3 timeline.
 *
 * The host returns commits in `--topo-order` with full `parents[]` and does
 * NOT compute pixel lanes (git-history proposal §2). This module turns that
 * list into a per-row render model for the slim graph gutter:
 *
 * - lanes are unlimited and grow on demand (Air-style): when no existing
 *   lane is free for a new chain, a fresh lane is appended — each row's
 *   gutter width follows the lanes actually drawn in THAT row
 *   (`graphRowWidth`), so the subject text hugs its own dots instead of a
 *   shared gutter sized by the deepest merge anywhere in the list;
 * - merge commits emit a curve from their node to the lane that picks up the
 *   second parent; a branch's oldest commit emits the return curve back to
 *   the parent's lane;
 * - a root commit terminates its lane (no downward edge), and the newest row
 *   starts it (no upward stub).
 *
 * COLORS follow the branch chain, not the lane index (Air-style): lane 0's
 * first chain is the main line (palette 0, blue); every time a lane is
 * freshly claimed — a merge's second parent, a window start — the chain
 * takes the next palette color and keeps it until the lane ends.
 * Segments/curves/nodes all carry the chain's color index.
 *
 * Pure and synchronous — the inspector maps the rows straight to SVG.
 */

export interface HistoryGraphCurve {
  fromLane: number;
  toLane: number;
  /** 'down' = from this row's node to `toLane` at the row's bottom edge
   *  (merge fork / branch return); 'up' = from `fromLane` at the top edge
   *  into this row's node (duplicate-lane collapse). */
  dir: 'down' | 'up';
  /** Chain color index (into the inspector's palette). */
  color: number;
}

export interface HistoryGraphSegment {
  lane: number;
  /** Chain color index (into the inspector's palette). */
  color: number;
}

export interface HistoryGraphRow {
  sha: string;
  /** Lane the commit node sits on. */
  lane: number;
  /** Node's chain color index. */
  color: number;
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

/* ---- graph geometry (lanes grow on demand) ---- */
/** Absolute x of lane `i`'s center — shared by every row, so per-row svg
 *  widths keep the dots column-aligned across the whole list. */
export const laneX = (i: number): number => 7 + i * 8;
/** Right edge of the gutter for a given maximum lane in use. */
export const graphWidthFor = (maxLane: number): number => laneX(maxLane) + 7;
/** Per-row gutter width: the rightmost lane actually drawn in this row
 *  (node, segment, or curve endpoint), so the subject hugs its own dots. */
export function graphRowWidth(row: HistoryGraphRow): number {
  let maxLane = row.lane;
  for (const seg of row.linesTop) maxLane = Math.max(maxLane, seg.lane);
  for (const seg of row.linesBottom) maxLane = Math.max(maxLane, seg.lane);
  for (const curve of row.curves) {
    maxLane = Math.max(maxLane, curve.fromLane, curve.toLane);
  }
  return graphWidthFor(maxLane);
}

export function assignHistoryLanes(commits: LaneInput[]): HistoryGraphRow[] {
  /** Sha expected at each display lane for the next row (null = lane free).
   *  Grows on demand — a fresh lane is appended when none is free. */
  const active: Array<string | null> = [null];
  /** Chain color currently occupying each lane (lane 0 starts as main = 0). */
  const laneColor: number[] = [0];
  /** Next palette index handed to a freshly claimed chain. */
  let nextColor = 1;
  const claimColor = (lane: number): void => { laneColor[lane] = nextColor++; };
  const rows: HistoryGraphRow[] = [];

  for (const commit of commits) {
    const linesTop = active.flatMap((sha, lane) =>
      sha !== null ? [{ lane, color: laneColor[lane]! }] : []);
    const curves: HistoryGraphCurve[] = [];

    // Home lane: the lane expecting this sha, a free lane, or a fresh lane
    // appended at the right edge.
    let lane = active.indexOf(commit.sha);
    if (lane === -1) {
      const free = active.indexOf(null);
      if (free !== -1) {
        lane = free;
        // A chain no lane was expecting (window start): lane 0 keeps the main
        // color on the first row, everything else claims a fresh one.
        if (!(lane === 0 && rows.length === 0)) claimColor(lane);
      } else {
        lane = active.length;
        active.push(null);
        laneColor.push(0);
        claimColor(lane);
      }
    }

    // A second lane also expecting this sha (both parents of a merge are the
    // same commit, or a lane collision) collapses into the node and frees.
    for (let l = 0; l < active.length; l++) {
      if (l !== lane && active[l] === commit.sha) {
        curves.push({ fromLane: l, toLane: lane, dir: 'up', color: laneColor[l]! });
        active[l] = null;
      }
    }

    // First parent continues this lane — unless another lane already expects
    // it, in which case the edge bends over and this lane frees.
    const [firstParent, ...extraParents] = commit.parents;
    if (firstParent) {
      const claimed = active.indexOf(firstParent);
      if (claimed !== -1 && claimed !== lane) {
        curves.push({ fromLane: lane, toLane: claimed, dir: 'down', color: laneColor[claimed]! });
        active[lane] = null;
      } else {
        active[lane] = firstParent;
      }
    } else {
      // Root commit: the lane ends at the node.
      active[lane] = null;
    }

    // Extra parents (merge): hand each a free lane — growing the gutter when
    // none is free — with a merge curve down to it.
    for (const parent of extraParents) {
      if (active.includes(parent)) continue;
      let free = active.indexOf(null);
      if (free === -1) {
        free = active.length;
        active.push(null);
        laneColor.push(0);
      }
      active[free] = parent;
      claimColor(free);
      curves.push({ fromLane: lane, toLane: free, dir: 'down', color: laneColor[free]! });
    }

    const linesBottom = active.flatMap((sha, l) =>
      sha !== null ? [{ lane: l, color: laneColor[l]! }] : []);
    rows.push({ sha: commit.sha, lane, color: laneColor[lane]!, linesTop, linesBottom, curves });
  }
  return rows;
}
