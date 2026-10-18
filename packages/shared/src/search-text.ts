/**
 * Pure Markdown and Unicode projection for search. No React and no DOM.
 * Ranges stay UTF-16 offsets into the original projected text.
 */

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { GIAN_ACTION_CLOSE, stripGianActionBlocks, stripGianRolePrefix } from './action.js';
import type { ComposerDocument } from './context.js';
import type { SearchTextRange } from './search.js';

const SNIPPET_RADIUS = 48;

interface MdNode {
  type: string;
  value?: string;
  alt?: string;
  children?: MdNode[];
}

const processor = unified().use(remarkParse).use(remarkGfm).use(remarkMath);

const SKIPPED = new Set(['html', 'definition', 'footnoteDefinition', 'yaml', 'toml']);

const SLOT_RE = /\uE000(\d+)\uE001/g;

/** Visible search text. Drops HTML, link destinations, role headers, and settled action blocks. */
export function projectSearchText(
  markdown: string,
  slots?: ReadonlyMap<number, string>,
): string {
  const withoutRole = stripGianRolePrefix(markdown);
  const source = withoutRole.includes(GIAN_ACTION_CLOSE)
    ? stripGianActionBlocks(withoutRole)
    : withoutRole;
  const tree = processor.parse(source) as MdNode;
  return normalizeSearchProjection(render(tree, slots)).text;
}

/**
 * Visible composer text. Chip labels are plain, without added quotes.
 * Attachment bodies and hover previews are not part of the document.
 * Text segments still use the Markdown projection. No document keeps the legacy path.
 */
export function projectComposerSearchText(document: ComposerDocument): string {
  const slots = new Map<number, string>();
  const source = document.segments.map((segment, index) => {
    if (segment.type === 'text' && !/^[ \t]+$/.test(segment.text)) return segment.text;
    slots.set(index, segment.type === 'text' ? segment.text : segment.label);
    return `\uE000${index}\uE001`;
  }).join('');
  return projectSearchText(source, slots);
}

export function normalizeSearchText(text: string): string {
  return normalizeSearchUnits(text).normalized;
}

export interface LiteralScan {
  ranges: SearchTextRange[];
  /** UTF-16 offset for the next page. Null once this text has no further match. */
  resume: number | null;
}

/** At most `limit` physical UTF-16 matches, starting at a prior resume offset. */
export function scanLiteralRanges(
  text: string,
  query: string,
  options: { from?: number; limit: number },
): LiteralScan {
  const limit = options.limit;
  const from = options.from ?? 0;
  if (!Number.isSafeInteger(limit) || limit <= 0) return { ranges: [], resume: from };
  const needle = normalizeSearchText(query);
  if (!needle) return { ranges: [], resume: null };
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const ranges: SearchTextRange[] = [];
  const window: Array<{ ch: string; start: number; end: number }> = [];
  let floor = from;
  for (const part of segmenter.segment(text)) {
    if (part.index < floor) continue;
    const end = part.index + part.segment.length;
    const folded = part.segment.normalize('NFKC').toLowerCase();
    for (let index = 0; index < folded.length; index += 1) {
      if (part.index < floor) break;
      window.push({ ch: folded[index]!, start: part.index, end });
      if (window.length > needle.length) window.shift();
      if (window.length !== needle.length) continue;
      let matched = true;
      for (let unit = 0; unit < needle.length; unit += 1) {
        if (window[unit]!.ch !== needle[unit]) {
          matched = false;
          break;
        }
      }
      if (!matched) continue;
      const start = window[0]!.start;
      const rangeEnd = window[window.length - 1]!.end;
      window.length = 0;
      if (!pushPhysicalRange(ranges, start, rangeEnd, floor)) continue;
      floor = rangeEnd;
      if (ranges.length >= limit) return { ranges, resume: rangeEnd };
    }
  }
  return { ranges, resume: null };
}

export function findLiteralRanges(text: string, query: string): SearchTextRange[] {
  const haystack = normalizeSearchUnits(text);
  const needle = normalizeSearchText(query);
  if (!needle) return [];
  const ranges: SearchTextRange[] = [];
  let from = 0;
  while (from + needle.length <= haystack.normalized.length) {
    const at = haystack.normalized.indexOf(needle, from);
    if (at < 0) break;
    const start = haystack.spans[at]?.start;
    const end = haystack.spans[at + needle.length - 1]?.end;
    if (start === undefined || end === undefined) break;
    pushPhysicalRange(ranges, start, end);
    from = at + needle.length;
  }
  return ranges;
}

/** Display window. Returned ranges are UTF-16 offsets into `snippet`. */
export function snippetAround(
  text: string,
  ranges: readonly SearchTextRange[],
  radius = SNIPPET_RADIUS,
): { snippet: string; ranges: SearchTextRange[] } {
  if (ranges.length === 0) return { snippet: text.slice(0, radius * 2), ranges: [] };
  const focus = ranges[0]!;
  const sliceStart = Math.max(0, focus.start - radius);
  const sliceEnd = Math.min(text.length, focus.end + radius);
  const snippet = text.slice(sliceStart, sliceEnd);
  const mapped = ranges.flatMap(range => {
    const start = Math.max(range.start, sliceStart) - sliceStart;
    const end = Math.min(range.end, sliceEnd) - sliceStart;
    return end > start ? [{ start, end }] : [];
  });
  return { snippet, ranges: mapped };
}

