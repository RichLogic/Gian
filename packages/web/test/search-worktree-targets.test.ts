/**
 * Working-tree inventory ids for Git-pane rows (Issue #168 / search
 * contract): main → ws:<workspace>, session-linked → wt:<session>, external
 * → ext:<workspace>:base64url(path). The ext id is ENCODED from the row's
 * own path — never decoded back for navigation.
 */
import { describe, expect, it } from 'vitest';
import type { LocalBranch, WorkspaceTree } from '../src/api.js';
import { inventoryTreeId } from '../src/views/spaces-git-pane.js';

function tree(overrides: Partial<WorkspaceTree>): WorkspaceTree {
  return {
    id: 'x',
    kind: 'worktree',
    label: 'wt',
    path: '/tmp/wt',
    branch: 'feat/x',
    isDirty: false,
    modifiedCount: 0,
    claudeMd: { exists: false, lines: 0, mtime: null },
    ...overrides,
  };
}

describe('inventoryTreeId', () => {
  it('maps the main tree to ws:<workspace>', () => {
    expect(inventoryTreeId('ws-1', tree({ kind: 'main' }), null)).toBe('ws:ws-1');
  });

  it('maps a session-linked worktree to wt:<session>', () => {
    expect(inventoryTreeId('ws-1', tree({ session: { id: 'sess-9', name: null } }), '/tmp/wt')).toBe('wt:sess-9');
  });

  it('encodes external paths without decoding them back', () => {
    const id = inventoryTreeId('ws-1', tree({ path: '/tmp/my worktree/外部' }), null);
    expect(id?.startsWith('ext:ws-1:')).toBe(true);
    const encoded = id!.slice('ext:ws-1:'.length);
    expect(/^[A-Za-z0-9_-]+$/.test(encoded)).toBe(true);
    // Round-trip: the encoding carries the exact path.
    const binary = atob(encoded.replaceAll('-', '+').replaceAll('_', '/'));
    const decoded = new TextDecoder().decode(Uint8Array.from(binary, char => char.charCodeAt(0)));
    expect(decoded).toBe('/tmp/my worktree/外部');
  });

  it('falls back to the branch worktree path when the tree row is missing', () => {
    expect(inventoryTreeId('ws-1', null, '/tmp/wt')?.startsWith('ext:ws-1:')).toBe(true);
    expect(inventoryTreeId('ws-1', null, null)).toBeNull();
  });
});
