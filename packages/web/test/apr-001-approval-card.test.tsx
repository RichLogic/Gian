// Coverage for traceability row (UI dimension):
//   APR-001 — Approval card must support Allow once / Allow session /
//             Decline (via click AND keyboard shortcuts A / Shift+A / D)
//             and surface risk / category / subject / reason text. The
//             "Allow session" button must only appear when the category
//             allows session scope.
//
// Click + risk text path is already touched in
// `packages/host/test/event-smoke.test.ts` and `e2e/specs/04-events-smoke.spec.ts`.
// This file fills the remaining UI dimensions through React Testing Library:
// keyboard shortcuts, conditional Allow-session button, category-aware
// subject formatting, resolved-state rendering.

import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ApprovalItem } from '../src/types.js';
import { ApprovalCard } from '../src/transcript/items.js';

function makeApproval(overrides: Partial<ApprovalItem> = {}): ApprovalItem {
  return {
    kind: 'approval',
    id: 'envelope-1',
    approvalId: 'appr-1',
    title: 'Run shell command',
    reason: 'install project deps',
    cmd: 'npm install',
    risk: 'medium',
    status: 'pending',
    category: 'command',
    scopeOptions: ['once', 'session'],
    ts: Date.UTC(2026, 4, 17, 10, 0, 0),
    turn: 1,
    ...overrides,
  };
}

