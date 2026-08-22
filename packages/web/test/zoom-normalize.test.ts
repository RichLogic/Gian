import { describe, expect, it } from 'vitest';
import { normalizeZoomPercent } from '../src/display-prefs.js';

describe('normalizeZoomPercent', () => {
  it('falls back to 100 for non-numeric input', () => {
    expect(normalizeZoomPercent(undefined)).toBe(100);
    expect(normalizeZoomPercent(null)).toBe(100);
    expect(normalizeZoomPercent('')).toBe(100);
    expect(normalizeZoomPercent('abc')).toBe(100);
  });

  it('parses numeric strings and snaps to the 10-percent grid', () => {
    expect(normalizeZoomPercent('110')).toBe(110);
    expect(normalizeZoomPercent(84)).toBe(80);
    expect(normalizeZoomPercent(85)).toBe(90);
  });
});
