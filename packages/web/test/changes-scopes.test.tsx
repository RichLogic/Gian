// Coverage for the Codex-aligned Changes scope picker (FILE-011, web side):
//   The Changes inspector offers six scopes — Last turn, All changes, Added,
//   Unadded, Committed, Branch — grouped Last Turn | working-tree slices |
//   history scopes with hairline separators, via a custom ✓-marked FLAT
//   dropdown (no nested submenus), defaults to Branch, persists the choice,
//   re-queries on switch, and hides the per-file stage toggle outside the
//   working-tree scopes. The primary scope stays in the title row; context
//   picking lives beneath it: Committed shows a searchable commit picker,
//   Branch shows `<head> → <base ⌄>` with a contained searchable branch list.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Inspector } from '../src/components/Inspector.js';
import { renderWithOperations } from './operation-test-utils.js';
import { LocaleProvider } from '../src/i18n/index.js';
import {
  __resetChangesDiffForTests,
  applyChangesScopeRequest,
} from '../src/controllers/use-changes-diff.js';

vi.mock('../src/api.js', () => ({
  loadChanged: vi.fn().mockResolvedValue([
    { path: 'a.ts', kind: 'update', staged: false, added: 1, removed: 0 },
  ]),
  loadCommits: vi.fn().mockResolvedValue([]),
  loadBranchList: vi.fn().mockResolvedValue({
    head: 'feature',
    base: 'origin/main',
    branches: [
      'main',
      'feature',
      'origin/main',
      'feature/this-is-a-very-long-branch-name-that-must-not-expand-the-inspector',
    ],
  }),
  loadTree: vi.fn().mockResolvedValue([]),
  loadAllFiles: vi.fn().mockResolvedValue({ files: [], truncated: false }),
  stageFile: vi.fn().mockResolvedValue(true),
  unstageFile: vi.fn().mockResolvedValue(true),
}));

import * as api from '../src/api.js';
const loadChanged = vi.mocked(api.loadChanged);
const loadCommits = vi.mocked(api.loadCommits);
const loadBranchList = vi.mocked(api.loadBranchList);

function renderChanges() {
  renderWithOperations(
    <LocaleProvider locale="en">
      <Inspector
        tab="changes"
        workingTreeId="wt:s1"
        workingTrees={[]}
        onOpenFile={vi.fn()}
        activeSessionId="session-current"
        canCommit={false}
        onComposePrompt={vi.fn()}
      />
    </LocaleProvider>,
  );
}

async function openScopeMenu(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  await user.click(document.querySelector('.changes-scope-btn') as HTMLElement);
  return document.querySelector('.changes-scope-menu') as HTMLElement;
}

async function pickScope(user: ReturnType<typeof userEvent.setup>, name: RegExp): Promise<void> {
  const menu = await openScopeMenu(user);
  await user.click(within(menu).getByRole('menuitemradio', { name }));
}

