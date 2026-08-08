// View-level working-tree override: per-session persistence + resolution
// precedence. Guards the 2026-08-06 regression where a branch-picker choice
// silently reverted to the primary checkout ("main") after a reload.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  readWtViewOverride,
  writeWtViewOverride,
  readWtAutoApplied,
  writeWtAutoApplied,
  resolveViewedTreeId,
} from '../src/presentation/wt-view.js';

beforeEach(() => localStorage.clear());

describe('wt-view override persistence', () => {
  it('round-trips a pick per session', () => {
    expect(readWtViewOverride('s1')).toBeNull();
    writeWtViewOverride('s1', 'ext:ws1:abc');
    writeWtViewOverride('s2', 'ws:ws2');
    expect(readWtViewOverride('s1')).toBe('ext:ws1:abc');
    expect(readWtViewOverride('s2')).toBe('ws:ws2');
  });

  it('round-trips the auto-applied detection marker', () => {
    expect(readWtAutoApplied('s1')).toBeNull();
    writeWtAutoApplied('s1', '/repo/.worktrees/feat');
    expect(readWtAutoApplied('s1')).toBe('/repo/.worktrees/feat');
  });
});

describe('resolveViewedTreeId', () => {
  const trees = [{ id: 'ws:main' }, { id: 'ext:ws:Z2lhbg' }];

  it('prefers the in-memory pick for the same session', () => {
    writeWtViewOverride('s1', 'ws:main');
    expect(resolveViewedTreeId({
      sessionId: 's1',
      inMemory: { sessionId: 's1', wtId: 'ext:ws:Z2lhbg' },
      stored: readWtViewOverride('s1'),
      trees,
      defaultId: 'ws:main',
    })).toBe('ext:ws:Z2lhbg');
  });

  it('falls back to the persisted override when memory holds another session', () => {
    writeWtViewOverride('s1', 'ext:ws:Z2lhbg');
    expect(resolveViewedTreeId({
      sessionId: 's1',
      inMemory: { sessionId: 's2', wtId: 'ws:main' },
      stored: readWtViewOverride('s1'),
      trees,
      defaultId: 'ws:main',
    })).toBe('ext:ws:Z2lhbg');
  });

  it('ignores an in-memory override whose worktree disappeared after refresh', () => {
    expect(resolveViewedTreeId({
      sessionId: 's1',
      inMemory: { sessionId: 's1', wtId: 'ext:ws:ZGVhZA' },
      stored: null,
      trees,
      defaultId: 'ws:main',
    })).toBe('ws:main');
  });

  it('falls through an invalid in-memory override to a valid stored tree', () => {
    expect(resolveViewedTreeId({
      sessionId: 's1',
      inMemory: { sessionId: 's1', wtId: 'ext:ws:ZGVhZA' },
      stored: 'ext:ws:Z2lhbg',
      trees,
      defaultId: 'ws:main',
    })).toBe('ext:ws:Z2lhbg');
  });

  it('ignores a persisted override whose tree no longer exists', () => {
    expect(resolveViewedTreeId({
      sessionId: 's1',
      inMemory: null,
      stored: 'ext:ws:ZGVhZA', // deleted worktree — not in the listing
      trees,
      defaultId: 'ws:main',
    })).toBe('ws:main');
  });

  it('returns the default when nothing is stored', () => {
    expect(resolveViewedTreeId({
      sessionId: 's1',
      inMemory: null,
      stored: null,
      trees,
      defaultId: 'ws:main',
    })).toBe('ws:main');
  });
});
