// chat-ui interaction cards: approval, question, native choice, exit-plan,
// protocol actions/inputs, resolved lines, and the resolving state.

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApprovalCard, ApprovalLine } from '../src/approval-cards.js';
import type { ApprovalItem } from '../src/types.js';

function approval(overrides: Partial<ApprovalItem> = {}): ApprovalItem {
  return {
    kind: 'approval', id: 'ap-1', approvalId: 'ap-1', title: 'Bash', reason: 'wants to run',
    cmd: 'rm -rf build', risk: 'medium', status: 'pending', category: 'command',
    ts: 1_000, turn: 1, ...overrides,
  };
}

describe('ApprovalCard — generic permission', () => {
  it('renders the command body, risk meta, and the three decisions', () => {
    const { container } = render(<ApprovalCard item={approval({ scopeOptions: ['once', 'session'] })} onApprove={vi.fn()} />);
    expect(container.querySelector('.ap2-kind')!.textContent).toBe('Approval');
    expect(container.querySelector('.ap2-cmd')!.textContent).toContain('$ rm -rf build');
    expect(container.querySelector('.ap2-head-meta')!.textContent).toContain('medium risk');
    expect(screen.getByText('Allow session')).toBeInTheDocument();
    expect(screen.getByText('Allow once')).toBeInTheDocument();
    expect(screen.getByText('Decline')).toBeInTheDocument();
  });

  it('Allow session only appears when the scope allows it', () => {
    render(<ApprovalCard item={approval({ scopeOptions: ['once'] })} onApprove={vi.fn()} />);
    expect(screen.queryByText('Allow session')).toBeNull();
  });

  it('decisions report the approval id + decision through onApprove', async () => {
    const user = userEvent.setup();
    const onApprove = vi.fn();
    render(<ApprovalCard item={approval()} onApprove={onApprove} />);
    await user.click(screen.getByText('Allow once'));
    expect(onApprove).toHaveBeenCalledWith('ap-1', 'allow_once');
  });

  it('resolving disables every action and shows the note', () => {
    render(<ApprovalCard item={approval()} onApprove={vi.fn()} resolving />);
    expect(screen.getByText('Resolving…')).toBeInTheDocument();
    for (const btn of screen.getAllByRole('button')) expect(btn).toBeDisabled();
  });

  it('low/unreported risk renders a fully neutral card', () => {
    const { container } = render(<ApprovalCard item={approval({ risk: 'low' })} onApprove={vi.fn()} />);
    expect(container.querySelector('.ap2.tone-warning')).toBeNull();
    expect(container.querySelector('.ap2-head-meta')).toBeNull();
  });

  it('resolved approvals compress to an approval line', () => {
    const { container } = render(<ApprovalCard item={approval({ status: 'approved-session' })} onApprove={vi.fn()} />);
    expect(container.querySelector('.ap2')).toBeNull();
    expect(container.querySelector('.approval-line')!.textContent).toContain('Allowed for session');
  });
});

