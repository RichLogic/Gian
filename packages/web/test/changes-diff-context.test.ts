/**
 * Changes inspector "attach diff as context": pure assembly (ordering,
 * 64 KiB budget truncation, empty guards) and the store-level attach flow
 * (load missing patches → assemble → inject one pastedText chip whose first
 * line names the active scope).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MAX_PASTED_TEXT_BYTES, type MessageContextItem } from '@gian/shared';
import type { ChangedEntry } from '../src/api.js';
import * as api from '../src/api.js';
import { injectComposerContextItems } from '../src/components/Composer.js';
import {
  __resetChangesDiffForTests,
  applyChangesScopeRequest,
  getChangesDiffState,
  setChangesDiffScope,
} from '../src/controllers/use-changes-diff.js';
import {
  assembleChangesDiffContextText,
  attachChangesDiffContext,
  changesDiffScopeLabel,
  DIFF_CONTEXT_TRUNCATED_MARKER,
} from '../src/controllers/changes-diff-context.js';
import type { ChangesDiffPatch } from '../src/controllers/use-changes-diff.js';

vi.mock('../src/api.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api.js')>('../src/api.js');
  return {
    ...actual,
    loadBranchList: vi.fn(),
    loadChanged: vi.fn(),
    loadDiff: vi.fn(),
  };
});

vi.mock('../src/components/Composer.js', () => ({
  injectComposerContextItems: vi.fn(() => true),
}));

const loadChanged = vi.mocked(api.loadChanged);
const loadBranchList = vi.mocked(api.loadBranchList);
const loadDiff = vi.mocked(api.loadDiff);
const inject = vi.mocked(injectComposerContextItems);

const FILES: ChangedEntry[] = [
  { path: 'src/a.ts', kind: 'update', staged: false, added: 3, removed: 1 },
  { path: 'src/b.ts', kind: 'create', staged: false, added: 5, removed: 0 },
];

function diffFor(path: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1 +1 @@',
    '-old',
    '+new',
  ].join('\n');
}

function loaded(diff: string, truncated = false): ChangesDiffPatch {
  return { status: 'loaded', diff, truncated };
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetChangesDiffForTests();
  localStorage.clear();
  loadChanged.mockResolvedValue(FILES);
  loadBranchList.mockResolvedValue({ head: 'demo', base: 'origin/main', branches: ['main', 'demo'] });
  loadDiff.mockImplementation(async (_tree: string, path: string) => ({
    diff: diffFor(path),
    truncated: false,
  }));
  inject.mockReturnValue(true);
});

describe('changesDiffScopeLabel', () => {
  const base = { commitSha: null, baseBranch: null, branchList: null, lastTurn: null };
  it('names each scope in English for the model', () => {
    expect(changesDiffScopeLabel({ ...base, scope: 'all' })).toBe('All changes (working tree)');
    expect(changesDiffScopeLabel({ ...base, scope: 'unstaged' })).toBe('Unstaged changes');
    expect(changesDiffScopeLabel({ ...base, scope: 'staged' })).toBe('Staged changes');
    expect(changesDiffScopeLabel({ ...base, scope: 'commit' })).toBe('Latest commit');
    expect(changesDiffScopeLabel({ ...base, scope: 'commit', commitSha: '0123456789abcdef' }))
      .toBe('Commit 0123456');
    expect(changesDiffScopeLabel({ ...base, scope: 'branch' })).toBe('Branch');
    expect(changesDiffScopeLabel({ ...base, scope: 'branch', baseBranch: 'origin/dev' }))
      .toBe('Branch (vs origin/dev)');
    expect(changesDiffScopeLabel({
      ...base, scope: 'branch',
      branchList: { head: 'demo', base: 'origin/main', branches: [] },
    })).toBe('Branch (vs origin/main)');
    expect(changesDiffScopeLabel({ ...base, scope: 'lastturn' })).toBe('Last turn');
    expect(changesDiffScopeLabel({ ...base, scope: 'lastturn', lastTurn: { sessionId: 's', turn: 3 } }))
      .toBe('Last turn (turn 3)');
  });
});

describe('assembleChangesDiffContextText', () => {
  it('joins patches in file-list order under a scope header', () => {
    const result = assembleChangesDiffContextText('Last turn (turn 3)', FILES, {
      'src/a.ts': loaded(diffFor('src/a.ts')),
      'src/b.ts': loaded(diffFor('src/b.ts')),
    })!;
    expect(result.truncated).toBe(false);
    expect(result.unavailable).toEqual([]);
    expect(result.text.startsWith('Diff · Last turn (turn 3)\n\n')).toBe(true);
    expect(result.text.indexOf('diff --git a/src/a.ts')).toBeLessThan(
      result.text.indexOf('diff --git a/src/b.ts'),
    );
  });

  it('marks host-truncated patches inline', () => {
    const result = assembleChangesDiffContextText('Staged changes', [FILES[0]!], {
      'src/a.ts': loaded(diffFor('src/a.ts'), true),
    })!;
    expect(result.text).toContain(`+new\n${DIFF_CONTEXT_TRUNCATED_MARKER}`);
    expect(result.truncated).toBe(false); // the assembly itself fit
  });

  it('omits errored patches and reports them as unavailable', () => {
    const result = assembleChangesDiffContextText('Branch', FILES, {
      'src/a.ts': { status: 'error', diff: null, truncated: false },
      'src/b.ts': loaded(diffFor('src/b.ts')),
    })!;
    expect(result.unavailable).toEqual(['src/a.ts']);
    expect(result.text).not.toContain('src/a.ts');
    expect(result.text).toContain('diff --git a/src/b.ts');
  });

  it('returns null when nothing contributes diff text', () => {
    expect(assembleChangesDiffContextText('Branch', [], {})).toBeNull();
    expect(assembleChangesDiffContextText('Branch', FILES, {
      'src/a.ts': { status: 'error', diff: null, truncated: false },
      'src/b.ts': { status: 'loading', diff: null, truncated: false },
    })).toBeNull();
    expect(assembleChangesDiffContextText('Branch', [FILES[0]!], {
      'src/a.ts': loaded(''),
    })).toBeNull();
  });

  it('truncates oversized diffs at a line boundary inside the pastedText budget', () => {
    // ~120 KiB of diff lines — well past the 64 KiB pastedText cap.
    const big = `${diffFor('src/big.ts')}\n${'+x = 1;\n'.repeat(15_000)}`;
    const result = assembleChangesDiffContextText('Branch', [
      { path: 'src/big.ts', kind: 'update', staged: false, added: 15_000, removed: 0 },
    ], { 'src/big.ts': loaded(big) })!;
    expect(result.truncated).toBe(true);
    expect(result.text.endsWith(`\n${DIFF_CONTEXT_TRUNCATED_MARKER}`)).toBe(true);
    const bytes = new TextEncoder().encode(result.text).byteLength;
    expect(bytes).toBeLessThanOrEqual(MAX_PASTED_TEXT_BYTES);
    // Line-boundary cut: no partial final content line before the marker.
    const body = result.text.slice(0, result.text.lastIndexOf(DIFF_CONTEXT_TRUNCATED_MARKER));
    expect(body.endsWith('+x = 1;\n')).toBe(true);
  });
});

describe('attachChangesDiffContext', () => {
  it('loads missing patches, then injects one pastedText chip labeled with the scope', async () => {
    setChangesDiffScope('ws:demo', 'all', 'session-1');
    await waitForStore('ws:demo', 'session-1');

    const result = await attachChangesDiffContext('ws:demo', 'session-1');
    expect(result).toBe('attached');
    // Both lazy patches were fetched by the attach flow (panel 2 never ran).
    expect(loadDiff).toHaveBeenCalledWith('ws:demo', 'src/a.ts', 'all', null, null);
    expect(loadDiff).toHaveBeenCalledWith('ws:demo', 'src/b.ts', 'all', null, null);

    expect(inject).toHaveBeenCalledTimes(1);
    const [sessionId, items] = inject.mock.calls[0] as [string, MessageContextItem[]];
    expect(sessionId).toBe('session-1');
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.type).toBe('pastedText');
    if (item.type !== 'pastedText') return;
    expect(item.text.startsWith('Diff · All changes (working tree)\n\n')).toBe(true);
    expect(item.text).toContain('diff --git a/src/a.ts');
    expect(item.text).toContain('diff --git a/src/b.ts');
    expect(item.byteSize).toBe(new TextEncoder().encode(item.text).byteLength);
    expect(item.byteSize).toBeLessThanOrEqual(MAX_PASTED_TEXT_BYTES);
  });

  it('labels the chip with the pinned last turn', async () => {
    applyChangesScopeRequest('ws:demo', 'lastturn', { sessionId: 'session-1', turn: 7 }, 'session-1');
    await waitForStore('ws:demo', 'session-1');

    const result = await attachChangesDiffContext('ws:demo', 'session-1');
    expect(result).toBe('attached');
    const [, items] = inject.mock.calls[0] as [string, MessageContextItem[]];
    const item = items[0]!;
    expect(item.type === 'pastedText' && item.text.startsWith('Diff · Last turn (turn 7)\n\n')).toBe(true);
    expect(loadDiff).toHaveBeenCalledWith(
      'ws:demo', 'src/a.ts', 'lastturn', null, null, 'session-1', 7, null,
    );
  });

  it('attaches nothing when every patch failed to load', async () => {
    loadDiff.mockRejectedValue(new Error('git died'));
    setChangesDiffScope('ws:demo', 'all', 'session-1');
    await waitForStore('ws:demo', 'session-1');

    const result = await attachChangesDiffContext('ws:demo', 'session-1');
    expect(result).toBe('empty');
    expect(inject).not.toHaveBeenCalled();
  });

  it('reports full when the composer rejects the chip', async () => {
    inject.mockReturnValue(false);
    setChangesDiffScope('ws:demo', 'all', 'session-1');
    await waitForStore('ws:demo', 'session-1');

    const result = await attachChangesDiffContext('ws:demo', 'session-1');
    expect(result).toBe('full');
  });
});

/** Wait until the scope-triggered list load has settled. */
async function waitForStore(tree: string, owner: string): Promise<void> {
  await vi.waitFor(() => {
    expect(getChangesDiffState(tree, owner).status).toBe('ready');
  });
}
