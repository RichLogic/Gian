import { fromMarkdown } from 'mdast-util-from-markdown';

import { isHttpsUrl } from './schemas.js';

interface MarkdownNode {
  type: string;
  url?: string;
  children?: MarkdownNode[];
}

const MAX_MARKDOWN_NODES = 4_096;
const EXECUTABLE_PROTOCOL = /^(?:javascript|data|vbscript):/i;

export function assertCatalogMarkdown(markdown: string, label: string): void {
  if (markdown.includes('\0')) {
    throw new Error(`${label} Catalog Markdown contains a NUL byte.`);
  }
  let tree: ReturnType<typeof fromMarkdown>;
  try {
    tree = fromMarkdown(markdown);
  } catch (error) {
    throw new Error(
      `${label} Catalog Markdown is not parseable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let count = 0;
  const walk = (node: MarkdownNode): void => {
    count += 1;
    if (count > MAX_MARKDOWN_NODES) {
      throw new Error(`${label} Catalog Markdown exceeds the bounded node count.`);
    }
    if (node.type === 'html') {
      throw new Error(`${label} Catalog Markdown contains raw HTML.`);
    }
    if (node.type === 'image' || node.type === 'imageReference') {
      throw new Error(`${label} Catalog Markdown contains a remote, data, or embedded image.`);
    }
    if (node.type === 'link' || node.type === 'definition') {
      const url = node.url ?? '';
      if (!url || url.startsWith('#') || isSafeRelativeMarkdownHref(url)) {
        // fragment and same-document / relative documentation links stay local
      } else if (EXECUTABLE_PROTOCOL.test(url) || url.startsWith('data:')) {
        throw new Error(`${label} Catalog Markdown contains an executable or data link.`);
      } else if (!isHttpsUrl(url)) {
        throw new Error(`${label} Catalog Markdown contains an unsafe link.`);
      }
    }
    const children = 'children' in node ? node.children : undefined;
    if (Array.isArray(children)) {
      for (const child of children) walk(child);
    }
  };
  walk(tree as MarkdownNode);
}

function isSafeRelativeMarkdownHref(url: string): boolean {
  if (url.startsWith('//') || url.includes(':') || url.includes('\\')) return false;
  if (url.startsWith('/')) return false;
  return !url.includes('..');
}
