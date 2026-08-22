import { describe, expect, it } from 'vitest';
import { normalizeGfmTables } from '../src/markdown-tables.js';

describe('normalizeGfmTables', () => {
  it('returns the same string when there is no pipe', () => {
    const md = 'plain paragraph\nno table here';
    expect(normalizeGfmTables(md)).toBe(md);
  });

  it('does not insert a blank line after a non-list paragraph', () => {
    const md = 'See this:\n| col |\n| --- |\n| 1 |';
    expect(normalizeGfmTables(md)).toBe(md);
  });

  it('leaves a mismatched table inside a fence untouched', () => {
    const md = '~~~\n| only |\n| --- | --- |\n~~~';
    expect(normalizeGfmTables(md)).toBe(md);
  });

  it('pads a short delimiter row outside fences', () => {
    expect(normalizeGfmTables('| left | right |\n| --- |\n| 1 | 2 |'))
      .toBe('| left | right |\n| --- | --- |\n| 1 | 2 |');
  });
});
