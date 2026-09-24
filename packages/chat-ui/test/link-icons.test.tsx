// links/link-icons.tsx — per-target link icons: the web domain→brand map
// with the globe fallback, the favicon upgrade fed by completed hover
// previews (rendering never fetches), and the file extension→letter-square
// map with the plain document fallback.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import { LinkAnchor } from '../src/links/LinkAnchor.js';
import { LinkPreviewContext } from '../src/links/preview-context.js';
import type { LinkPreview, LinkPreviewFetcher } from '../src/links/preview-context.js';
import { clearLinkFavicons, recordLinkFavicon } from '../src/links/favicon-store.js';
import { PREVIEW_HOVER_OPEN_MS } from '../src/reference-popover.js';

const FAVICON_URL = '/api/link-preview/favicon?url=https%3A%2F%2Fexample.com%2Ffavicon.ico';

const PREVIEW: LinkPreview = {
  url: 'https://example.com/',
  title: 'Example',
  description: null,
  siteName: null,
  faviconUrl: FAVICON_URL,
};

function webIcon(container: HTMLElement): Element | null {
  return container.querySelector('[data-link-icon]');
}

describe('LinkKindIcon web domain map', () => {
  beforeEach(() => clearLinkFavicons());
  afterEach(() => clearLinkFavicons());

  it.each([
    ['https://github.com/gian-dev/gian', 'web-github'],
    ['https://gist.github.com/user/abc', 'web-github'],
    ['https://gitlab.com/group/repo', 'web-gitlab'],
    ['https://www.npmjs.com/package/react', 'web-npm'],
    ['https://stackoverflow.com/q/1', 'web-stackoverflow'],
    ['https://developer.mozilla.org/en-US/docs/Web', 'web-mdn'],
    ['https://arxiv.org/abs/2401.00001', 'web-arxiv'],
    ['https://x.com/gian', 'web-x'],
    ['https://twitter.com/gian', 'web-x'],
    ['https://www.figma.com/file/abc', 'web-figma'],
    ['https://docs.google.com/document/d/abc', 'web-gdocs'],
    ['http://localhost:8991/', 'web-local'],
    ['http://127.0.0.1:5192/', 'web-local'],
    ['http://[::1]:8080/', 'web-local'],
  ])('maps %s to %s', (href, expected) => {
    const { container } = render(<LinkAnchor href={href}>link</LinkAnchor>);
    expect(webIcon(container)?.getAttribute('data-link-icon')).toBe(expected);
  });

  it('keeps the globe for unknown domains', () => {
    const { container } = render(<LinkAnchor href="https://unknown-site.example.org/x">link</LinkAnchor>);
    const icon = webIcon(container);
    expect(icon?.getAttribute('data-link-icon')).toBe('web');
    expect(icon?.querySelector('circle')).not.toBeNull();
  });

  it('renders monochrome brand marks (github/x/mdn/localhost) in currentColor so they follow the theme', () => {
    for (const href of [
      'https://github.com/a',
      'https://x.com/a',
      'https://developer.mozilla.org/a',
      'http://localhost:8991/',
    ]) {
      const { container } = render(<LinkAnchor href={href}>link</LinkAnchor>);
      const icon = webIcon(container)!;
      // Every painted shape inherits the link color — no raw black that
      // would vanish on a dark theme.
      const painted = icon.querySelectorAll('[fill]:not([fill="none"]), [stroke]:not([stroke="none"])');
      expect(painted.length).toBeGreaterThan(0);
      for (const node of painted) {
        const stroke = node.getAttribute('stroke');
        const fill = node.getAttribute('fill');
        expect(stroke && stroke !== 'none' ? stroke : fill).toBe('currentColor');
      }
    }
  });

  it('renders hue-brand marks with fixed colors on both themes', () => {
    const { container } = render(<LinkAnchor href="https://github.com">x</LinkAnchor>);
    expect(container.querySelector('[data-link-icon="web-github"]')).not.toBeNull();
    const gitlab = render(<LinkAnchor href="https://gitlab.com">x</LinkAnchor>);
    expect(
      gitlab.container.querySelector('[data-link-icon="web-gitlab"] path')?.getAttribute('fill'),
    ).toBe('#e24329');
  });
});

