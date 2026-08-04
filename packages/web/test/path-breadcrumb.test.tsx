// PathBreadcrumb dropdown behaviour:
//   - The session menu and the branch (worktree) dropdown are mutually
//     exclusive — opening one must close the other (2026-08-04: both could
//     stay open at once because the outside-click handler only fires outside
//     BOTH menus/anchors).

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PathBreadcrumb } from '../src/components/PathBreadcrumb.js';
import type { PathSegment } from '../src/components/PathBreadcrumb.js';

const segments: PathSegment[] = [
  { kind: 'workspace', label: 'Gian-Dev' },
  { kind: 'session', label: 'bug fix', menuAnchor: true },
  { kind: 'branch', label: 'fix/subtask-running-check' },
];

function renderBreadcrumb() {
  return render(
    <PathBreadcrumb
      segments={segments}
      sessionMenu={{ onRename: () => {} }}
      branchMenu={{
        items: [
          { id: 'w1', label: 'main', detail: 'Primary' },
          { id: 'w2', label: 'fix/subtask-running-check', active: true },
        ],
        onPick: () => {},
      }}
    />,
  );
}

const openMenus = () => document.querySelectorAll('.session-menu').length;

describe('PathBreadcrumb dropdowns', () => {
  it('opens the session menu from the session segment', async () => {
    const user = userEvent.setup();
    renderBreadcrumb();
    await user.click(screen.getByRole('button', { name: /bug fix/ }));
    expect(screen.getByText('Rename')).toBeTruthy();
    expect(openMenus()).toBe(1);
  });

  it('opening the branch dropdown closes the session menu', async () => {
    const user = userEvent.setup();
    renderBreadcrumb();
    await user.click(screen.getByRole('button', { name: /bug fix/ }));
    expect(screen.getByText('Rename')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /fix\/subtask-running-check/ }));
    expect(screen.queryByText('Rename')).toBeNull();
    expect(screen.getByText('Primary')).toBeTruthy();
    expect(openMenus()).toBe(1);
  });

  it('opening the session menu closes the branch dropdown', async () => {
    const user = userEvent.setup();
    renderBreadcrumb();
    await user.click(screen.getByRole('button', { name: /fix\/subtask-running-check/ }));
    expect(screen.getByText('Primary')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /bug fix/ }));
    expect(screen.queryByText('Primary')).toBeNull();
    expect(screen.getByText('Rename')).toBeTruthy();
    expect(openMenus()).toBe(1);
  });
});
