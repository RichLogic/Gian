import { isValidElement, useContext, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeHighlight from 'rehype-highlight';
import { useChatUiT } from './i18n.js';
import { normalizeGfmTables } from './markdown-tables.js';
import { MermaidDiagram, looksLikeMermaid } from './markdown-mermaid.js';
import { CopyButton } from './copy-button.js';
import { LinkAnchor } from './links/LinkAnchor.js';
import { FileRefRehypeContext } from './contexts.js';

// FileLink moved to links/file-link.tsx; re-exported here so existing
// import paths (`markdown.js`, `items.js`) keep working.
export { FileLink } from './links/file-link.js';

/** Recursively flatten a React node tree to its text — used to recover the raw
 *  source of a fenced code block for its copy button. */
function reactNodeText(node: React.ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(reactNodeText).join('');
  if (isValidElement(node)) return reactNodeText((node.props as { children?: React.ReactNode }).children);
  return '';
}

/** Custom <code> for rendered markdown: intercepts fenced blocks tagged
 *  `mermaid` and swaps in the diagram renderer (inline code never carries a
 *  `language-*` class, so it always falls through to a plain <code>).
 *  Everything else renders unchanged — syntax highlighting comes from
 *  rehype-highlight spans already inside `children`. */
function MarkdownCode(props: {
  node?: unknown;
  className?: string;
  children?: React.ReactNode;
}) {
  const { className, children } = props;
  const lang = /(?:^|\s)language-([\w+-]+)/.exec(className ?? '')?.[1];
  if (lang === 'mermaid') {
    return <MermaidDiagram source={reactNodeText(children).replace(/\n+$/, '')} />;
  }
  return <code className={className}>{children}</code>;
}

/** Decides whether a fenced block is a mermaid diagram, and if so how it
 *  renders. Returns the diagram source plus `tagged`: a tagged
 *  (`language-mermaid`) block renders through its `code` element child (the
 *  MarkdownCode override swaps in the diagram), while a bare fence sniffed
 *  by keyword has no marker and needs the diagram element created here.
 *  Note the child is the not-yet-executed `code` component element, so the
 *  language is read off its props. */
function mermaidBlockOf(
  children: React.ReactNode,
  code: string,
): { source: string; tagged: boolean } | null {
  const child = (
    (Array.isArray(children) ? children : [children]).find(isValidElement) as
      | React.ReactElement<{ className?: string }>
      | undefined
  ) ?? null;
  if (!child || code.length === 0) return null;
  const className = typeof child.props.className === 'string' ? child.props.className : '';
  const lang = /(?:^|\s)language-([\w+-]+)/.exec(className)?.[1];
  if (lang === 'mermaid') return { source: code, tagged: true };
  if (!className && looksLikeMermaid(code)) return { source: code, tagged: false };
  return null;
}

/** Custom <pre> for rendered markdown: wraps the code block so a copy button can
 *  pin to its top-right (the <pre> itself scrolls horizontally, so the button
 *  rides the non-scrolling wrapper). Mermaid blocks render as diagrams; the
 *  wrapper stays so the copy button still copies the diagram source. */
function MarkdownPre({ children }: { node?: unknown; children?: React.ReactNode }) {
  const t = useChatUiT();
  const code = reactNodeText(children).replace(/\n+$/, '');
  const mermaid = mermaidBlockOf(children, code);
  if (mermaid) {
    return (
      <div className="code-block mermaid-block">
        <CopyButton text={mermaid.source} title={t('transcript.copyCode')} className="code-copy" />
        {mermaid.tagged ? children : <MermaidDiagram source={mermaid.source} />}
      </div>
    );
  }
  return (
    <div className="code-block">
      {code.length > 0 && <CopyButton text={code} title={t('transcript.copyCode')} className="code-copy" />}
      <pre>{children}</pre>
    </div>
  );
}

/** Custom <table> for rendered markdown: wraps the table in a horizontally
 *  scrolling container so a wide table scrolls on its own (touch-friendly on
 *  narrow viewports) instead of widening the whole transcript. */
function MarkdownTable({ children }: { node?: unknown; children?: React.ReactNode }) {
  return (
    <div className="md-table-scroll">
      <table>{children}</table>
    </div>
  );
}

interface MarkdownBoundaryNode {
  type: string;
  value?: string;
  children?: MarkdownBoundaryNode[];
}

/**
 * mdast-util-to-hast pretty-prints `\n` whitespace text nodes between block
 * children (`<ol>\n<li>…</li>\n</ol>\n<p>…`). Under normal white-space
 * (assistant bubbles) they collapse away, but the user bubble is pre-wrap, so
 * each renders as a phantom empty line around lists, quotes and tables. Drop
 * them where HTML whitespace is semantically insignificant — block containers
 * only. Inline contexts (`p`, cells, code) keep every whitespace node: a
 * whitespace-only run between inline elements is a real space or soft break.
 */
const INSIGNIFICANT_WHITESPACE_PARENTS = new Set([
  'ul', 'ol', 'li', 'blockquote', 'dl', 'table', 'thead', 'tbody', 'tfoot', 'tr',
]);

function rehypeTightBlockWhitespace() {
  const visit = (node: MarkdownBoundaryNode, blockParent: boolean) => {
    if (!node.children) return;
    if (blockParent) {
      node.children = node.children.filter(child =>
        child.type !== 'text' || !child.value?.includes('\n') || child.value.trim() !== '');
    }
    for (const child of node.children) {
      visit(child, child.type === 'element'
        && INSIGNIFICANT_WHITESPACE_PARENTS.has((child as { tagName?: string }).tagName ?? ''));
    }
  };
  return (tree: MarkdownBoundaryNode) => visit(tree, true);
}

function remarkBoundarySpaces({ source }: { source: string }) {
  return (tree: unknown) => {
    const blocks = (tree as MarkdownBoundaryNode).children ?? [];
    for (const edge of ['start', 'end'] as const) {
      const block = edge === 'start' ? blocks[0] : blocks.at(-1);
      // Preserve paragraph boundaries without changing indented/fenced code,
      // lists or headings into plain text.
      if (block?.type !== 'paragraph' || !block.children) continue;
      const pattern = edge === 'start' ? /^[ \t]+/ : /[ \t]+$/;
      const expected = pattern.exec(source)?.[0] ?? '';
      if (!expected) continue;
      const text = edge === 'start' ? block.children[0] : block.children.at(-1);
      const present = text?.type === 'text' ? pattern.exec(text.value ?? '')?.[0] ?? '' : '';
      if (present.length >= expected.length) continue;
      const node = { type: 'text', value: expected.slice(present.length) };
      if (edge === 'start') block.children.unshift(node);
      else block.children.push(node);
    }
  };
}

/**
 * Inline slot placeholders let a caller splice interactive React widgets INTO
 * the markdown flow. The token (private-use chars, so it parses as plain
 * text) marks a widget's position inside the source; the rehype pass swaps
 * each token for an <md-slot> element carrying the widget index as its text
 * child, and the components map hands the index to `renderSlot`. Because the
 * whole source parses as one document, block constructs (lists, headings,
 * quotes) that span a widget stay intact instead of splitting at the widget
 * boundary. Tokens inside code/pre stay literal.
 */
const SLOT_TOKEN_RE = /\uE000(\d+)\uE001/g;

export function inlineSlotToken(index: number): string {
  return `\uE000${index}\uE001`;
}

interface SlotTreeNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: SlotTreeNode[];
}

