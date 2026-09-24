// links/LinkPreviewCard.tsx — the hover unfurl on web-link anchors. Covers
// the intent gating (no fetch on render, fetch only after the 300ms hover
// intent), card rendering from a mocked LinkPreviewContext, silent failure,
// abort-on-unhover, the per-session cache, and the no-context degradation.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import { LinkAnchor } from '../src/links/LinkAnchor.js';
import { LinkPreviewContext } from '../src/links/preview-context.js';
import type { LinkPreview, LinkPreviewFetcher } from '../src/links/preview-context.js';
import { PREVIEW_HOVER_CLOSE_MS, PREVIEW_HOVER_OPEN_MS } from '../src/reference-popover.js';

const PREVIEW: LinkPreview = {
  url: 'https://example.com/',
  title: 'Example Title',
  description: 'An example description',
  siteName: 'Example Site',
  faviconUrl: '/api/link-preview/favicon?url=https%3A%2F%2Fexample.com%2Ffavicon.ico',
};

function fetcherOf(implementation: LinkPreviewFetcher['fetchPreview']): LinkPreviewFetcher {
  return { fetchPreview: vi.fn(implementation) };
}

function renderLink(fetcher: LinkPreviewFetcher | null, behavior?: { openWebUrl: (url: string) => void }) {
  const ui = <LinkAnchor href="https://example.com/docs">docs</LinkAnchor>;
  return render(
    fetcher
      ? <LinkPreviewContext.Provider value={fetcher}>{ui}</LinkPreviewContext.Provider>
      : ui,
  );
}

function card(): HTMLElement | null {
  return document.body.querySelector('.link-preview');
}

async function hover(anchor: HTMLElement, ms = PREVIEW_HOVER_OPEN_MS) {
  fireEvent.mouseOver(anchor);
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
  // Flush the fetch promise microtasks.
  await act(async () => {});
}

async function unhover(anchor: HTMLElement, ms = PREVIEW_HOVER_CLOSE_MS) {
  fireEvent.mouseOut(anchor);
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
  await act(async () => {});
}

describe('LinkAnchor web-link hover preview', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('never fetches on render — only on settled hover intent', async () => {
    const fetcher = fetcherOf(async () => PREVIEW);
    renderLink(fetcher);
    expect(fetcher.fetchPreview).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    expect(fetcher.fetchPreview).not.toHaveBeenCalled();
    expect(card()).toBeNull();
  });

  it('ignores a passing hover shorter than the intent window', async () => {
    const fetcher = fetcherOf(async () => PREVIEW);
    const { getByRole } = renderLink(fetcher);
    const anchor = getByRole('link');
    fireEvent.mouseOver(anchor);
    await act(async () => {
      vi.advanceTimersByTime(PREVIEW_HOVER_OPEN_MS - 1);
    });
    fireEvent.mouseOut(anchor);
    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    expect(fetcher.fetchPreview).not.toHaveBeenCalled();
    expect(card()).toBeNull();
  });

  it('fetches at intent time and renders favicon + title + description + domain', async () => {
    const fetcher = fetcherOf(async () => PREVIEW);
    const { getByRole } = renderLink(fetcher);
    const anchor = getByRole('link');
    fireEvent.mouseOver(anchor);
    await act(async () => {
      vi.advanceTimersByTime(PREVIEW_HOVER_OPEN_MS - 1);
    });
    expect(fetcher.fetchPreview).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(fetcher.fetchPreview).toHaveBeenCalledWith(
      'https://example.com/docs',
      expect.any(AbortSignal),
    );
    await act(async () => {});
    expect(card()).not.toBeNull();
    expect(document.body.querySelector('.link-preview-title')?.textContent).toBe('Example Title');
    expect(document.body.querySelector('.link-preview-desc')?.textContent)
      .toBe('An example description');
    expect(document.body.querySelector('.link-preview-domain')?.textContent).toBe('example.com');
    const favicon = document.body.querySelector<HTMLImageElement>('.link-preview-favicon');
    expect(favicon?.getAttribute('src')).toBe(PREVIEW.faviconUrl);
  });

  it('renders nothing extra when the fetch resolves null (silent failure)', async () => {
    const fetcher = fetcherOf(async () => null);
    const { getByRole } = renderLink(fetcher);
    await hover(getByRole('link'));
    expect(fetcher.fetchPreview).toHaveBeenCalledTimes(1);
    expect(card()).toBeNull();
    // The null is cached: a re-hover does not even try again.
    await hover(getByRole('link'));
    expect(fetcher.fetchPreview).toHaveBeenCalledTimes(1);
    expect(card()).toBeNull();
  });

  it('renders nothing extra when the fetch rejects', async () => {
    const fetcher = fetcherOf(async () => {
      throw new Error('network down');
    });
    const { getByRole } = renderLink(fetcher);
    await hover(getByRole('link'));
    expect(card()).toBeNull();
  });

  it('aborts the in-flight fetch on unhover', async () => {
    let signal: AbortSignal | undefined;
    const fetcher = fetcherOf((_url, s) => {
      signal = s;
      return new Promise<LinkPreview | null>(() => {});
    });
    const { getByRole } = renderLink(fetcher);
    const anchor = getByRole('link');
    fireEvent.mouseOver(anchor);
    await act(async () => {
      vi.advanceTimersByTime(PREVIEW_HOVER_OPEN_MS);
    });
    expect(signal?.aborted).toBe(false);
    await unhover(anchor);
    expect(signal?.aborted).toBe(true);
    expect(card()).toBeNull();
  });

  it('serves re-hovers from the session cache without refetching', async () => {
    const fetcher = fetcherOf(async () => PREVIEW);
    const { getByRole } = renderLink(fetcher);
    const anchor = getByRole('link');
    await hover(anchor);
    expect(card()).not.toBeNull();
    await unhover(anchor);
    expect(card()).toBeNull();
    await hover(anchor);
    expect(card()).not.toBeNull();
    expect(fetcher.fetchPreview).toHaveBeenCalledTimes(1);
  });

  it('keeps plain anchors and no hover behavior when no context is mounted', async () => {
    const { getByRole } = renderLink(null);
    const anchor = getByRole('link');
    expect(anchor.getAttribute('target')).toBe('_blank');
    await hover(anchor);
    expect(card()).toBeNull();
  });
});
