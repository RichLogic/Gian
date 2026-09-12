import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OPEN_TARGET,
  openCategoryFor,
  resolveOpenTarget,
} from '../src/components/sheet-model.js';
import { normalizeBrowserAddress } from '../src/presentation/browser-address.js';
import {
  findBlankBrowserTab,
  PENDING_BROWSER_TAB_URL,
} from '../src/presentation/browser-tabs.js';

describe('Browser file-open routing', () => {
  it('uses Browser as the default for HTML without changing other categories', () => {
    expect(openCategoryFor('public/index.html')).toBe('web');
    expect(DEFAULT_OPEN_TARGET.web).toBe('@browser');
    expect(DEFAULT_OPEN_TARGET.images).toBe('@newtab');
    expect(DEFAULT_OPEN_TARGET.pdf).toBe('@newtab');
    expect(resolveOpenTarget('web')).toEqual({ kind: 'system', name: 'gian-browser' });
  });

  it('keeps the explicit system-browser target distinct from Browser', () => {
    expect(resolveOpenTarget('web', { web: '@newtab' })).toEqual({ kind: 'system', name: 'browser' });
    expect(resolveOpenTarget('web', { web: '@browser' })).toEqual({ kind: 'system', name: 'gian-browser' });
  });
});

describe('Browser blank-tab reuse', () => {
  it('reuses the first browser tab with no recorded URL and skips tabs showing content', () => {
    const tabs = [
      { id: 'tab-file-1', kind: 'file' },
      { id: 'tab-browser-1', kind: 'browser' },
      { id: 'tab-browser-2', kind: 'browser' },
    ];
    // Nothing recorded yet: the seeded blank tab wins.
    expect(findBlankBrowserTab(tabs, new Map())).toBe('tab-browser-1');
    // First tab shows a page; the still-blank second tab is reused instead.
    expect(findBlankBrowserTab(tabs, new Map([
      ['tab-browser-1', 'gian-browser://site/index.html'],
    ]))).toBe('tab-browser-2');
    // An explicit about:blank reading normalizes to '' and stays reusable.
    expect(findBlankBrowserTab(tabs, new Map([
      ['tab-browser-1', 'gian-browser://site/index.html'],
      ['tab-browser-2', ''],
    ]))).toBe('tab-browser-2');
  });

  it('returns null once every browser tab shows content', () => {
    const tabs = [
      { id: 'tab-browser-1', kind: 'browser' },
      { id: 'tab-browser-2', kind: 'browser' },
    ];
    expect(findBlankBrowserTab(tabs, new Map([
      ['tab-browser-1', 'https://example.com/'],
      ['tab-browser-2', PENDING_BROWSER_TAB_URL],
    ]))).toBeNull();
    expect(findBlankBrowserTab([], new Map())).toBeNull();
  });
});

describe('Browser address normalization', () => {
  it('defaults public hosts to HTTPS and localhost to HTTP', () => {
    expect(normalizeBrowserAddress('example.com/path')).toBe('https://example.com/path');
    expect(normalizeBrowserAddress('localhost:5173')).toBe('http://localhost:5173/');
    expect(normalizeBrowserAddress('127.0.0.1:3000/test')).toBe('http://127.0.0.1:3000/test');
  });

  it('accepts the project scheme and rejects executable or file schemes', () => {
    expect(normalizeBrowserAddress('gian-browser://site/index.html')).toBe('gian-browser://site/index.html');
    expect(normalizeBrowserAddress('file:///tmp/index.html')).toBeNull();
    expect(normalizeBrowserAddress('javascript:alert(1)')).toBeNull();
    expect(normalizeBrowserAddress('')).toBeNull();
  });
});
