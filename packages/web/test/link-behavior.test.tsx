import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LinkAnchor, LinkBehaviorContext } from '@gian/chat-ui';
import type { GianBrowserApi } from '@gian/shared';
import { createWebLinkBehavior, fileLinkHref } from '../src/links/link-behavior.js';
import { createBrowserUrlOpener } from '../src/links/open-url-in-browser.js';

// Gian Web's LinkBehavior: file links route into the Sheet with the
// (path, false, line) convention, file hrefs use the editor scheme, and web
// links open in the desktop shell's in-app Browser (falling back to a plain
// `_blank` window when no desktop bridge is present).

function stubDeps(overrides: Partial<Parameters<typeof createWebLinkBehavior>[0]> = {}) {
  return {
    openFileInSheet: vi.fn(),
    openRelativeFileHref: vi.fn(),
    openUrlInBrowser: vi.fn().mockReturnValue(false),
    ...overrides,
  };
}

function mockBrowserBridge() {
  const browser = {
    navigate: vi.fn().mockResolvedValue({}),
  } as unknown as GianBrowserApi;
  window.gianDesktop = { browser };
  return browser;
}

function openerDeps(overrides: Partial<Parameters<typeof createBrowserUrlOpener>[0]> = {}) {
  return {
    tabs: [] as Array<{ id: string; kind: string }>,
    urls: new Map<string, string>(),
    claimTab: vi.fn(),
    revealBrowserTab: vi.fn(),
    createBrowserTab: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  delete window.gianDesktop;
  vi.restoreAllMocks();
});

describe('fileLinkHref', () => {
  it('maps absolute paths to the editor scheme, encoding special chars', () => {
    expect(fileLinkHref('/repo/src/a.ts')).toBe('vscode://file//repo/src/a.ts');
    expect(fileLinkHref('/repo/src/a.ts', 12)).toBe('vscode://file//repo/src/a.ts:12');
    expect(fileLinkHref('/repo/my dir/a.ts')).toBe('vscode://file//repo/my%20dir/a.ts');
  });
});

describe('createWebLinkBehavior', () => {
  it('routes file opens into the Sheet as non-permanent tabs with the line', () => {
    const deps = stubDeps();
    const behavior = createWebLinkBehavior(deps);
    behavior.openFile!('/repo/a.ts', 7);
    expect(deps.openFileInSheet).toHaveBeenCalledWith('/repo/a.ts', false, 7);
  });

  it('delegates relative hrefs to the click-time re-resolver', () => {
    const deps = stubDeps();
    const behavior = createWebLinkBehavior(deps);
    behavior.openRelative!('./missing.md');
    expect(deps.openRelativeFileHref).toHaveBeenCalledWith('./missing.md');
  });

  it('hands web-link clicks to the in-app Browser instead of _blank', () => {
    const deps = stubDeps({ openUrlInBrowser: vi.fn().mockReturnValue(true) });
    const windowOpen = vi.spyOn(window, 'open').mockImplementation(() => null);
    const behavior = createWebLinkBehavior(deps);
    render(
      <LinkBehaviorContext.Provider value={behavior}>
        <LinkAnchor href="https://example.com/docs">site</LinkAnchor>
      </LinkBehaviorContext.Provider>,
    );
    const anchor = screen.getByRole('link');
    // No target=_blank: the click is routed through openWebUrl.
    expect(anchor.getAttribute('target')).toBeNull();
    fireEvent.click(anchor);
    // Canonical form ('/' appended) so the Browser tab's recorded URL
    // matches what the native side reports back.
    expect(deps.openUrlInBrowser).toHaveBeenCalledWith('https://example.com/docs');
    expect(windowOpen).not.toHaveBeenCalled();
  });

  it('falls back to window.open _blank when the Browser bridge is unavailable', () => {
    const deps = stubDeps({ openUrlInBrowser: vi.fn().mockReturnValue(false) });
    const windowOpen = vi.spyOn(window, 'open').mockImplementation(() => null);
    const behavior = createWebLinkBehavior(deps);
    behavior.openWebUrl!('https://example.com');
    expect(windowOpen).toHaveBeenCalledWith('https://example.com/', '_blank', 'noopener,noreferrer');
  });

  it('ignores malformed URLs without opening anything', () => {
    const deps = stubDeps({ openUrlInBrowser: vi.fn().mockReturnValue(true) });
    const windowOpen = vi.spyOn(window, 'open').mockImplementation(() => null);
    const behavior = createWebLinkBehavior(deps);
    expect(() => behavior.openWebUrl!('not a url')).not.toThrow();
    expect(deps.openUrlInBrowser).not.toHaveBeenCalled();
    expect(windowOpen).not.toHaveBeenCalled();
  });

  it('ignores non-http(s) URLs without opening anything', () => {
    const deps = stubDeps({ openUrlInBrowser: vi.fn().mockReturnValue(true) });
    const windowOpen = vi.spyOn(window, 'open').mockImplementation(() => null);
    const behavior = createWebLinkBehavior(deps);
    behavior.openWebUrl!('ftp://example.com/x');
    behavior.openWebUrl!('gian-browser://site/index.html');
    expect(deps.openUrlInBrowser).not.toHaveBeenCalled();
    expect(windowOpen).not.toHaveBeenCalled();
  });
});

