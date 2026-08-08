// Transcript redesign P2 (2026-08-08) — 回顾态.
// Pins the `.turnsum` completed-turn fold (docs/work-items/transcript-redesign-acd.md §3):
//   - collapse-as-soon-as-the-turn-ends, for live turns AND historical replays
//   - stats口径: duration = first process event ts → turn-end ts; actions =
//     process-event count (incl. approvals, 1 each); files deduped by path
//     with add/del summed; failed = command + agent errors, kept danger-red
//   - a turn with no process events gets no summary row
//   - pending approvals/questions never fold; resolved ones fold as
//     `.approval-line` rows
// plus the P2边角形态: status-line, minimal error card, auto-notice归位,
// compaction row.

import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  AgentSpawnItem,
  ApprovalItem,
  AutoNoticeItem,
  CommandItem,
  CompactionItem,
  DiffItem,
  FileReadItem,
  MsgItem,
  StatusItem,
  TranscriptItem,
} from '../src/types.js';
import { Transcript } from '../src/transcript/Transcript.js';

function userMsg(overrides: Partial<MsgItem> = {}): MsgItem {
  return { kind: 'user', id: 'u-1', text: 'do the thing', exec: 'claude', ts: 500, turn: 1, ...overrides };
}

function assistantMsg(overrides: Partial<MsgItem> = {}): MsgItem {
  return { kind: 'assistant', id: 'a-1', text: 'done.', exec: 'claude', ts: 62_500, turn: 1, ...overrides };
}

function command(overrides: Partial<CommandItem> = {}): CommandItem {
  return {
    kind: 'command', id: 'cmd-1', command: 'pnpm test', status: 'success',
    stdout: 'ok', ts: 1_000, turn: 1, ...overrides,
  };
}

function fileRead(overrides: Partial<FileReadItem> = {}): FileReadItem {
  return { kind: 'file-read', id: 'fr-1', path: '/w/a.ts', ts: 2_000, turn: 1, ...overrides };
}

function diff(overrides: Partial<DiffItem> = {}): DiffItem {
  return {
    kind: 'diff', id: 'diff-1',
    files: [{ path: 'a.ts', add: 6, del: 2, hunks: [] }],
    ts: 3_000, turn: 1, ...overrides,
  };
}

function approval(overrides: Partial<ApprovalItem> = {}): ApprovalItem {
  return {
    kind: 'approval', id: 'appr-env-1', approvalId: 'appr-1',
    title: 'Run shell command', reason: '', cmd: 'pnpm dev:web',
    risk: 'medium', status: 'approved-once', category: 'command',
    ts: 4_000, turn: 1, ...overrides,
  };
}

function agent(overrides: Partial<AgentSpawnItem> = {}): AgentSpawnItem {
  return {
    kind: 'agent-spawn', id: 'agent-1', provider: 'claude',
    description: 'explore the reducer', status: 'done',
    startedAt: 1_000, updatedAt: 2_000, ts: 2_500, turn: 1, ...overrides,
  };
}

function turnEnd(overrides: Partial<StatusItem> = {}): StatusItem {
  return { kind: 'turn-end', id: 'te-1', text: 'Turn 1 · complete', ts: 63_000, turn: 1, ...overrides };
}

function renderTranscript(items: TranscriptItem[]) {
  return render(<Transcript items={items} pending={false} onApprove={vi.fn()} />);
}

// ---------------------------------------------------------------------------
// 完成即折 — completed turns fold into one .turnsum row
// ---------------------------------------------------------------------------