describe('LinkKindIcon file extension map', () => {
  function fileIcon(container: HTMLElement): Element | null {
    return container.querySelector('[data-link-icon]');
  }

  it.each([
    ['/repo/src/a.ts', 'file-ts'],
    ['/repo/src/a.tsx', 'file-ts'],
    ['/repo/src/a.js', 'file-js'],
    ['/repo/src/a.jsx', 'file-js'],
    ['/repo/a.json', 'file-json'],
    ['/repo/README.md', 'file-md'],
    ['/repo/a.css', 'file-css'],
    ['/repo/a.py', 'file-py'],
    ['/repo/a.rs', 'file-rs'],
    ['/repo/a.go', 'file-go'],
    ['/repo/a.html', 'file-html'],
    ['/repo/a.vue', 'file-vue'],
    ['/repo/a.yaml', 'file-yaml'],
    ['/repo/a.toml', 'file-toml'],
  ])('maps %s to %s', (abs, expected) => {
    const node = { properties: { dataFileAbs: abs } };
    const { container } = render(<LinkAnchor node={node} href="./a">file</LinkAnchor>);
    expect(fileIcon(container)?.getAttribute('data-link-icon')).toBe(expected);
  });

  it('draws the extension letter square with white-on-hue lettering', () => {
    const node = { properties: { dataFileAbs: '/repo/src/a.ts' } };
    const { container } = render(<LinkAnchor node={node} href="./a.ts">a.ts</LinkAnchor>);
    const icon = container.querySelector('[data-link-icon="file-ts"]')!;
    expect(icon.querySelector('rect')?.getAttribute('fill')).toBe('#3178c6');
    expect(icon.querySelector('text')?.textContent).toBe('TS');
  });

  it('uses the relative href when no absolute path exists', () => {
    const { container } = render(<LinkAnchor href="./docs/guide.md">guide</LinkAnchor>);
    expect(fileIcon(container)?.getAttribute('data-link-icon')).toBe('file-md');
  });

  it('keeps the plain document glyph for unknown or missing extensions', () => {
    for (const abs of ['/repo/Makefile', '/repo/.gitignore', '/repo/a.zzz']) {
      const node = { properties: { dataFileAbs: abs } };
      const { container } = render(<LinkAnchor node={node} href="./a">file</LinkAnchor>);
      expect(fileIcon(container)?.getAttribute('data-link-icon')).toBe('file');
    }
  });
});

describe('LinkKindIcon favicon upgrade', () => {
  beforeEach(() => clearLinkFavicons());
  afterEach(() => clearLinkFavicons());

  it('swaps the glyph for the recorded favicon of the link origin', () => {
    const { container } = render(<LinkAnchor href="https://example.com/docs">docs</LinkAnchor>);
    expect(container.querySelector('[data-link-icon="web"]')).not.toBeNull();

    act(() => recordLinkFavicon('https://example.com/', FAVICON_URL));

    const img = container.querySelector<HTMLImageElement>('img[data-link-icon="web-favicon"]');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).toBe(FAVICON_URL);
    expect(container.querySelector('svg[data-link-icon]')).toBeNull();
  });

  it('upgrades a brand-glyph link too (favicon wins over the map)', () => {
    const { container } = render(<LinkAnchor href="https://github.com/gian-dev">repo</LinkAnchor>);
    expect(container.querySelector('[data-link-icon="web-github"]')).not.toBeNull();

    act(() => recordLinkFavicon('https://github.com/org/repo', '/api/link-preview/favicon?url=gh'));

    expect(container.querySelector('img[data-link-icon="web-favicon"]')).not.toBeNull();
    expect(container.querySelector('[data-link-icon="web-github"]')).toBeNull();
  });

  it('does not leak a favicon across origins', () => {
    const { container } = render(<LinkAnchor href="https://other.example.net/x">x</LinkAnchor>);
    act(() => recordLinkFavicon('https://example.com/', FAVICON_URL));
    expect(container.querySelector('[data-link-icon="web-favicon"]')).toBeNull();
    expect(container.querySelector('[data-link-icon="web"]')).not.toBeNull();
  });

  it('upgrades the icon from a completed hover-preview fetch — no fetch on render', async () => {
    vi.useFakeTimers();
    try {
      const fetcher: LinkPreviewFetcher = { fetchPreview: vi.fn(async () => PREVIEW) };
      const { container, getByRole } = render(
        <LinkPreviewContext.Provider value={fetcher}>
          <LinkAnchor href="https://example.com/docs">docs</LinkAnchor>
        </LinkPreviewContext.Provider>,
      );
      // Render alone never fetches — the icon is still the fallback glyph.
      expect(fetcher.fetchPreview).not.toHaveBeenCalled();
      await act(async () => {
        vi.advanceTimersByTime(5_000);
      });
      expect(fetcher.fetchPreview).not.toHaveBeenCalled();

      // A settled hover intent fetches once; the icon upgrades when it lands.
      fireEvent.mouseOver(getByRole('link'));
      await act(async () => {
        vi.advanceTimersByTime(PREVIEW_HOVER_OPEN_MS);
      });
      await act(async () => {});
      expect(fetcher.fetchPreview).toHaveBeenCalledTimes(1);
      expect(container.querySelector('img[data-link-icon="web-favicon"]')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a second link to the same origin upgrades without its own fetch', async () => {
    vi.useFakeTimers();
    try {
      const fetcher: LinkPreviewFetcher = { fetchPreview: vi.fn(async () => PREVIEW) };
      const first = render(
        <LinkPreviewContext.Provider value={fetcher}>
          <LinkAnchor href="https://example.com/docs">docs</LinkAnchor>
        </LinkPreviewContext.Provider>,
      );
      fireEvent.mouseOver(first.getByRole('link'));
      await act(async () => {
        vi.advanceTimersByTime(PREVIEW_HOVER_OPEN_MS);
      });
      await act(async () => {});

      const second = render(<LinkAnchor href="https://example.com/other">other</LinkAnchor>);
      expect(second.container.querySelector('img[data-link-icon="web-favicon"]')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
