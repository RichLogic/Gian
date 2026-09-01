// Stable Working / terminal Turn boundary (Issue #116), plus the unchanged
// Panel-2 event-feed projection and in-place row drill-down.

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { act, render, screen, within } from '@testing-library/react';
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

function workOf(container: HTMLElement): HTMLElement {
  const work = container.querySelector('[data-testid="turn-work"]');
  expect(work).not.toBeNull();
  return work as HTMLElement;
}

// ---------------------------------------------------------------------------
// 进行态收纳 — in-flight turns collect process rows into ONE box
// ---------------------------------------------------------------------------

describe('turn work boundary: live grouping and terminal handoff', () => {
  it('keeps the auto-expanded live preview under the restyled Working header', () => {
    const view = renderTranscript([
      userMsg(), assistantMsg(), tool({ name: 'Bash' }), command(), fileRead(), diff(), reasoning(),
    ]);
    const work = workOf(view.container);
    expect(work).toHaveAttribute('data-state', 'working');
    expect(work).toHaveTextContent('Working');
    expect(work).not.toHaveTextContent('actions');
    expect(view.container.querySelectorAll('.transcript > .trow')).toHaveLength(0);
    expect(screen.getByText('working on it')).toBeInTheDocument();

    const body = within(work).getByTestId('turn-work-preview');
    expect(body.querySelectorAll('.trow')).toHaveLength(5);
    expect(within(body).getByText('Bash')).toBeInTheDocument();
    expect(within(body).getByText('pnpm test')).toBeInTheDocument();
    expect(within(body).getByText('/w/a.ts')).toBeInTheDocument();
    expect(within(body).getByText('a.ts')).toBeInTheDocument();
    expect(within(body).getByText('checking the reducer')).toBeInTheDocument();
  });

  it('aligns preview rows with the Working label without a nested guide-rail indent', () => {
    const css = readFileSync('src/styles/events.css', 'utf8');
    const rule = css.match(/\.turn-work-preview\s*\{([^}]*)\}/);
    expect(rule).not.toBeNull();
    expect(rule![1]).toContain('margin-left: 0');
    expect(rule![1]).toContain('padding-left: 0');
    expect(rule![1]).toContain('border-left: 0');
  });

  it('keeps a pending approval inline after Working', () => {
    const view = renderTranscript([userMsg(), tool(), approval({ status: 'pending' })]);
    const work = workOf(view.container);
    const card = screen.getByText('pnpm dev:web');
    expect(work.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('keeps resolved approvals inside the live preview', () => {
    const view = renderTranscript([userMsg(), tool(), approval({ status: 'approved-once' })]);
    const body = within(workOf(view.container)).getByTestId('turn-work-preview');
    expect(body.querySelectorAll('.approval-line')).toHaveLength(1);
    expect(within(body).getByText(/pnpm dev:web/)).toBeInTheDocument();
  });

  it('keeps errors and error-level notices inline', () => {
    const view = renderTranscript([
      userMsg(), tool(), errorItem(), {
        kind: 'auto-notice', id: 'an-1', variant: 'circuit-breaker',
        trigger: 'consecutive', consecutive: 3, total: 5, ts: 8_000, turn: 1,
      } as TranscriptItem,
    ]);
    expect(workOf(view.container)).not.toHaveTextContent(/boom|stopped/i);
    expect(screen.getByText(/boom/)).toBeInTheDocument();
    expect(Array.from(view.container.querySelectorAll('.error-label')).some(
      label => /stopped/i.test(label.textContent ?? ''),
    )).toBe(true);
  });

  it('puts every live process message above Working', () => {
    const view = renderTranscript([
      userMsg(), tool({ ts: 1_000 }), assistantMsg({ id: 'a-mid', text: 'mid-turn note', ts: 2_000 }),
    ]);
    const note = screen.getByText('mid-turn note');
    const work = workOf(view.container);
    expect(note.compareDocumentPosition(work) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('updates the same Working node as new events arrive', () => {
    const items = [userMsg(), tool({ id: 'tool-1', name: 'Read', ts: 1_000 })];
    const view = renderTranscript(items);
    const before = workOf(view.container);
    view.rerender(<Transcript items={[...items, command({ ts: 2_000 })]} pending onApprove={vi.fn()} />);
    const after = workOf(view.container);
    expect(after).toBe(before);
    expect(within(after).getByTestId('turn-work-preview').querySelectorAll('.trow')).toHaveLength(2);
  });

  it('lists EVERY folded row in the scrollable live preview (no five-row cap)', () => {
    const view = renderTranscript([
      userMsg(),
      ...Array.from({ length: 7 }, (_, index) => tool({
        id: `t-${index + 1}`,
        name: `Tool ${index + 1}`,
        ts: index + 1_000,
      })),
    ]);
    const preview = within(workOf(view.container)).getByTestId('turn-work-preview');
    expect(preview).toHaveClass('turn-work-scroll');
    expect(preview.querySelectorAll('.trow')).toHaveLength(7);
    expect(within(preview).getByText('Tool 1')).toBeInTheDocument();
    expect(within(preview).getByText('Tool 7')).toBeInTheDocument();
  });

  it('ticks Working elapsed time and freezes it at terminal', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(6_000);
      const items = [userMsg(), tool({ ts: 1_000 })];
      const view = renderTranscript(items);
      expect(workOf(view.container)).toHaveTextContent('Working');
      expect(workOf(view.container).querySelector('.turn-work-duration')).toHaveTextContent('5s');
      act(() => vi.advanceTimersByTime(2_000));
      expect(workOf(view.container).querySelector('.turn-work-duration')).toHaveTextContent('7s');
      view.rerender(<Transcript items={[...items, turnEnd({ ts: 9_000 })]} pending={false} onApprove={vi.fn()} />);
      expect(workOf(view.container)).toHaveTextContent('Worked');
      expect(workOf(view.container).querySelector('.turn-work-duration')).toHaveTextContent('8s');
      act(() => vi.advanceTimersByTime(5_000));
      expect(workOf(view.container).querySelector('.turn-work-duration')).toHaveTextContent('8s');
    } finally {
      vi.useRealTimers();
    }
  });

  it('morphs in place before the final result when the Provider emits turn-end afterwards', () => {
    const liveItems = [
      userMsg(), tool({ ts: 1_000 }), assistantMsg({ id: 'a-mid', text: 'process note', ts: 2_000 }),
    ];
    const view = renderTranscript(liveItems);
    const before = workOf(view.container);
    view.rerender(<Transcript items={[
      ...liveItems,
      assistantMsg({ id: 'a-final', text: 'final summary', ts: 3_000 }),
      turnEnd({ ts: 4_000 }),
    ]} pending={false} onApprove={vi.fn()} />);
    const after = workOf(view.container);
    expect(after).toBe(before);
    expect(after).toHaveAttribute('data-state', 'worked');
    expect(screen.getByText('process note').compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(after.compareDocumentPosition(screen.getByText('final summary')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('shows Failed and Stopped terminal variants', () => {
    const failed = renderTranscript([userMsg(), tool(), errorItem(), turnEnd({ outcome: 'failed' })], false);
    expect(workOf(failed.container)).toHaveTextContent('Failed');
    failed.unmount();
    const stopped = renderTranscript([userMsg(), tool(), turnEnd({ outcome: 'stopped' })], false);
    expect(workOf(stopped.container)).toHaveTextContent('Stopped');
  });

  it('remembers a manual collapse across new events and auto-collapses at turn-end', async () => {
    const user = userEvent.setup();
    const items = [userMsg(), tool({ ts: 1_000 })];
    const view = renderTranscript(items);
    // Working: auto-expanded by default.
    expect(within(workOf(view.container)).getByTestId('turn-work-preview')).toBeInTheDocument();

    // Manual collapse is remembered — new events must not re-expand.
    await user.click(workOf(view.container));
    expect(workOf(view.container).querySelector('[data-testid="turn-work-preview"]')).toBeNull();
    view.rerender(<Transcript items={[...items, command({ ts: 2_000 })]} pending onApprove={vi.fn()} />);
    expect(workOf(view.container).querySelector('[data-testid="turn-work-preview"]')).toBeNull();

    // Turn completes → the block stays collapsed as Worked.
    view.rerender(<Transcript
      items={[...items, command({ ts: 2_000 }), turnEnd({ ts: 3_000 })]}
      pending={false}
      onApprove={vi.fn()}
    />);
    const done = workOf(view.container);
    expect(done).toHaveAttribute('data-state', 'worked');
    expect(done.querySelector('.turnsum-body')).toBeNull();
  });

  it('auto-collapses at turn-end unless the user manually expanded during the turn', async () => {
    const user = userEvent.setup();
    const items = [userMsg(), tool({ ts: 1_000 })];

    // Untouched Working block: completion collapses it.
    const untouched = renderTranscript(items);
    expect(within(workOf(untouched.container)).getByTestId('turn-work-preview')).toBeInTheDocument();
    untouched.rerender(<Transcript items={[...items, turnEnd({ ts: 3_000 })]} pending={false} onApprove={vi.fn()} />);
    expect(workOf(untouched.container).querySelector('.turnsum-body')).toBeNull();
    untouched.unmount();

    // Collapse-then-re-expand counts as a manual expand: completion keeps it open.
    const view = renderTranscript(items);
    await user.click(workOf(view.container));
    await user.click(workOf(view.container));
    expect(within(workOf(view.container)).getByTestId('turn-work-preview')).toBeInTheDocument();
    view.rerender(<Transcript items={[...items, turnEnd({ ts: 3_000 })]} pending={false} onApprove={vi.fn()} />);
    const done = workOf(view.container);
    expect(done).toHaveAttribute('data-state', 'worked');
    // The no-panel fallback body is a SIBLING of the .turnsum element.
    expect(view.container.querySelector('.turnsum-body')).not.toBeNull();
  });

  it('keeps the streaming output under the running Bash row; it returns to a single line when the command ends', () => {
    const items = [userMsg(), command({ status: 'running', stdout: 'chunk 1\n', ts: 1_500 })];
    const view = renderTranscript(items);
    const preview = within(workOf(view.container)).getByTestId('turn-work-preview');
    const stream = preview.querySelector('.turn-work-live-stream .cmd-stream');
    expect(stream).not.toBeNull();
    expect(stream!.textContent).toContain('chunk 1');
    expect(stream!.querySelector('.cmd-cursor')).not.toBeNull();

    view.rerender(<Transcript
      items={[userMsg(), command({ status: 'success', stdout: 'chunk 1\n', ts: 1_500 })]}
      pending
      onApprove={vi.fn()}
    />);
    const after = within(workOf(view.container)).getByTestId('turn-work-preview');
    expect(after.querySelector('.turn-work-live-stream')).toBeNull();
    expect(within(after).getByText('pnpm test')).toBeInTheDocument();
  });

  it('head click toggles; the head carries no panel hint (rows open the feed)', async () => {
    const user = userEvent.setup();
    const open = vi.fn();
    const { container } = render(
      <ChatPanelOpenContext.Provider value={open}>
        <Transcript
          items={[userMsg(), tool()]}
          pending
          onApprove={vi.fn()}
        />
      </ChatPanelOpenContext.Provider>,
    );
    // Head click toggles the block instead of routing to the panel.
    await user.click(screen.getByTestId('turn-work'));
    expect(open).not.toHaveBeenCalled();
    expect(screen.queryByTestId('turn-work-preview')).toBeNull();
    // No ⇥ panel hint on the head — preview rows open the anchored feed.
    expect(container.querySelector('.turnsum .trow-ext')).toBeNull();
  });

  it('clicking a preview row opens the panel-2 feed anchored at that row without toggling the block', async () => {
    const user = userEvent.setup();
    const open = vi.fn();
    render(
      <ChatPanelOpenContext.Provider value={open}>
        <Transcript
          items={[userMsg(), tool(), command()]}
          pending
          onApprove={vi.fn()}
        />
      </ChatPanelOpenContext.Provider>,
    );
    await user.click(screen.getByText('pnpm test'));
    expect(open).toHaveBeenCalledWith({ kind: 'event-feed', turn: 1, anchorId: '1:command:cmd-1' });
    expect(screen.getByTestId('turn-work-preview')).toBeInTheDocument();
  });

  it('renders no boundary without process events and leaves idle dangling rows flat', () => {
    const messages = renderTranscript([userMsg(), assistantMsg()]);
    expect(messages.container.querySelector('[data-testid="turn-work"]')).toBeNull();
    messages.unmount();
    const dangling = render(<Transcript items={[userMsg(), reasoning(), tool()]} pending={false} onApprove={vi.fn()} />);
    expect(dangling.container.querySelector('[data-testid="turn-work"]')).toBeNull();
    expect(dangling.container.querySelectorAll('.transcript > .trow')).toHaveLength(2);
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
  it('shows the complete turn even when the transcript preview is capped at five', () => {
    const tools = Array.from({ length: 7 }, (_, index) => tool({
      id: `t-${index + 1}`,
      name: `Tool ${index + 1}`,
      ts: index + 1_000,
    }));
    render(
      <ChatContextPanel
        target={{ kind: 'event-feed', turn: 1, sessionId: 'session-1' }}
        items={[userMsg(), ...tools]}
        onClose={() => {}}
      />,
    );
    const feed = screen.getByTestId('chat-event-feed');
    expect(feed.querySelectorAll('.trow')).toHaveLength(7);
    expect(within(feed).getByText('Tool 1')).toBeInTheDocument();
    expect(within(feed).getByText('Tool 7')).toBeInTheDocument();
  });

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

  it('anchors the requested row: scrolls it into view, flashes it, and expands only that row', async () => {
    const user = userEvent.setup();
    const scrollIntoView = vi.fn();
    window.HTMLElement.prototype.scrollIntoView = scrollIntoView;
    const view = render(
      <ChatContextPanel
        target={{ kind: 'event-feed', turn: 1, sessionId: 'session-1', anchorId: '1:command:cmd-1' }}
        items={[userMsg(), tool(), command()]}
        onClose={() => {}}
      />,
    );
    const feed = screen.getByTestId('chat-event-feed');
    const row = within(feed).getByText('pnpm test').closest('.trow');
    expect(row).not.toBeNull();
    expect(row!).toHaveClass('is-anchor-flash');
    expect(row!).toHaveClass('open');
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center' });
    // Other rows stay unflashed.
    expect(feed.querySelectorAll('.is-anchor-flash')).toHaveLength(1);
    expect(feed.querySelectorAll('.trow.open')).toHaveLength(1);
    const detail = row!.nextElementSibling;
    expect(detail).toHaveClass('trow-detail');
    expect(detail).toHaveTextContent('$ pnpm test');
    expect(detail).toHaveTextContent('ok');

    // A second click on the same transcript row is a fresh anchor request:
    // reopen it even when the user collapsed the first expansion in Panel 2.
    await user.click(row!);
    expect(feed.querySelectorAll('.trow.open')).toHaveLength(0);
    view.rerender(
      <ChatContextPanel
        target={{ kind: 'event-feed', turn: 1, sessionId: 'session-1', anchorId: '1:command:cmd-1' }}
        items={[userMsg(), tool(), command()]}
        onClose={() => {}}
      />,
    );
    expect(feed.querySelectorAll('.trow.open')).toHaveLength(1);

    // Moving the anchor closes the prior auto-open row and opens the new one.
    view.rerender(
      <ChatContextPanel
        target={{ kind: 'event-feed', turn: 1, sessionId: 'session-1', anchorId: '1:tool:tool-1' }}
        items={[userMsg(), tool(), command()]}
        onClose={() => {}}
      />,
    );
    expect(within(feed).getByText('Read').closest('.trow')).toHaveClass('open');
    expect(within(feed).getByText('pnpm test').closest('.trow')).not.toHaveClass('open');
    expect(feed.querySelectorAll('.trow.open')).toHaveLength(1);
  });

  it('flashes nothing without an anchor request', () => {
    render(
      <ChatContextPanel
        target={{ kind: 'event-feed', turn: 1, sessionId: 'session-1' }}
        items={[userMsg(), tool(), command()]}
        onClose={() => {}}
      />,
    );
    expect(screen.getByTestId('chat-event-feed').querySelector('.is-anchor-flash')).toBeNull();
  });
});
