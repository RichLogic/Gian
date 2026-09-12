// GFM table repair for model-written markdown.
//
// react-markdown + remark-gfm (micromark) implements the GFM spec strictly,
// and two patterns that models emit constantly are spec-invalid:
//
//  1. A table whose header directly follows a list-item line (`- x` / `1. x`)
//     without a blank line — the header is absorbed into the list item's
//     paragraph, the delimiter row can't interrupt it, and the whole table
//     renders as raw pipe text. Fix: insert a blank line before the header
//     (only when the header sits at column 0 — an indented table already
//     parses as list content).
//  2. A delimiter row (`| --- | --- |`) whose cell count differs from the
//     header row's — GFM requires equality, so the table silently degrades to
//     a paragraph. Fix: pad/trim delimiter cells to the header count.
//     Alignment colons (`:--`, `--:`) on surviving cells are preserved.
//
// Both repairs are fence-aware: nothing inside ``` or ~~~ code blocks is
// touched, and escaped pipes (\|) never count as cell separators.

/** Split a table row into cells, ignoring escaped pipes. Outer pipes are
 *  optional in GFM; leading/trailing empty artifacts are dropped. */
function splitRowCells(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let escaped = false;
  for (const ch of line) {
    if (escaped) {
      current += ch === '|' ? '|' : `\\${ch}`;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '|') {
      cells.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (escaped) current += '\\';
  cells.push(current);
  // Drop the artifacts of leading/trailing pipes.
  if (cells.length > 1 && cells[0]!.trim() === '') cells.shift();
  if (cells.length > 1 && cells[cells.length - 1]!.trim() === '') cells.pop();
  return cells;
}

/** A delimiter cell is only hyphens with optional alignment colons. */
const DELIMITER_CELL_RE = /^:?-+:?:?$/;

/** True when `line` is a GFM delimiter row (every cell is dashes/colons and
 *  the row holds at least one pipe — so a plain `---` hr is never matched). */
function isDelimiterRow(line: string): boolean {
  if (!line.includes('|')) return false;
  const cells = splitRowCells(line);
  return cells.length > 0 && cells.every(cell => DELIMITER_CELL_RE.test(cell.trim()));
}

function isHeaderCandidate(line: string): boolean {
  return line.includes('|') && splitRowCells(line).length > 0;
}

const LIST_ITEM_RE = /^ {0,3}(?:[-*+]|\d{1,9}[.)])\s/;

function countCells(line: string): number {
  return splitRowCells(line).length;
}

/** Rebuild the delimiter row with exactly `target` cells, keeping alignment
 *  colons from the surviving cells and defaulting padded cells to `---`. */
function normalizeDelimiterRow(line: string, target: number): string {
  const cells = splitRowCells(line).map(cell => cell.trim());
  const next: string[] = [];
  for (let i = 0; i < target; i++) {
    next.push(cells[i] ?? '---');
  }
  return `| ${next.join(' | ')} |`;
}

export function normalizeGfmTables(markdown: string): string {
  if (!markdown.includes('|')) return markdown;
  const lines = markdown.split('\n');
  const out: string[] = [];
  let fenceMarker: '```' | '~~~' | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fenceMatch = line.match(/^ {0,3}(```|~~~)/);
    if (fenceMatch) {
      // ``` inside a ~~~ block (and vice versa) does not toggle the fence.
      if (fenceMarker === null) fenceMarker = fenceMatch[1] as '```' | '~~~';
      else if (fenceMarker === fenceMatch[1]) fenceMarker = null;
      out.push(line);
      continue;
    }
    if (fenceMarker !== null) {
      out.push(line);
      continue;
    }

    const next = lines[i + 1];
    if (next !== undefined && isHeaderCandidate(line) && isDelimiterRow(next)) {
      // Repair 2: delimiter/header cell-count mismatch (do this first so a
      // header directly after a list AND a mismatched delimiter both heal).
      const headerCells = countCells(line);
      const delimiterCells = countCells(next);
      const delimiter = delimiterCells === headerCells
        ? next
        : normalizeDelimiterRow(next, headerCells);

      // Repair 1: header glued to a list item at column 0.
      const previous = out.length > 0 ? out[out.length - 1]! : '';
      if (previous !== '' && LIST_ITEM_RE.test(previous) && !line.startsWith(' ')) {
        out.push('');
      }
      out.push(line, delimiter);
      i++; // consume the delimiter line we just emitted
      continue;
    }

    out.push(line);
  }
  return out.join('\n');
}
