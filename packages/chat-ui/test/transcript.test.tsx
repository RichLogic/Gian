// chat-ui Transcript container: loading/older/error/empty states, working
// indicator, turn work blocks, pending interactions, extras, overlay slot.

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Transcript } from '../src/transcript.js';
import type { ApprovalItem, CommandItem, MsgItem, StatusItem } from '../src/types.js';

const onApprove = vi.fn();

function userMsg(overrides: Partial<MsgItem> = {}): MsgItem {
  return { kind: 'user', id: 'u-1', text: 'do it', exec: 'claude', ts: 100, turn: 1, ...overrides };
}
function assistantMsg(overrides: Partial<MsgItem> = {}): MsgItem {
  return { kind: 'assistant', id: 'a-1', text: 'done', exec: 'claude', ts: 250, turn: 1, ...overrides };
}
function cmd(overrides: Partial<CommandItem> = {}): CommandItem {
  return { kind: 'command', id: 'c-1', command: 'ls', status: 'success', stdout: '', ts: 200, turn: 1, ...overrides };
}
function turnEnd(overrides: Partial<StatusItem> = {}): StatusItem {
  return { kind: 'turn-end', id: 'te-1', text: '', ts: 300, turn: 1, outcome: 'worked', ...overrides };
}
function approval(overrides: Partial<ApprovalItem> = {}): ApprovalItem {
  return {
    kind: 'approval', id: 'ap-1', approvalId: 'ap-1', title: 'Bash', reason: '', cmd: 'ls',
    risk: 'medium', status: 'pending', category: 'command', ts: 260, turn: 1, ...overrides,
  };
}