describe('Changes scope picker', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetChangesDiffForTests();
    loadChanged.mockClear();
    loadCommits.mockClear();
    loadBranchList.mockClear();
  });

  it('defaults to Branch and queries the branch scope', async () => {
    renderChanges();
    expect(document.querySelector('.changes-scope-btn')?.textContent).toContain('Branch');
    const head = document.querySelector('.insp-head') as HTMLElement;
    const controls = document.querySelector('.changes-controls') as HTMLElement;
    expect(head.children[1]).toHaveClass('changes-scope');
    expect(head.querySelector('.iconbtn')).toBeNull();
    expect(controls).toHaveClass('changes-controls');
    expect(controls.firstElementChild).toHaveClass('changes-base-row');
    expect(document.querySelector('.changes-summary')).toBeNull();
    await waitFor(() => expect(loadChanged).toHaveBeenCalledWith('wt:s1', 'branch', null, null, 'session-current', undefined));
  });

  it('lists the six scopes grouped in order, with a ✓ on the active one', async () => {
    const user = userEvent.setup();
    renderChanges();
    const menu = await openScopeMenu(user);
    const items = Array.from(menu.querySelectorAll(':scope > button'));
    expect(items.map(b => b.textContent?.replace('✓', '').trim())).toEqual([
      'Last turn', 'All changes', 'Added', 'Unadded', 'Committed', 'Branch',
    ]);
    // Two hairline separators: before All changes and before Committed.
    expect(menu.querySelectorAll('.changes-scope-sep')).toHaveLength(2);
    // Branch is the active row — it carries the checkmark + .active class.
    const active = menu.querySelector('button.active');
    expect(active?.textContent).toContain('Branch');
    expect(active?.textContent).toContain('✓');
  });

  it('switching scope re-queries and persists the choice', async () => {
    const user = userEvent.setup();
    renderChanges();
    await waitFor(() => expect(loadChanged).toHaveBeenCalledWith('wt:s1', 'branch', null, null, 'session-current', undefined));

    await pickScope(user, /Unadded/);

    await waitFor(() => expect(loadChanged).toHaveBeenCalledWith('wt:s1', 'unstaged', null, null, 'session-current', undefined));
    expect(localStorage.getItem('gian.changes.scope')).toBe('unstaged');
    // Trigger now reflects the new scope.
    expect(document.querySelector('.changes-scope-btn')?.textContent).toContain('Unadded');
  });

  it('Committed shows a second-row commit picker; picking one pins its sha', async () => {
    const user = userEvent.setup();
    loadCommits.mockResolvedValue([
      { sha: 'abc1234def0000', subject: 'feat: first', rel: '19 hours ago' },
      { sha: '0000ffff11112222', subject: 'fix: second', rel: '2 days ago' },
    ]);
    renderChanges();
    await pickScope(user, /Committed/);
    await waitFor(() => expect(loadCommits).toHaveBeenCalledWith('wt:s1'));
    // Second row appears with the default (latest commit).
    const rowBtn = document.querySelector('.changes-base-btn') as HTMLElement;
    expect(rowBtn.textContent).toContain('Latest commit');
    expect(document.querySelector('.changes-controls')?.firstElementChild).toBe(rowBtn.closest('.changes-base-row'));
    await waitFor(() => expect(loadChanged).toHaveBeenCalledWith('wt:s1', 'commit', null, null, 'session-current', undefined));

    await user.click(rowBtn);
    await user.click(await screen.findByText('feat: first'));
    await waitFor(() => expect(loadChanged).toHaveBeenCalledWith('wt:s1', 'commit', 'abc1234def0000', null, 'session-current', undefined));
    // Row button reflects the pinned commit (short sha).
    expect(document.querySelector('.changes-base-btn')?.textContent).toContain('abc1234');
  });

  it('Branch shows a `<head> → <base>` second row; picking a base re-queries with it', async () => {
    const user = userEvent.setup();
    renderChanges();
    // Default scope is Branch — the second row names the remote default.
    await waitFor(() => expect(loadBranchList).toHaveBeenCalledWith('wt:s1'));
    const row = document.querySelector('.changes-base-row') as HTMLElement;
    expect(row.textContent).toContain('feature');
    expect(row.textContent).toContain('→');
    expect(row.textContent).toContain('origin/main');

    await user.click(document.querySelector('.changes-base-btn') as HTMLElement);
    const menu = document.querySelector('.changes-base-menu') as HTMLElement;
    expect(within(menu).queryByText(/Auto/)).toBeNull();
    expect(within(menu).getAllByRole('menuitemradio', { name: /origin\/main$/ })).toHaveLength(1);
    const longBranch = within(menu).getByText('feature/this-is-a-very-long-branch-name-that-must-not-expand-the-inspector');
    expect(longBranch).toHaveClass('branch-name');
    expect(longBranch.closest('button')).toHaveAttribute('title', longBranch.textContent);
    await user.click(within(menu).getByRole('menuitemradio', { name: 'main' }));
    await waitFor(() => expect(loadChanged).toHaveBeenCalledWith('wt:s1', 'branch', null, 'main', 'session-current', undefined));
    // The explicit base is remembered per working tree.
    expect(localStorage.getItem('gian.changes.base.wt:s1')).toBe('main');
  });

  it('hides the stage toggle outside the working-tree scopes', async () => {
    const user = userEvent.setup();
    renderChanges();
    // Branch (default, a history scope): the file row has no stage chip.
    await screen.findByText('a.ts');
    expect(document.querySelector('.changes-stage')).toBeNull();

    // Switch to Unadded (a working-tree scope): the stage chip appears.
    await pickScope(user, /Unadded/);
    await waitFor(() => expect(document.querySelector('.changes-stage')).not.toBeNull());
  });

  it('accepts a stored "all" scope as All changes', async () => {
    localStorage.setItem('gian.changes.scope', 'all');
    renderChanges();
    expect(document.querySelector('.changes-scope-btn')?.textContent).toContain('All changes');
    await waitFor(() => expect(loadChanged).toHaveBeenCalledWith('wt:s1', 'all', null, null, 'session-current', undefined));
  });

  it('an external scope request (GitBadge click) forces All changes and persists it', async () => {
    localStorage.setItem('gian.changes.scope', 'branch');
    renderChanges();
    // App writes the use-changes-diff store directly (the inspector's old
    // scopeRequest prop is gone).
    act(() => applyChangesScopeRequest('wt:s1', 'all'));
    await waitFor(() => expect(loadChanged).toHaveBeenCalledWith('wt:s1', 'all', null, null, 'session-current', undefined));
    expect(document.querySelector('.changes-scope-btn')?.textContent).toContain('All changes');
    expect(localStorage.getItem('gian.changes.scope')).toBe('all');
  });

  it('pins a Diff-chip request to its exact session and turn', async () => {
    renderChanges();
    act(() => applyChangesScopeRequest('wt:s1', 'lastturn', { sessionId: 'session-card', turn: 7 }));
    await waitFor(() => expect(loadChanged).toHaveBeenCalledWith(
      'wt:s1',
      'lastturn',
      null,
      null,
      'session-card',
      7,
    ));
  });
});
