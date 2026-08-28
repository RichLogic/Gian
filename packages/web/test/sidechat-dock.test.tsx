/**
 * Side Chat surface (gian.proxy/2.0 proposal §10.5) — component-level
 * contract over the REAL operation dispatcher + store, for the panel-2
 * surface (Dock rail entry → ChatContextPanel → SideChatDock):
 *
 * - Dock rail button: gating states (catalog missing / unsupported /
 *   dynamic-disabled / enabled), active state, open-count badge, toggle;
 * - the panel-2 mount: ChatContextPanel renders the dock for the sidechat
 *   chat-panel kind;
 * - the create affordance inside the dock (gated "+" chip + empty-state
 *   CTA): pending blocks duplicates, failure surfaces;
 * - the dock: multiple open Side Chats with isolated transcripts, reload
 *   recovery (resume dispatched once, recovering blocks sends, failure keeps
 *   content + offers close), shared Transcript/Composer pipeline, snapshot
 *   `state`-driven turn running;
 * - the close flow (§10.5.4): 4-clause confirm, cancel keeps everything,
 *   confirm → pending/closing (never flips back), success removes, failure
 *   keeps + retry;
 * - the parent-session delete cascade (use-topbar-model): the confirm lists
 *   the still-open Side Chats AND the delete carries their ids as
 *   `confirmed_sidechat_ids` (Host requirement);
 * - no `resumeRef` ever reaches rendered output or an outgoing WS message.
 */
import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import type {
  ClientToServerMessage,
  EventEnvelope,
  ServerToClientMessage,
  Session,
  SideChatInfo,
} from '@gian/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { typeInlineComposer } from './inline-composer-test-utils.js';

import {
  __resetSideChatResumeMarksForTests,
  SideChatDock,
} from '../src/components/SideChatDock.js';
import { ChatContextPanel } from '../src/components/ChatContextPanel.js';
import { Dock } from '../src/components/Dock.js';
import { actionControlState } from '../src/components/action-gating.js';
import { useTopbarModel } from '../src/controllers/use-topbar-model.js';
import { EN } from '../src/i18n/en.js';
import { LocaleProvider } from '../src/i18n/index.js';
import { __resetFeedback, getSnapshot, resolveConfirm } from '../src/feedback.js';
import {
  createOperationDispatcher,
  type OperationDispatcher,
  type OperationTransport,
} from '../src/operations/dispatcher.js';
import { createOperationStore, type OperationStore } from '../src/operations/store.js';
import {
  OperationDispatcherProvider,
  OperationStoreProvider,
} from '../src/operations/use-operations.js';
// Side effects: register the product operation definitions under test.
import '../src/operations/session.js';
import '../src/operations/message.js';
import '../src/operations/approval.js';
import '../src/operations/sidechat.js';
import { applyEnvelope } from '../src/transcript/apply.js';
import type { TranscriptItem } from '../src/types.js';

// The dock's fixed Composer discovers executor capabilities lazily — keep the REST
// layer inert (catalog parsing itself is covered by composer-catalog.test).
vi.mock('../src/api.js', () => ({
  loadProxyCapabilities: vi.fn(async () => ({})),
  loadProxyModels: vi.fn(async () => []),
  loadProxyModes: vi.fn(async () => []),
  loadSlashCommands: vi.fn(async () => []),
  loadSessionSlashCommands: vi.fn(async () => []),
  loadNativeConfig: vi.fn(async () => null),
  loadResolvedProxyCatalog: vi.fn(async () => ({})),
}));

class FakeTransport implements OperationTransport {
  sent: ClientToServerMessage[] = [];
  private messageListeners = new Set<(msg: ServerToClientMessage) => void>();
  private stateListeners = new Set<(state: 'connecting' | 'open' | 'closed', attempt: number) => void>();

  send(msg: ClientToServerMessage): void {
    this.sent.push(msg);
  }