function makeQuestion(overrides: Partial<ApprovalItem> = {}): ApprovalItem {
  return makeApproval({
    approvalId: 'appr-question',
    title: 'Question from agent',
    reason: '',
    cmd: '',
    risk: 'low',
    category: 'question',
    scopeOptions: ['once'],
    questions: [{
      question: 'Pick dinner',
      header: 'DINNER',
      options: [
        { label: 'Rice', description: 'simple' },
        { label: 'Noodles' },
      ],
    }],
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// APR-001 — surface text: minimal v3 shows only the subject + buttons
// ---------------------------------------------------------------------------

describe('APR-001: pending approval card surface (v3)', () => {
  it('renders the cmd subject with a `$ ` prompt and no v2 chrome', () => {
    const onApprove = vi.fn();
    render(<ApprovalCard item={makeApproval()} onApprove={onApprove} />);

    // Command category renders the `$ ` prompt prefix.
    expect(screen.getByText('npm install')).toBeInTheDocument();
    expect(screen.getByText('$')).toBeInTheDocument();
    // v3 removed the icon / v2 title / risk pill / reason line / timestamp.
    expect(screen.queryByText('Run shell command')).toBeNull();
    expect(screen.queryByText('install project deps')).toBeNull();
    expect(screen.queryByText(/risk/i)).toBeNull();
    expect(document.querySelector('.approval-top')).toBeNull();
    expect(document.querySelector('.approval-ico')).toBeNull();
    expect(document.querySelector('.approval-risk')).toBeNull();
  });

  it('APR-001: cards carry a mono type-label head (Approval / Question / Plan)', () => {
    const { container, rerender } = render(<ApprovalCard item={makeApproval()} onApprove={vi.fn()} />);
    expect(container.querySelector('.approval-head')).toHaveTextContent('Approval');

    rerender(<ApprovalCard item={makeQuestion()} onApprove={vi.fn()} />);
    expect(container.querySelector('.approval-head')).toHaveTextContent('Question');

    rerender(<ApprovalCard
      item={makeApproval({
        category: 'exit_plan_mode',
        cmd: 'plan body',
        scopeOptions: ['once'],
        planActions: ['accept_with_auto', 'accept_with_ask', 'keep_planning'],
      })}
      onApprove={vi.fn()}
    />);
    expect(container.querySelector('.approval-head')).toHaveTextContent('Plan');
  });

  it('APR-001: the resolved .approval-line carries no type-label head', () => {
    const { container } = render(<ApprovalCard
      item={makeApproval({ status: 'approved-once' })}
      onApprove={vi.fn()}
    />);
    expect(container.querySelector('.approval-head')).toBeNull();
  });

  it('APR-001: high risk no longer earns a red outline or badge', () => {
    const { container } = render(<ApprovalCard item={makeApproval({ risk: 'high', title: 'Dangerous shell' })} onApprove={vi.fn()} />);
    expect(container.querySelector('.approval.high')).toBeNull();
    expect(screen.queryByText(/high risk/i)).toBeNull();
  });

  it('APR-001: buttons are secondary / danger-ghost — no primary', () => {
    const { container } = render(<ApprovalCard item={makeApproval()} onApprove={vi.fn()} />);
    expect(container.querySelector('.btn.primary')).toBeNull();
    expect(screen.getByRole('button', { name: /Allow once/i })).toHaveClass('secondary');
    expect(screen.getByRole('button', { name: /Allow session/i })).toHaveClass('secondary');
    expect(screen.getByRole('button', { name: /Decline/i })).toHaveClass('danger-ghost');
  });

  it('APR-001: non-command categories omit the `$ ` shell prefix', () => {
    // Network / file_write_outside_ws etc. show the raw URL / path, no $.
    render(<ApprovalCard
      item={makeApproval({
        category: 'network',
        cmd: 'https://api.example.com/secret',
        title: 'Fetch URL',
      })}
      onApprove={vi.fn()}
    />);
    expect(screen.getByText('https://api.example.com/secret')).toBeInTheDocument();
    // No prompt span should appear in the cmd block for non-command categories.
    expect(screen.queryByText('$')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// APR-001 — Allow session button is conditional on scopeOptions
// ---------------------------------------------------------------------------

describe('APR-001: Allow-session conditional surfaces', () => {
  it('renders Allow session button when scopeOptions includes "session"', () => {
    render(<ApprovalCard item={makeApproval({ scopeOptions: ['once', 'session'] })} onApprove={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Allow session/i })).toBeInTheDocument();
  });

  it('APR-001: hides Allow session button when scopeOptions is ["once"] only', () => {
    // Host marks `category: 'other'` / `exit_plan_mode` / `question` with
    // scopeOptions = ['once']. UI must respect that.
    render(<ApprovalCard item={makeApproval({ scopeOptions: ['once'] })} onApprove={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /Allow session/i })).toBeNull();
  });

  it('APR-001: also defaults to once-only when scopeOptions is omitted', () => {
    const item = makeApproval();
    delete (item as { scopeOptions?: unknown }).scopeOptions;
    render(<ApprovalCard item={item} onApprove={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /Allow session/i })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// APR-001 — click path
// ---------------------------------------------------------------------------

describe('APR-001: click-path decisions', () => {
  it('Allow once button invokes onApprove with allow_once', async () => {
    const user = userEvent.setup();
    const onApprove = vi.fn();
    render(<ApprovalCard item={makeApproval()} onApprove={onApprove} />);

    await user.click(screen.getByRole('button', { name: /Allow once/i }));
    expect(onApprove).toHaveBeenCalledWith('appr-1', 'allow_once');
  });

  it('APR-001: Allow session button invokes onApprove with allow_session', async () => {
    const user = userEvent.setup();
    const onApprove = vi.fn();
    render(<ApprovalCard item={makeApproval()} onApprove={onApprove} />);
    await user.click(screen.getByRole('button', { name: /Allow session/i }));
    expect(onApprove).toHaveBeenCalledWith('appr-1', 'allow_session');
  });

  it('APR-001: Decline button invokes onApprove with decline', async () => {
    const user = userEvent.setup();
    const onApprove = vi.fn();
    render(<ApprovalCard item={makeApproval()} onApprove={onApprove} />);
    await user.click(screen.getByRole('button', { name: /Decline/i }));
    expect(onApprove).toHaveBeenCalledWith('appr-1', 'decline');
  });

  it('APR-001: Question submit includes answers and category context', async () => {
    const user = userEvent.setup();
    const onApprove = vi.fn();
    render(<ApprovalCard item={makeQuestion()} onApprove={onApprove} />);

    await user.click(screen.getByLabelText(/Rice/i));
    await user.click(screen.getByRole('button', { name: /Submit/i }));

    expect(onApprove).toHaveBeenCalledWith(
      'appr-question',
      'allow_once',
      { 'Pick dinner': 'Rice' },
      { category: 'question' },
    );
  });

  it('APR-001: multi-question card surfaces one at a time and submits all answers', async () => {
    const user = userEvent.setup();
    const onApprove = vi.fn();
    const item = makeQuestion({
      questions: [
        { question: 'Pick dinner', header: 'DINNER', options: [{ label: 'Rice' }, { label: 'Noodles' }] },
        { question: 'Pick drink', header: 'DRINK', options: [{ label: 'Tea' }, { label: 'Water' }] },
      ],
    });
    render(<ApprovalCard item={item} onApprove={onApprove} />);

    // Only the first question is in the DOM; progress shows 1 / 2.
    expect(screen.getByText('Pick dinner')).toBeInTheDocument();
    expect(screen.queryByText('Pick drink')).not.toBeInTheDocument();
    expect(screen.getByText('1 / 2')).toBeInTheDocument();

    // Answer Q1 → Next reveals Q2 (and hides Q1).
    await user.click(screen.getByLabelText(/Rice/i));
    await user.click(screen.getByRole('button', { name: /Next/i }));
    expect(screen.getByText('Pick drink')).toBeInTheDocument();
    expect(screen.queryByText('Pick dinner')).not.toBeInTheDocument();
    expect(screen.getByText('2 / 2')).toBeInTheDocument();

    // Answer Q2 → Submit dispatches BOTH answers in one call.
    await user.click(screen.getByLabelText(/Tea/i));
    await user.click(screen.getByRole('button', { name: /Submit/i }));
    expect(onApprove).toHaveBeenCalledWith(
      'appr-question',
      'allow_once',
      { 'Pick dinner': 'Rice', 'Pick drink': 'Tea' },
      { category: 'question' },
    );
  });
});

// ---------------------------------------------------------------------------
// APR-001 — keyboard shortcuts (A / Shift+A / D)
// ---------------------------------------------------------------------------

describe('APR-001: keyboard shortcuts', () => {
  it('A key triggers allow_once on a pending command approval', async () => {
    const user = userEvent.setup();
    const onApprove = vi.fn();
    render(<ApprovalCard item={makeApproval()} onApprove={onApprove} />);

    await user.keyboard('a');
    expect(onApprove).toHaveBeenCalledWith('appr-1', 'allow_once');
  });

  it('APR-001: Shift+A triggers allow_session when scopeOptions includes session', async () => {
    const user = userEvent.setup();
    const onApprove = vi.fn();
    render(<ApprovalCard item={makeApproval()} onApprove={onApprove} />);

    await user.keyboard('{Shift>}A{/Shift}');
    expect(onApprove).toHaveBeenCalledWith('appr-1', 'allow_session');
  });

  it('APR-001: Shift+A is suppressed when scopeOptions excludes session', async () => {
    // Categories with once-only scope must NOT respond to Shift+A — the
    // host disallows session-scope for them and the UI must mirror.
    const user = userEvent.setup();
    const onApprove = vi.fn();
    render(<ApprovalCard
      item={makeApproval({ scopeOptions: ['once'] })}
      onApprove={onApprove}
    />);

    await user.keyboard('{Shift>}A{/Shift}');
    expect(onApprove).not.toHaveBeenCalled();
  });

  it('APR-001: D key triggers decline', async () => {
    const user = userEvent.setup();
    const onApprove = vi.fn();
    render(<ApprovalCard item={makeApproval()} onApprove={onApprove} />);

    await user.keyboard('d');
    expect(onApprove).toHaveBeenCalledWith('appr-1', 'decline');
  });

  it('APR-001: keyboard shortcuts are gated to pending status only', async () => {
    const user = userEvent.setup();
    const onApprove = vi.fn();
    render(<ApprovalCard
      item={makeApproval({ status: 'approved-once' })}
      onApprove={onApprove}
    />);

    await user.keyboard('a');
    await user.keyboard('d');
    expect(onApprove).not.toHaveBeenCalled();
  });

  it('APR-001: keyboard shortcuts are suppressed while focus is in an input/textarea', async () => {
    const user = userEvent.setup();
    const onApprove = vi.fn();
    render(
      <div>
        <textarea data-testid="composer" />
        <ApprovalCard item={makeApproval()} onApprove={onApprove} />
      </div>,
    );

    const textarea = screen.getByTestId('composer');
    textarea.focus();
    await user.keyboard('a');
    await user.keyboard('d');
    expect(onApprove).not.toHaveBeenCalled();
  });

  it('APR-001: A with a modifier (Cmd/Ctrl/Alt) does NOT trigger — only the raw shortcut works', async () => {
    const user = userEvent.setup();
    const onApprove = vi.fn();
    render(<ApprovalCard item={makeApproval()} onApprove={onApprove} />);

    await user.keyboard('{Meta>}a{/Meta}');   // Cmd+A — text selection
    await user.keyboard('{Control>}a{/Control}'); // Ctrl+A — text selection
    await user.keyboard('{Alt>}a{/Alt}');     // Alt+A — accent / OS shortcut
    expect(onApprove).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// APR-001 — exit_plan_mode (three-way actions) suppresses A/Shift+A/D
// ---------------------------------------------------------------------------

describe('APR-001: exit_plan_mode three-way actions', () => {
  it('renders the three semantic buttons instead of allow/decline', () => {
    render(<ApprovalCard
      item={makeApproval({
        category: 'exit_plan_mode',
        title: 'Plan ready for review',
        cmd: '1. Inspect\n2. Edit\n',
        scopeOptions: ['once'],
        planActions: ['accept_with_auto', 'accept_with_ask', 'keep_planning'],
      })}
      onApprove={vi.fn()}
    />);
    expect(screen.getByRole('button', { name: /Yes, auto-accept edits/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Yes, manually approve edits/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /No, keep planning/i })).toBeInTheDocument();
    // Allow/Decline are hidden in plan-exit mode.
    expect(screen.queryByRole('button', { name: /Allow once/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Decline$/i })).toBeNull();
  });

  it('APR-001: A/D shortcuts are suppressed in exit_plan_mode', async () => {
    const user = userEvent.setup();
    const onApprove = vi.fn();
    render(<ApprovalCard
      item={makeApproval({
        category: 'exit_plan_mode',
        title: 'Plan ready for review',
        cmd: 'plan body',
        scopeOptions: ['once'],
        planActions: ['accept_with_auto', 'accept_with_ask', 'keep_planning'],
      })}
      onApprove={onApprove}
    />);
    await user.keyboard('a');
    await user.keyboard('d');
    expect(onApprove).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// APR-001 — resolved-state rendering
// ---------------------------------------------------------------------------

describe('APR-001: resolved approval states', () => {
  it('renders "Allowed once" / "Allowed for session" / "Declined" labels', () => {
    const { rerender } = render(<ApprovalCard
      item={makeApproval({ status: 'approved-once' })}
      onApprove={vi.fn()}
    />);
    expect(screen.getByText(/Allowed once/i)).toBeInTheDocument();

    rerender(<ApprovalCard
      item={makeApproval({ status: 'approved-session' })}
      onApprove={vi.fn()}
    />);
    expect(screen.getByText(/Allowed for session/i)).toBeInTheDocument();

    rerender(<ApprovalCard
      item={makeApproval({ status: 'declined' })}
      onApprove={vi.fn()}
    />);
    // "Declined" appears in BOTH the badge AND the resolved-note text; use
    // getAllByText so a single resolved card doesn't flunk over duplicate matches.
    const declined = screen.getAllByText(/Declined/i);
    expect(declined.length).toBeGreaterThanOrEqual(1);
  });

  it('APR-001: resolved card has no decision buttons (no Allow/Decline)', () => {
    render(<ApprovalCard
      item={makeApproval({ status: 'approved-once' })}
      onApprove={vi.fn()}
    />);
    expect(screen.queryByRole('button', { name: /Allow once/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Decline$/i })).toBeNull();
  });

  it('APR-001: resolved QUESTION compresses to a single line with the picked answer', () => {
    // P1 redesign: resolved approvals/questions are `.approval-line` rows —
    // ✓ + the question text + the answer as the right note — not a card.
    const { container } = render(<ApprovalCard
      item={makeQuestion({ status: 'approved-once', answeredWith: 'Rice' })}
      onApprove={vi.fn()}
    />);
    const line = container.querySelector('.approval-line');
    expect(line).not.toBeNull();
    expect(line!.querySelector('.al-mark.ok')).not.toBeNull();
    expect(screen.getByText('Pick dinner')).toBeInTheDocument();
    expect(screen.getByText('Rice')).toBeInTheDocument();
    // No permission-style leftovers.
    expect(screen.queryByText(/Allowed once/i)).toBeNull();
    expect(screen.queryByText(/by web/i)).toBeNull();
    expect(container.querySelector('.approval-top')).toBeNull();
  });

  it('APR-001: a declined QUESTION line shows ✕ and "cancelled", omitting the answer', () => {
    const { container } = render(<ApprovalCard
      item={makeQuestion({ status: 'declined', answeredWith: 'Rice' })}
      onApprove={vi.fn()}
    />);
    expect(container.querySelector('.approval-line .al-mark.no')).not.toBeNull();
    expect(screen.getByText(/cancelled/i)).toBeInTheDocument();
    // Declined → we did not answer, so the picked-answer line must not show.
    expect(screen.queryByText('Rice')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// APR-001 — resolved approvals compress to `.approval-line` rows
// ---------------------------------------------------------------------------

describe('APR-001: resolved approval line', () => {
  it('renders ✓ + `$ cmd` + "Allowed once · by web" for an approved command', () => {
    const { container } = render(<ApprovalCard
      item={makeApproval({ status: 'approved-once' })}
      onApprove={vi.fn()}
    />);
    const line = container.querySelector('.approval-line');
    expect(line).not.toBeNull();
    expect(line!.querySelector('.al-mark.ok')).toHaveTextContent('✓');
    expect(line!.querySelector('.al-subject')).toHaveTextContent('$ npm install');
    expect(line!.querySelector('.al-note')).toHaveTextContent(/Allowed once · by web/i);
  });

  it('APR-001: declined approvals render ✕ + "Declined · by web"', () => {
    const { container } = render(<ApprovalCard
      item={makeApproval({ status: 'declined', cmd: 'git push --force' })}
      onApprove={vi.fn()}
    />);
    const line = container.querySelector('.approval-line');
    expect(line!.querySelector('.al-mark.no')).toHaveTextContent('✕');
    expect(line!.querySelector('.al-subject')).toHaveTextContent('git push --force');
    expect(line!.querySelector('.al-note')).toHaveTextContent(/Declined · by web/i);
  });
});

// ---------------------------------------------------------------------------
// APR-001 — v3 removed the visible kbd hint chips; the shortcuts themselves
// stay (covered by the keyboard-shortcut suite above).
// ---------------------------------------------------------------------------

describe('APR-001: hint chip removed in v3', () => {
  it('renders no kbd hint chips on a pending card', () => {
    render(<ApprovalCard item={makeApproval()} onApprove={vi.fn()} />);
    expect(document.querySelectorAll('kbd.kc')).toHaveLength(0);
  });
});
