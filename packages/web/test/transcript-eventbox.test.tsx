// Event box (2026-08-24) — 进行态.
// Pins the `.eventbox` in-flight-turn grouping (GitHub issue #96):
//   - a turn WITHOUT turn-end collects all its process events (tool /
//     command / diff / file-read / file-search / web-search / reasoning /
//     agent-spawn / auto-notice / compaction) + RESOLVED approvals into ONE
//     box instead of flooding the transcript row by row
//   - the box emits at the turn's LAST boxed row so it stays at the bottom
//     of the live reply flow; new events join the tail (newest at bottom)
//   - PENDING approvals/questions stay inline — they wait on the user
//   - user/assistant messages, status and error items stay inline
//   - clicking the box routes the same live set to panel 2 (event-feed);
//     when the turn-end arrives the turnsum fold takes over the same items
// plus the panel-2 event feed: same predicate, live re-projection.

import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  AgentSpawnItem,
  ApprovalItem,
  CommandItem,
  DiffItem,
  FileReadItem,
  MsgItem,
  ReasoningItem,
  StatusItem,
  ToolItem,
  TranscriptItem,
} from '../src/types.js';
import { Transcript } from '../src/transcript/Transcript.js';
import { ChatContextPanel } from '../src/components/ChatContextPanel.js';
import { EventFeed } from '../src/transcript/EventFeed.js';
import { ChatPanelOpenContext } from '../src/presentation/chat-panel.js';

function userMsg(overrides: Partial<MsgItem> = {}): MsgItem {
  return { kind: 'user', id: 'u-1', text: 'do the thing', exec: 'claude', ts: 500, turn: 1, ...overrides };
}

function assistantMsg(overrides: Partial<MsgItem> = {}): MsgItem {
  return { kind: 'assistant', id: 'a-1', text: 'working on it', exec: 'claude', ts: 800, turn: 1, ...overrides };
}

function tool(overrides: Partial<ToolItem> = {}): ToolItem {
  return {
    kind: 'tool', id: 'tool-1', name: 'Read', summary: '{"file_path":"/w/a.ts"}',
    status: 'success', output: 'file body', ts: 1_000, turn: 1, ...overrides,
  };
}

function command(overrides: Partial<CommandItem> = {}): CommandItem {
  return {
    kind: 'command', id: 'cmd-1', command: 'pnpm test', status: 'success',
    stdout: 'ok', ts: 2_000, turn: 1, ...overrides,
  };
}

function fileRead(overrides: Partial<FileReadItem> = {}): FileReadItem {
  return { kind: 'file-read', id: 'fr-1', path: '/w/a.ts', ts: 3_000, turn: 1, ...overrides };
}

function diff(overrides: Partial<DiffItem> = {}): DiffItem {
  return {
    kind: 'diff', id: 'diff-1',
    files: [{ path: 'a.ts', add: 6, del: 2, hunks: [] }],
    ts: 4_000, turn: 1, ...overrides,
  };
}

function reasoning(overrides: Partial<ReasoningItem> = {}): ReasoningItem {
  return {
    kind: 'reasoning', id: 'rs-1', variant: 'full', text: 'checking the reducer',
    ts: 5_000, turn: 1, ...overrides,
  };
}

function approval(overrides: Partial<ApprovalItem> = {}): ApprovalItem {
  return {
    kind: 'approval', id: 'appr-env-1', approvalId: 'appr-1',
    title: 'Run shell command', reason: '', cmd: 'pnpm dev:web',
    risk: 'medium', status: 'approved-once', category: 'command',
    ts: 6_000, turn: 1, ...overrides,
  };
}

function errorItem(overrides: Partial<StatusItem> = {}): StatusItem {
  return { kind: 'error', id: 'err-1', text: 'Turn failed: boom', ts: 7_000, turn: 1, ...overrides };
}

function turnEnd(overrides: Partial<StatusItem> = {}): StatusItem {
  return { kind: 'turn-end', id: 'te-1', text: 'Turn 1 · complete', ts: 63_000, turn: 1, ...overrides };
}

