/**
 * Canonical-projection → DOM mapping for conversation find (Issue #168 /
 * 0.6.7). The Host find API returns UTF-16 ranges into the SHARED projected
 * search text (projectSearchText / projectComposerSearchText). This module
 * aligns one rendered message with that projection and maps ranges onto DOM
 * Ranges — never by occurrence guessing, never onto invisible nodes.
 *
 * Alignment walks the message DOM with the projection's own separator rules
 * (block '\n', table cells '\t' within a row, rows '\n', hard break '\n'),
 * requires EXACT text equality at every step, and treats constructs whose
 * projection text is not inline-visible DOM text as ATOMIC visible elements:
 * math (`.katex` — the projection carries the TeX source, the visible
 * element gets the highlight as a whole) and images (alt text is indexed,
 * the `<img>` itself is the visible anchor). Copy buttons, hidden previews,
 * aria-hidden and control content are excluded; inline reference chips keep
 * their visible label. Any mismatch fails the whole message (null) — the
 * caller re-queries instead of highlighting a guess.
 */
import type { SearchTextRange } from '@gian/shared';
import { normalizeSearchProjection } from '@gian/shared';

export interface DomTextSpan {
  kind: 'text';
  node: Text;
  projStart: number;
  projEnd: number;
  /**
   * Node offset of each kept projection character, parallel to
   * `[projStart, projEnd)`. Leading trim and collapsed newline runs move
   * this off zero; a gap inside the node is recorded instead of assuming
   * the projection is a prefix.
   */
  nodeOffsets: number[];
}

export interface DomAtomicSpan {
  kind: 'atomic';
  element: HTMLElement;
  projStart: number;
  projEnd: number;
}

export type DomSpan = DomTextSpan | DomAtomicSpan;

export interface MessageAlignment {
  /** The projection text exactly as aligned (equals the input). */
  text: string;
  spans: DomSpan[];
}

const EXCLUDED = 'button:not(.message-inline-reference), [role="button"]:not(.message-inline-reference), [aria-hidden="true"], [hidden], script, style, svg';
const BLOCK = 'p, pre, li, td, th, h1, h2, h3, h4, h5, h6, blockquote';
const CELL = 'td, th';

type Segment =
  | { kind: 'text'; node: Text; text: string; pre: HTMLElement | null; verbatim: boolean }
  | { kind: 'sep'; text: string }
  | { kind: 'atomic'; element: HTMLElement; text: string };

function collectSegments(message: HTMLElement): Segment[] {
  const segments: Segment[] = [];
  const walker = document.createTreeWalker(message, NodeFilter.SHOW_ALL);
  let previousBlock: Element | null = null;
  let previousCell: Element | null = null;
  let skipWithin: HTMLElement | null = null;

  /** Separator ahead of content in `block`/`cell`, from the PREVIOUS content's
   *  boundaries — cells in one row use '\t', anything else structural '\n'. */
  const boundary = (block: Element, cell: Element | null): void => {
    if (cell) {
      if (previousCell && previousCell !== cell) {
        segments.push({ kind: 'sep', text: previousCell.parentElement === cell.parentElement ? '\t' : '\n' });
      } else if (!previousCell && previousBlock) {
        segments.push({ kind: 'sep', text: '\n' });
      }
      previousCell = cell;
      previousBlock = block;
      return;
    }
    if (previousBlock && previousBlock !== block) segments.push({ kind: 'sep', text: '\n' });
    previousCell = null;
    previousBlock = block;
  };

  while (walker.nextNode()) {
    const current = walker.currentNode;
    if (skipWithin) {
      if (skipWithin.contains(current)) continue;
      skipWithin = null;
    }
    if (current instanceof HTMLElement) {
      if (current.closest(EXCLUDED)) continue;
      if (current.classList.contains('katex')) {
        // The projection carries the TeX source once; the visible element is
        // the atomic highlight anchor. Boundaries update like any content.
        const source = current.querySelector('.katex-mathml annotation')?.textContent ?? '';
        const cell = current.closest(CELL);
        boundary(current.closest(BLOCK) ?? message, cell);
        if (source) segments.push({ kind: 'atomic', element: current, text: source });
        skipWithin = current;
        continue;
      }
      if (current.tagName === 'IMG') {
        const alt = current.getAttribute('alt') ?? '';
        const cell = current.closest(CELL);
        boundary(current.closest(BLOCK) ?? message, cell);
        if (alt) segments.push({ kind: 'atomic', element: current, text: alt });
        continue;
      }
      if (current.tagName === 'BR') {
        segments.push({ kind: 'sep', text: '\n' });
        previousBlock = null;
        previousCell = null;
        continue;
      }
      continue;
    }
    const node = current as Text;
    if (!node.data || node.parentElement?.closest(EXCLUDED)) continue;
    const parent = node.parentElement;
    const cell = parent?.closest(CELL) ?? null;
    const block = parent?.closest(BLOCK) ?? message;
    boundary(block, cell);
    segments.push({
      kind: 'text', node, text: node.data,
      pre: parent?.closest('pre') ?? null,
      verbatim: !!parent?.closest('code'),
    });
  }
  // The projection is trimmed — trailing separators have no counterpart.
  while (segments.length > 0 && segments[segments.length - 1]!.kind === 'sep') segments.pop();
  // Structural renderer whitespace: react-markdown keeps ONE trailing
  // newline inside <pre> that mdast code.value does not carry. Strip it
  // from the LAST text node of each <pre> (a syntax-highlighted code may
  // make that node a lone '\n' — it drops out entirely). The user's own
  // trailing blank lines inside the fence stay intact.
  const lastPreText = new Map<HTMLElement, number>();
  segments.forEach((segment, index) => {
    if (segment.kind === 'text' && segment.pre) lastPreText.set(segment.pre, index);
  });
  for (const index of lastPreText.values()) {
    const segment = segments[index]!;
    if (segment.kind !== 'text' || !segment.text.endsWith('\n')) continue;
    segment.text = segment.text.slice(0, -1);
  }
  return segments.filter(segment => segment.kind !== 'text' || segment.text !== '');
}

