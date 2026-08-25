// Trace frontend MVP — SessionMain wiring tests.
// Pins: the Chat/Trace segmented toggle swaps the transcript for the Trace
// view (fed by Core's persisted snapshot with a derived fallback), and clicking a trace row routes the
// item detail into the chat-owned panel 2 via ChatPanelOpenContext.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Session, Workspace } from '@gian/shared';
import { loadSessionTrace } from '../src/api.js';
import { LocaleProvider } from '../src/i18n/index.js';
import { ChatPanelOpenContext } from '../src/presentation/chat-panel.js';
import { traceFixtureStepRequest } from '../src/trace/fixtures.js';
import { SessionMain } from '../src/views/SessionMain.js';
import type { QueueEntry, TranscriptItem } from '../src/types.js';
import { sessionContractFixture } from './fixtures/ws-contract.js';

vi.mock('../src/api.js', () => {
  const never = () => new Promise<never>(() => {});
  return {
    loadChanged: never,
    loadProxyModels: never,
    loadProxyCapabilities: never,
    loadSlashCommands: never,
    loadSessionSlashCommands: never,
    loadNativeConfig: never,
    loadSessionTrace: vi.fn(),
    loadAgents: async () => [],
  };
});

const workspace: Workspace = {
  id: 'workspace-trace',
  name: 'Trace workspace',
  path: '/tmp/trace-workspace',
  sort_order: 0,
  hidden: 0,
  pinned: 0,
  created_at: '2026-08-15T00:00:00.000Z',
  updated_at: '2026-08-15T00:00:00.000Z',
};

function callbacks() {
  return {
    onSend: vi.fn(),
    onSendSkill: vi.fn(),
    onStop: vi.fn(),
    onApprove: vi.fn(),
    onQueueAdd: vi.fn(),
    onQueueRemove: vi.fn(),
    onQueueUpdate: vi.fn(),
    onQueueClear: vi.fn(),
    onQueueSendNow: vi.fn(),
    onSteer: vi.fn(),
    onSetMode: vi.fn(),
    onSetModel: vi.fn(),
    onSetEffort: vi.fn(),
    onSetServiceTier: vi.fn(),
    onSetNativeConfig: vi.fn(),
    onDelete: vi.fn(),
    onReopen: vi.fn(),
    onShowChanges: vi.fn(),
    onShowLastTurnChanges: vi.fn(),
  };
}

function element(
  session: Session,
  items: TranscriptItem[],
  queue: QueueEntry[] = [],
  openChatPanel?: (request: unknown) => void,
) {
  return (
    <LocaleProvider locale="en">
      <ChatPanelOpenContext.Provider value={openChatPanel ?? null}>
        <SessionMain
          session={session}
          workspace={workspace}
          items={items}
          hydrated
          pending={false}
          queue={queue}
          workingTreeId={null}
          branch={null}
          {...callbacks()}
        />
      </ChatPanelOpenContext.Provider>
    </LocaleProvider>
  );
}

function toolItems(): TranscriptItem[] {
  return [
    { kind: 'turn-start', id: 'ts-1', text: '', ts: 1_000, turn: 1 },
    { kind: 'user', id: 'u-1', text: 'run the checks', exec: 'claude', ts: 1_100, turn: 1 },
    {
      kind: 'tool', id: 'call-1', name: 'Bash', summary: '{"command":"pnpm test"}',
      status: 'success', ts: 1_500, turn: 1,
    },
    {
      kind: 'tool', id: 'call-2', name: 'Read', summary: '{"file_path":"/a.ts"}',
      status: 'error', ts: 1_800, turn: 1,
    },
    { kind: 'assistant', id: 'a-1', text: 'one check failed', exec: 'claude', ts: 2_000, turn: 1 },
    { kind: 'turn-end', id: 'te-1', text: '', ts: 3_000, turn: 1 },
  ];
}