describe('createBrowserUrlOpener', () => {
  it('reuses the first blank Browser tab and navigates it', () => {
    const browser = mockBrowserBridge();
    const deps = openerDeps({
      tabs: [
        { id: 'tab-file-1', kind: 'file' },
        { id: 'tab-browser-1', kind: 'browser' },
        { id: 'tab-browser-2', kind: 'browser' },
      ],
      urls: new Map([['tab-browser-1', 'https://other.example/']]),
    });
    const open = createBrowserUrlOpener(deps);
    expect(open('https://example.com/')).toBe(true);
    // The claim lands synchronously, before the native navigation event.
    expect(deps.claimTab).toHaveBeenCalledWith('tab-browser-2', 'https://example.com/');
    expect(deps.revealBrowserTab).toHaveBeenCalledWith('tab-browser-2');
    expect(browser.navigate).toHaveBeenCalledWith('tab-browser-2', 'https://example.com/');
    expect(deps.createBrowserTab).not.toHaveBeenCalled();
  });

  it('only reveals a tab already showing the URL — no navigate, no mint', () => {
    const browser = mockBrowserBridge();
    const deps = openerDeps({
      tabs: [{ id: 'tab-browser-1', kind: 'browser' }],
      // Also the rapid-double-click case: the in-flight navigate claimed the
      // tab with this same URL before the native state event arrived.
      urls: new Map([['tab-browser-1', 'https://example.com/']]),
    });
    const open = createBrowserUrlOpener(deps);
    expect(open('https://example.com/')).toBe(true);
    expect(deps.revealBrowserTab).toHaveBeenCalledWith('tab-browser-1');
    expect(browser.navigate).not.toHaveBeenCalled();
    expect(deps.claimTab).not.toHaveBeenCalled();
    expect(deps.createBrowserTab).not.toHaveBeenCalled();
  });

  it('mints a new tab when every Browser tab already shows other content', () => {
    const browser = mockBrowserBridge();
    const deps = openerDeps({
      tabs: [{ id: 'tab-browser-1', kind: 'browser' }],
      urls: new Map([['tab-browser-1', 'https://other.example/']]),
    });
    const open = createBrowserUrlOpener(deps);
    expect(open('https://example.com/')).toBe(true);
    expect(deps.revealBrowserTab).toHaveBeenCalledWith(null);
    expect(browser.navigate).not.toHaveBeenCalled();
    expect(deps.createBrowserTab).toHaveBeenCalledTimes(1);
    // Once the native tab exists, the mint callback navigates it.
    const onCreated = deps.createBrowserTab.mock.calls[0]![0] as (
      browser: GianBrowserApi,
      tabId: string,
    ) => void;
    onCreated(browser, 'tab-browser-2');
    expect(deps.claimTab).toHaveBeenCalledWith('tab-browser-2', 'https://example.com/');
    expect(browser.navigate).toHaveBeenCalledWith('tab-browser-2', 'https://example.com/');
  });

  it('returns false without the desktop bridge so the caller can fall back', () => {
    delete window.gianDesktop;
    const deps = openerDeps();
    const open = createBrowserUrlOpener(deps);
    expect(open('https://example.com/')).toBe(false);
    expect(deps.claimTab).not.toHaveBeenCalled();
    expect(deps.revealBrowserTab).not.toHaveBeenCalled();
    expect(deps.createBrowserTab).not.toHaveBeenCalled();
  });
});

describe('LinkAnchor → Browser routing (bridge mocked)', () => {
  it('clicking a transcript link reuses the blank Browser tab and navigates', () => {
    const browser = mockBrowserBridge();
    const urls = new Map<string, string>();
    const deps = openerDeps({
      tabs: [{ id: 'tab-browser-1', kind: 'browser' }],
      urls,
      claimTab: (tabId, url) => { urls.set(tabId, url); },
    });
    const behavior = createWebLinkBehavior(stubDeps({
      openUrlInBrowser: createBrowserUrlOpener(deps),
    }));
    const windowOpen = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(
      <LinkBehaviorContext.Provider value={behavior}>
        <LinkAnchor href="https://example.com">site</LinkAnchor>
      </LinkBehaviorContext.Provider>,
    );
    fireEvent.click(screen.getByRole('link'));
    expect(browser.navigate).toHaveBeenCalledWith('tab-browser-1', 'https://example.com/');
    expect(windowOpen).not.toHaveBeenCalled();
    // A rapid second click while the navigate is in flight only re-reveals.
    fireEvent.click(screen.getByRole('link'));
    expect(browser.navigate).toHaveBeenCalledTimes(1);
    expect(deps.createBrowserTab).not.toHaveBeenCalled();
  });
});
