// Transcript Turn work boundary (Issue #116):
//   - one stable Working row becomes Worked / Failed / Stopped in place
//   - duration = first process event ts → turn-end ts and freezes at terminal
//   - the collapsed row omits counts; details remain available on click
//   - a turn with no process events gets no boundary row
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
import { ChatPanelOpenContext } from '../src/presentation/chat-panel.js';
import { applyEnvelope } from '../src/transcript/apply.js';
import type { EventEnvelope } from '@gian/shared';

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

function kimiDisplayEnvelope(
  type: 'activity.reasoning' | 'message' | 'state.turn-completed',
  data: Record<string, unknown>,
): EventEnvelope {
  const turnId = 'turn_kimi_shared';
  return {
    session_id: 'kimi-session',
    turn: 7,
    call_id: turnId,
    event: type === 'state.turn-completed' ? 'turn.completed' : 'acp.sessionUpdate',
    ts: type === 'state.turn-completed' ? 3_000 : type === 'message' ? 2_000 : 1_000,
    data: {},
    display: { type, data } as EventEnvelope['display'],
  };
}

// ---------------------------------------------------------------------------
// 完成即折 — completed turns fold into one .turnsum row
// ---------------------------------------------------------------------------

describe('P2 turnsum: 完成即折', () => {
  it('reconciles Kimi reasoning and assistant rows sharing one provider id from live to complete', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      let items: TranscriptItem[] = [];
      items = applyEnvelope(items, kimiDisplayEnvelope('activity.reasoning', {
        itemId: 'turn_kimi_shared', text: 'checking the implementation', kind: 'full', delta: true,
      }), 'kimi');
      items = applyEnvelope(items, kimiDisplayEnvelope('message', {
        itemId: 'turn_kimi_shared', text: 'The fix is ready.', delta: true,
      }), 'kimi');

      const view = renderTranscript(items);
      expect(view.container.querySelectorAll('.trow[data-variant="full"]')).toHaveLength(1);
      expect(screen.getByText('The fix is ready.')).toBeInTheDocument();

      items = applyEnvelope(items, kimiDisplayEnvelope('state.turn-completed', {
        turnId: 'turn_kimi_shared',
      }), 'kimi');
      view.rerender(<Transcript items={items} pending={false} onApprove={vi.fn()} />);

      expect(view.container.querySelectorAll('.transcript > .trow[data-variant="full"]')).toHaveLength(0);
      expect(view.container.querySelectorAll('.turnsum')).toHaveLength(1);
      expect(screen.getByText('The fix is ready.')).toBeInTheDocument();
      expect(consoleError.mock.calls.flat().join(' ')).not.toMatch(/same key|unique "key"/i);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('a completed turn folds its process events; the same boundary reads Working while live', () => {
    const completed: TranscriptItem[] = [
      userMsg(), command(), fileRead(), diff(), turnEnd(), assistantMsg(),
    ];
    const { container, rerender } = renderTranscript(completed);

    const sum = container.querySelector('.turnsum');
    expect(sum).not.toBeNull();
    // Duration: first process event (cmd @1s) → turn-end (@63s) = 62s.
    expect(sum!.querySelector('.turnsum-lead')).toHaveTextContent('Worked');
    expect(sum!.querySelector('.turn-work-duration')).toHaveTextContent('1m 02s');
    // Folded rows are not visible until the summary is expanded.
    expect(container.querySelector('.turnsum-body')).toBeNull();
    expect(screen.queryByText('pnpm test')).toBeNull();
    expect(container.querySelector('.turnsum-time')).not.toBeNull();

    // Same items minus the turn-end keep one compact live boundary.
    rerender(<Transcript
      items={[userMsg(), command(), fileRead(), diff()]}
      pending
      onApprove={vi.fn()}
    />);
    expect(container.querySelector('.turnsum')).toHaveTextContent('Working');
    expect(container.querySelector('[data-testid="turn-work-preview"]')).not.toBeNull();
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

describe('P2 turnsum: compact summary', () => {
  it('keeps counts out of the collapsed row while retaining an accessible action total', () => {
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
    const summary = container.querySelector('.turnsum')!;
    expect(summary).not.toHaveTextContent('actions');
    expect(summary).not.toHaveTextContent('files');
    expect(summary.getAttribute('aria-label')).toContain('5 actions');
  });

  it('tool-level errors stay in details without changing a completed Turn label', async () => {
    const user = userEvent.setup();
    const { container } = renderTranscript([
      userMsg(),
      command({ id: 'c-1', status: 'error' }),
      command({ id: 'c-2', status: 'success' }),
      agent({ status: 'error' }),
      turnEnd(),
    ]);
    expect(container.querySelector('.turnsum')).toHaveTextContent('Worked');
    await user.click(container.querySelector('.turnsum') as HTMLElement);
    expect(container.querySelectorAll('.turnsum-body .trow')).toHaveLength(3);
  });

  it('a single-action turn uses the singular label', () => {
    const { container } = renderTranscript([userMsg(), command(), turnEnd()]);
    expect(container.querySelector('.turnsum')?.getAttribute('aria-label')).toContain('1 action');
    expect(container.querySelector('.turnsum')?.getAttribute('aria-label')).not.toContain('1 actions');
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
    expect(container.querySelector('.turnsum')?.getAttribute('aria-label')).toContain('2 actions');

    // The pending card renders outside the fold, right after the summary.
    const transcript = container.querySelector('.transcript')!;
    const kids = Array.from(transcript.children);
    const sumIdx = kids.findIndex(el => el.classList.contains('turnsum'));
    const approvalIdx = kids.findIndex(el => el.classList.contains('ap2'));
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
    expect(container.querySelector('.turnsum')?.getAttribute('aria-label')).toContain('3 actions');
  });
});

// ---------------------------------------------------------------------------
// 展开即全量 — the expanded body lists EVERY folded row in a capped scroll
// area (2026-08-27 redesign); rows open the panel-2 event feed anchored at
// the clicked row (no head ⇥ panel hint). Without a chat panel the terminal
// block keeps the original in-place card expansion.
// ---------------------------------------------------------------------------

describe('turnsum: expanded body and panel routing', () => {
  function manyCommands(n: number): TranscriptItem[] {
    return Array.from({ length: n }, (_, i) =>
      command({ id: `cmd-${i}`, command: `run-${i}`, ts: 1_000 + i * 100 }));
  }

  it('>10 folded rows: the expanded body lists every row in a scroll area; no head panel hint', async () => {
    const user = userEvent.setup();
    const open = vi.fn();
    const { container } = render(
      <ChatPanelOpenContext.Provider value={open}>
        <Transcript
          items={[userMsg(), ...manyCommands(11), turnEnd()]}
          pending={false}
          onApprove={vi.fn()}
        />
      </ChatPanelOpenContext.Provider>,
    );

    // Terminal blocks default to collapsed; the click expands in place.
    await user.click(container.querySelector('.turnsum') as HTMLElement);
    expect(open).not.toHaveBeenCalled();
    const body = container.querySelector('.turnsum-body.turn-work-scroll');
    expect(body).not.toBeNull();
    expect(body!.querySelectorAll('.trow')).toHaveLength(11);
    expect(within(body as HTMLElement).getByText('run-0')).toBeInTheDocument();
    expect(within(body as HTMLElement).getByText('run-10')).toBeInTheDocument();

    // No ⇥ panel hint on the head — rows open the anchored feed instead.
    expect(container.querySelector('.turnsum .trow-ext')).toBeNull();
  });

  it('clicking an expanded terminal row opens the feed anchored at that row', async () => {
    const user = userEvent.setup();
    const open = vi.fn();
    const { container } = render(
      <ChatPanelOpenContext.Provider value={open}>
        <Transcript
          items={[userMsg(), ...manyCommands(3), turnEnd()]}
          pending={false}
          onApprove={vi.fn()}
        />
      </ChatPanelOpenContext.Provider>,
    );

    await user.click(container.querySelector('.turnsum') as HTMLElement);
    await user.click(within(container.querySelector('.turnsum-body') as HTMLElement).getByText('run-1'));
    expect(open).toHaveBeenCalledWith({ kind: 'event-feed', turn: 1, anchorId: '1:command:cmd-1' });
  });

  it('≤10 folded rows expand inline the same way (scroll area, not panel)', async () => {
    const user = userEvent.setup();
    const open = vi.fn();
    const { container } = render(
      <ChatPanelOpenContext.Provider value={open}>
        <Transcript
          items={[userMsg(), ...manyCommands(10), turnEnd()]}
          pending={false}
          onApprove={vi.fn()}
        />
      </ChatPanelOpenContext.Provider>,
    );

    await user.click(container.querySelector('.turnsum') as HTMLElement);
    expect(open).not.toHaveBeenCalled();
    const body = container.querySelector('.turnsum-body');
    expect(body).not.toBeNull();
    expect(within(body as HTMLElement).getByText('run-9')).toBeInTheDocument();
  });

  it('falls back to the original in-place card expansion when no chat-panel context exists', async () => {
    const user = userEvent.setup();
    const { container } = renderTranscript([userMsg(), ...manyCommands(11), turnEnd()]);

    await user.click(container.querySelector('.turnsum') as HTMLElement);
    const body = container.querySelector('.turnsum-body');
    expect(body).not.toBeNull();
    // The fallback body renders full cards, not the single-line scroll area.
    expect(body!.classList.contains('turn-work-scroll')).toBe(false);
    expect(within(body as HTMLElement).getByText('run-10')).toBeInTheDocument();
  });
});