/** Align the rendered message with its canonical projection. Null when the
 *  normalized DOM text disagrees — the caller must NOT fall back to guessed
 *  offsets. Renderer structural whitespace (the <pre> trailing newline) is
 *  normalized at segment collection. The projection's own final newline
 *  layout normalization is then applied without trimming code content.
 *  Surviving characters map back to
 *  the DOM nodes that produced them. Boundary spaces the projection drops
 *  (composer caret space, leading whitespace slots) do not shift interior
 *  offsets. */
export function alignMessageToProjection(
  message: HTMLElement,
  projected: string,
): MessageAlignment | null {
  const segments = collectSegments(message);
  let raw = '';
  const pieces: Array<Segment & { rawStart: number }> = [];
  for (const segment of segments) {
    pieces.push({ ...segment, rawStart: raw.length });
    raw += segment.text;
  }
  const normalized = normalizeSearchProjection(segments.map(segment => ({
    text: segment.text,
    verbatim: segment.kind === 'atomic'
      ? segment.element.classList.contains('katex')
      : segment.kind === 'text' && segment.verbatim,
  })), true);
  if (normalized.text !== projected) return null;
  const normAtRaw = new Array<number>(raw.length).fill(-1);
  normalized.rawIndexes.forEach((rawIndex, normIndex) => {
    normAtRaw[rawIndex] = normIndex;
  });
  const spans: DomSpan[] = [];
  for (const piece of pieces) {
    if (piece.kind === 'sep') continue;
    let projStart = -1;
    const nodeOffsets: number[] = [];
    for (let offset = 0; offset < piece.text.length; offset += 1) {
      const norm = normAtRaw[piece.rawStart + offset] ?? -1;
      if (norm < 0) continue;
      if (projStart < 0) projStart = norm;
      nodeOffsets.push(offset);
    }
    if (projStart < 0) continue;
    const projEnd = projStart + nodeOffsets.length;
    if (piece.kind === 'text') {
      spans.push({
        kind: 'text',
        node: piece.node,
        projStart,
        projEnd,
        nodeOffsets,
      });
    } else {
      spans.push({
        kind: 'atomic',
        element: piece.element,
        projStart,
        projEnd,
      });
    }
  }
  return { text: projected, spans };
}

export interface MappedRange {
  range: Range;
  /** Set when the hit resolves to an atomic visible element (math, image) —
   *  the caller renders its own explicit visible marker for it. */
  atomicElement?: HTMLElement;
}

/** Map one canonical projection range onto a DOM Range. An atomic span hit
 *  selects the whole visible element; a partial atomic overlap is
 *  unmappable (null). */
export function rangeForProjectionRange(
  spans: DomSpan[],
  range: SearchTextRange,
): MappedRange | null {
  for (const span of spans) {
    if (span.kind !== 'atomic') continue;
    if (range.start >= span.projStart && range.end <= span.projEnd) {
      const domRange = document.createRange();
      domRange.selectNode(span.element);
      return { range: domRange, atomicElement: span.element };
    }
    if (range.start < span.projEnd && range.end > span.projStart) return null;
  }
  const first = spans.find((span): span is DomTextSpan =>
    span.kind === 'text' && span.projStart <= range.start && range.start < span.projEnd);
  const last = spans.find((span): span is DomTextSpan =>
    span.kind === 'text' && span.projStart <= range.end - 1 && range.end - 1 < span.projEnd);
  if (!first || !last) return null;
  const startOffset = first.nodeOffsets[range.start - first.projStart];
  const endOffset = last.nodeOffsets[range.end - 1 - last.projStart];
  if (startOffset === undefined || endOffset === undefined) return null;
  const domRange = document.createRange();
  domRange.setStart(first.node, startOffset);
  domRange.setEnd(last.node, endOffset + 1);
  return { range: domRange };
}

/** Center a match range in the transcript scroller without disturbing the
 *  React tree. */
export function revealTranscriptMatch(root: HTMLElement, match: Range): void {
  const scroller = root.closest<HTMLElement>('.main-scroll');
  const rect = match.getBoundingClientRect();
  if (scroller && rect.height > 0) {
    scroller.scrollTop += rect.top - scroller.getBoundingClientRect().top
      - scroller.clientHeight / 2 + rect.height / 2;
  } else {
    match.startContainer.parentElement?.scrollIntoView({ block: 'center' });
  }
}