function rehypeInlineSlots() {
  const visit = (node: SlotTreeNode, skip: boolean) => {
    if (!node.children) return;
    const skipHere = skip || (node.type === 'element' && (node.tagName === 'pre' || node.tagName === 'code'));
    const next: SlotTreeNode[] = [];
    for (const child of node.children) {
      if (!skipHere && child.type === 'text' && child.value?.includes('\uE000')) {
        SLOT_TOKEN_RE.lastIndex = 0;
        let cursor = 0;
        let match: RegExpExecArray | null;
        while ((match = SLOT_TOKEN_RE.exec(child.value))) {
          if (match.index > cursor) next.push({ type: 'text', value: child.value.slice(cursor, match.index) });
          next.push({ type: 'element', tagName: 'md-slot', properties: {}, children: [{ type: 'text', value: match[1] ?? '0' }] });
          cursor = match.index + match[0].length;
        }
        if (cursor < child.value.length) next.push({ type: 'text', value: child.value.slice(cursor) });
      } else {
        next.push(child);
      }
    }
    node.children = next;
    for (const child of node.children) visit(child, skipHere);
  };
  return (tree: SlotTreeNode) => visit(tree, false);
}

export function MarkdownText({ children, preserveBoundarySpaces = false, renderSlot }: {
  children: string;
  preserveBoundarySpaces?: boolean;
  /** Renders inline slot tokens (see inlineSlotToken) as widgets spliced into
   *  the markdown flow; the slot element's text child carries the index. */
  renderSlot?: (index: number) => React.ReactNode;
}) {
  const makeRehype = useContext(FileRefRehypeContext);
  const rehypePlugins = useMemo(
    () => [
      rehypeTightBlockWhitespace,
      rehypeKatex,
      // Tagged languages only (`detect: false`); mermaid stays unhighlighted
      // so the `code` override sees the raw diagram source.
      [rehypeHighlight, { detect: false, plainText: ['mermaid'] }],
      ...(makeRehype ? [makeRehype] : []),
      ...(renderSlot ? [rehypeInlineSlots] : []),
    ],
    [makeRehype, renderSlot],
  );
  // Repair spec-invalid table patterns models emit constantly (header glued
  // to a list item, delimiter/header cell-count mismatch) before remark sees
  // them — otherwise the table silently renders as raw pipe text.
  const source = useMemo(() => normalizeGfmTables(children), [children]);
  // The components object (and the md-slot closure) must keep a stable
  // identity across renders — a fresh component type would make React
  // unmount/remount every chip subtree, detaching the very DOM nodes the
  // chip hover/click handlers and popover anchors point at.
  const components = useMemo(() => ({
    a: LinkAnchor as never,
    pre: MarkdownPre as never,
    code: MarkdownCode as never,
    table: MarkdownTable as never,
    ...(renderSlot ? {
      'md-slot': (({ children: slotChildren }: { children?: React.ReactNode }) => (
        <>{renderSlot(Number(reactNodeText(slotChildren)))}</>
      )) as never,
    } : {}),
  }), [renderSlot]);
  return (
    <ReactMarkdown
      remarkPlugins={preserveBoundarySpaces
        ? [remarkGfm, remarkMath, [remarkBoundarySpaces, { source }]]
        : [remarkGfm, remarkMath]}
      rehypePlugins={rehypePlugins as never}
      components={components}
    >
      {source}
    </ReactMarkdown>
  );
}