  onMessage(listener: (msg: ServerToClientMessage) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onState(listener: (state: 'connecting' | 'open' | 'closed', attempt: number) => void): () => void {
    this.stateListeners.add(listener);
    listener('open', 0);
    return () => this.stateListeners.delete(listener);
  }

  /** Settle the run that sent message `sent[sentIndex]` (default: latest). */
  settle(ok: boolean, error?: { code: string; message: string }, sentIndex = -1): void {
    const message = this.sent.at(sentIndex) as ClientToServerMessage & { request_id?: string };
    expect(message?.request_id, 'every dispatched WS message carries a request_id').toBeTruthy();
    this.emit({
      type: 'operation:result',
      request_id: message.request_id!,
      request_type: message.type,
      ok,
      ...(error ? { error } : {}),
    });
  }

  emit(message: ServerToClientMessage): void {
    for (const listener of this.messageListeners) listener(message);
  }

  sentOfType(type: ClientToServerMessage['type']) {
    return this.sent.filter(message => message.type === type);
  }
}

const PARENT = {
  id: 's-parent',
  name: 'Parent session',
  type: 'coding',
  task_id: null,
  workspace_id: 'w-1',
  executor: 'codex',
  model: 'gpt-5.6-sol',
  approval_mode: 'ask',
  native_config_options: [],
  thinking_effort: 'high',
  status: 'done',
  completed_at: null,
  worktree_outcome: null,
} as unknown as Session;

let recordSeq = 0;
function sideChat(
  id: string,
  status: SideChatInfo['status'] = 'open',
  state: SideChatInfo['state'] = 'idle',
): SideChatInfo {
  recordSeq += 1;
  return {
    id,
    parent_session_id: 's-parent',
    ordinal: recordSeq,
    name: null,
    stream_id: `stream-${id}`,
    state,
    status,
    anchor: { type: 'turn', turn_id: 't_parent', source_turn_id: 'provider-turn-parent' },
    session_config: {},
    last_error: status === 'unavailable' ? 'resume reference invalidated' : null,
    uncertain_turn_id: null,
    events: [],
    user_inputs: [],
    created_at: `2026-08-20T08:${String(recordSeq).padStart(2, '0')}:00.000Z`,
    updated_at: '2026-08-20T08:00:00.000Z',
  } as unknown as SideChatInfo;
}

/** A standard event sequence applied through the REAL transcript pipeline —
 *  assistant text, a tool card, an interaction (approval), a command, and a
 *  reasoning card (§10.5: a Side Chat renders whatever the runtime produces). */
function sideChatEventItems(sidechatId: string): TranscriptItem[] {
  let items: TranscriptItem[] = [];
  const apply = (envelope: Partial<EventEnvelope> & Pick<EventEnvelope, 'call_id'>) => {
    items = applyEnvelope(items, {
      session_id: sidechatId,
      turn: 1,
      ts: 1_700_000_000_000,
      event: 'event',
      data: {},
      ...envelope,
    } as EventEnvelope, 'codex');
  };
  apply({ call_id: 'c-msg', event: 'assistant_text', data: { text: 'side answer', itemId: 'm-1' } });
  apply({
    call_id: 'c-tool',
    display: { type: 'activity.tool', data: { itemId: 't-1', title: 'Read', input: '/tmp/a.ts', status: 'success' } } as never,
  });
  apply({
    call_id: 'c-approval',
    display: {
      type: 'interaction.approval',
      data: { approvalId: 'ap-1', subject: 'rm -rf /tmp/x', description: 'dangerous' },
    } as never,
  });
  apply({
    call_id: 'c-cmd',
    display: { type: 'activity.command', data: { itemId: 'cmd-1', command: 'ls', stdout: 'a.ts', status: 'success' } } as never,
  });
  apply({
    call_id: 'c-reason',
    display: { type: 'activity.reasoning', data: { itemId: 'r-1', text: 'thinking it over' } } as never,
  });
  return items;
}

const ENABLED_CONTROL = actionControlState(
  [{ id: 'sidechat.create', supported: true }],
  { 'sidechat.create': { enabled: true } },
  'sidechat.create',
);

interface Harness {
  store: OperationStore;
  transport: FakeTransport;
  dispatcher: OperationDispatcher;
}

const liveDispatchers: OperationDispatcher[] = [];

function makeHarness(): Harness {
  const store = createOperationStore();
  const transport = new FakeTransport();
  const dispatcher = createOperationDispatcher({ store, transport });
  liveDispatchers.push(dispatcher);
  return { store, transport, dispatcher };
}

function Providers({ harness, children }: { harness: Harness; children: ReactNode }) {
  return (
    <LocaleProvider locale="en">
      <OperationStoreProvider store={harness.store}>
        <OperationDispatcherProvider dispatcher={harness.dispatcher}>
          {children}
        </OperationDispatcherProvider>
      </OperationStoreProvider>
    </LocaleProvider>
  );
}

function renderDock(
  harness: Harness,
  props: {
    sideChats: SideChatInfo[];
    items?: Record<string, TranscriptItem[]>;
    control?: Parameters<typeof SideChatDock>[0]['control'];
    onClosed?: (sidechatId: string) => void;
  },
) {
  return render(
    <Providers harness={harness}>
      <SideChatDock
        parent={PARENT}
        sideChats={props.sideChats}
        items={props.items ?? {}}
        control={props.control === undefined ? ENABLED_CONTROL : props.control}
        onClosed={props.onClosed ?? (() => {})}
      />
    </Providers>,
  );
}

beforeEach(() => {
  recordSeq = 0;
  __resetFeedback();
  __resetSideChatResumeMarksForTests();
});

afterEach(() => {
  __resetFeedback();
  __resetSideChatResumeMarksForTests();
  while (liveDispatchers.length > 0) liveDispatchers.pop()!.dispose();
});

// ─── Dock rail button (the entry point) ─────────────────────────────────────

describe('Dock rail Side Chat button', () => {
  function renderButton(sideChat: Parameters<typeof Dock>[0]['sideChat']) {
    return render(
      <LocaleProvider locale="en">
        <Dock
          activeRail={null}
          onToggleRail={() => {}}
          sideChat={sideChat}
          wsState="open"
          wsAttempt={0}
          authed
          runner={null}
        />
      </LocaleProvider>,
    );
  }

  it('is always rendered with a tooltip, greyed when gating disallows it', () => {
    const { unmount } = renderButton({
      active: false, disabled: true, title: EN['sidechat.unavailable']!, count: 0, onToggle: () => {},
    });
    const button = screen.getByTestId('dock-sidechat');
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', EN['sidechat.unavailable']);
    unmount();

    renderButton({
      active: false, disabled: true, title: 'Runtime has no side-context primitive.', count: 0, onToggle: () => {},
    });
    expect(screen.getByTestId('dock-sidechat')).toHaveAttribute(
      'title', 'Runtime has no side-context primitive.',
    );
  });

  it('enabled → click toggles; active state and the open-count badge render', () => {
    const onToggle = vi.fn();
    renderButton({ active: true, disabled: false, title: EN['sidechat.createTitle']!, count: 2, onToggle });
    const button = screen.getByTestId('dock-sidechat');
    expect(button).toBeEnabled();
    expect(button.className).toContain('active');
    expect(button.querySelector('.dock-badge')?.textContent).toBe('2');

    fireEvent.click(button);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});

// ─── Panel-2 mount (ChatContextPanel sidechat kind) ─────────────────────────

describe('ChatContextPanel sidechat kind (panel 2)', () => {
  it('renders the Side Chat dock as panel-2 content for the sidechat target', () => {
    const harness = makeHarness();
    render(
      <Providers harness={harness}>
        <ChatContextPanel
          target={{ kind: 'sidechat', sessionId: 's-parent' }}
          items={[]}
          sideChat={{
            parent: PARENT,
            sideChats: [sideChat('sc-1')],
            items: {},
            control: ENABLED_CONTROL,
            onClosed: () => {},
          }}
          onClose={() => {}}
        />
      </Providers>,
    );
    expect(screen.getByTestId('sidechat-dock')).toBeInTheDocument();
    expect(screen.getByTestId('sidechat-panel-sc-1')).toBeInTheDocument();
    // Terminal-style single header: NO generic chat-context header above the
    // dock, no per-panel title row — just the one tab strip.
    expect(document.querySelector('.chat-context-panel.sidechat .chat-context-head')).toBeNull();
    expect(document.querySelector('.sidechat-panel-head')).toBeNull();
    expect(document.querySelectorAll('.sidechat-root > .sheet-tabs')).toHaveLength(1);
    expect(harness.transport.sentOfType('sidechat:create')).toHaveLength(0);
  });

  it('keeps the empty panel idle until the prominent New button is clicked', async () => {
    const harness = makeHarness();
    render(
      <Providers harness={harness}>
        <ChatContextPanel
          target={{ kind: 'sidechat', sessionId: 's-parent', createIfEmpty: true } as never}
          items={[]}
          sideChat={{
            parent: PARENT,
            sideChats: [],
            items: {},
            control: ENABLED_CONTROL,
            onClosed: () => {},
          }}
          onClose={() => {}}
        />
      </Providers>,
    );

    await act(async () => {});
    expect(harness.transport.sentOfType('sidechat:create')).toHaveLength(0);
    const create = screen.getByTestId('sidechat-create-empty');
    expect(create).toHaveAccessibleName('New Side Chat');
    expect(create).toHaveClass('primary');
    expect(create).toHaveClass('sidechat-create-cta');
    expect(create.querySelector('svg')).not.toBeNull();
    fireEvent.click(create);
    expect(harness.transport.sentOfType('sidechat:create')).toHaveLength(1);
    expect(harness.transport.sentOfType('sidechat:create')[0]).toMatchObject({
      parent_session_id: 's-parent',
    });
  });
});

// ─── Create affordance inside the dock ──────────────────────────────────────

describe('SideChatDock create affordance', () => {
  it('empty state renders with a gated CTA; control null/disabled greys with the fallback or PROXY reason', () => {
    const harness = makeHarness();
    const view = renderDock(harness, { sideChats: [], control: null });
    const cta = screen.getByTestId('sidechat-create-empty');
    expect(cta).toBeDisabled();
    expect(cta).toHaveAttribute('title', EN['sidechat.unavailable']);
    // The strip "+" is equally gated.
    expect(screen.getByTestId('sidechat-create')).toBeDisabled();
    expect(screen.getByTestId('sidechat-create')).toHaveClass('prominent');

    view.rerender(
      <Providers harness={harness}>
        <SideChatDock
          parent={PARENT}
          sideChats={[]}
          items={{}}
          control={actionControlState(
            [{ id: 'sidechat.create', supported: false, reason: 'Runtime has no side-context primitive.' }],
            { 'sidechat.create': { enabled: true } },
            'sidechat.create',
          )}
          onClosed={() => {}}
        />
      </Providers>,
    );
    expect(screen.getByTestId('sidechat-create-empty')).toHaveAttribute(
      'title', 'Runtime has no side-context primitive.',
    );
  });

  it('enabled → click dispatches sidechat:create for the parent; pending blocks duplicates', () => {
    const harness = makeHarness();
    renderDock(harness, { sideChats: [] });

    fireEvent.click(screen.getByTestId('sidechat-create-empty'));
    const creates = harness.transport.sentOfType('sidechat:create');
    expect(creates).toHaveLength(1);
    expect(creates[0]).toMatchObject({ parent_session_id: 's-parent' });
    // The web never mints or carries resumeRef/streamId/sidechatId.
    expect(JSON.stringify(harness.transport.sent)).not.toContain('resumeRef');

    // While the create run is in flight the affordance is inert.
    expect(screen.getByTestId('sidechat-create-empty')).toBeDisabled();
    fireEvent.click(screen.getByTestId('sidechat-create-empty'));
    expect(harness.transport.sentOfType('sidechat:create')).toHaveLength(1);
  });

  it('create failure surfaces an error toast (the record would arrive via sidechat:created — nothing appears silently)', () => {
    const harness = makeHarness();
    renderDock(harness, { sideChats: [] });
    fireEvent.click(screen.getByTestId('sidechat-create-empty'));
    act(() => harness.transport.settle(false, { code: 'SIDECHAT_UNSUPPORTED', message: 'nope' }));
    const errorToasts = getSnapshot().toasts.filter(toast => toast.kind === 'error');
    expect(errorToasts).toHaveLength(1);
    expect(errorToasts.map(toast => toast.message)).toContain('nope');
  });
});

// ─── Dock ───────────────────────────────────────────────────────────────────

describe('SideChatDock', () => {
  it('success adds the surface: a record appearing in the read model renders the panel (reload path)', () => {
    const harness = makeHarness();
    const record = sideChat('sc-1');
    const view = renderDock(harness, { sideChats: [] });
    expect(screen.queryByTestId('sidechat-panel-sc-1')).toBeNull();

    view.rerender(
      <Providers harness={harness}>
        <SideChatDock
          parent={PARENT}
          sideChats={[record]}
          items={{}}
          control={ENABLED_CONTROL}
          onClosed={() => {}}
        />
      </Providers>,
    );
    expect(screen.getByTestId('sidechat-panel-sc-1')).toBeInTheDocument();
  });

  it('two open Side Chats under one parent keep isolated transcripts (chip switch)', () => {    const harness = makeHarness();
    const older = sideChat('sc-a');
    const newer = sideChat('sc-b');
    renderDock(harness, {
      sideChats: [older, newer],
      items: {
        'sc-a': sideChatEventItems('sc-a'),
        'sc-b': [{
          kind: 'assistant', id: 'm-b', text: 'answer from B', exec: 'codex',
          ts: 1_700_000_000_001, turn: 1,
        }],
      },
    });

    // Newest record is selected by default: B's content, not A's.
    expect(screen.getByText('answer from B')).toBeInTheDocument();
    expect(screen.queryByText('side answer')).toBeNull();
    // The close ✕ lives inside the ACTIVE tab only (terminal-style strip).
    expect(screen.queryByTestId('sidechat-close-sc-b')).not.toBeNull();
    expect(screen.queryByTestId('sidechat-close-sc-a')).toBeNull();

    fireEvent.click(screen.getByTestId('sidechat-chip-sc-a'));
    expect(screen.getByText('side answer')).toBeInTheDocument();
    expect(screen.queryByText('answer from B')).toBeNull();
    expect(screen.queryByTestId('sidechat-close-sc-a')).not.toBeNull();
    expect(screen.queryByTestId('sidechat-close-sc-b')).toBeNull();
  });

  it('renders tool / interaction / command / reasoning items through the shared pipeline', () => {
    const harness = makeHarness();
    const record = sideChat('sc-1');
    renderDock(harness, {
      sideChats: [record],
      items: { 'sc-1': sideChatEventItems('sc-1') },
    });
    // Assistant text, tool card, interaction (approval) card, command card,
    // reasoning row — all produced by the shared Transcript, unmodified.
    expect(screen.getByText('side answer')).toBeInTheDocument();
    expect(screen.getByText('Read')).toBeInTheDocument();
    expect(screen.getByText(/rm -rf \/tmp\/x/)).toBeInTheDocument();
    expect(screen.getByText('thinking it over')).toBeInTheDocument();
  });

  it('a running snapshot state blocks the composer with the honest busy copy (no queue)', () => {
    const harness = makeHarness();
    renderDock(harness, { sideChats: [sideChat('sc-1', 'open', 'running')] });
    act(() => harness.transport.settle(true)); // resume confirmed

    const textarea = screen.getByRole('textbox');
    expect(textarea).toHaveAttribute('contenteditable', 'false');
    expect(textarea).toHaveAttribute('aria-placeholder', EN['sidechat.turnRunning']);
  });

  it('reload recovery: an open record resumes once, recovering blocks sends, success enables the composer', () => {
    const harness = makeHarness();
    const record = sideChat('sc-1');
    const view = renderDock(harness, { sideChats: [record] });

    // First render of an unseen open record → exactly one sidechat:resume,
    // and the composer is replaced by the stable recovering state (no sends).
    expect(harness.transport.sentOfType('sidechat:resume')).toHaveLength(1);
    expect(harness.transport.sent[0]).toMatchObject({
      sidechat_id: 'sc-1',
      parent_session_id: 's-parent',
    });
    expect(screen.getByTestId('sidechat-recovering')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();

    // Re-renders never re-dispatch (page-lifetime mark).
    view.rerender(
      <Providers harness={harness}>
        <SideChatDock parent={PARENT} sideChats={[record]} items={{}} control={ENABLED_CONTROL} onClosed={() => {}} />
      </Providers>,
    );
    expect(harness.transport.sentOfType('sidechat:resume')).toHaveLength(1);

    // Resume success → the composer appears and accepts input.
    act(() => harness.transport.settle(true));
    expect(screen.queryByTestId('sidechat-recovering')).toBeNull();
    const textarea = screen.getByRole('textbox');
    expect(textarea).toHaveAttribute('contenteditable', 'true');

    const panel = screen.getByTestId('sidechat-panel-sc-1');
    expect(within(panel).getByTestId('fixed-composer-model-chip')).toHaveTextContent('gpt-5.6-sol');
    expect(within(panel).getByTestId('fixed-composer-thinking-chip')).toHaveTextContent('High');
    expect(within(panel).queryByTestId('fixed-composer-fast-chip')).toBeNull();
    expect(within(panel).getByTestId('fixed-composer-approval-chip')).toHaveTextContent('Ask for approval');
    const bar = panel.querySelector('.composer-bar') as HTMLElement;
    const order = Array.from(bar.children).map(element => (
      element.classList.contains('spacer') ? 'spacer'
        : element.classList.contains('cmp-control-sep') ? 'separator'
          : element.getAttribute('data-testid') ?? element.getAttribute('aria-label')
    ));
    expect(order).toEqual([
      'fixed-composer-model-chip',
      'separator',
      'fixed-composer-thinking-chip',
      'spacer',
      'fixed-composer-approval-chip',
      'Send',
    ]);
    expect(bar.querySelector('.cmp-bulb')).toBeNull();
    expect(bar.querySelector('.cmp-caret')).toBeNull();
    expect(within(panel).queryByRole('button', { name: 'Screenshot' })).toBeNull();
  });

  it('advertised Turn-bound controls change only the Side Chat draft and ride the atomic send', () => {
    const harness = makeHarness();
    const record = {
      ...sideChat('sc-config'),
      turn_config: {
        model: 'gpt-5.6-sol',
        effort: 'high',
        fast: false,
        approval: 'ask',
      },
      turn_config_revision: 'turn-options-1',
      turn_config_options: [{
        id: 'model',
        displayName: 'Model',
        role: 'model' as const,
        binding: 'turn' as const,
        control: 'select' as const,
        required: true,
        defaultValue: 'gpt-5.6-sol',
        choices: [
          { value: 'gpt-5.6-sol', displayName: 'Sol' },
          { value: 'gpt-5.6-terra', displayName: 'Terra' },
        ],
      }, {
        id: 'effort',
        displayName: 'Thinking',
        role: 'effort' as const,
        binding: 'turn' as const,
        control: 'select' as const,
        required: true,
        defaultValue: 'high',
        choices: [
          { value: 'medium', displayName: 'Medium' },
          { value: 'high', displayName: 'High' },
        ],
      }, {
        id: 'fast',
        displayName: 'Fast',
        role: 'fast' as const,
        binding: 'turn' as const,
        control: 'boolean' as const,
        required: true,
        defaultValue: false,
      }, {
        id: 'approval',
        displayName: 'Approval',
        role: 'approval_mode' as const,
        binding: 'turn' as const,
        control: 'select' as const,
        required: true,
        defaultValue: 'ask',
        choices: [
          { value: 'ask', displayName: 'Ask' },
          { value: 'auto', displayName: 'Auto' },
        ],
      }],
    } satisfies SideChatInfo;
    renderDock(harness, { sideChats: [record] });
    act(() => harness.transport.settle(true)); // resume confirmed

    const panel = screen.getByTestId('sidechat-panel-sc-config');
    expect(within(panel).getByTestId('composer-model-chip')).toHaveTextContent('Sol');
    expect(within(panel).getByTestId('composer-thinking-chip')).toHaveTextContent('High');
    expect(within(panel).getByTestId('composer-fast-chip')).toHaveAttribute('aria-pressed', 'false');
    expect(within(panel).getByRole('button', { name: 'Ask for approval' })).toBeInTheDocument();

    fireEvent.click(within(panel).getByTestId('composer-model-chip'));
    fireEvent.click(screen.getByText('Terra'));
    expect(within(panel).getByTestId('composer-model-chip')).toHaveTextContent('Terra');
    expect(harness.transport.sentOfType('sidechat:set_turn_config').at(-1)).toMatchObject({
      sidechat_id: 'sc-config',
      option_id: 'model',
      value: 'gpt-5.6-terra',
    });

    const textarea = within(panel).getByRole('textbox');
    typeInlineComposer(textarea, 'configured turn');
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(harness.transport.sentOfType('message:send').at(-1)).toMatchObject({
      session_id: 'sc-config',
      text: 'configured turn',
      turn_config: {
        model: 'gpt-5.6-terra',
        effort: 'high',
        fast: false,
        approval: 'ask',
      },
    });
    expect(PARENT.model).toBe('gpt-5.6-sol');
  });

  it('resume failure keeps the content and shows cannot-continue + a close entry (never a fake fresh Side Chat)', () => {
    const harness = makeHarness();
    const record = sideChat('sc-1');
    renderDock(harness, {
      sideChats: [record],
      items: { 'sc-1': sideChatEventItems('sc-1') },
    });
    act(() => harness.transport.settle(false, { code: 'SIDECHAT_UNAVAILABLE', message: 'gone' }));

    expect(screen.getByTestId('sidechat-cannot-continue')).toBeInTheDocument();
    expect(screen.getByTestId('sidechat-close-entry-sc-1')).toBeInTheDocument();
    // Transient content preserved for review.
    expect(screen.getByText('side answer')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('a record arriving unavailable renders cannot-continue directly and dispatches NO resume', () => {
    const harness = makeHarness();
    renderDock(harness, { sideChats: [sideChat('sc-1', 'unavailable', 'error')] });

    expect(harness.transport.sent).toHaveLength(0);
    expect(screen.getByTestId('sidechat-cannot-continue')).toBeInTheDocument();
    expect(screen.getByTestId('sidechat-close-entry-sc-1')).toBeInTheDocument();
  });

  it('close: confirm carries the 4 mandated clauses; cancel keeps everything; confirm → closing; success removes; failure keeps + retry', async () => {
    const harness = makeHarness();
    const record = sideChat('sc-1');
    const onClosed = vi.fn();
    renderDock(harness, { sideChats: [record], onClosed });
    act(() => harness.transport.settle(true)); // resume confirmed

    // 1) Open the close confirm — copy carries all four mandated clauses.
    fireEvent.click(screen.getByTestId('sidechat-close-sc-1'));
    const confirm = getSnapshot().confirms.at(-1)!;
    expect(confirm.danger).toBe(true);
    for (const key of [
      'sidechat.closeConfirm.deleted',
      'sidechat.closeConfirm.turnStopped',
      'sidechat.closeConfirm.sideEffects',
      'sidechat.closeConfirm.providerRecords',
    ]) {
      expect(confirm.message).toContain(EN[key]!);
    }
    // 2) Cancel: nothing dispatched, panel unchanged.
    await act(async () => resolveConfirm(confirm.id, false));
    expect(harness.transport.sentOfType('sidechat:close')).toHaveLength(0);
    expect(screen.getByTestId('sidechat-panel-sc-1')).toBeInTheDocument();

    // 3) Confirm: one sidechat:close, UI enters closing and never flips back.
    fireEvent.click(screen.getByTestId('sidechat-close-sc-1'));
    await act(async () => resolveConfirm(getSnapshot().confirms.at(-1)!.id, true));
    expect(harness.transport.sentOfType('sidechat:close')).toHaveLength(1);
    expect(screen.getByTestId('sidechat-closing')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByTestId('sidechat-close-sc-1')).toBeNull();

    // 4) Failure: closing state keeps an error + retry; nothing removed.
    act(() => harness.transport.settle(false, { code: 'IO', message: 'lost' }));
    expect(onClosed).not.toHaveBeenCalled();
    expect(screen.getByTestId('sidechat-closing')).toBeInTheDocument();
    expect(screen.getByText(EN['sidechat.closeFailed']!)).toBeInTheDocument();

    // 5) Retry continues the SAME confirmed close (idempotent Host-side,
    // §10.5.4); success removes via the authoritative callback.
    fireEvent.click(screen.getByTestId('sidechat-retry-close-sc-1'));
    expect(harness.transport.sentOfType('sidechat:close')).toHaveLength(2);
    act(() => harness.transport.settle(true));
    expect(onClosed).toHaveBeenCalledWith('sc-1');

    // 6) Nothing rendered or sent ever mentions the provider resume reference.
    expect(document.body.innerHTML).not.toContain('resumeRef');
    expect(JSON.stringify(harness.transport.sent)).not.toContain('resumeRef');
  });

  it('a record already closing renders the closing state with no way back to open', () => {
    const harness = makeHarness();
    renderDock(harness, { sideChats: [sideChat('sc-1', 'closing', 'stale')] });
    expect(screen.getByTestId('sidechat-closing')).toBeInTheDocument();
    expect(screen.queryByTestId('sidechat-close-sc-1')).toBeNull();
    expect(harness.transport.sent).toHaveLength(0);
  });

  it('sends via message:send on the Side Chat route (session_id = sidechat id)', () => {
    const harness = makeHarness();
    renderDock(harness, { sideChats: [sideChat('sc-1')] });
    act(() => harness.transport.settle(true)); // resume confirmed

    const textarea = screen.getByRole('textbox');
    typeInlineComposer(textarea, 'hello side chat');
    fireEvent.keyDown(textarea, { key: 'Enter' });

    const sends = harness.transport.sentOfType('message:send');
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ session_id: 'sc-1', text: 'hello side chat' });
    // The parent's session id never leaves in a Side Chat send.
    expect(JSON.stringify(sends)).not.toContain('s-parent');
  });
});

// ─── Parent-session delete cascade (§10.5.4 + Host confirmed-ids contract) ──

describe('parent session delete confirm cascade', () => {
  const t = (key: string) => EN[key] ?? key;

  function renderTopbar(sideChats: SideChatInfo[]) {
    const ops = { dispatch: vi.fn() };
    const hook = renderHook(() => useTopbarModel({
      mode: 'sessions',
      activeTaskId: null,
      activeSubtaskId: null,
      activeSession: PARENT,
      activeWorkspace: null,
      activeWorktreeName: null,
      workingTrees: [],
      refreshWorkingTrees: () => {},
      wtView: null,
      setWtView: () => {},
      viewedWorkingTreeId: () => null,
      activeSessionRecovering: false,
      activeSessionSideChats: sideChats,
      onAssignSessionTask: () => {},
      ops: ops as never,
      t,
    }));
    return { hook, ops };
  }

  it('lists the still-open Side Chats AND passes their ids as confirmed_sidechat_ids (Host requirement)', async () => {
    const { hook, ops } = renderTopbar([sideChat('sc-1'), sideChat('sc-2')]);
    act(() => { void hook.result.current.sessionMenu!.onDelete!(); });

    const confirm = getSnapshot().confirms.at(-1)!;
    expect(confirm.message).toContain('Chat1');
    expect(confirm.message).toContain('Chat2');
    expect(confirm.message).toContain('permanently closed');

    await act(async () => resolveConfirm(confirm.id, true));
    expect(ops.dispatch).toHaveBeenCalledWith('session.delete', {
      sessionId: 's-parent',
      confirmedSidechatIds: ['sc-1', 'sc-2'],
    });
  });

  it('no Side Chats → the confirm keeps its original copy and the delete carries no sidechat ids', async () => {
    const { hook, ops } = renderTopbar([]);
    act(() => { void hook.result.current.sessionMenu!.onDelete!(); });

    const confirm = getSnapshot().confirms.at(-1)!;
    expect(confirm.message).not.toContain('Side chat');
    expect(confirm.message).toContain(EN['coding.session.deleteConfirmSuffix']!);
    await act(async () => resolveConfirm(confirm.id, true));
    expect(ops.dispatch).toHaveBeenCalledWith('session.delete', { sessionId: 's-parent' });
  });
});
