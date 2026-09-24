/**
 * Web-link hover preview (unfurl). `WebLink` is `LinkAnchor`'s web-kind
 * renderer: the anchor keeps its exact click semantics (`openWebUrl`
 * routing or the plain `_blank` fallback) and gains a hover card when a
 * `LinkPreviewContext` is mounted above it.
 *
 * Timing reuses the reference-chip hover contract (`useHoverPreview`):
 * the 300ms open delay IS the hover-intent debounce — no fetch fires on
 * render or on a passing mouse-over; only a pointer that settles for the
 * intent window triggers one. Leaving the link aborts the in-flight fetch
 * and closes the card 200ms later, unless the pointer moved onto the card.
 *
 * Failures are silent: a fetch that resolves null (or rejects) closes the
 * loading card and negative-caches the URL for the session, so re-hovering
 * a broken link does nothing. The link itself is never altered.
 *
 * Resolved previews (including nulls) are cached per session per fetcher,
 * so a second hover of the same URL opens instantly without a network hit.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ReferencePopover, useHoverPreview, type ReferenceAnchor } from '../reference-popover.js';
import { useLinkPreview, type LinkPreview, type LinkPreviewFetcher } from './preview-context.js';
import { recordLinkFavicon } from './favicon-store.js';

const sessionCaches = new WeakMap<LinkPreviewFetcher, Map<string, LinkPreview | null>>();

function sessionCache(fetcher: LinkPreviewFetcher): Map<string, LinkPreview | null> {
  let cache = sessionCaches.get(fetcher);
  if (!cache) {
    cache = new Map();
    sessionCaches.set(fetcher, cache);
  }
  return cache;
}

/** Feed the icon favicon store under both the hovered href's origin and the
 *  final (post-redirect) URL's origin — either may key the rendered link. */
function recordFavicon(href: string, preview: LinkPreview | null): void {
  if (!preview?.faviconUrl) return;
  recordLinkFavicon(href, preview.faviconUrl);
  recordLinkFavicon(preview.url, preview.faviconUrl);
}

export function WebLink({
  href,
  openWebUrl,
  icon,
  children,
}: {
  href: string;
  openWebUrl?: ((url: string) => void) | null;
  icon: React.ReactNode;
  children?: React.ReactNode;
}) {
  const fetcher = useLinkPreview();
  const { scheduleOpen, scheduleClose, cancelClose } = useHoverPreview();
  const anchorRef = useRef<HTMLAnchorElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [card, setCard] = useState<{ anchor: ReferenceAnchor; preview: LinkPreview | null } | null>(null);

  const close = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setCard(null);
  }, []);

  useEffect(() => () => abortRef.current?.abort(), []);

  const open = useCallback(() => {
    const el = anchorRef.current;
    if (!el || !fetcher) return;
    const anchor = el.getBoundingClientRect();
    const cache = sessionCache(fetcher);
    const cached = cache.get(href);
    if (cached === null) return; // known-unavailable: stay silent
    if (cached !== undefined) {
      recordFavicon(href, cached);
      setCard({ anchor, preview: cached });
      return;
    }
    // Optimistic loading card: the domain is known synchronously, the rest
    // fills in when the fetch lands.
    setCard({ anchor, preview: null });
    const controller = new AbortController();
    abortRef.current = controller;
    fetcher.fetchPreview(href, controller.signal)
      .then(preview => {
        cache.set(href, preview);
        // Favicon upgrade: the already-fetched preview feeds the per-origin
        // icon store, so every link to that origin swaps its glyph for the
        // real favicon. Recording is safe even when this hover was aborted —
        // no new fetch is involved.
        recordFavicon(href, preview);
        if (controller.signal.aborted) return;
        // A failed fetch closes the optimistic card again — nothing extra
        // is rendered, and the negative cache entry silences re-hovers.
        if (!preview) {
          setCard(null);
          return;
        }
        setCard(current => (current ? { anchor: current.anchor, preview } : null));
      })
      .catch(() => {
        cache.set(href, null);
        if (!controller.signal.aborted) setCard(null);
      });
  }, [href, fetcher]);

  const hover = fetcher
    ? {
        onMouseEnter: () => scheduleOpen(open),
        onMouseLeave: () => scheduleClose(close),
        onFocus: () => scheduleOpen(open),
        onBlur: () => scheduleClose(close),
      }
    : {};

  const anchor = openWebUrl ? (
    <a
      ref={anchorRef}
      href={href}
      data-link-kind="web"
      rel="noreferrer noopener"
      {...hover}
      onClick={event => {
        event.preventDefault();
        close();
        openWebUrl(href);
      }}
    >
      {icon}
      {children}
    </a>
  ) : (
    <a
      ref={anchorRef}
      href={href}
      data-link-kind="web"
      target="_blank"
      rel="noreferrer noopener"
      {...hover}
    >
      {icon}
      {children}
    </a>
  );

  return (
    <>
      {anchor}
      {card && (
        <ReferencePopover
          anchor={card.anchor}
          anchorEl={anchorRef.current}
          onClose={close}
          width={320}
          onMouseEnter={cancelClose}
          onMouseLeave={() => scheduleClose(close)}
        >
          <LinkPreviewCard url={card.preview?.url ?? href} preview={card.preview} />
        </ReferencePopover>
      )}
    </>
  );
}

function LinkPreviewCard({ url, preview }: { url: string; preview: LinkPreview | null }) {
  const domain = domainOf(url);
  return (
    <div className="link-preview">
      {preview?.faviconUrl && (
        <img className="link-preview-favicon" src={preview.faviconUrl} alt="" />
      )}
      <div className="link-preview-text">
        <span className="link-preview-title">{preview?.title ?? preview?.siteName ?? domain}</span>
        {preview?.description && (
          <span className="link-preview-desc">{preview.description}</span>
        )}
        <span className="link-preview-domain">{domain}</span>
      </div>
    </div>
  );
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