function renderTranscript(items: TranscriptItem[], pending = true) {
  return render(<Transcript items={items} pending={pending} onApprove={vi.fn()} />);
}

function boxOf(container: HTMLElement): HTMLElement {
  const box = container.querySelector('[data-testid="event-box"]');
  expect(box).not.toBeNull();
  return box as HTMLElement;
}

// ---------------------------------------------------------------------------
// 进行态收纳 — in-flight turns collect process rows into ONE box
// ---------------------------------------------------------------------------

describe('event box: in-flight turn grouping', () => {
  it('collects every process kind of an in-flight turn into one box', () => {
    const view = renderTranscript([
      userMsg(),
      assistantMsg(),
      tool({ name: 'Bash' }),
      command(),
      fileRead(),
      diff(),
      reasoning(),
    ]);

    const box = boxOf(view.container);
    expect(view.container.querySelectorAll('[data-testid="event-box"]')).toHaveLength(1);
    const rows = box.querySelectorAll('.trow');
    expect(rows).toHaveLength(5);
    expect(within(box).getByText('Bash')).toBeInTheDocument();
    expect(within(box).getByText('pnpm test')).toBeInTheDocument();
    expect(within(box).getByText('/w/a.ts')).toBeInTheDocument();
    expect(within(box).getByText('a.ts')).toBeInTheDocument();
    expect(within(box).getByText('checking the reducer')).toBeInTheDocument();

    // Nothing process-shaped leaks outside the box…
    expect(view.container.querySelectorAll('.transcript > .trow')).toHaveLength(0);
    // …while the conversation content stays inline.
    expect(screen.getByText('do the thing')).toBeInTheDocument();
    expect(screen.getByText('working on it')).toBeInTheDocument();
  });

  it('keeps a PENDING approval inline and out of the box, after the box', () => {
    const view = renderTranscript([
      userMsg(),
      tool(),
      approval({ status: 'pending' }),
    ]);

    const box = boxOf(view.container);
    expect(within(box).queryByText(/pnpm dev:web/)).toBeNull();
    expect(box.querySelectorAll('.approval-line')).toHaveLength(0);

    // The pending card renders inline, AFTER the box (it is the live
    // question the user must answer).
    const card = screen.getByText('pnpm dev:web');
    expect(
      box.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('moves a RESOLVED approval into the box as a one-line summary', () => {
    const view = renderTranscript([
      userMsg(),
      tool(),
      approval({ status: 'approved-once' }),
    ]);

    const box = boxOf(view.container);
    const lines = box.querySelectorAll('.approval-line');
    expect(lines).toHaveLength(1);
    expect(within(lines[0] as HTMLElement).getByText(/pnpm dev:web/)).toBeInTheDocument();
    // No interactive card remains for the resolved approval.
    expect(screen.queryByRole('button', { name: /allow/i })).toBeNull();
  });

  it('keeps error items inline and out of the box', () => {
    const view = renderTranscript([userMsg(), tool(), errorItem()]);

    const box = boxOf(view.container);
    expect(within(box).queryByText(/boom/)).toBeNull();
    expect(screen.getByText(/boom/)).toBeInTheDocument();
  });

  it('keeps error-level auto-notices inline as the minimal error card', () => {
    const view = renderTranscript([
      userMsg(),
      tool(),
      {
        kind: 'auto-notice', id: 'an-1', variant: 'circuit-breaker',
        trigger: 'consecutive', consecutive: 3, total: 5, ts: 6_000, turn: 1,
      } as TranscriptItem,
    ]);

    const box = boxOf(view.container);
    expect(box.querySelectorAll('.trow')).toHaveLength(1);
    // The danger signal stays inline as the full error card.
    const card = view.container.querySelector('.approval');
    expect(card).not.toBeNull();
    expect(card!.querySelector('.error-label')).toHaveTextContent(/stopped/i);
  });

  it('emits the box at the last boxed row so interleaved text keeps its place', () => {
    const view = renderTranscript([
      userMsg(),
      tool({ id: 'tool-1', name: 'Read', ts: 1_000 }),
      assistantMsg({ id: 'a-mid', text: 'mid-turn note', ts: 1_500 }),
      command({ id: 'cmd-1', ts: 2_000 }),
    ]);

    const box = boxOf(view.container);
    const note = screen.getByText('mid-turn note');
    // Box sits AFTER the mid-turn assistant text (its last row is later).
    expect(
      note.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(within(box).getByText('Read')).toBeInTheDocument();
    expect(within(box).getByText('pnpm test')).toBeInTheDocument();
  });

  it('appends new live events to the same box (newest at the bottom)', () => {
    const items = [userMsg(), tool({ id: 'tool-1', name: 'Read', ts: 1_000 })];
    const view = renderTranscript(items);

    view.rerender(
      <Transcript
        items={[...items, command({ id: 'cmd-1', ts: 2_000 })]}
        pending
        onApprove={vi.fn()}
      />,
    );

    const boxes = view.container.querySelectorAll('[data-testid="event-box"]');
    expect(boxes).toHaveLength(1);
    const rows = boxes[0]!.querySelectorAll('.trow');
    expect(rows).toHaveLength(2);
    expect(within(rows[1] as HTMLElement).getByText('pnpm test')).toBeInTheDocument();
  });

  it('shows a live running timer for a running tool row', () => {
    const view = renderTranscript([
      userMsg(),
      tool({ id: 'tool-1', name: 'Bash', status: 'running', output: undefined }),
    ]);
    expect(within(boxOf(view.container)).getByText(/running · /)).toBeInTheDocument();
  });

  it('hands the same items to the turnsum fold once the turn ends', () => {
    const items = [userMsg(), tool(), command()];
    const view = renderTranscript(items);
    expect(view.container.querySelectorAll('[data-testid="event-box"]')).toHaveLength(1);
    expect(view.container.querySelectorAll('.turnsum')).toHaveLength(0);

    view.rerender(
      <Transcript items={[...items, turnEnd()]} pending={false} onApprove={vi.fn()} />,
    );

    expect(view.container.querySelectorAll('[data-testid="event-box"]')).toHaveLength(0);
    expect(view.container.querySelectorAll('.turnsum')).toHaveLength(1);
  });

  it('routes the box click to panel 2 as an event-feed request', async () => {
    const user = userEvent.setup();
    const open = vi.fn();
    render(
      <ChatPanelOpenContext.Provider value={open}>
        <Transcript items={[userMsg(), tool()]} pending onApprove={vi.fn()} />
      </ChatPanelOpenContext.Provider>,
    );

    await user.click(screen.getByTestId('event-box'));
    expect(open).toHaveBeenCalledWith({ kind: 'event-feed', turn: 1 });
  });

  it('renders no box for a turn with no process events', () => {
    const view = renderTranscript([userMsg(), assistantMsg()]);
    expect(view.container.querySelectorAll('[data-testid="event-box"]')).toHaveLength(0);
  });

  it('leaves a dangling turn (no turn-end) flat in an IDLE session', () => {
    // A session that ended mid-turn (crash / completed status) is history,
    // not a live tail: rows stay flat and fully interactive.
    const view = render(
      <Transcript
        items={[userMsg(), reasoning(), tool({ output: undefined })]}
        pending={false}
        onApprove={vi.fn()}
      />,
    );
    expect(view.container.querySelectorAll('[data-testid="event-box"]')).toHaveLength(0);
    expect(view.container.querySelectorAll('.transcript > .trow')).toHaveLength(2);
  });

  it('shows a header with the live label and the event count', () => {
    const view = renderTranscript([userMsg(), tool(), command()]);
    const box = boxOf(view.container);
    const head = box.querySelector('.eventbox-head');
    expect(head).not.toBeNull();
    expect(head!).toHaveTextContent('Activity');
    expect(head!).toHaveTextContent('2 actions');
    expect(head!.querySelector('.eventbox-live')).not.toBeNull();
  });

  it('shows only the LATEST 5 events; the header keeps the total count', () => {
    const view = renderTranscript([
      userMsg(),
      ...[1, 2, 3, 4, 5, 6, 7].map(n =>
        tool({ id: `t${n}`, name: `T${n}`, ts: n * 1_000 })),
    ]);
    const box = boxOf(view.container);
    const rows = box.querySelectorAll('.eventbox-body .trow');
    expect(rows).toHaveLength(5);
    // The two oldest events scrolled out of the window entirely.
    expect(within(box).queryByText('T1')).toBeNull();
    expect(within(box).queryByText('T2')).toBeNull();
    expect(within(box).getByText('T3')).toBeInTheDocument();
    expect(within(box).getByText('T7')).toBeInTheDocument();
    // …but the header still counts everything, advertising that panel 2
    // has more.
    expect(box.querySelector('.eventbox-head')).toHaveTextContent('7 actions');
  });
});

// ---------------------------------------------------------------------------
// Event feed drill-down — every panel-2 row expands IN PLACE
// ---------------------------------------------------------------------------

describe('event feed drill-down (in-place)', () => {
  function agentSpawn(overrides: Partial<AgentSpawnItem> = {}): AgentSpawnItem {
    return {
      kind: 'agent-spawn', id: 'agent-1', provider: 'claude',
      description: 'explore the reducer', status: 'done',
      startedAt: 1_000, updatedAt: 2_000, ts: 2_500, turn: 1, ...overrides,
    };
  }

  it('expands a tool row in place with input + output, and collapses again', async () => {
    const user = userEvent.setup();
    const view = render(<EventFeed items={[tool()]} />);

    await user.click(screen.getByText('Read'));
    const detail = view.container.querySelector('.trow-detail');
    expect(detail).not.toBeNull();
    expect(detail!).toHaveTextContent('"file_path": "/w/a.ts"');
    expect(detail!).toHaveTextContent('file body');

    await user.click(screen.getByText('Read'));
    expect(view.container.querySelector('.trow-detail')).toBeNull();
  });

  it('falls back to the raw item JSON for a tool row without any payload', async () => {
    const user = userEvent.setup();
    const view = render(<EventFeed items={[
      tool({ id: 'tool-x', name: 'Codex event: item/started', summary: '', output: undefined }),
    ]} />);

    await user.click(screen.getByText('Codex event: item/started'));
    const detail = view.container.querySelector('.trow-detail');
    expect(detail).toHaveTextContent('"kind": "tool"');
    expect(detail).toHaveTextContent('Codex event: item/started');
  });

  it('expands command output, reasoning text and search matches in place', async () => {
    const user = userEvent.setup();
    const view = render(<EventFeed items={[
      command(),
      reasoning(),
      {
        kind: 'file-search', id: 'fs-1', pattern: 'useWorkbench', searchKind: 'grep',
        matches: ['src/a.ts', 'src/b.ts'], ts: 5_500, turn: 1,
      } as TranscriptItem,
    ]} />);

    await user.click(screen.getByText('pnpm test'));
    const details = () => view.container.querySelectorAll('.trow-detail');
    expect(details()).toHaveLength(1);
    expect(details()[0]).toHaveTextContent('$ pnpm test');
    expect(details()[0]).toHaveTextContent('ok');

    await user.click(screen.getByText('checking the reducer'));
    expect(details()[1]).toHaveTextContent('checking the reducer');

    await user.click(screen.getByText('useWorkbench'));
    expect(details()[2]).toHaveTextContent('src/a.ts');
    expect(details()[2]).toHaveTextContent('src/b.ts');
  });

  it('expands a diff row with colored hunks; a hunk-less diff falls back to text', async () => {
    const user = userEvent.setup();
    const withHunks = diff({
      files: [{
        path: 'a.ts', add: 1, del: 1,
        hunks: [{
          header: '@@ -1,2 +1,2 @@',
          lines: [
            { kind: 'del', text: 'old line' },
            { kind: 'add', text: 'new line' },
          ],
        }],
      }],
    });
    const view = render(<EventFeed items={[withHunks]} />);

    await user.click(screen.getByText('a.ts'));
    const colored = view.container.querySelector('.trow-detail.diff');
    expect(colored).not.toBeNull();
    expect(colored!.querySelector('.dline.del')).toHaveTextContent('old line');
    expect(colored!.querySelector('.dline.add')).toHaveTextContent('new line');

    const view2 = render(<EventFeed items={[diff()]} />);
    await user.click(within(view2.container).getByText('a.ts'));
    const plain = view2.container.querySelector('.trow-detail');
    expect(plain).not.toBeNull();
    expect(plain).toHaveTextContent(/a\.ts\s+\+6 −2/);
  });

  it('expands an agent row in place with prompt + result (no panel navigation)', async () => {
    const user = userEvent.setup();
    const view = render(<EventFeed items={[agentSpawn({
      input: { prompt: 'Read the reducer and report risks.' },
      output: 'Found one stale transition.',
    })]} />);

    await user.click(screen.getByText('explore the reducer'));
    const detail = view.container.querySelector('.trow-detail');
    expect(detail).toHaveTextContent('status: done');
    expect(detail).toHaveTextContent('Read the reducer and report risks.');
    expect(detail).toHaveTextContent('Found one stale transition.');
  });

  it('keeps a resolved approval line static (already the full record)', () => {
    const view = render(<EventFeed items={[approval({ status: 'approved-once' })]} />);

    expect(view.container.querySelectorAll('.approval-line')).toHaveLength(1);
    expect(view.container.querySelector('.trow')).toBeNull();
    expect(view.container.querySelector('.trow-detail')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Panel-2 event feed — the same projection, live
// ---------------------------------------------------------------------------

describe('panel-2 event feed', () => {
  it('renders exactly the box predicate: process rows + resolved approvals of the turn', () => {
    render(
      <ChatContextPanel
        target={{ kind: 'event-feed', turn: 1, sessionId: 'session-1' }}
        items={[
          userMsg(),
          assistantMsg(),
          tool(),
          approval({ status: 'approved-once' }),
          approval({ id: 'appr-env-2', approvalId: 'appr-2', status: 'pending', ts: 6_500 }),
          errorItem(),
          command({ id: 'cmd-other', command: 'other turn', ts: 8_000, turn: 2 }),
        ]}
        onClose={() => {}}
      />,
    );

    const feed = screen.getByTestId('chat-event-feed');
    expect(within(feed).getByText('Read')).toBeInTheDocument();
    expect(feed.querySelectorAll('.approval-line')).toHaveLength(1);
    // Pending approvals, errors, messages and OTHER turns stay out.
    expect(within(feed).queryByText(/boom/)).toBeNull();
    expect(within(feed).queryByText('working on it')).toBeNull();
    expect(within(feed).queryByText('other turn')).toBeNull();
    expect(feed.querySelectorAll('.approval-line')).toHaveLength(1);
  });

  it('re-projects live: a new event of the turn appears on rerender', () => {
    const base = [userMsg(), tool()];
    const view = render(
      <ChatContextPanel
        target={{ kind: 'event-feed', turn: 1, sessionId: 'session-1' }}
        items={base}
        onClose={() => {}}
      />,
    );
    expect(within(screen.getByTestId('chat-event-feed')).queryByText('pnpm test')).toBeNull();

    view.rerender(
      <ChatContextPanel
        target={{ kind: 'event-feed', turn: 1, sessionId: 'session-1' }}
        items={[...base, command()]}
        onClose={() => {}}
      />,
    );
    expect(within(screen.getByTestId('chat-event-feed')).getByText('pnpm test')).toBeInTheDocument();
  });

  it('shows the empty hint when the turn has no process events yet', () => {
    render(
      <ChatContextPanel
        target={{ kind: 'event-feed', turn: 1, sessionId: 'session-1' }}
        items={[userMsg()]}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByTestId('chat-event-feed')).toBeNull();
    expect(screen.getByText('No process events in this turn yet.')).toBeInTheDocument();
  });
});
