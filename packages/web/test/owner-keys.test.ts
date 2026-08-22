import { describe, expect, it } from 'vitest';
import { filesInspectorOwnerKey } from '../src/controllers/use-files-inspector.js';
import { historyCommitOwnerKey } from '../src/controllers/use-history-commit.js';

describe('historyCommitOwnerKey', () => {
  it('is JSON [session, tree, sha] when all parts are present', () => {
    expect(historyCommitOwnerKey('s-1', 'wt-1', 'abc123')).toBe(JSON.stringify(['s-1', 'wt-1', 'abc123']));
  });

  it('is null when any part is missing', () => {
    expect(historyCommitOwnerKey(null, 'wt-1', 'abc123')).toBeNull();
    expect(historyCommitOwnerKey('s-1', null, 'abc123')).toBeNull();
    expect(historyCommitOwnerKey('s-1', 'wt-1', '')).toBeNull();
  });
});

describe('filesInspectorOwnerKey', () => {
  it('is JSON [session, tree] when both parts are present', () => {
    expect(filesInspectorOwnerKey('s-1', 'wt-1')).toBe(JSON.stringify(['s-1', 'wt-1']));
  });

  it('is null when session or tree is missing', () => {
    expect(filesInspectorOwnerKey(undefined, 'wt-1')).toBeNull();
    expect(filesInspectorOwnerKey('s-1', null)).toBeNull();
  });
});
