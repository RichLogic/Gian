import { isValidElement, useContext, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useChatUiT } from './i18n.js';
import { normalizeGfmTables } from './markdown-tables.js';
import { CopyButton } from './copy-button.js';
import {
  BrowserLinkOpenContext,
  FileLinkHrefContext,
  FileLinkOpenContext,
  FileRefRehypeContext,
  RelativeLinkOpenContext,
} from './contexts.js';

/** Markdown renderer for transcript prose (assistant text + reasoning). Adds
 *  the app-supplied file-linkify rehype plugin and an `a` override so
 *  detected files open through the app's `FileLinkOpenContext` callback
 *  (with line jump) instead of navigating away. */
function MarkdownAnchor(props: {
  node?: { properties?: Record<string, unknown> };
  href?: string;
  children?: React.ReactNode;
}) {
  const openBrowser = useContext(BrowserLinkOpenContext);
  const openRelative = useContext(RelativeLinkOpenContext);
  const p = props.node?.properties ?? {};
  const abs = typeof p.dataFileAbs === 'string' ? p.dataFileAbs : null;
  if (abs) {
    const line = p.dataFileLine ? Number(p.dataFileLine) : undefined;
    return <FileLink path={abs} line={line} className="file-link-auto">{props.children}</FileLink>;
  }
  const routesToBrowser = !!props.href && /^https?:\/\//i.test(props.href);
  // Relative/bare-path hrefs the render-time linkify pass didn't resolve
  // (e.g. a file the agent created after the index loaded) never got a
  // dataFileAbs. Without a handler we'd have to swallow the click — such
  // hrefs would just reload the SPA at a junk URL. With a handler, the app
  // re-resolves against its own index at click time instead.
  const isDeadRelative = !!props.href && !/^[a-z][a-z0-9+.-]*:/i.test(props.href);
  return (
    <a
      href={props.href}
      target={routesToBrowser && openBrowser ? undefined : '_blank'}
      rel="noreferrer noopener"
      onClick={event => {
        if (isDeadRelative) {
          event.preventDefault();
          if (openRelative && props.href) openRelative(props.href);
          return;
        }
        if (!routesToBrowser || !openBrowser || !props.href) return;
        event.preventDefault();
        openBrowser(props.href);
      }}
    >
      {props.children}
    </a>
  );
}

/** Recursively flatten a React node tree to its text — used to recover the raw
 *  source of a fenced code block for its copy button. */
function reactNodeText(node: React.ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(reactNodeText).join('');
  if (isValidElement(node)) return reactNodeText((node.props as { children?: React.ReactNode }).children);
  return '';
}

/** Custom <pre> for rendered markdown: wraps the code block so a copy button can
 *  pin to its top-right (the <pre> itself scrolls horizontally, so the button
 *  rides the non-scrolling wrapper). */
function MarkdownPre({ children }: { node?: unknown; children?: React.ReactNode }) {
  const t = useChatUiT();
  const code = reactNodeText(children).replace(/\n+$/, '');
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
    () => (makeRehype ? [makeRehype] : []),
    [makeRehype],
  );
  // Repair spec-invalid table patterns models emit constantly (header glued
  // to a list item, delimiter/header cell-count mismatch) before remark sees
  // them — otherwise the table silently renders as raw pipe text.
  const source = useMemo(() => normalizeGfmTables(children), [children]);
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={rehypePlugins as never}
      components={{ a: MarkdownAnchor as never, pre: MarkdownPre as never }}
    >
      {source}
    </ReactMarkdown>
  );
}

/**
 * Renders a file path as a clickable link. Clicks route through the app's
 * `FileLinkOpenContext` callback (e.g. an in-app preview surface). The anchor
 * href comes from the app-supplied `FileLinkHrefContext` factory — the
 * package never synthesizes an absolute-path or editor-scheme URL itself, and
 * without either context the link renders inert (clicks prevented).
 */
export function FileLink({
  path,
  line,
  className,
  children,
}: {
  path: string;
  line?: number | undefined;
  className?: string;
  children?: React.ReactNode;
}) {
  const openInApp = useContext(FileLinkOpenContext);
  const hrefFor = useContext(FileLinkHrefContext);
  const href = hrefFor?.(path, line);
  const title = openInApp
    ? `Preview ${path}${line ? `:${line}` : ''}`
    : `${path}${line ? `:${line}` : ''}`;
  return (
    <a
      className={`file-link${className ? ` ${className}` : ''}`}
      href={href}
      onClick={e => {
        // stopPropagation lets these sit inside collapsible card headers
        // without toggling the card on click.
        e.preventDefault();
        e.stopPropagation();
        if (openInApp) openInApp(path, line);
      }}
      title={title}
    >
      {children ?? path}
    </a>
  );
}
