/**
 * Worktree search focus: scroll the inventory row only after it is in a
 * visible pane, and scroll again when the same tree is chosen again.
 */
import { act, render, screen } from '@testing-library/react';
import type { Workspace } from '@gian/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GianWs } from '../src/ws.js';
import { GitPane } from '../src/views/spaces-git-pane.js';

const fixtures = vi.hoisted(() => {
  const claudeMd = { exists: false, lines: 0, mtime: null };
  return {
    repo: {
      git: {
        isRepo: true,
        remote: null,
        defaultBranch: 'main',
        currentBranch: 'main',
        lastCommit: null,
        modifiedCount: 0,
        pendingOp: null,
      },
      claudeMd,
    },
    branches: [
      {
        name: 'main',
        upstream: null,
        ahead: 0,
        behind: 0,
        gone: false,
        lastCommit: null,
        worktreePath: '/tmp/navigation-workspace',
        isWorktreeBranch: false,
        session: null,
      },
      {
        name: 'feature',
        upstream: null,
        ahead: 0,
        behind: 0,
        gone: false,
        lastCommit: null,
        worktreePath: '/tmp/feature',
        isWorktreeBranch: true,
        session: { id: 's-9', name: 'gian-dev-release-0-6-7' },
      },
    ],
    trees: [
      {
        id: 'main',
        kind: 'main' as const,
        label: 'main',
        path: '/tmp/navigation-workspace',
        branch: 'main',
        isDirty: false,
        modifiedCount: 0,
        claudeMd,
        session: undefined,
      },
      {
        id: 'wt',
        kind: 'worktree' as const,
        label: 'gian-dev-release-0-6-7',
        path: '/tmp/feature',
        branch: 'feature',
        isDirty: false,
        modifiedCount: 0,
        claudeMd,
        session: { id: 's-9', name: 'gian-dev-release-0-6-7' },
      },
    ],
  };
});

vi.mock('../src/api.js', () => ({
  loadRepoInfo: vi.fn(async () => fixtures.repo),
  loadBranches: vi.fn(async () => fixtures.branches),
  loadWorkspaceTrees: vi.fn(async () => fixtures.trees),
}));

vi.mock('../src/operations/use-operations.js', () => ({
  useOperationDispatch: () => () => ({ id: 'run-1' }),
  useOperationPending: () => false,
  useOperationRun: () => undefined,
}));

const workspace: Workspace = {
  id: 'workspace-nav',
  name: 'Navigation workspace',
  path: '/tmp/navigation-workspace',
  sort_order: 0,
  hidden: 0,
  pinned: 0,
  created_at: '2026-08-08T00:00:00.000Z',
  updated_at: '2026-08-08T00:00:00.000Z',
};

const ws = { onMessage: () => () => {} } as unknown as GianWs;

function targetRow(): HTMLElement {
  const row = document.querySelector('[data-wt-id="wt:s-9"]');
  if (!(row instanceof HTMLElement)) throw new Error('missing worktree row');
  return row;
}

describe('GitPane worktree focus', () => {
  let scrolled: HTMLElement[];

  beforeEach(() => {
    scrolled = [];
    vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(function scroll(this: HTMLElement) {
      scrolled.push(this);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function renderPane(props: {
    hidden?: boolean;
    displayNone?: boolean;
    focusVisible: boolean;
    focusNonce: number;
  }) {
    return render(
      <div
        hidden={props.hidden || undefined}
        style={props.displayNone ? { display: 'none' } : undefined}
      >
        <GitPane
          workspace={workspace}
          ws={ws}
          onOpenClaudeMd={() => {}}
          onChange={() => {}}
          focusTreeId="wt:s-9"
          focusNonce={props.focusNonce}
          focusVisible={props.focusVisible}
        />
      </div>,
    );
  }

  it('scrolls when the pane becomes visible and again when the same tree is chosen', async () => {
    const view = renderPane({ focusVisible: false, focusNonce: 1 });
    expect(await screen.findByText('gian-dev-release-0-6-7')).toBeTruthy();
    await act(async () => { await Promise.resolve(); });
    expect(scrolled).toEqual([]);

    view.rerender(
      <div>
        <GitPane
          workspace={workspace}
          ws={ws}
          onOpenClaudeMd={() => {}}
          onChange={() => {}}
          focusTreeId="wt:s-9"
          focusNonce={1}
          focusVisible
        />
      </div>,
    );
    await act(async () => { await Promise.resolve(); });
    expect(scrolled).toEqual([targetRow()]);

    scrolled.length = 0;
    view.rerender(
      <div>
        <GitPane
          workspace={workspace}
          ws={ws}
          onOpenClaudeMd={() => {}}
          onChange={() => {}}
          focusTreeId="wt:s-9"
          focusNonce={1}
          focusVisible
        />
      </div>,
    );
    await act(async () => { await Promise.resolve(); });
    expect(scrolled).toEqual([]);

    view.rerender(
      <div>
        <GitPane
          workspace={workspace}
          ws={ws}
          onOpenClaudeMd={() => {}}
          onChange={() => {}}
          focusTreeId="wt:s-9"
          focusNonce={2}
          focusVisible
        />
      </div>,
    );
    await act(async () => { await Promise.resolve(); });
    expect(scrolled).toEqual([targetRow()]);
  });

  it('does not scroll a row under the hidden attribute', async () => {
    renderPane({ hidden: true, focusVisible: true, focusNonce: 1 });
    expect(await screen.findByText('gian-dev-release-0-6-7')).toBeTruthy();
    await act(async () => { await Promise.resolve(); });
    expect(scrolled).toEqual([]);
  });

  it('does not scroll a row inside a display:none sheet', async () => {
    renderPane({ displayNone: true, focusVisible: true, focusNonce: 1 });
    expect(await screen.findByText('gian-dev-release-0-6-7')).toBeTruthy();
    await act(async () => { await Promise.resolve(); });
    expect(scrolled).toEqual([]);
  });
});
