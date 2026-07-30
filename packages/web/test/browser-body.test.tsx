import { describe, it, expect } from 'vitest';
import {
  normalizeBrowserUrl,
  browserNavPush,
  browserNavGo,
  browserHostOf,
  type BrowserNavState,
} from '../src/components/BrowserBody.js';

describe('normalizeBrowserUrl', () => {
  it('keeps full URLs as-is', () => {
    expect(normalizeBrowserUrl('http://example.com/a')).toBe('http://example.com/a');
    expect(normalizeBrowserUrl('https://example.com')).toBe('https://example.com');
  });

  it('defaults localhost / loopback / bare IPs to http (dev-preview case)', () => {
    expect(normalizeBrowserUrl('localhost:5191')).toBe('http://localhost:5191');
    expect(normalizeBrowserUrl('localhost:5191/app')).toBe('http://localhost:5191/app');
    expect(normalizeBrowserUrl('127.0.0.1:8991/health')).toBe('http://127.0.0.1:8991/health');
    expect(normalizeBrowserUrl('192.168.1.10:3000')).toBe('http://192.168.1.10:3000');
  });

  it('defaults everything else to https', () => {
    expect(normalizeBrowserUrl('example.com')).toBe('https://example.com');
    expect(normalizeBrowserUrl('  example.com/path ')).toBe('https://example.com/path');
  });

  it('returns null for empty input', () => {
    expect(normalizeBrowserUrl('')).toBeNull();
    expect(normalizeBrowserUrl('   ')).toBeNull();
  });
});

describe('browserNavPush / browserNavGo', () => {
  const at = (history: string[], idx: number): BrowserNavState => ({ history, idx });

  it('appends and moves the pointer', () => {
    const s = browserNavPush(at([], -1), 'http://a');
    expect(s).toEqual({ history: ['http://a'], idx: 0 });
    const s2 = browserNavPush(s, 'http://b');
    expect(s2).toEqual({ history: ['http://a', 'http://b'], idx: 1 });
  });

  it('truncates forward entries on a new navigation', () => {
    let s = at(['http://a', 'http://b', 'http://c'], 2);
    s = browserNavGo(s, -1); // at b
    s = browserNavPush(s, 'http://d');
    expect(s).toEqual({ history: ['http://a', 'http://b', 'http://d'], idx: 2 });
  });

  it('clamps back/forward at the ends', () => {
    const s = at(['http://a', 'http://b'], 1);
    expect(browserNavGo(s, 1)).toEqual(s); // already at newest
    const back = browserNavGo(s, -1);
    expect(back.idx).toBe(0);
    expect(browserNavGo(back, -1)).toEqual(back); // already at oldest
  });

  it('caps history at 50 entries', () => {
    let s = at([], -1);
    for (let i = 0; i < 60; i++) s = browserNavPush(s, `http://${i}`);
    expect(s.history.length).toBe(50);
    expect(s.history[s.history.length - 1]).toBe('http://59');
    expect(s.idx).toBe(49);
  });
});

describe('browserHostOf', () => {
  it('extracts the host for tab titles', () => {
    expect(browserHostOf('http://localhost:5191/app')).toBe('localhost:5191');
    expect(browserHostOf('https://example.com/')).toBe('example.com');
  });

  it('falls back to the raw string for invalid URLs', () => {
    expect(browserHostOf('not a url')).toBe('not a url');
  });
});
