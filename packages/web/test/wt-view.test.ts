// View-level working-tree override: per-session persistence + resolution
// precedence. Guards the 2026-08-06 regression where a branch-picker choice
// silently reverted to the primary checkout ("main") after a reload.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  readWtViewOverride,
  writeWtViewOverride,
  readWtAutoApplied,
  writeWtAutoApplied,
  decideWorktreeViewRequest,
  resolveViewedTreeId,
  worktreeDisplayName,
} from '../src/presentation/wt-view.js';

beforeEach(() => localStorage.clear());

describe('worktree display name', () => {
  it('uses the checkout directory instead of its branch or session label', () => {
    expect(worktreeDisplayName({
      path: '/Users/rich/Coding/worktrees/gian-dev-0.4.1-bug-fix/',
      label: 'CLI Proxy 插件化',
    })).toBe('gian-dev-0.4.1-bug-fix');
  });

  it('supports Windows separators and falls back when the path has no name', () => {
    expect(worktreeDisplayName({ path: 'C:\\worktrees\\gian-fix', label: 'fallback' })).toBe('gian-fix');
    expect(worktreeDisplayName({ path: '/', label: 'Primary checkout' })).toBe('Primary checkout');
  });
});

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

describe('worktree view requests', () => {
  it('opens trusted Tool requests immediately, including during a Turn', () => {
    expect(decideWorktreeViewRequest({
      source: 'gian_tool', status: 'running', processed: false,
    })).toBe('open');
  });

  it('waits for direct Agent detection to reach a terminal Turn before prompting', () => {
    expect(decideWorktreeViewRequest({
      source: 'agent', status: 'running', processed: false,
    })).toBe('wait');
    expect(decideWorktreeViewRequest({
      source: 'agent', status: 'pending', processed: false,
    })).toBe('wait');
    expect(decideWorktreeViewRequest({
      source: 'agent', status: 'done', processed: false,
    })).toBe('prompt');
    expect(decideWorktreeViewRequest({
      source: null, status: 'error', processed: false,
    })).toBe('prompt');
  });

  it('never reopens a processed request over a newer manual pick', () => {
    expect(decideWorktreeViewRequest({
      source: 'gian_tool', status: 'done', processed: true,
    })).toBe('ignore');
    expect(decideWorktreeViewRequest({
      source: 'agent', status: 'done', processed: true,
    })).toBe('ignore');
  });
});