describe('ApprovalCard — protocol (gian.proxy/2.0) path', () => {
  it('renders verbatim action buttons, danger pinned last, primary degraded to secondary', async () => {
    const user = userEvent.setup();
    const onApprove = vi.fn();
    const { container } = render(
      <ApprovalCard
        item={approval({
          category: 'other',
          actions: [
            { id: 'reject_once', label: 'No', style: 'danger' },
            { id: 'allow_once', label: 'Yes', style: 'primary' },
            { id: 'allow_always', label: 'Always', style: 'secondary' },
          ],
        })}
        onApprove={onApprove}
      />,
    );
    const buttons = screen.getAllByRole('button').map(b => b.textContent);
    expect(buttons).toEqual(['Yes', 'Always', 'No']);
    expect(screen.getByText('Yes').className).toContain('secondary');
    await user.click(screen.getByText('No'));
    expect(onApprove).toHaveBeenCalledWith('ap-1', 'decline', undefined, { category: 'other', nativeOptionId: 'reject_once' });
    expect(container.querySelector('.ap2-kind')!.textContent).toBe('Approval');
  });

  it('question interactionKind drives the card label; required inputs gate the buttons', async () => {
    const user = userEvent.setup();
    const onApprove = vi.fn();
    render(
      <ApprovalCard
        item={approval({
          cmd: '', title: 'Deploy?', interactionKind: 'question', category: 'other',
          inputs: [{ id: 'env', type: 'single_select', label: 'Env', required: true, choices: [
            { value: 'dev', displayName: 'Dev' }, { value: 'prod', displayName: 'Prod' },
          ] }],
          actions: [{ id: 'allow_once', label: 'Go', style: 'secondary' }],
        })}
        onApprove={onApprove}
      />,
    );
    expect(screen.getByText('Question')).toBeInTheDocument();
    const go = screen.getByText('Go');
    expect(go).toBeDisabled();
    await user.click(screen.getByText('Prod'));
    expect(go).toBeEnabled();
    await user.click(go);
    expect(onApprove).toHaveBeenCalledWith('ap-1', 'allow_once', { env: 'prod' }, { category: 'other', nativeOptionId: 'allow_once' });
  });

  it('boolean and multiline inputs collect values', async () => {
    const user = userEvent.setup();
    const onApprove = vi.fn();
    const { container } = render(
      <ApprovalCard
        item={approval({
          cmd: '', category: 'other',
          inputs: [
            { id: 'ok', type: 'boolean', label: 'I agree', required: true },
            { id: 'note', type: 'multiline_text', label: 'Note', required: false },
          ],
          actions: [{ id: 'allow_once', label: 'Send', style: 'secondary' }],
        })}
        onApprove={onApprove}
      />,
    );
    await user.click(screen.getByRole('checkbox'));
    await user.type(container.querySelector('textarea.approval-text-field')!, 'hello');
    await user.click(screen.getByText('Send'));
    expect(onApprove).toHaveBeenCalledWith('ap-1', 'allow_once', { ok: true, note: 'hello' }, { category: 'other', nativeOptionId: 'allow_once' });
  });
});

describe('ApprovalCard — structured question card', () => {
  const question = approval({
    category: 'question',
    cmd: '',
    questions: [
      { question: 'Which DB?', header: 'DB', multiSelect: false, options: [{ label: 'SQLite' }, { label: 'Postgres' }] },
      { question: 'Which features?', multiSelect: true, options: [{ label: 'Cache' }, { label: 'Queue' }] },
    ],
  });

  it('pages one question at a time and submits all answers together', async () => {
    const user = userEvent.setup();
    const onApprove = vi.fn();
    const { container } = render(<ApprovalCard item={question} onApprove={onApprove} />);
    expect(container.querySelector('.ap2-kind')!.textContent).toBe('Question');
    expect(container.querySelector('.ap2-q-chip')!.textContent).toBe('DB');
    expect(container.querySelector('.ap2-head-meta')!.textContent).toBe('1 / 2');
    // Next gated until answered.
    expect(screen.getByText('Next')).toBeDisabled();
    await user.click(screen.getByText('SQLite'));
    await user.click(screen.getByText('Next'));
    expect(container.querySelector('.ap2-head-meta')!.textContent).toBe('2 / 2');
    await user.click(screen.getByText('Cache'));
    await user.click(screen.getByText('Queue'));
    await user.click(screen.getByText('Submit'));
    expect(onApprove).toHaveBeenCalledWith('ap-1', 'allow_once', {
      'Which DB?': 'SQLite',
      'Which features?': ['Cache', 'Queue'],
    }, { category: 'question' });
  });

  it('Other free text counts as an answer', async () => {
    const user = userEvent.setup();
    const onApprove = vi.fn();
    render(<ApprovalCard item={approval({
      category: 'question', cmd: '',
      questions: [{ question: 'Name?', multiSelect: false, options: [{ label: 'A' }] }],
    })} onApprove={onApprove} />);
    await user.type(screen.getByPlaceholderText('Type a custom answer'), 'custom');
    await user.click(screen.getByText('Submit'));
    expect(onApprove).toHaveBeenCalledWith('ap-1', 'allow_once', { 'Name?': 'custom' }, { category: 'question' });
  });

  it('cancel declines the question', async () => {
    const user = userEvent.setup();
    const onApprove = vi.fn();
    render(<ApprovalCard item={question} onApprove={onApprove} />);
    await user.click(screen.getByText('Cancel'));
    expect(onApprove).toHaveBeenCalledWith('ap-1', 'decline', undefined, { category: 'question' });
  });
});

