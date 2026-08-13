// PathBreadcrumb dropdown behaviour:
//   - The session menu and the branch (worktree) dropdown are mutually
//     exclusive — opening one must close the other (2026-08-04: both could
//     stay open at once because the outside-click handler only fires outside
//     BOTH menus/anchors).

import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PathBreadcrumb } from '../src/components/PathBreadcrumb.js';
import type { PathSegment, SessionMenuActions } from '../src/components/PathBreadcrumb.js';

const segments: PathSegment[] = [
  { kind: 'workspace', label: 'Gian-Dev' },
  { kind: 'session', label: 'bug fix', menuAnchor: true },
  { kind: 'branch', label: 'gian-dev-subtask-running-check' },
];

function renderBreadcrumb(
  onBranchOpen?: () => void,
  sessionMenu: SessionMenuActions = { onRename: () => {} },
) {
  return render(
    <PathBreadcrumb
      segments={segments}
      sessionMenu={sessionMenu}
      branchMenu={{
        onOpen: onBranchOpen,
        items: [
          { id: 'w1', label: 'Gian-Dev', detail: 'main · Primary' },
          { id: 'w2', label: 'gian-dev-subtask-running-check', detail: 'fix/subtask-running-check', active: true },
        ],
        onPick: () => {},
      }}
    />,
  );
}

const openMenus = () => document.querySelectorAll('.session-menu').length;

describe('PathBreadcrumb dropdowns', () => {
  it('shows only the worktree icon and chevrons between segments', () => {
    const { container } = renderBreadcrumb();
    expect(container.querySelectorAll('[data-icon="folder-code"]')).toHaveLength(0);
    expect(container.querySelectorAll('[data-icon="message-square"]')).toHaveLength(0);
    expect(container.querySelectorAll('[data-icon="git-branch"]')).toHaveLength(1);
    expect(container.querySelectorAll('.path-sep [data-icon="chevron-right"]')).toHaveLength(2);
    expect(container.querySelector('.path-sep')?.textContent).toBe('');
  });

  it('opens the session menu from the session segment', async () => {
    const user = userEvent.setup();
    renderBreadcrumb();
    await user.click(screen.getByRole('button', { name: /bug fix/ }));
    expect(screen.getByText('Rename')).toBeTruthy();
    expect(openMenus()).toBe(1);
  });

  it('runs the move-to-task action and closes the session menu', async () => {
    const user = userEvent.setup();
    const onAssignTask = vi.fn();
    renderBreadcrumb(undefined, { onRename: () => {}, onAssignTask });

    await user.click(screen.getByRole('button', { name: /bug fix/ }));
    await user.click(screen.getByRole('button', { name: /Move to task/ }));

    expect(onAssignTask).toHaveBeenCalledOnce();
    expect(openMenus()).toBe(0);
  });

  it('opening the branch dropdown closes the session menu', async () => {
    const user = userEvent.setup();
    renderBreadcrumb();
    await user.click(screen.getByRole('button', { name: /bug fix/ }));
    expect(screen.getByText('Rename')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /gian-dev-subtask-running-check/ }));
    expect(screen.queryByText('Rename')).toBeNull();
    expect(screen.getByText('main · Primary')).toBeTruthy();
    expect(openMenus()).toBe(1);
  });

  it('refreshes working trees whenever the branch dropdown opens', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    renderBreadcrumb(onOpen);
    const branch = screen.getByRole('button', { name: /gian-dev-subtask-running-check/ });

    await user.click(branch);
    expect(onOpen).toHaveBeenCalledTimes(1);
    await user.click(branch); // close: no refresh
    expect(onOpen).toHaveBeenCalledTimes(1);
    await user.click(branch);
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it('opening the session menu closes the branch dropdown', async () => {
    const user = userEvent.setup();
    renderBreadcrumb();
    await user.click(screen.getByRole('button', { name: /gian-dev-subtask-running-check/ }));
    expect(screen.getByText('main · Primary')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /bug fix/ }));
    expect(screen.queryByText('main · Primary')).toBeNull();
    expect(screen.getByText('Rename')).toBeTruthy();
    expect(openMenus()).toBe(1);
  });

  it('worktree dropdown is content-sized and keeps branch as secondary detail', async () => {
    const user = userEvent.setup();
    renderBreadcrumb();
    await user.click(screen.getByRole('button', { name: /gian-dev-subtask-running-check/ }));
    const menu = document.querySelector('.session-menu.branch-menu');
    expect(menu).toBeTruthy();
    // The breadcrumb segment itself is also a button with the same name; pick
    // the one inside the menu.
    const menuRow = within(menu as HTMLElement).getByRole('button', { name: /gian-dev-subtask-running-check/ });
    expect(menuRow.getAttribute('title')).toBe('gian-dev-subtask-running-check');
    expect(menuRow.querySelector('.item-label')?.textContent).toBe('gian-dev-subtask-running-check');
    expect(menuRow.querySelector('.sub')?.textContent).toBe('fix/subtask-running-check');
  });
});
