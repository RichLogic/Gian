// Coverage for traceability rows (component rendering dimension):
//   EVT-006 — Codex reasoning must default to a collapsed
//             ReasoningCard with summary/full label and line count.
//   EVT-007 — Codex plan_update + cc exit_plan_mode approval must
//             surface a `PlanChip` that expands the plan inline on click.
//
// The reducer side is already pinned by
// `evt-006-007-008-reducers.test.ts`. This file closes the rendering
// dimension so the matrix rows can leave GAP.

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ApprovalItem, ReasoningItem, TranscriptItem } from '../src/types.js';
import { ReasoningCard } from '../src/transcript/items.js';
import { PlanChip } from '../src/components/PlanChip.js';

function reasoningItem(overrides: Partial<ReasoningItem> = {}): ReasoningItem {
  return {
    kind: 'reasoning',
    id: 'r-1',
    text: 'first line\nsecond line\nthird line',
    variant: 'full',
    ts: 0,
    turn: 1,
    ...overrides,
  };
}

function planApproval(overrides: Partial<ApprovalItem> = {}): ApprovalItem {
  return {
    kind: 'approval',
    id: 'env-1',
    approvalId: 'appr-plan',
    title: 'Plan ready for review',
    reason: '',
    cmd: '1. Inspect\n2. Edit\n3. Test',
    risk: 'low',
    status: 'pending',
    category: 'exit_plan_mode',
    scopeOptions: ['once'],
    planActions: ['accept_with_auto', 'accept_with_ask', 'keep_planning'],
    ts: 0,
    turn: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// EVT-006 — ReasoningCard render
// ---------------------------------------------------------------------------

describe('EVT-006: ReasoningCard component', () => {
  it('renders a folded .evt.thinking shell that is closed by default', () => {
    render(<ReasoningCard item={reasoningItem()} />);
    const shell = screen.getByText('Reasoning').closest('.evt');
    expect(shell).toBeInTheDocument();
    expect(shell).toHaveClass('thinking');
    expect(shell).not.toHaveClass('open');
  });

  it('EVT-006: variant=full carries the "Reasoning" label; summary carries "Reasoning summary"', () => {
    const { rerender } = render(<ReasoningCard item={reasoningItem({ variant: 'full' })} />);
    expect(screen.getByText('Reasoning')).toBeInTheDocument();

    rerender(<ReasoningCard item={reasoningItem({ variant: 'summary' })} />);
    expect(screen.getByText('Reasoning summary')).toBeInTheDocument();
  });

  it('EVT-006: data-variant attribute encodes the variant for CSS styling', () => {
    const { rerender } = render(<ReasoningCard item={reasoningItem({ variant: 'full' })} />);
    expect(screen.getByText('Reasoning').closest('.evt')).toHaveAttribute('data-variant', 'full');

    rerender(<ReasoningCard item={reasoningItem({ variant: 'summary' })} />);
    expect(screen.getByText('Reasoning summary').closest('.evt')).toHaveAttribute('data-variant', 'summary');
  });

  it('EVT-006: surfaces a line count in the header', () => {
    render(<ReasoningCard item={reasoningItem({ text: 'a\nb\nc\nd' })} />);
    expect(screen.getByText('4 lines')).toBeInTheDocument();
  });

  it('EVT-006: empty text renders as "0 lines" — singular/plural respected', () => {
    render(<ReasoningCard item={reasoningItem({ text: '' })} />);
    expect(screen.getByText('0 lines')).toBeInTheDocument();
  });

  it('EVT-006: single-line content uses singular "line"', () => {
    render(<ReasoningCard item={reasoningItem({ text: 'just one' })} />);
    expect(screen.getByText('1 line')).toBeInTheDocument();
  });

  it('EVT-006: clicking the head toggles open and reveals the trace', async () => {
    const user = userEvent.setup();
    render(<ReasoningCard item={reasoningItem()} />);
    const shell = screen.getByText('Reasoning').closest('.evt') as HTMLElement;
    expect(shell).not.toHaveClass('open');
    expect(shell.querySelector('.evt-body')).toBeNull();
    await user.click(screen.getByText('Reasoning'));
    expect(shell).toHaveClass('open');
    expect(shell.querySelector('.evt-body')?.textContent).toContain('first line');
  });
});

// ---------------------------------------------------------------------------
// EVT-007 — PlanChip render
// ---------------------------------------------------------------------------

describe('EVT-007: PlanChip from cc exit_plan_mode approval', () => {
  it('renders the chip with a pending dot when the approval is still pending', () => {
    const items: TranscriptItem[] = [planApproval({ status: 'pending' })];
    render(<PlanChip items={items} sessionId="sess-1" />);
    const chip = screen.getByRole('button', { name: /Plan/i });
    expect(chip).toBeInTheDocument();
    // The status dot carries a class encoding the status.
    expect(chip.querySelector('.plan-chip-dot--pending')).not.toBeNull();
  });

  it('EVT-007: renders an accepted dot when the approval was accepted', () => {
    const items: TranscriptItem[] = [planApproval({ status: 'approved-once' })];
    render(<PlanChip items={items} sessionId="sess-1" />);
    const chip = screen.getByRole('button', { name: /Plan/i });
    expect(chip.querySelector('.plan-chip-dot--accepted')).not.toBeNull();
  });

  it('EVT-007: renders a declined dot when the user keeps planning', () => {
    const items: TranscriptItem[] = [planApproval({ status: 'declined' })];
    render(<PlanChip items={items} sessionId="sess-1" />);
    const chip = screen.getByRole('button', { name: /Plan/i });
    expect(chip.querySelector('.plan-chip-dot--declined')).not.toBeNull();
  });

  it('EVT-007: clicking the chip toggles an inline panel with the approval markdown', async () => {
    const user = userEvent.setup();
    const items: TranscriptItem[] = [planApproval({ cmd: '## Plan\n- step a\n- step b' })];
    render(<PlanChip items={items} sessionId="sess-1" />);

    const chip = screen.getByRole('button', { name: /Plan/i });
    expect(chip).toHaveAttribute('aria-expanded', 'false');
    await user.click(chip);

    expect(chip).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('region', { name: 'Plan' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Plan' })).toBeInTheDocument();
    expect(screen.getByText('step a')).toBeInTheDocument();
    expect(screen.getByText('step b')).toBeInTheDocument();

    await user.click(chip);
    expect(chip).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('region', { name: 'Plan' })).not.toBeInTheDocument();
  });

  it('EVT-007: picks the MOST RECENT exit_plan_mode approval when multiple exist', async () => {
    const user = userEvent.setup();
    const items: TranscriptItem[] = [
      planApproval({ approvalId: 'old', cmd: 'old plan' }),
      // Some unrelated approvals in between
      {
        kind: 'approval', id: 'env-mid', approvalId: 'cmd-1',
        title: 'Bash', reason: 'install', cmd: 'npm install',
        risk: 'medium', status: 'pending', category: 'command',
        ts: 0, turn: 1,
      },
      planApproval({ approvalId: 'new', cmd: 'new plan' }),
    ];
    render(<PlanChip items={items} sessionId="sess-1" />);
    await user.click(screen.getByRole('button', { name: /Plan/i }));
    expect(screen.getByRole('region', { name: 'Plan' })).toHaveTextContent('new plan');
    expect(screen.queryByText('old plan')).not.toBeInTheDocument();
  });
});

describe('EVT-007: PlanChip from codex plan_update', () => {
  // Use JS expression form `{"..."}` so backslash escapes (\n) are real
  // newlines, not literal `\n` (JSX double-quoted attributes pass strings
  // through verbatim without escape processing).
  const LIVE_PLAN = '## Live plan\nstep';

  it('renders the chip when planText is non-empty even without any approval', () => {
    render(<PlanChip items={[]} sessionId="sess-2" planText={LIVE_PLAN} />);
    expect(screen.getByRole('button', { name: /Plan/i })).toBeInTheDocument();
  });

  it('hides a streamed plan after turn-end completion finalizes it', () => {
    const { container } = render(
      <PlanChip
        items={[]}
        sessionId="sess-2"
        planText={'- [x] inspect\n- [x] test'}
        planCompleted
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('EVT-007: clicking the codex chip expands the live plan markdown inline', async () => {
    const user = userEvent.setup();
    render(<PlanChip items={[]} sessionId="sess-2" planText={LIVE_PLAN} />);

    const chip = screen.getByRole('button', { name: /Plan/i });
    await user.click(chip);
    expect(screen.getByRole('region', { name: 'Plan' })).toHaveTextContent('Live plan');
    expect(screen.getByRole('region', { name: 'Plan' })).toHaveTextContent('step');
  });

  it('EVT-007: renders nothing when both items have no plan approval AND planText is empty', () => {
    const { container } = render(<PlanChip items={[]} sessionId="sess-3" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('EVT-007: renders nothing for whitespace-only codex plan text', () => {
    const { container } = render(
      <PlanChip items={[]} sessionId="sess-3" planText={'   \n  '} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('EVT-007: cc exit_plan_mode approval takes precedence over codex planText when both exist', () => {
    // The component checks approval first; codex text is the fallback.
    // We can't directly observe "which one rendered" via the dot alone
    // because pending also exists for codex if approval is pending, but
    // the click callback id is unique enough.
    render(
      <PlanChip
        items={[planApproval({ approvalId: 'cc-plan' })]}
        sessionId="sess-1"
        planText="codex backup plan"
      />,
    );
    const chip = screen.getByRole('button', { name: /Plan/i });
    // The cc plan has a pending dot; codex would render plan-chip-dot--accepted.
    expect(chip.querySelector('.plan-chip-dot--pending')).not.toBeNull();
  });
});
