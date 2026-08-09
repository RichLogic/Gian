import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PlanChip } from '../src/components/PlanChip.js';
import { TurnDiffChip } from '../src/components/TurnDiffChip.js';
import { UnderbarPanelGroup } from '../src/components/UnderbarPanelGroup.js';
import type { AgentSpawnItem, DiffItem } from '../src/types.js';

function agentItem(): AgentSpawnItem {
  return {
    kind: 'agent-spawn',
    id: 'agent-1',
    provider: 'codex',
    description: 'Review the transcript renderer',
    status: 'running',
    startedAt: 100,
    updatedAt: 100,
    ts: 100,
    turn: 1,
  };
}

function diffItem(): DiffItem {
  return {
    kind: 'diff',
    id: 'diff-1',
    turn: 1,
    ts: 200,
    files: [{ path: 'src/chat.tsx', add: 4, del: 1, hunks: [] }],
  };
}

function renderUnderbar() {
  render(
    <UnderbarPanelGroup sessionId="session-1">
      <PlanChip
        sessionId="session-1"
        planText={'## Plan\n- [ ] inspect'}
        items={[agentItem()]}
      />
      <TurnDiffChip
        sessionId="session-1"
        items={[diffItem()]}
        onShowLastTurn={vi.fn()}
      />
      <span data-testid="underbar-blank" />
    </UnderbarPanelGroup>,
  );
}

describe('UnderbarPanelGroup', () => {
  it('keeps Plan, Agent, and Diff upward panels mutually exclusive', async () => {
    const user = userEvent.setup();
    renderUnderbar();

    const planTrigger = screen.getByRole('button', { name: /Plan/i });
    const agentTrigger = screen.getByRole('button', { name: /Agent/i });
    const diffTrigger = screen.getByRole('button', { name: /1 file/i });

    await user.click(planTrigger);
    expect(screen.getByRole('region', { name: 'Plan' })).toBeInTheDocument();

    await user.click(screen.getByText('inspect'));
    expect(screen.getByRole('region', { name: 'Plan' })).toBeInTheDocument();

    await user.click(agentTrigger);
    expect(screen.queryByRole('region', { name: 'Plan' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Agent runs' })).toBeInTheDocument();

    await user.click(diffTrigger);
    expect(screen.queryByRole('region', { name: 'Agent runs' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Last turn' })).toBeInTheDocument();
    expect(planTrigger).toHaveAttribute('aria-expanded', 'false');
    expect(agentTrigger).toHaveAttribute('aria-expanded', 'false');
    expect(diffTrigger).toHaveAttribute('aria-expanded', 'true');

    await user.click(diffTrigger);
    expect(screen.queryByRole('region', { name: 'Last turn' })).not.toBeInTheDocument();
  });

  it('closes the active panel from blank space or Escape', async () => {
    const user = userEvent.setup();
    renderUnderbar();

    const planTrigger = screen.getByRole('button', { name: /Plan/i });
    await user.click(planTrigger);
    await user.click(screen.getByTestId('underbar-blank'));
    expect(screen.queryByRole('region', { name: 'Plan' })).not.toBeInTheDocument();

    await user.click(planTrigger);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('region', { name: 'Plan' })).not.toBeInTheDocument();
  });
});
