import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TurnDiffChip } from '../src/components/TurnDiffChip.js';
import type { DiffItem } from '../src/types.js';

function diffItem(): DiffItem {
  return {
    kind: 'diff',
    id: 'diff-7',
    turn: 7,
    ts: 7_000,
    files: [
      { path: 'src/a.ts', add: 4, del: 1, hunks: [] },
      { path: 'src/b.ts', add: 2, del: 0, hunks: [] },
    ],
  };
}

describe('TurnDiffChip', () => {
  it('opens an upward file panel before navigating', async () => {
    const user = userEvent.setup();
    const onShowLastTurn = vi.fn();
    render(
      <TurnDiffChip
        items={[diffItem()]}
        sessionId="session-1"
        onShowLastTurn={onShowLastTurn}
      />,
    );

    await user.click(screen.getByRole('button', { name: /2 files/i }));

    expect(screen.getByRole('region', { name: 'Last turn' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /src\/a\.ts/i })).toBeInTheDocument();
    expect(onShowLastTurn).not.toHaveBeenCalled();
  });

  it('pins the selected file to the card turn and closes the panel', async () => {
    const user = userEvent.setup();
    const onShowLastTurn = vi.fn();
    render(
      <TurnDiffChip
        items={[diffItem()]}
        sessionId="session-1"
        onShowLastTurn={onShowLastTurn}
      />,
    );

    await user.click(screen.getByRole('button', { name: /2 files/i }));
    await user.click(screen.getByRole('button', { name: /src\/a\.ts/i }));

    expect(onShowLastTurn).toHaveBeenCalledWith(7, 'src/a.ts');
    expect(screen.queryByRole('region', { name: 'Last turn' })).toBeNull();
  });
});
