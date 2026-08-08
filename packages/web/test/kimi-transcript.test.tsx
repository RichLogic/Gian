import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { EventEnvelope } from '@gian/shared';
import type { ApprovalItem, ToolItem } from '../src/types.js';
import { applyEnvelope } from '../src/transcript/apply.js';
import { ApprovalCard, ToolEvent } from '../src/transcript/items.js';

function envelope(
  event: EventEnvelope['event'],
  callId: string,
  data: Record<string, unknown>,
): EventEnvelope {
  return {
    session_id: 'kimi-session',
    turn: 1,
    call_id: callId,
    event,
    ts: 1,
    data,
  };
}

describe('Kimi transcript events', () => {
  it('upserts ACP tool updates by stable toolCallId', () => {
    let items = applyEnvelope([], envelope('file_read', 'read-1', {
      path: '/workspace/package.json',
    }), 'kimi');
    items = applyEnvelope(items, envelope('file_read', 'read-1', {
      path: '/workspace/package.json',
      startLine: 4,
    }), 'kimi');

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'file-read',
      id: 'read-1',
      path: '/workspace/package.json',
      startLine: 4,
    });
  });

  it('preserves generic tool status, input, and failure output across sparse updates', () => {
    let items = applyEnvelope([], envelope('tool_execution', 'tool-1', {
      itemId: 'tool-1',
      title: 'Deploy',
      status: 'running',
      input: { target: 'staging' },
    }), 'kimi');
    items = applyEnvelope(items, envelope('tool_execution', 'tool-1', {
      itemId: 'tool-1',
      status: 'error',
      output: 'deployment failed',
    }), 'kimi');

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'tool',
      id: 'tool-1',
      name: 'Deploy',
      summary: '{"target":"staging"}',
      status: 'error',
      output: 'deployment failed',
    });

    render(<ToolEvent item={items[0] as ToolItem} />);
    expect(screen.getByText('error')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Deploy'));
    expect(screen.getByText('deployment failed')).toBeInTheDocument();
  });

  it('renders executor-owned approval labels and returns the exact option ID', () => {
    const onApprove = vi.fn();
    const item: ApprovalItem = {
      kind: 'approval',
      id: 'approval-card-1',
      approvalId: 'approval-1',
      title: 'Run deployment',
      reason: 'Needs permission',
      cmd: '',
      risk: 'medium',
      status: 'pending',
      category: 'other',
      nativeOptions: [
        { optionId: 'kimi-once-42', label: 'Allow this time', kind: 'allow_once' },
        { optionId: 'kimi-no-42', label: 'Reject', kind: 'reject_once' },
      ],
      ts: 1,
      turn: 1,
    };

    render(<ApprovalCard item={item} onApprove={onApprove} />);
    // P1 v3: provider buttons render as secondary / danger-ghost, no primary.
    expect(screen.getByRole('button', { name: 'Allow this time' })).toHaveClass('secondary');
    expect(screen.getByRole('button', { name: 'Reject' })).toHaveClass('danger-ghost');
    fireEvent.click(screen.getByRole('button', { name: 'Allow this time' }));

    expect(onApprove).toHaveBeenCalledWith(
      'approval-1',
      'allow_once',
      undefined,
      {
        category: 'other',
        nativeOptionId: 'kimi-once-42',
      },
    );
  });

  it('renders a Kimi AskUserQuestion as a single-select question card (P1)', () => {
    const onApprove = vi.fn();
    // kimi-proxy sends AskUserQuestion with a bare 'AskUserQuestion' title,
    // the question text as the reason, and the answers as nativeOptions.
    const item: ApprovalItem = {
      kind: 'approval',
      id: 'approval-card-q1',
      approvalId: 'approval-q1',
      title: 'AskUserQuestion',
      reason: '这个进行中的 merge 是你发起的吗?',
      cmd: '',
      risk: 'medium',
      status: 'pending',
      category: 'other',
      nativeOptions: [
        { optionId: 'kimi-yes-1', label: '是,继续等它完成', kind: 'allow_once' },
        { optionId: 'kimi-no-1', label: '不是,abort 掉', kind: 'reject_once' },
      ],
      ts: 1,
      turn: 1,
    };

    render(<ApprovalCard item={item} onApprove={onApprove} />);

    // The question text is the content; the accept option is a radio, the
    // reject-kind option collapses into the Cancel button.
    expect(document.querySelector('.approval-head')).toHaveTextContent('Question');
    expect(screen.getByText('这个进行中的 merge 是你发起的吗?')).toBeInTheDocument();
    expect(screen.getByLabelText('是,继续等它完成')).toHaveAttribute('type', 'radio');
    expect(screen.queryByRole('button', { name: '不是,abort 掉' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    // Kimi question card limits: no header chip, no Other free text.
    expect(document.querySelector('.question-header')).toBeNull();
    expect(document.querySelector('.question-option--other')).toBeNull();

    // Submit returns the picked option through the native decision channel.
    const submit = screen.getByRole('button', { name: 'Submit' });
    expect(submit).toBeDisabled();
    fireEvent.click(screen.getByLabelText('是,继续等它完成'));
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    expect(onApprove).toHaveBeenCalledWith(
      'approval-q1',
      'allow_once',
      undefined,
      { category: 'other', nativeOptionId: 'kimi-yes-1' },
    );
  });

  it('Kimi question Cancel resolves with the reject option id when one exists', () => {
    const onApprove = vi.fn();
    const item: ApprovalItem = {
      kind: 'approval',
      id: 'approval-card-q2',
      approvalId: 'approval-q2',
      title: 'AskUserQuestion',
      reason: '继续吗?',
      cmd: '',
      risk: 'medium',
      status: 'pending',
      category: 'other',
      nativeOptions: [
        { optionId: 'kimi-yes-2', label: '继续', kind: 'allow_once' },
        { optionId: 'kimi-no-2', label: '停止', kind: 'reject_once' },
      ],
      ts: 1,
      turn: 1,
    };

    render(<ApprovalCard item={item} onApprove={onApprove} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onApprove).toHaveBeenCalledWith(
      'approval-q2',
      'decline',
      undefined,
      { category: 'other', nativeOptionId: 'kimi-no-2' },
    );
  });
});