describe('ApprovalCard — Kimi native question', () => {
  it('renders nativeOptions as a single-select question card; reject folds into Cancel', async () => {
    const user = userEvent.setup();
    const onApprove = vi.fn();
    render(
      <ApprovalCard
        item={approval({
          title: 'AskUserQuestion', category: 'other', cmd: '', reason: 'Pick one',
          nativeOptions: [
            { optionId: 'yes', label: 'Yes', kind: 'allow_once' },
            { optionId: 'no', label: 'No', kind: 'allow_once' },
            { optionId: 'cancel', label: 'Cancel', kind: 'reject_once' },
          ],
        })}
        onApprove={onApprove}
      />,
    );
    expect(screen.getByText('Pick one')).toBeInTheDocument();
    const submit = screen.getByText('Submit');
    expect(submit).toBeDisabled();
    await user.click(screen.getByText('No'));
    await user.click(submit);
    expect(onApprove).toHaveBeenCalledWith('ap-1', 'allow_once', undefined, { category: 'other', nativeOptionId: 'no' });
  });
});

describe('ApprovalCard — native choice (non-question)', () => {
  it('renders the executor-owned buttons verbatim with reject pinned last', async () => {
    const user = userEvent.setup();
    const onApprove = vi.fn();
    render(
      <ApprovalCard
        item={approval({
          category: 'command', title: 'Bash',
          nativeOptions: [
            { optionId: 'r1', label: 'Reject', kind: 'reject_once' },
            { optionId: 'a1', label: 'Allow', kind: 'allow_once' },
            { optionId: 'a2', label: 'Always allow', kind: 'allow_always' },
          ],
        })}
        onApprove={onApprove}
      />,
    );
    expect(screen.getAllByRole('button').map(b => b.textContent)).toEqual(['Allow', 'Always allow', 'Reject']);
    await user.click(screen.getByText('Always allow'));
    expect(onApprove).toHaveBeenCalledWith('ap-1', 'allow_session', undefined, { category: 'command', nativeOptionId: 'a2' });
  });
});

describe('ApprovalCard — exit plan mode', () => {
  it('renders the plan markdown and the three-way action set', async () => {
    const user = userEvent.setup();
    const onApprove = vi.fn();
    const { container } = render(
      <ApprovalCard
        item={approval({
          category: 'exit_plan_mode', title: 'Plan', cmd: '# Plan\n\n1. do it',
          planActions: ['accept_with_auto', 'accept_with_ask', 'keep_planning'],
        })}
        onApprove={onApprove}
      />,
    );
    expect(container.querySelector('.ap2-kind')!.textContent).toBe('Plan');
    expect(container.querySelector('.approval-plan-md h1')!.textContent).toBe('Plan');
    expect(screen.getByText('Yes, manually approve edits')).toBeInTheDocument();
    expect(screen.getByText('Yes, auto-accept edits')).toBeInTheDocument();
    await user.click(screen.getByText('No, keep planning'));
    expect(onApprove).toHaveBeenCalledWith('ap-1', 'keep_planning');
  });
});

describe('ApprovalLine', () => {
  it('declined renders ✕ with the declined note', () => {
    const { container } = render(<ApprovalLine item={approval({ status: 'declined' })} />);
    expect(container.querySelector('.al-mark.no')!.textContent).toBe('✕');
    expect(container.querySelector('.al-note')!.textContent).toContain('Declined');
  });
  it('resolved questions surface the picked answer', () => {
    const { container } = render(<ApprovalLine item={approval({
      category: 'question', status: 'approved-once', answeredWith: 'SQLite',
      questions: [{ question: 'Which DB?', multiSelect: false, options: [] }],
    })} />);
    expect(container.querySelector('.al-subject')!.textContent).toBe('Which DB?');
    expect(container.querySelector('.al-note')!.textContent).toContain('SQLite');
  });
});