describe('P2 turnsum: 完成即折', () => {
  it('a completed turn folds its process events into a summary row; live turns stay flat', () => {
    const completed: TranscriptItem[] = [
      userMsg(), command(), fileRead(), diff(), turnEnd(), assistantMsg(),
    ];
    const { container, rerender } = renderTranscript(completed);

    const sum = container.querySelector('.turnsum');
    expect(sum).not.toBeNull();
    // Duration: first process event (cmd @1s) → turn-end (@63s) = 62s.
    expect(sum!.querySelector('.turnsum-lead')).toHaveTextContent('Worked 1m 02s');
    // Folded rows are not visible until the summary is expanded.
    expect(container.querySelector('.turnsum-body')).toBeNull();
    expect(screen.queryByText('pnpm test')).toBeNull();
    expect(container.querySelector('.turnsum-time')).not.toBeNull();

    // Same items minus the turn-end = a live turn → rows render flat.
    rerender(<Transcript
      items={[userMsg(), command(), fileRead(), diff()]}
      pending
      onApprove={vi.fn()}
    />);
    expect(container.querySelector('.turnsum')).toBeNull();
    expect(screen.getByText('pnpm test')).toBeInTheDocument();
  });

  it('expanding the summary restores the process rows on the guide rail; resolved approvals are .approval-line rows', async () => {
    const user = userEvent.setup();
    const { container } = renderTranscript([
      userMsg(), command(), approval(), turnEnd(), assistantMsg(),
    ]);

    await user.click(container.querySelector('.turnsum') as HTMLElement);
    const body = container.querySelector('.turnsum-body');
    expect(body).not.toBeNull();
    expect(within(body as HTMLElement).getByText('pnpm test')).toBeInTheDocument();
    // Resolved approval folds as a single ✓ line, not a card.
    const line = body!.querySelector('.approval-line');
    expect(line).not.toBeNull();
    expect(line!.querySelector('.al-mark.ok')).not.toBeNull();
    expect(line!.querySelector('.al-subject')).toHaveTextContent('$ pnpm dev:web');

    await user.click(container.querySelector('.turnsum') as HTMLElement);
    expect(container.querySelector('.turnsum-body')).toBeNull();
  });

  it('a turn with no process events (messages only) renders no summary row', () => {
    const { container } = renderTranscript([userMsg(), assistantMsg(), turnEnd()]);
    expect(container.querySelector('.turnsum')).toBeNull();
    expect(screen.getByText('do the thing')).toBeInTheDocument();
    expect(screen.getByText('done.')).toBeInTheDocument();
  });

  it('messages stay outside the fold — order is user, turnsum, assistant', () => {
    const { container } = renderTranscript([
      userMsg(), command(), turnEnd(), assistantMsg(),
    ]);
    const kids = Array.from(container.querySelector('.transcript')!.children);
    const order = kids.map(el =>
      el.querySelector('.msg.user') ? 'user'
      : el.classList.contains('turnsum') ? 'turnsum'
      : el.querySelector('.msg:not(.user)') || el.classList.contains('msg') ? 'assistant'
      : 'other');
    expect(order).toEqual(['user', 'turnsum', 'assistant']);
  });
});

// ---------------------------------------------------------------------------
// 统计口径 — actions / files dedupe / failed in red
// ---------------------------------------------------------------------------

describe('P2 turnsum: stats口径', () => {
  it('actions counts every process event incl. approvals; files dedupe by path and sum add/del', () => {
    const { container } = renderTranscript([
      userMsg(),
      command(),
      fileRead(),
      diff({ id: 'd-1', files: [{ path: 'a.ts', add: 6, del: 2, hunks: [] }] }),
      diff({ id: 'd-2', files: [{ path: 'a.ts', add: 1, del: 1, hunks: [] }, { path: 'b.ts', add: 3, del: 0, hunks: [] }] }),
      approval(),
      turnEnd(),
      assistantMsg(),
    ]);
    const stats = container.querySelector('.turnsum-stats')!;
    // cmd + read + 2 diffs + resolved approval = 5
    expect(stats).toHaveTextContent('5 actions');
    // a.ts twice deduped → 2 files; add 6+1+3=10, del 2+1+0=3
    expect(stats).toHaveTextContent('2 files');
    expect(stats.querySelector('.add')).toHaveTextContent('+10');
    expect(stats.querySelector('.del')).toHaveTextContent('−3');
    // No failures → no err segment.
    expect(stats.querySelector('.err')).toBeNull();
  });

  it('failed counts command + agent errors and stays danger-red', () => {
    const { container } = renderTranscript([
      userMsg(),
      command({ id: 'c-1', status: 'error' }),
      command({ id: 'c-2', status: 'success' }),
      agent({ status: 'error' }),
      turnEnd(),
    ]);
    const err = container.querySelector('.turnsum-stats .err');
    expect(err).not.toBeNull();
    expect(err).toHaveTextContent('2 failed');
  });

  it('a single-action turn uses the singular label', () => {
    const { container } = renderTranscript([userMsg(), command(), turnEnd()]);
    expect(container.querySelector('.turnsum-stats')).toHaveTextContent('1 action');
    expect(container.querySelector('.turnsum-stats')).not.toHaveTextContent('1 actions');
  });
});

// ---------------------------------------------------------------------------
// Pending 审批永不折叠
// ---------------------------------------------------------------------------

