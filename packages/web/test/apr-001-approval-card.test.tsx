// Coverage for traceability row (UI dimension):
//   APR-001 — Approval card must support Allow once / Allow session /
//             Decline through explicit card controls
//             and surface risk / category / subject / reason text. The
//             "Allow session" button must only appear when the category
//             allows session scope.
//
// Click + risk text path is already touched in
// `packages/host/test/event-smoke.test.ts` and `e2e/specs/04-events-smoke.spec.ts`.
// This file fills the remaining UI dimensions through React Testing Library:
// explicit-decision behavior, conditional Allow-session button, category-aware
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
// APR-001 — surface text: the .ap2 shell shows head + subject + buttons
// ---------------------------------------------------------------------------

describe('APR-001: pending approval card surface (.ap2)', () => {
  it('renders the cmd subject with a `$ ` prompt and no v2 chrome', () => {
    const onApprove = vi.fn();
    render(<ApprovalCard item={makeApproval()} onApprove={onApprove} />);

    // Command category renders the `$ ` prompt prefix.
    expect(screen.getByText('npm install')).toBeInTheDocument();
    expect(screen.getByText('$')).toBeInTheDocument();
    // The v2/v3 chrome (icon title / reason line / risk pill) stays gone —
    // risk surfaces only as the head meta (see the risk-meta suite below).
    expect(screen.queryByText('Run shell command')).toBeNull();
    expect(screen.queryByText('install project deps')).toBeNull();
    expect(document.querySelector('.approval-top')).toBeNull();
    expect(document.querySelector('.approval-ico')).toBeNull();
    expect(document.querySelector('.approval-risk')).toBeNull();
  });

  it('APR-001: cards carry an icon + uppercase kind label head (Approval / Question / Plan)', () => {
    const { container, rerender } = render(<ApprovalCard item={makeApproval()} onApprove={vi.fn()} />);
    expect(container.querySelector('.ap2-head')).not.toBeNull();
    expect(container.querySelector('.ap2-icon svg')).not.toBeNull();
    expect(container.querySelector('.ap2-kind')).toHaveTextContent('Approval');

    rerender(<ApprovalCard item={makeQuestion()} onApprove={vi.fn()} />);
    expect(container.querySelector('.ap2-kind')).toHaveTextContent('Question');

    rerender(<ApprovalCard
      item={makeApproval({
        category: 'exit_plan_mode',
        cmd: 'plan body',
        scopeOptions: ['once'],
        planActions: ['accept_with_auto', 'accept_with_ask', 'keep_planning'],
      })}
      onApprove={vi.fn()}
    />);
    expect(container.querySelector('.ap2-kind')).toHaveTextContent('Plan');
  });

  it('APR-001: the resolved .approval-line carries no .ap2 head', () => {
    const { container } = render(<ApprovalCard
      item={makeApproval({ status: 'approved-once' })}
      onApprove={vi.fn()}
    />);
    expect(container.querySelector('.ap2-head')).toBeNull();
  });

  it('APR-001: risk meta renders only for medium / high; low stays fully neutral', () => {
    // medium → warn meta + warn tone bar class.
    const { container, rerender } = render(<ApprovalCard item={makeApproval({ risk: 'medium' })} onApprove={vi.fn()} />);
    expect(container.querySelector('.ap2.tone-warning')).not.toBeNull();
    const meta = container.querySelector('.ap2-head-meta');
    expect(meta).toHaveTextContent('medium risk');
    expect(meta!.querySelector('.is-medium')).not.toBeNull();

    // high → danger meta + danger tone bar class.
    rerender(<ApprovalCard item={makeApproval({ risk: 'high', title: 'Dangerous shell' })} onApprove={vi.fn()} />);
    expect(container.querySelector('.ap2.tone-danger')).not.toBeNull();
    const highMeta = container.querySelector('.ap2-head-meta');
    expect(highMeta).toHaveTextContent('high risk');
    expect(highMeta!.querySelector('.is-high')).not.toBeNull();

    // low → NO meta, NO tone class: a fully neutral card.
    rerender(<ApprovalCard item={makeApproval({ risk: 'low' })} onApprove={vi.fn()} />);
    expect(container.querySelector('.ap2-head-meta')).toBeNull();
    expect(container.querySelector('.ap2[class*="tone-"]')).toBeNull();
    expect(screen.queryByText(/risk/i)).toBeNull();
  });

  it('APR-001: buttons are secondary / danger-ghost — no primary, danger pinned last', () => {
    const { container } = render(<ApprovalCard item={makeApproval()} onApprove={vi.fn()} />);
    expect(container.querySelector('.btn.primary')).toBeNull();
    expect(screen.getByRole('button', { name: /Allow once/i })).toHaveClass('secondary');
    expect(screen.getByRole('button', { name: /Allow session/i })).toHaveClass('secondary');
    expect(screen.getByRole('button', { name: /Decline/i })).toHaveClass('danger-ghost');

    // The action row is right-aligned with the danger action fixed last.
    const actions = container.querySelector('.ap2-actions')!;
    const buttons = Array.from(actions.querySelectorAll('button'));
    expect(buttons.at(-1)).toHaveClass('danger-ghost');
    expect(buttons.at(-1)).toHaveTextContent(/Decline/i);
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

  it('APR-001: the picked question option row carries is-picked', async () => {
    const user = userEvent.setup();
    const { container } = render(<ApprovalCard item={makeQuestion()} onApprove={vi.fn()} />);

    // Whole-row option cards; nothing picked yet.
    const rows = container.querySelectorAll('.ap2-opt');
    expect(rows.length).toBeGreaterThanOrEqual(3); // Rice, Noodles, Other
    expect(container.querySelector('.ap2-opt.is-picked')).toBeNull();

    await user.click(screen.getByLabelText(/Rice/i));
    const picked = container.querySelector('.ap2-opt.is-picked');
    expect(picked).not.toBeNull();
    expect(picked).toHaveTextContent('Rice');

    // The question progress moved from the button row to the head meta —
    // single-question cards show no progress at all.
    expect(container.querySelector('.question-progress')).toBeNull();

    // "Other" is the same row shape with an inline text input.
    expect(container.querySelector('.ap2-opt.ap2-opt-other input[type="text"]')).not.toBeNull();
  });

  it('APR-001: multi-question progress lives in the head meta', () => {
    const { container } = render(<ApprovalCard
      item={makeQuestion({
        questions: [
          { question: 'Pick dinner', options: [{ label: 'Rice' }] },
          { question: 'Pick drink', options: [{ label: 'Tea' }] },
        ],
      })}
      onApprove={vi.fn()}
    />);
    expect(container.querySelector('.ap2-head .ap2-head-meta')).toHaveTextContent('1 / 2');
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
// Approval decisions require an explicit click. Bare approval-card shortcuts
// were removed from the Keymap because they could fire while the user was
// navigating transcript content.
// ---------------------------------------------------------------------------

describe('APR-001: explicit decisions', () => {
  it('does not bind A, Shift+A, or D to approval decisions', async () => {
    const user = userEvent.setup();
    const onApprove = vi.fn();
    render(<ApprovalCard item={makeApproval()} onApprove={onApprove} />);

    await user.keyboard('a');
    await user.keyboard('{Shift>}A{/Shift}');
    await user.keyboard('d');
    expect(onApprove).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// APR-001 — exit_plan_mode (three-way actions) suppresses A/Shift+A/D
// ---------------------------------------------------------------------------

describe('APR-001: exit_plan_mode three-way actions', () => {
  it('renders the three semantic buttons instead of allow/decline', () => {
    const { container } = render(<ApprovalCard
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
    // Order: manually approve → auto-accept → keep planning (danger last).
    const buttons = Array.from(container.querySelectorAll('.ap2-actions button'));
    expect(buttons.map(b => b.textContent)).toEqual([
      'Yes, manually approve edits',
      'Yes, auto-accept edits',
      'No, keep planning',
    ]);
    expect(buttons.at(-1)).toHaveClass('danger-ghost');
    // The plan body renders in the height-capped markdown block.
    expect(container.querySelector('.ap2-plan')).not.toBeNull();
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

describe('gian.proxy/2.0 interaction actions and inputs', () => {
  it('renders Proxy action labels/styles and submits input values', async () => {
    const user = userEvent.setup();
    const onApprove = vi.fn();
    render(<ApprovalCard
      item={makeApproval({
        actions: [
          { id: 'allow_once', label: 'Allow once', style: 'primary' },
          { id: 'reject_once', label: 'Reject', style: 'danger' },
        ],
        inputs: [
          {
            id: 'reason',
            type: 'text',
            label: 'Reason',
            required: true,
          },
          {
            id: 'confirmed',
            type: 'boolean',
            label: 'Confirmed',
            required: true,
          },
        ],
      })}
      onApprove={onApprove}
    />);

    const allow = screen.getByRole('button', { name: 'Allow once' });
    // No primary anywhere (2026-08-27): a protocol `primary` style degrades
    // to secondary; danger renders danger-ghost and pins to the row's end.
    expect(allow.className).toContain('secondary');
    expect(allow.className).not.toContain('primary');
    expect(screen.getByRole('button', { name: 'Reject' }).className).toContain('danger-ghost');
    expect(allow).toBeDisabled();

    await user.type(screen.getByLabelText('Reason'), 'looks safe');
    expect(allow).toBeDisabled();
    await user.click(screen.getByLabelText('Confirmed'));
    expect(allow).toBeEnabled();
    await user.click(allow);
    expect(onApprove).toHaveBeenCalledWith(
      'appr-1',
      'allow_once',
      { reason: 'looks safe', confirmed: true },
      { category: 'command', nativeOptionId: 'allow_once' },
    );
  });

  it('labels the card head from interactionKind (question/choice/confirmation/permission)', () => {
    const cases = [
      ['question', 'Question'],
      ['choice', 'Choice'],
      ['confirmation', 'Confirmation'],
      ['permission', 'Approval'],
      [undefined, 'Approval'],
    ] as const;
    for (const [interactionKind, label] of cases) {
      const { container, unmount } = render(<ApprovalCard
        item={makeApproval({
          interactionKind,
          actions: [{ id: 'ok', label: 'OK', style: 'primary' }],
        })}
        onApprove={vi.fn()}
      />);
      expect(container.querySelector('.ap2')).not.toBeNull();
      expect(container.querySelector('.ap2-kind')).toHaveTextContent(label);
      unmount();
    }
  });

  it('pins danger-styled protocol actions to the end of the row', () => {
    const { container } = render(<ApprovalCard
      item={makeApproval({
        actions: [
          // Proxy order puts the danger action FIRST — the card must move it last.
          { id: 'reject_once', label: 'Reject', style: 'danger' },
          { id: 'allow_once', label: 'Allow once', style: 'primary' },
          { id: 'allow_session', label: 'Allow session', style: 'secondary' },
        ],
      })}
      onApprove={vi.fn()}
    />);
    const buttons = Array.from(container.querySelectorAll('.ap2-actions button'));
    expect(buttons.map(b => b.textContent)).toEqual(['Allow once', 'Allow session', 'Reject']);
    expect(buttons.at(-1)).toHaveClass('danger-ghost');
    expect(container.querySelector('.btn.primary')).toBeNull();
  });

  it('tints the card root with the tone class', () => {
    // Low-risk fixture: tone comes from the v2 hint alone.
    const { container, unmount } = render(<ApprovalCard
      item={makeApproval({
        interactionKind: 'permission',
        tone: 'warning',
        risk: 'low',
        actions: [{ id: 'ok', label: 'OK', style: 'primary' }],
      })}
      onApprove={vi.fn()}
    />);
    expect(container.querySelector('.ap2.tone-warning')).not.toBeNull();
    unmount();

    const { container: danger } = render(<ApprovalCard
      item={makeApproval({
        interactionKind: 'permission',
        tone: 'danger',
        risk: 'low',
        actions: [{ id: 'ok', label: 'OK', style: 'primary' }],
      })}
      onApprove={vi.fn()}
    />);
    expect(danger.querySelector('.ap2.tone-danger')).not.toBeNull();

    // neutral tone + low risk renders no tone class.
    const { container: neutral } = render(<ApprovalCard
      item={makeApproval({
        interactionKind: 'permission',
        tone: 'neutral',
        risk: 'low',
        actions: [{ id: 'ok', label: 'OK', style: 'primary' }],
      })}
      onApprove={vi.fn()}
    />);
    expect(neutral.querySelector('.ap2')).not.toBeNull();
    expect(neutral.querySelector('.ap2[class*="tone-"]')).toBeNull();
  });

  it('combines v2 tone and risk — the more severe wins the tone bar', () => {
    // warning hint + high risk → danger bar.
    const { container, unmount } = render(<ApprovalCard
      item={makeApproval({
        interactionKind: 'confirmation',
        tone: 'warning',
        risk: 'high',
        actions: [{ id: 'ok', label: 'OK', style: 'secondary' }],
      })}
      onApprove={vi.fn()}
    />);
    expect(container.querySelector('.ap2.tone-danger')).not.toBeNull();
    unmount();

    // danger hint + medium risk → danger bar.
    const { container: danger } = render(<ApprovalCard
      item={makeApproval({
        interactionKind: 'confirmation',
        tone: 'danger',
        risk: 'medium',
        actions: [{ id: 'ok', label: 'OK', style: 'secondary' }],
      })}
      onApprove={vi.fn()}
    />);
    expect(danger.querySelector('.ap2.tone-danger')).not.toBeNull();
  });

  it('renders a prose subject as text and a context subject as a mono block', () => {
    const { container: prose, unmount } = render(<ApprovalCard
      item={makeApproval({
        interactionKind: 'question',
        title: 'What should change?',
        reason: '',
        cmd: 'What should change?',
        actions: [{ id: 'ok', label: 'OK', style: 'primary' }],
      })}
      onApprove={vi.fn()}
    />);
    expect(prose.querySelector('.ap2-prose')).toHaveTextContent('What should change?');
    expect(prose.querySelector('.ap2-cmd')).toBeNull();
    unmount();

    const { container: mono } = render(<ApprovalCard
      item={makeApproval({
        interactionKind: 'permission',
        cmd: 'Bash\nnpm install',
        hasSubject: true,
        actions: [{ id: 'ok', label: 'OK', style: 'primary' }],
      })}
      onApprove={vi.fn()}
    />);
    expect(mono.querySelector('.ap2-cmd')).not.toBeNull();
    expect(mono.querySelector('.ap2-prose')).toBeNull();
  });

  it('renders single_select as a radio list and gates the action on it', async () => {
    const user = userEvent.setup();
    const onApprove = vi.fn();
    const { container } = render(<ApprovalCard
      item={makeApproval({
        interactionKind: 'question',
        cmd: '',
        reason: '',
        actions: [{ id: 'submit', label: 'Submit', style: 'primary' }],
        inputs: [{
          id: 'dinner',
          type: 'single_select',
          label: 'Pick dinner',
          required: true,
          choices: [
            { value: 'rice', displayName: 'Rice' },
            { value: 'noodles', displayName: 'Noodles' },
          ],
        }],
      })}
      onApprove={onApprove}
    />);

    // Radio list, not a native <select> dropdown.
    expect(container.querySelector('select')).toBeNull();
    const radios = container.querySelectorAll('input[type="radio"]');
    expect(radios).toHaveLength(2);

    const submit = screen.getByRole('button', { name: 'Submit' });
    expect(submit).toBeDisabled();
    await user.click(screen.getByLabelText('Rice'));
    expect(submit).toBeEnabled();
    await user.click(submit);
    expect(onApprove).toHaveBeenCalledWith(
      'appr-1',
      'allow_once',
      { dinner: 'rice' },
      { category: 'command', nativeOptionId: 'submit' },
    );
  });

  it('renders multi_select as checkboxes and collects an array answer', async () => {
    const user = userEvent.setup();
    const onApprove = vi.fn();
    const { container } = render(<ApprovalCard
      item={makeApproval({
        interactionKind: 'question',
        cmd: '',
        reason: '',
        actions: [{ id: 'submit', label: 'Submit', style: 'primary' }],
        inputs: [{
          id: 'toppings',
          type: 'multi_select',
          label: 'Pick toppings',
          required: true,
          choices: [
            { value: 'egg', displayName: 'Egg' },
            { value: 'pork', displayName: 'Pork' },
          ],
        }],
      })}
      onApprove={onApprove}
    />);

    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
    const submit = screen.getByRole('button', { name: 'Submit' });
    expect(submit).toBeDisabled();
    await user.click(screen.getByLabelText('Egg'));
    await user.click(screen.getByLabelText('Pork'));
    expect(submit).toBeEnabled();
    await user.click(submit);
    expect(onApprove).toHaveBeenCalledWith(
      'appr-1',
      'allow_once',
      { toppings: ['egg', 'pork'] },
      { category: 'command', nativeOptionId: 'submit' },
    );
  });

  it('renders an actions-only kimi-shaped question as direct option buttons', async () => {
    const user = userEvent.setup();
    const onApprove = vi.fn();
    const { container } = render(<ApprovalCard
      item={makeApproval({
        interactionKind: 'question',
        title: 'AskUserQuestion',
        cmd: '',
        reason: 'Pick dinner',
        nativeOptions: [
          { optionId: 'opt-rice', label: 'Rice', kind: 'allow_once' },
          { optionId: 'opt-noodles', label: 'Noodles', kind: 'allow_once' },
        ],
        actions: [
          { id: 'opt-rice', label: 'Rice', style: 'secondary' },
          { id: 'opt-noodles', label: 'Noodles', style: 'secondary' },
        ],
      })}
      onApprove={onApprove}
    />);

    // Unified card, not the legacy KimiQuestionCard radio+Submit flow.
    expect(container.querySelector('.ap2')).not.toBeNull();
    expect(container.querySelectorAll('input[type="radio"]')).toHaveLength(0);
    expect(container.querySelector('.ap2-kind')).toHaveTextContent('Question');

    // Options answer directly — no prior selection step.
    const rice = screen.getByRole('button', { name: 'Rice' });
    expect(rice).toBeEnabled();
    await user.click(rice);
    expect(onApprove).toHaveBeenCalledWith(
      'appr-1',
      'allow_once',
      undefined,
      { category: 'command', nativeOptionId: 'opt-rice' },
    );
  });

  it('keeps legacy structured questions on the QuestionCard path (no v2 fields)', () => {
    const { container } = render(<ApprovalCard
      item={makeQuestion()}
      onApprove={vi.fn()}
    />);
    // QuestionCard: paged radio options + Back/Next/Submit, not protocol
    // action buttons.
    expect(container.querySelector('.ap2-opts')).not.toBeNull();
    expect(screen.getByText('Pick dinner')).toBeInTheDocument();
  });
});
