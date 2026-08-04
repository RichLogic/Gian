import { describe, it, expect } from 'vitest';
import { isWithinRoot, longestRootMatch } from '../src/utils/paths.js';

describe('isWithinRoot', () => {
  it('matches a file under the root', () => {
    expect(isWithinRoot('/Users/r/Coding/Gian-Dev', '/Users/r/Coding/Gian-Dev/packages/web/src/App.tsx')).toBe(true);
  });
  it('matches the root itself', () => {
    expect(isWithinRoot('/Users/r/Coding/Gian-Dev', '/Users/r/Coding/Gian-Dev')).toBe(true);
  });
  it('does NOT match a sibling root that shares a prefix', () => {
    // The whole point: /…/Gian-Dev must not count as under /…/Gian.
    expect(isWithinRoot('/Users/r/Coding/Gian', '/Users/r/Coding/Gian-Dev/x.ts')).toBe(false);
  });
  it('tolerates a trailing slash on the root', () => {
    expect(isWithinRoot('/Users/r/Coding/Gian-Dev/', '/Users/r/Coding/Gian-Dev/a.ts')).toBe(true);
  });
});

describe('longestRootMatch', () => {
  const trees = [
    { id: 'a', path: '/Users/r/Coding/Gian' },
    { id: 'b', path: '/Users/r/Coding/Gian-Dev' },
    { id: 'c', path: '/Users/r/Coding/Gian-Dev/packages/host' },
  ];
  it('routes a Gian-Dev file to the Gian-Dev tree, not the Gian sibling', () => {
    expect(longestRootMatch(trees, '/Users/r/Coding/Gian-Dev/packages/web/x.ts')?.id).toBe('b');
  });
  it('prefers the deepest (longest) containing root', () => {
    expect(longestRootMatch(trees, '/Users/r/Coding/Gian-Dev/packages/host/src/y.ts')?.id).toBe('c');
  });
  it('routes a Gian file to the Gian tree', () => {
    expect(longestRootMatch(trees, '/Users/r/Coding/Gian/z.ts')?.id).toBe('a');
  });
  it('returns undefined when no root contains the path', () => {
    expect(longestRootMatch(trees, '/tmp/other/w.ts')).toBeUndefined();
  });
});
