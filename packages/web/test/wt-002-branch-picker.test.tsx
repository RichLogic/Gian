// Coverage for traceability row (component dimension):
//   WT-002 — BranchPicker must:
//             • show local + remote branches in separate sections
//             • float the default branch to the top of Local
//             • hide branches that are already checked out in a worktree
//               (to prevent picking a branch git would refuse)
//             • hide remote refs that already have a local tracker
//               (to avoid showing the same logical branch twice)
//             • filter by case-insensitive substring on the full name
//             • surface a "No branches match" empty-state hint

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { LocalBranch, RemoteBranch } from '../src/api.js';
import { BranchPicker } from '../src/components/BranchPicker.js';

function localBranch(overrides: Partial<LocalBranch> = {}): LocalBranch {
  return {
    name: 'feature/x',
    upstream: null,
    ahead: 0,
    behind: 0,
    gone: false,
    lastCommit: null,
    worktreePath: null,
    isWorktreeBranch: false,
    session: null,
    ...overrides,
  };
}

function remoteBranch(overrides: Partial<RemoteBranch> = {}): RemoteBranch {
  return {
    fullName: 'origin/feature/y',
    remote: 'origin',
    branch: 'feature/y',
    lastCommit: { hash: 'abc', subject: 'subject', age: '1 day ago' },
    hasLocalTracking: false,
    ...overrides,
  };
}

function renderPicker(opts: {
  branches?: LocalBranch[];
  remoteBranches?: RemoteBranch[];
  value?: string;
  defaultBranch?: string | null;
  onChange?: ReturnType<typeof vi.fn>;
  disabled?: boolean;
} = {}) {
  const onChange = opts.onChange ?? vi.fn();
  render(
    <BranchPicker
      branches={opts.branches ?? []}
      remoteBranches={opts.remoteBranches ?? []}
      value={opts.value ?? ''}
      defaultBranch={opts.defaultBranch ?? null}
      onChange={onChange}
      disabled={opts.disabled}
      ariaLabel="Pick base branch"
    />,
  );
  return { onChange };
}

async function openPicker(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /Pick base branch/i }));
}

// ---------------------------------------------------------------------------
// WT-002 — sections + grouping
// ---------------------------------------------------------------------------

