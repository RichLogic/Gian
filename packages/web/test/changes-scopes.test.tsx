// Coverage for the Codex-aligned Changes scope picker (FILE-011, web side):
//   The Changes inspector offers exactly five scopes — Unstaged, Staged,
//   Commit, Branch, Last turn — via a custom ✓-marked dropdown (not a native
//   <select>), defaults to Branch, persists the choice, re-queries on switch,
//   and hides the per-file stage toggle outside the working-tree scopes.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Inspector } from '../src/components/Inspector.js';
import { LocaleProvider } from '../src/i18n/index.js';

vi.mock('../src/api.js', () => ({
  loadChanged: vi.fn().mockResolvedValue([
    { path: 'a.ts', kind: 'update', staged: false, added: 1, removed: 0 },
  ]),
  loadTree: vi.fn().mockResolvedValue([]),
  loadAllFiles: vi.fn().mockResolvedValue({ files: [], truncated: false }),
  stageFile: vi.fn().mockResolvedValue(true),
  unstageFile: vi.fn().mockResolvedValue(true),
}));

import * as api from '../src/api.js';
const loadChanged = vi.mocked(api.loadChanged);

function renderChanges() {
  render(
    <LocaleProvider locale="en">
      <Inspector
        tab="changes"
        workingTreeId="wt:s1"
        workingTrees={[]}
        onOpenFile={vi.fn()}
        onOpenDiff={vi.fn()}
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

describe('Changes scope picker', () => {
  beforeEach(() => {
    localStorage.clear();
    loadChanged.mockClear();
  });

  it('defaults to Branch and queries the branch scope', async () => {
    renderChanges();
    expect(document.querySelector('.changes-scope-btn')?.textContent).toContain('Branch');
    await waitFor(() => expect(loadChanged).toHaveBeenCalledWith('wt:s1', 'branch'));
  });

  it('lists exactly the five Codex scopes in order, with a ✓ on the active one', async () => {
    const user = userEvent.setup();
    renderChanges();
    const menu = await openScopeMenu(user);
    const items = Array.from(menu.querySelectorAll('button'));
    expect(items.map(b => b.textContent?.replace('✓', '').trim())).toEqual([
      'Unstaged', 'Staged', 'Commit', 'Branch', 'Last turn',
    ]);
    // Branch is the active row — it carries the checkmark + .active class.
    const active = menu.querySelector('button.active');
    expect(active?.textContent).toContain('Branch');
    expect(active?.textContent).toContain('✓');
  });

  it('switching scope re-queries and persists the choice', async () => {
    const user = userEvent.setup();
    renderChanges();
    await waitFor(() => expect(loadChanged).toHaveBeenCalledWith('wt:s1', 'branch'));

    const menu = await openScopeMenu(user);
    await user.click(within(menu).getByRole('menuitemradio', { name: /Unstaged/ }));

    await waitFor(() => expect(loadChanged).toHaveBeenCalledWith('wt:s1', 'unstaged'));
    expect(localStorage.getItem('gian.changes.scope')).toBe('unstaged');
    // Trigger now reflects the new scope.
    expect(document.querySelector('.changes-scope-btn')?.textContent).toContain('Unstaged');
  });

  it('hides the stage toggle outside the working-tree scopes', async () => {
    const user = userEvent.setup();
    renderChanges();
    // Branch (default, a history scope): the file row has no stage chip.
    await screen.findByText('a.ts');
    expect(document.querySelector('.changes-stage')).toBeNull();

    // Switch to Unstaged (a working-tree scope): the stage chip appears.
    const menu = await openScopeMenu(user);
    await user.click(within(menu).getByRole('menuitemradio', { name: /Unstaged/ }));
    await waitFor(() => expect(document.querySelector('.changes-stage')).not.toBeNull());
  });

  it('migrates a legacy stored "all" scope to Branch', async () => {
    localStorage.setItem('gian.changes.scope', 'all');
    renderChanges();
    expect(document.querySelector('.changes-scope-btn')?.textContent).toContain('Branch');
    await waitFor(() => expect(loadChanged).toHaveBeenCalledWith('wt:s1', 'branch'));
  });
});
