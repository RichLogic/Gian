import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OPEN_TARGET,
  openCategoryFor,
  resolveOpenTarget,
} from '../src/components/sheet-model.js';
import { normalizeBrowserAddress } from '../src/presentation/browser-address.js';

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