describe('SessionMain Chat/Trace wiring (Trace MVP)', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(loadSessionTrace).mockReset();
    vi.mocked(loadSessionTrace).mockImplementation(() => new Promise<never>(() => {}));
  });

  it('switches between the transcript and the trace view via the tabs', async () => {
    const session = sessionContractFixture({ id: 'session-trace', status: 'done' });
    render(element(session, toolItems()));

    // Chat by default: the user bubble renders, no trace view.
    expect(screen.getByText('run the checks')).toBeInTheDocument();
    expect(screen.queryByTestId('trace-view')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Trace' }));
    expect(screen.getByTestId('trace-view')).toBeInTheDocument();
    // The chat transcript is swapped out (its bubbles unmount); the trace's
    // own input row may legitimately carry the same text.
    expect(document.querySelector('.transcript')).toBeNull();
    expect(document.querySelector('.msg.user')).toBeNull();
    // The derived snapshot grouped the turn and mapped the tool rows.
    expect(screen.getByTestId('trace-turn-turn:1')).toBeInTheDocument();
    const bashRow = screen.getByTestId('trace-row-1:tool:call-1');
    expect(bashRow).toHaveTextContent('Bash');

    await userEvent.click(screen.getByRole('button', { name: 'Chat' }));
    expect(screen.queryByTestId('trace-view')).not.toBeInTheDocument();
    expect(screen.getByText('run the checks')).toBeInTheDocument();
  });

  it('opens a trace item detail in the chat panel when a trace row is clicked', async () => {
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
    const open = vi.fn();
    const session = sessionContractFixture({ id: 'session-trace', status: 'done' });
    render(element(session, toolItems(), [], open));

    await userEvent.click(screen.getByRole('button', { name: 'Trace' }));
    await userEvent.click(screen.getByTestId('trace-row-1:tool:call-1'));
    expect(open).toHaveBeenCalledTimes(1);
    const request = open.mock.calls[0]![0] as { kind: string; item: { id: string; title: string } };
    expect(request.kind).toBe('trace-item');
    expect(request.item.id).toBe('1:tool:call-1');
    expect(request.item.title).toBe('Bash');
  });

  it('renders persisted step/request evidence that is absent from Transcript', async () => {
    const open = vi.fn();
    const session = sessionContractFixture({ id: 'session-trace', status: 'done' });
    vi.mocked(loadSessionTrace).mockResolvedValue({
      ...traceFixtureStepRequest,
      sessionId: session.id,
    });
    render(element(session, toolItems(), [], open));

    await userEvent.click(screen.getByRole('button', { name: 'Trace' }));
    const step = await screen.findByTestId('trace-row-step:turn-1:native-turn-1:0');
    expect(step).toHaveTextContent('Step 1');
    expect(screen.queryByTestId('trace-row-request-1')).not.toBeInTheDocument();

    await userEvent.click(step);
    const requestRow = screen.getByTestId('trace-row-request-1');
    expect(requestRow).toHaveTextContent('DeepSeek Chat');
    await userEvent.click(requestRow);

    expect(loadSessionTrace).toHaveBeenCalledWith(session.id, expect.any(AbortSignal));
    const request = open.mock.calls.at(-1)?.[0] as {
      kind: string;
      item: { kind: string; id: string };
    };
    expect(request.kind).toBe('trace-item');
    expect(request.item).toMatchObject({ kind: 'request', id: 'request-1' });
  });

  it('keeps transcript-derived sessions flat: no step groups or parentId rows', async () => {
    const session = sessionContractFixture({ id: 'session-trace', status: 'done' });
    render(element(session, toolItems()));
    await userEvent.click(screen.getByRole('button', { name: 'Trace' }));
    // Old sessions carry no step/request kinds, so nothing nests and no
    // collapse chrome appears — the list renders exactly as before steps.
    expect(document.querySelectorAll('[data-kind="step"]')).toHaveLength(0);
    expect(document.querySelectorAll('[data-kind="request"]')).toHaveLength(0);
    expect(document.querySelectorAll('.trace-step-caret')).toHaveLength(0);
    expect(document.querySelectorAll('.trace-step-children')).toHaveLength(0);
    expect(screen.getByTestId('trace-row-1:tool:call-1')).toBeInTheDocument();
  });

  it('marks the trace snapshot partial while the session is still running', async () => {
    const session = sessionContractFixture({ id: 'session-trace', status: 'running' });
    render(
      <LocaleProvider locale="en">
        <SessionMain
          session={session}
          workspace={workspace}
          items={toolItems().filter(i => i.kind !== 'turn-end')}
          hydrated
          pending
          queue={[]}
          workingTreeId={null}
          branch={null}
          {...callbacks()}
        />
      </LocaleProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Trace' }));
    expect(screen.getByTestId('trace-partial')).toBeInTheDocument();
    expect(screen.getByTestId('trace-view')).toHaveAttribute('data-partial', 'true');
  });
});