describe('P2 turnsum: pending approvals never fold', () => {
  it('a pending approval of a completed turn stays expanded after the summary row and counts as an action', async () => {
    const user = userEvent.setup();
    const { container } = renderTranscript([
      userMsg(),
      command(),
      approval({ status: 'pending', scopeOptions: ['once'] }),
      turnEnd(),
    ]);

    // Summary exists (the command folds) and counts the pending approval.
    expect(container.querySelector('.turnsum')).not.toBeNull();
    expect(container.querySelector('.turnsum-stats')).toHaveTextContent('2 actions');

    // The pending card renders outside the fold, right after the summary.
    const transcript = container.querySelector('.transcript')!;
    const kids = Array.from(transcript.children);
    const sumIdx = kids.findIndex(el => el.classList.contains('turnsum'));
    const approvalIdx = kids.findIndex(el => el.classList.contains('approval') && !el.classList.contains('approval-line'));
    expect(sumIdx).toBeGreaterThanOrEqual(0);
    expect(approvalIdx).toBe(sumIdx + 1);
    expect(screen.getByRole('button', { name: /Allow once/i })).toBeInTheDocument();

    // Expanding the summary shows only the command — the pending card is
    // not inside the body.
    await user.click(container.querySelector('.turnsum') as HTMLElement);
    const body = container.querySelector('.turnsum-body') as HTMLElement;
    expect(within(body).queryByRole('button', { name: /Allow once/i })).toBeNull();
    expect(within(body).getByText('pnpm test')).toBeInTheDocument();
  });

  it('a turn with ONLY a pending approval renders no summary row', () => {
    const { container } = renderTranscript([
      userMsg(),
      approval({ status: 'pending', scopeOptions: ['once'] }),
      turnEnd(),
    ]);
    expect(container.querySelector('.turnsum')).toBeNull();
    expect(screen.getByRole('button', { name: /Allow once/i })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 边角形态 — status / error / auto-notice / compaction
// ---------------------------------------------------------------------------

describe('P2边角形态', () => {
  it('status renders as a centered plain-text line, not the pill', () => {
    const { container } = renderTranscript([
      { kind: 'status', id: 'st-1', text: 'Session ended · token limit reached', ts: 1_000, turn: 1 },
    ]);
    const line = container.querySelector('.status-line');
    expect(line).not.toBeNull();
    expect(line).toHaveTextContent('Session ended · token limit reached');
    expect(container.querySelector('.transcript-empty')).toBeNull();
  });

  it('error renders the minimal card: danger label + text, no icon/title/pill/timestamp', () => {
    const { container } = renderTranscript([
      { kind: 'error', id: 'err-1', text: 'claude -p exited with code 1', ts: 1_000, turn: 1 },
    ]);
    const card = container.querySelector('.approval');
    expect(card).not.toBeNull();
    expect(card!.querySelector('.error-label')).toHaveTextContent(/turn failed/i);
    expect(card!.querySelector('.error-text')).toHaveTextContent('claude -p exited with code 1');
    expect(card!.querySelector('.approval-top')).toBeNull();
    expect(card!.querySelector('.approval-ico')).toBeNull();
    expect(card!.querySelector('.approval-risk')).toBeNull();
  });

  it('classifier-denied auto-notice is a .trow single line with the counters', () => {
    const notice: AutoNoticeItem = {
      kind: 'auto-notice', id: 'an-1', variant: 'classifier-denied',
      action: 'Bash(rm -rf /tmp/x)', reason: 'destructive command',
      consecutive: 2, total: 5, ts: 1_000, turn: 1,
    };
    const { container } = renderTranscript([notice]);
    const row = container.querySelector('.trow');
    expect(row).not.toBeNull();
    expect(row!.querySelector('.trow-verb')).toHaveTextContent('Auto-block');
    expect(row!.querySelector('.trow-subject')).toHaveTextContent('Bash(rm -rf /tmp/x)');
    expect(row!.querySelector('.trow-subject')).toHaveTextContent('destructive command');
    expect(row!.querySelector('.trow-meta')).toHaveTextContent('2/3 · 5 total');
  });

  it('circuit-breaker auto-notice is the minimal error card labelled AUTO-MODE STOPPED', () => {
    const notice: AutoNoticeItem = {
      kind: 'auto-notice', id: 'an-2', variant: 'circuit-breaker',
      trigger: 'consecutive', consecutive: 3, total: 5, ts: 1_000, turn: 1,
    };
    const { container } = renderTranscript([notice]);
    const card = container.querySelector('.approval');
    expect(card).not.toBeNull();
    expect(card!.querySelector('.error-label')).toHaveTextContent('AUTO-MODE STOPPED');
    expect(card!.querySelector('.error-text')).toHaveTextContent('3 consecutive denials');
    expect(card!.querySelector('.approval-top')).toBeNull();
  });

  it('compaction renders a .trow Compact row with before → after tokens', () => {
    const item: CompactionItem = {
      kind: 'compaction', id: 'cmp-1', beforeTokens: 128_000, afterTokens: 41_000, ts: 1_000, turn: 1,
    };
    const { container } = renderTranscript([item]);
    const row = container.querySelector('.trow');
    expect(row).not.toBeNull();
    expect(row!.querySelector('.trow-verb')).toHaveTextContent('Compact');
    expect(row!.querySelector('.trow-subject')).toHaveTextContent('context compacted · 128k → 41k');
  });

  it('auto-notice and compaction fold into a completed turn like other process rows', () => {
    const notice: AutoNoticeItem = {
      kind: 'auto-notice', id: 'an-3', variant: 'classifier-denied',
      action: 'Bash(foo)', consecutive: 1, total: 1, ts: 1_500, turn: 1,
    };
    const compaction: CompactionItem = { kind: 'compaction', id: 'cmp-2', ts: 1_600, turn: 1 };
    const { container } = renderTranscript([userMsg(), command(), notice, compaction, turnEnd()]);
    expect(container.querySelector('.turnsum-stats')).toHaveTextContent('3 actions');
  });
});
