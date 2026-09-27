/**
 * Minimal line-based unified diff (LCS) for turning the turn-level file
 * history checkpoints (GET /sessions/{id}/file-history/content with the
 * before/after phases) into a real patch for the outer diff.updated event.
 * Bounded: inputs are clamped so pathological files cannot stall the proxy.
 */

const MAX_DIFF_LINES = 4_000;

interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/** Classic LCS table over a bounded window; falls back to a whole-file
 *  replace when the budget would blow. */
function lcsOps(a: string[], b: string[]): Array<{ kind: 'same' | 'del' | 'add'; line: string }> {
  const budget = 1_500;
  if (a.length > budget || b.length > budget) {
    return [
      ...a.map((line) => ({ kind: 'del' as const, line })),
      ...b.map((line) => ({ kind: 'add' as const, line })),
    ];
  }
  const table: Uint32Array[] = [];
  for (let i = 0; i <= a.length; i += 1) table.push(new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i]![j] = a[i] === b[j]
        ? (table[i + 1]?.[j + 1] ?? 0) + 1
        : Math.max(table[i + 1]?.[j] ?? 0, table[i]?.[j + 1] ?? 0);
    }
  }
  const ops: Array<{ kind: 'same' | 'del' | 'add'; line: string }> = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ kind: 'same', line: a[i]! });
      i += 1;
      j += 1;
    } else if ((table[i + 1]?.[j] ?? 0) >= (table[i]?.[j + 1] ?? 0)) {
      ops.push({ kind: 'del', line: a[i]! });
      i += 1;
    } else {
      ops.push({ kind: 'add', line: b[j]! });
      j += 1;
    }
  }
  while (i < a.length) { ops.push({ kind: 'del', line: a[i]! }); i += 1; }
  while (j < b.length) { ops.push({ kind: 'add', line: b[j]! }); j += 1; }
  return ops;
}

function hunksOf(ops: Array<{ kind: 'same' | 'del' | 'add'; line: string }>): DiffHunk[] {
  const context = 3;
  const hunks: DiffHunk[] = [];
  let index = 0;
  let oldLine = 1;
  let newLine = 1;
  while (index < ops.length) {
    // find the next change
    let scan = index;
    let sinceChange = 0;
    while (scan < ops.length && ops[scan]!.kind === 'same') {
      scan += 1;
      sinceChange += 1;
    }
    if (scan >= ops.length) break;
    // keep up to `context` leading same-lines
    const leadStart = Math.max(index, scan - context);
    for (let k = index; k < leadStart; k += 1) {
      if (ops[k]!.kind === 'same') { oldLine += 1; newLine += 1; }
    }
    index = leadStart;
    const hunk: DiffHunk = { oldStart: oldLine, oldLines: 0, newStart: newLine, newLines: 0, lines: [] };
    sinceChange = 0;
    while (index < ops.length) {
      const op = ops[index]!;
      if (op.kind === 'same') {
        sinceChange += 1;
        if (sinceChange > context * 2) break;
        hunk.lines.push(` ${op.line}`);
        hunk.oldLines += 1;
        hunk.newLines += 1;
        oldLine += 1;
        newLine += 1;
      } else {
        sinceChange = 0;
        if (op.kind === 'del') {
          hunk.lines.push(`-${op.line}`);
          hunk.oldLines += 1;
          oldLine += 1;
        } else {
          hunk.lines.push(`+${op.line}`);
          hunk.newLines += 1;
          newLine += 1;
        }
      }
      index += 1;
    }
    hunks.push(hunk);
  }
  return hunks;
}

/** Render a bounded unified diff for one file; empty string when identical. */
export function renderUnifiedDiff(path: string, before: string, after: string): { diff: string; truncated: boolean } {
  const ops = lcsOps(splitLines(before), splitLines(after));
  if (ops.every((op) => op.kind === 'same')) return { diff: '', truncated: false };
  const parts: string[] = [`--- a/${path}`, `+++ b/${path}`];
  let truncated = false;
  let total = 2;
  for (const hunk of hunksOf(ops)) {
    const header = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
    if (total + hunk.lines.length + 1 > MAX_DIFF_LINES) {
      truncated = true;
      break;
    }
    parts.push(header, ...hunk.lines);
    total += hunk.lines.length + 1;
  }
  if (truncated) parts.push('… patch truncated by the proxy diff budget');
  return { diff: parts.join('\n'), truncated };
}
