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

export function MarkdownText({ children }: { children: string }) {
  const makeRehype = useContext(FileRefRehypeContext);
  const rehypePlugins = useMemo(
    () => [
      rehypeKatex,
      // Tagged languages only (`detect: false`); mermaid stays unhighlighted
      // so the `code` override sees the raw diagram source.
      [rehypeHighlight, { detect: false, plainText: ['mermaid'] }],
      ...(makeRehype ? [makeRehype] : []),
    ],
    [makeRehype],
  );
  // Repair spec-invalid table patterns models emit constantly (header glued
  // to a list item, delimiter/header cell-count mismatch) before remark sees
  // them — otherwise the table silently renders as raw pipe text.
  const source = useMemo(() => normalizeGfmTables(children), [children]);
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={rehypePlugins as never}
      components={{
        a: LinkAnchor as never,
        pre: MarkdownPre as never,
        code: MarkdownCode as never,
      }}
    >
      {source}
    </ReactMarkdown>
  );
}