describe('WT-002: BranchPicker grouping', () => {
  it('renders Local and Remote section headers when both have results', async () => {
    const user = userEvent.setup();
    renderPicker({
      branches: [localBranch({ name: 'main' })],
      remoteBranches: [remoteBranch({ fullName: 'origin/foo', branch: 'foo' })],
    });
    await openPicker(user);
    expect(screen.getByText('Local')).toBeInTheDocument();
    expect(screen.getByText('Remote')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /main/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /origin\/foo/i })).toBeInTheDocument();
  });

  it('WT-002: floats the defaultBranch to the top of Local even when alphabetically later', async () => {
    const user = userEvent.setup();
    renderPicker({
      branches: [
        localBranch({ name: 'aaa-feature' }),
        localBranch({ name: 'main' }),
        localBranch({ name: 'zzz-feature' }),
      ],
      defaultBranch: 'main',
    });
    await openPicker(user);
    const options = screen.getAllByRole('option');
    // First option must be the default branch.
    expect(options[0]!.textContent).toMatch(/^main/);
    // Default badge surfaces on the default-branch row.
    expect(screen.getByText('default')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// WT-002 — occupied / duplicate hiding
// ---------------------------------------------------------------------------

describe('WT-002: occupied + duplicate filters', () => {
  it('hides branches that are already checked out in a worktree (worktreePath != null)', async () => {
    const user = userEvent.setup();
    renderPicker({
      branches: [
        localBranch({ name: 'free-branch' }),
        localBranch({ name: 'busy-branch', worktreePath: '/tmp/busy' }),
      ],
    });
    await openPicker(user);
    expect(screen.queryByRole('option', { name: /busy-branch/i })).toBeNull();
    expect(screen.getByRole('option', { name: /free-branch/i })).toBeInTheDocument();
  });

  it('WT-002: hides a remote ref whose short branch name already has a local tracker', async () => {
    // Avoid two entries for the same logical branch: if `main` exists
    // locally, the `origin/main` entry must NOT also appear.
    const user = userEvent.setup();
    renderPicker({
      branches: [localBranch({ name: 'main' })],
      remoteBranches: [
        remoteBranch({ fullName: 'origin/main', branch: 'main' }),
        remoteBranch({ fullName: 'origin/feature-only', branch: 'feature-only' }),
      ],
    });
    await openPicker(user);
    expect(screen.queryByRole('option', { name: /^origin\/main$/i })).toBeNull();
    expect(screen.getByRole('option', { name: /origin\/feature-only/i })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// WT-002 — filtering
// ---------------------------------------------------------------------------

describe('WT-002: filtering', () => {
  it('filters local + remote together by case-insensitive substring on the FULL name', async () => {
    const user = userEvent.setup();
    renderPicker({
      branches: [
        localBranch({ name: 'main' }),
        localBranch({ name: 'feature/auth' }),
      ],
      remoteBranches: [
        remoteBranch({ fullName: 'origin/feature/billing', branch: 'feature/billing' }),
        remoteBranch({ fullName: 'origin/release', branch: 'release' }),
      ],
    });
    await openPicker(user);
    const search = screen.getByPlaceholderText(/Search local \+ remote branches/i);
    await user.type(search, 'FEAT');
    // Substring matches feature/* on both local and remote.
    expect(screen.getByRole('option', { name: /^feature\/auth/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /origin\/feature\/billing/i })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /^main/i })).toBeNull();
    expect(screen.queryByRole('option', { name: /origin\/release/i })).toBeNull();
  });

  it('WT-002: shows "No branches match" when the filter excludes everything', async () => {
    const user = userEvent.setup();
    renderPicker({
      branches: [localBranch({ name: 'main' })],
    });
    await openPicker(user);
    const search = screen.getByPlaceholderText(/Search local \+ remote branches/i);
    await user.type(search, 'zzz');
    expect(screen.getByText(/No branches match/i)).toBeInTheDocument();
  });

  it('WT-002: shows "No branches" when no branches are provided at all', async () => {
    const user = userEvent.setup();
    renderPicker({ branches: [], remoteBranches: [] });
    await openPicker(user);
    expect(screen.getByText(/^No branches$/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// WT-002 — selection + close behavior
// ---------------------------------------------------------------------------

describe('WT-002: selection + popover lifecycle', () => {
  it('clicking a local branch fires onChange with the branch name AND closes the popover', async () => {
    const user = userEvent.setup();
    const { onChange } = renderPicker({
      branches: [localBranch({ name: 'feature/x' })],
    });
    await openPicker(user);
    await user.click(screen.getByRole('option', { name: /feature\/x/i }));
    expect(onChange).toHaveBeenCalledWith('feature/x');
    // Popover closed — no listbox visible.
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('WT-002: clicking a remote branch fires onChange with the FULL name (origin/foo)', async () => {
    const user = userEvent.setup();
    const { onChange } = renderPicker({
      branches: [],
      remoteBranches: [remoteBranch({ fullName: 'origin/feature/y', branch: 'feature/y' })],
    });
    await openPicker(user);
    await user.click(screen.getByRole('option', { name: /origin\/feature\/y/i }));
    expect(onChange).toHaveBeenCalledWith('origin/feature/y',);
  });

  it('WT-002: the active value gets aria-selected=true', async () => {
    const user = userEvent.setup();
    renderPicker({
      branches: [localBranch({ name: 'main' }), localBranch({ name: 'feature/x' })],
      value: 'feature/x',
    });
    await openPicker(user);
    const active = screen.getByRole('option', { name: /feature\/x/i });
    expect(active).toHaveAttribute('aria-selected', 'true');
    const other = screen.getByRole('option', { name: /^main/i });
    expect(other).toHaveAttribute('aria-selected', 'false');
  });

  it('WT-002: disabled picker cannot be opened', async () => {
    const user = userEvent.setup();
    renderPicker({
      branches: [localBranch({ name: 'main' })],
      disabled: true,
    });
    await user.click(screen.getByRole('button', { name: /Pick base branch/i }));
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('WT-002: trigger button displays placeholder when value is empty', () => {
    renderPicker({ branches: [], value: '' });
    expect(screen.getByText(/Pick a base branch/i)).toBeInTheDocument();
  });

  it('WT-002: trigger button displays the current value when set', () => {
    renderPicker({
      branches: [localBranch({ name: 'main' })],
      value: 'main',
    });
    // The trigger button shows `main` as its label.
    expect(screen.getByRole('button', { name: /Pick base branch/i })).toHaveTextContent('main');
  });
});
