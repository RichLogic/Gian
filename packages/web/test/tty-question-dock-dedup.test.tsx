// Coverage for traceability row (CLAUDE-TTY-002, UI dimension):
//   In Beta mode the pending AskUserQuestion is pinned in a dedicated
//   "Claude is waiting" dock. The same approval must NOT also render inline in
//   the transcript — that double-rendered the card on real hardware. Once the
//   question resolves the dock releases it and the resolved card shows inline.

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ApprovalItem, MsgItem, TranscriptItem } from '../src/types.js';
import { Transcript } from '../src/transcript/Transcript.js';

function userMsg(): MsgItem {
  return {
    kind: 'user',
    id: 'u-1',
    exec: 'claude',
    text: 'ask me a question with options',
    ts: Date.UTC(2026, 5, 1, 0, 0, 0),
    turn: 1,
  } as MsgItem;
}

function question(status: ApprovalItem['status']): ApprovalItem {
  return {
    kind: 'approval',
    id: 'env-q',
    approvalId: 'toolu_q1',
    title: '好的，那接下来你想让我做什么?',
    reason: '',
    cmd: '',
    risk: 'low',
    status,
    category: 'question',
    scopeOptions: ['once'],
    questions: [{
      question: '好的，那接下来你想让我做什么?',
      header: '下一步',
      options: [
        { label: '继续当前任务' },
        { label: '随便聊聊' },
      ],
    }],
    ts: Date.UTC(2026, 5, 1, 0, 0, 1),
    turn: 1,
  };
}

describe('CLAUDE-TTY-002: Beta question dock dedup', () => {
  it('suppresses the inline pending question card when it is pinned in the dock', () => {
    const items: TranscriptItem[] = [userMsg(), question('pending')];
    render(
      <Transcript items={items} pending onApprove={vi.fn()} hiddenApprovalId="toolu_q1" />,
    );
    // The radio options belong to the inline QuestionCard — they must not be
    // rendered here when the dock owns the card.
    expect(screen.queryByText('继续当前任务')).toBeNull();
    expect(screen.queryByText('随便聊聊')).toBeNull();
  });

  it('renders the pending question inline when nothing is pinned (no dock)', () => {
    const items: TranscriptItem[] = [userMsg(), question('pending')];
    render(<Transcript items={items} pending onApprove={vi.fn()} />);
    expect(screen.getByText('继续当前任务')).toBeInTheDocument();
  });

  it('shows the resolved card inline once the dock releases it (hiddenApprovalId cleared)', () => {
    const items: TranscriptItem[] = [
      userMsg(),
      { ...question('approved-once'), answeredWith: '继续当前任务' },
    ];
    // pendingQuestion is gone → CodingView passes hiddenApprovalId=undefined.
    render(<Transcript items={items} pending={false} onApprove={vi.fn()} />);
    expect(screen.getByText(/answered/i)).toBeInTheDocument();
    expect(screen.getByText('继续当前任务')).toBeInTheDocument();
  });
});
