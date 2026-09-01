// Coverage for the drag-reorder controller's pure helpers in
// packages/web/src/dnd-reorder.ts (2026-08-29).

import { describe, expect, it } from 'vitest';
import { moveById } from '../src/dnd-reorder.js';

describe('moveById: drop one id before/after another', () => {
  it('moves an item before the target', () => {
    expect(moveById(['a', 'b', 'c'], 'c', 'a', 'before')).toEqual(['c', 'a', 'b']);
  });

  it('moves an item after the target', () => {
    expect(moveById(['a', 'b', 'c'], 'a', 'c', 'after')).toEqual(['b', 'c', 'a']);
  });

  it('moves an earlier item below a later one', () => {
    expect(moveById(['a', 'b', 'c', 'd'], 'a', 'c', 'before')).toEqual(['b', 'a', 'c', 'd']);
  });

  it('returns the input array untouched when the drop lands on the current position', () => {
    const ids = ['a', 'b', 'c'];
    expect(moveById(ids, 'a', 'b', 'before')).toBe(ids);
    expect(moveById(ids, 'b', 'a', 'after')).toBe(ids);
  });

  it('returns the input array untouched for unknown ids or a self-drop', () => {
    const ids = ['a', 'b'];
    expect(moveById(ids, 'zzz', 'a', 'before')).toBe(ids);
    expect(moveById(ids, 'a', 'zzz', 'after')).toBe(ids);
    expect(moveById(ids, 'a', 'a', 'before')).toBe(ids);
  });
});
