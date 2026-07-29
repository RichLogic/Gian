import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { EventEnvelope } from '@gian/shared';
import type { ApprovalItem } from '../src/types.js';
import { applyEnvelope } from '../src/transcript/apply.js';
import { ApprovalCard } from '../src/transcript/items.js';

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
});
