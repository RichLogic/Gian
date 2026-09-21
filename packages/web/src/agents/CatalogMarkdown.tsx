import { useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { LinkAnchor, LinkPolicyContext, strictHttpsPolicy } from '@gian/chat-ui';
import { normalizeGfmTables } from '../markdown-tables.js';

/**
 * Restricted Catalog Markdown renderer (WP4, issue #146; proposal §7.3).
 * Catalog documents are signed and Bundle-verified Host-side, but the Web
 * still renders them through the narrowest existing channel:
 *
 * - react-markdown without rehype-raw: raw HTML in the source is escaped
 *   text, never injected markup (same guarantee as the Sheet preview);
 * - links route through the shared `LinkAnchor` under `strictHttpsPolicy`:
 *   only `https:` URLs render as links (through the external-navigation
 *   boundary — the in-app Browser when available, otherwise a new window
 *   with noopener); every other scheme — including `http:`, `javascript:`,
 *   `data:`, and relative links — degrades to plain text;
 * - images never render (remote/data images are forbidden by the Catalog
 *   contract); the alt text is shown instead;
 * - Markdown never controls layout or action availability: it renders inside
 *   `.md-preview` like file previews and cannot emit buttons or forms.
 */
export function CatalogMarkdown({ source }: { source: string }) {
  const normalized = useMemo(() => normalizeGfmTables(source), [source]);
  return (
    <div className="md-preview catalog-doc" data-testid="catalog-doc">
      <LinkPolicyContext.Provider value={strictHttpsPolicy}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            a: LinkAnchor as never,
            img: ({ alt }) => <span className="catalog-doc-img-placeholder">{alt ?? ''}</span>,
          }}
        >
          {normalized}
        </ReactMarkdown>
      </LinkPolicyContext.Provider>
    </div>
  );
}