/** Keep a UTF-16 span only when it starts at or after the previous span and `minStart`. */
function pushPhysicalRange(
  ranges: SearchTextRange[],
  start: number,
  end: number,
  minStart = 0,
): boolean {
  if (end <= start || start < minStart) return false;
  const previous = ranges[ranges.length - 1];
  if (previous && start < previous.end) return false;
  ranges.push({ start, end });
  return true;
}

interface NormalizedUnits {
  normalized: string;
  spans: Array<{ start: number; end: number }>;
}

function normalizeSearchUnits(text: string): NormalizedUnits {
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  let normalized = '';
  const spans: Array<{ start: number; end: number }> = [];
  for (const part of segmenter.segment(text)) {
    const folded = part.segment.normalize('NFKC').toLowerCase();
    const end = part.index + part.segment.length;
    for (let index = 0; index < folded.length; index += 1) {
      normalized += folded[index];
      spans.push({ start: part.index, end });
    }
  }
  return { normalized, spans };
}

export interface SearchProjectionPart {
  text: string;
  /** Code/math source whitespace is content, not Markdown layout. */
  verbatim?: boolean;
}

/** Mapping is opt-in: indexing only needs text, not per-character arrays. */
export function normalizeSearchProjection(parts: readonly SearchProjectionPart[], mapOffsets?: false): { text: string };
export function normalizeSearchProjection(parts: readonly SearchProjectionPart[], mapOffsets: true): {
  text: string;
  rawIndexes: number[];
};
export function normalizeSearchProjection(parts: readonly SearchProjectionPart[], mapOffsets = false): {
  text: string;
  rawIndexes?: number[];
} {
  const raw = parts.map(part => part.text).join('');
  const verbatim: Array<{ start: number; end: number }> = [];
  let offset = 0;
  for (const part of parts) {
    if (part.verbatim && part.text.length > 0) verbatim.push({ start: offset, end: offset + part.text.length });
    offset += part.text.length;
  }
  const start = Math.min(raw.length - raw.trimStart().length, verbatim[0]?.start ?? raw.length);
  const end = Math.max(raw.trimEnd().length, verbatim.at(-1)?.end ?? 0);
  const rawIndexes = mapOffsets ? [] as number[] : undefined;
  let text = '';
  const append = (from: number, to: number) => {
    text += raw.slice(from, to);
    if (rawIndexes) for (let index = from; index < to; index += 1) rawIndexes.push(index);
  };
  let sliceStart = start;
  let protectedIndex = 0;
  let index = raw.indexOf('\n', start);
  while (index >= 0 && index < end) {
    while (verbatim[protectedIndex] && verbatim[protectedIndex]!.end <= index) protectedIndex += 1;
    const protectedRange = verbatim[protectedIndex];
    if (protectedRange && protectedRange.start <= index) {
      index = raw.indexOf('\n', protectedRange.end);
      continue;
    }
    let next = index + 1;
    const boundary = Math.min(end, protectedRange?.start ?? end);
    while (next < boundary && raw[next] === '\n') next += 1;
    if (next - index > 2) {
      append(sliceStart, index + 2);
      sliceStart = next;
    }
    index = raw.indexOf('\n', next);
  }
  append(sliceStart, end);
  return rawIndexes ? { text, rawIndexes } : { text };
}

function joinParts(parts: SearchProjectionPart[][], separator: string): SearchProjectionPart[] {
  return parts.flatMap((part, index) => index === 0 ? part : [{ text: separator }, ...part]);
}

function render(node: MdNode, slots?: ReadonlyMap<number, string>): SearchProjectionPart[] {
  if (SKIPPED.has(node.type)) return [];
  if (node.type === 'text') return [{ text: expandSlots(node.value ?? '', slots) }];
  if (node.type === 'inlineCode' || node.type === 'code'
    || node.type === 'math' || node.type === 'inlineMath') {
    return [{ text: node.value ?? '', verbatim: true }];
  }
  if (node.type === 'image' || node.type === 'imageReference') return [{ text: node.alt ?? '' }];
  if (node.type === 'break' || node.type === 'thematicBreak') return [{ text: '\n' }];
  const children = node.children ?? [];
  const parts = children.map(child => render(child, slots));
  if (node.type === 'tableRow') return joinParts(parts, '\t');
  if (node.type === 'tableCell' || node.type === 'link' || node.type === 'linkReference'
    || node.type === 'paragraph' || node.type === 'heading' || node.type === 'emphasis'
    || node.type === 'strong' || node.type === 'delete') {
    return parts.flat();
  }
  return joinParts(parts.filter(part => part.some(chunk => chunk.text.length > 0)), '\n');
}

function expandSlots(value: string, slots?: ReadonlyMap<number, string>): string {
  if (!slots || !value.includes('\uE000')) return value;
  return value.replace(SLOT_RE, (token, index: string) => slots.get(Number(index)) ?? token);
}