describe('Transcript states', () => {
  it('empty state only once hydrated and not pending', () => {
    const { container, rerender } = render(
      <Transcript items={[]} pending={false} onApprove={onApprove} hydrated={false} />,
    );
    expect(container.querySelector('.transcript-empty')).toBeNull();
    rerender(<Transcript items={[]} pending={false} onApprove={onApprove} hydrated />);
    expect(container.querySelector('.transcript-empty')!.textContent).toBe('say hi to start the conversation');
    rerender(<Transcript items={[]} pending onApprove={onApprove} hydrated />);
    expect(container.querySelector('.transcript-empty')).toBeNull();
  });

  it('renders the load-older button and reports the click', async () => {
    const user = userEvent.setup();
    const onLoadOlder = vi.fn();
    render(
      <Transcript items={[userMsg()]} pending={false} onApprove={onApprove} hasOlder onLoadOlder={onLoadOlder} />,
    );
    await user.click(screen.getByText('Load earlier messages'));
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });

  it('loading-older disables the button and swaps the label', () => {
    render(
      <Transcript items={[userMsg()]} pending={false} onApprove={onApprove} hasOlder loadingOlder onLoadOlder={vi.fn()} />,
    );
    expect(screen.getByText('Loading earlier messages…')).toBeDisabled();
  });

  it('history errors render role=alert with retry; 401 uses the unauthorized copy', async () => {
    const user = userEvent.setup();
    const onRetryHistory = vi.fn();
    const { rerender } = render(
      <Transcript items={[]} pending={false} onApprove={onApprove}
        historyError={{ status: 500, operation: 'initial' }} onRetryHistory={onRetryHistory} />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load message history.');
    await user.click(screen.getByText('Retry history load'));
    expect(onRetryHistory).toHaveBeenCalledTimes(1);
    rerender(
      <Transcript items={[]} pending={false} onApprove={onApprove}
        historyError={{ status: 401, operation: 'initial' }} onRetryHistory={onRetryHistory} />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('no longer authorized');
  });

  it('an older-page error keeps its distinct copy', () => {
    render(
      <Transcript items={[userMsg()]} pending={false} onApprove={onApprove}
        historyError={{ status: 500, operation: 'older' }} onRetryHistory={vi.fn()} />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load earlier messages.');
  });
});

describe('Transcript body', () => {
  it('renders user + assistant bubbles and folds the turn into Worked', () => {
    const { container } = render(
      <Transcript items={[userMsg(), cmd(), assistantMsg(), turnEnd()]} pending={false} onApprove={onApprove} />,
    );
    expect(container.querySelector('.msg.user')).not.toBeNull();
    expect(container.querySelector('.msg-text.md')!.textContent).toBe('done');
    const work = container.querySelector('[data-testid="turn-work"]')!;
    expect(work.getAttribute('data-state')).toBe('worked');
    expect(work.textContent).toContain('Worked');
  });

  it('a live turn shows the Working block; the working indicator slot renders when pending', () => {
    const { container } = render(
      <Transcript items={[userMsg(), cmd({ status: 'running' })]} pending onApprove={onApprove}
        workingIndicator={<span data-testid="working">…</span>} />,
    );
    const work = container.querySelector('[data-testid="turn-work"]')!;
    expect(work.getAttribute('data-state')).toBe('working');
    expect(screen.getByTestId('working')).toBeInTheDocument();
  });

  it('no working indicator while waiting on the user (trailing approval)', () => {
    render(
      <Transcript items={[userMsg(), approval()]} pending onApprove={onApprove}
        workingIndicator={<span data-testid="working">…</span>} />,
    );
    expect(screen.queryByTestId('working')).toBeNull();
    expect(screen.getByText('Allow once')).toBeInTheDocument();
  });

  it('hiddenApprovalId suppresses the pinned card', () => {
    render(
      <Transcript items={[userMsg(), approval()]} pending={false} onApprove={onApprove} hiddenApprovalId="ap-1" />,
    );
    expect(screen.queryByText('Allow once')).toBeNull();
  });

  it('pending approvals stay inline after the terminal block, resolved ones fold', () => {
    const { container } = render(
      <Transcript items={[userMsg(), cmd(), approval(), assistantMsg(), turnEnd()]} pending={false} onApprove={onApprove} />,
    );
    expect(container.querySelector('[data-testid="turn-work"]')).not.toBeNull();
    // Pending card stays outside the fold, after the block.
    expect(screen.getByText('Allow once')).toBeInTheDocument();
    expect(container.querySelector('.approval-line')).toBeNull();
  });

  it('extras interleave by timestamp', () => {
    const { container } = render(
      <Transcript
        items={[userMsg(), assistantMsg({ ts: 400 })]}
        pending={false}
        onApprove={onApprove}
        extras={[{ id: 'x1', afterTs: 150, node: <div className="extra-card">subtask</div> }]}
      />,
    );
    const text = container.querySelector('.transcript')!.textContent!;
    expect(text.indexOf('do it')).toBeLessThan(text.indexOf('subtask'));
    expect(text.indexOf('subtask')).toBeLessThan(text.indexOf('done'));
  });

  it('the overlay slot receives the transcript root ref', () => {
    const renderOverlay = vi.fn().mockReturnValue(<div data-testid="overlay" />);
    render(<Transcript items={[userMsg()]} pending={false} onApprove={onApprove} renderOverlay={renderOverlay} />);
    expect(screen.getByTestId('overlay')).toBeInTheDocument();
    expect(renderOverlay.mock.calls[0]![0]).toHaveProperty('current');
  });

  it('turn-end footer slot renders for a text-free failed turn', () => {
    const { container } = render(
      <Transcript
        items={[userMsg(), cmd({ status: 'error' }), turnEnd({ outcome: 'failed' })]}
        pending={false}
        onApprove={onApprove}
        renderTurnEndFooter={() => <button type="button" className="fork-turn-btn">F</button>}
      />,
    );
    expect(container.querySelector('.turn-result-fallback .fork-turn-btn')).not.toBeNull();
  });

  it('assistant footer actions render only on the terminal result message', () => {
    const { container } = render(
      <Transcript
        items={[userMsg(), cmd(), assistantMsg(), turnEnd()]}
        pending={false}
        onApprove={onApprove}
        renderAssistantFooterActions={() => <button type="button" className="fork-turn-btn">F</button>}
      />,
    );
    const foot = container.querySelector('.msg-foot .fork-turn-btn');
    expect(foot).not.toBeNull();
    // The result footer also owns Copy.
    expect(container.querySelector('.msg-foot .msg-copy')).not.toBeNull();
  });
});
