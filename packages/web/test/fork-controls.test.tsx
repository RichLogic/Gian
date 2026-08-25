/**
 * Session Fork UI (gian.proxy/2.0 proposal §10.6) — component-level contract
 * over the REAL operation dispatcher + store:
 *
 * - head fork entry in the session dropdown menu (PathBreadcrumb via
 *   use-topbar-model): always visible, greyed with the Proxy/dynamic reason
 *   or the generic fallback (catalog §9.4 + dynamic snapshot §10.3),
 *   in-flight fork greys it ("forking"), click dispatches the exact head
 *   anchor through the shared `dispatchHeadFork` helper, settled failures
 *   surface via the operation layer's normal error path;
 * - per-turn control: only Terminal Turn boundaries render it; `atTurn`
 *   unsupported greys ONLY the per-turn control (head stays enabled); the
 *   dispatched anchor carries the item's exact turn_id + source_turn_id
 *   verbatim (no derivation, no head fallback); missing Host-flowed identity
 *   greys the control with the generic reason;
 * - origin display: banner names the parent session + boundary, falls back
 *   to a short id, and the fork copy never uses rewind/git/worktree/rollback
 *   vocabulary (asserted against the i18n values themselves, §10.6/§23);
 * - no auto-switch after a successful fork; the legacy "Fork as <executor>"
 *   operation (`session.fork` → session:create) is untouched.
 */
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import type {
  ClientToServerMessage,
  EventEnvelope,
  ServerToClientMessage,
  Session,
} from '@gian/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  dispatchHeadFork,
  ForkFromTurnControl,
  ForkOriginBanner,
  useForkRunSettledToast,
} from '../src/components/ForkControls.js';
import { PathBreadcrumb } from '../src/components/PathBreadcrumb.js';
import { actionControlState } from '../src/components/action-gating.js';
import { useTopbarModel } from '../src/controllers/use-topbar-model.js';
import { EN } from '../src/i18n/en.js';
import { ZH } from '../src/i18n/zh.js';
import { LocaleProvider } from '../src/i18n/index.js';
import { __resetFeedback, getSnapshot } from '../src/feedback.js';
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
import type { OperationRun } from '../src/operations/types.js';
import { Transcript } from '../src/transcript/Transcript.js';
import { applyEnvelope } from '../src/transcript/apply.js';
import { SessionMain } from '../src/views/SessionMain.js';
import type { TranscriptItem } from '../src/types.js';
// Side effects: register the product operation definitions under test.
import '../src/operations/session.js';
import '../src/operations/message.js';
import '../src/operations/sidechat.js';

// SessionMain's Composer discovers executor capabilities lazily — keep the
// REST layer inert (catalog parsing is covered by composer-catalog.test).
vi.mock('../src/api.js', () => ({
  loadChanged: vi.fn(async () => ({})),
  loadProxyCapabilities: vi.fn(async () => ({})),
  loadProxyModels: vi.fn(async () => []),
  loadProxyModes: vi.fn(async () => []),
  loadSlashCommands: vi.fn(async () => []),
  loadSessionSlashCommands: vi.fn(async () => []),
  loadNativeConfig: vi.fn(async () => null),
  loadAgents: vi.fn(async () => []),
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

const FORK_SUPPORTED = [
  { id: 'session.fork', supported: true },
  { id: 'session.fork.atTurn', supported: true },
];
const FORK_ENABLED = {
  'session.fork': { enabled: true },
  'session.fork.atTurn': { enabled: true },
};

function headState(
  catalogActions: Parameters<typeof actionControlState>[0],
  availableActions: Parameters<typeof actionControlState>[1],
) {
  return actionControlState(catalogActions, availableActions, 'session.fork');
}

function atTurnState(
  catalogActions: Parameters<typeof actionControlState>[0],
  availableActions: Parameters<typeof actionControlState>[1],
) {
  return actionControlState(catalogActions, availableActions, 'session.fork.atTurn');
}

beforeEach(() => {
  __resetFeedback();
});

afterEach(() => {
  __resetFeedback();
  while (liveDispatchers.length > 0) liveDispatchers.pop()!.dispose();
});

// ─── Head fork (session dropdown menu) ─────────────────────────────────────

describe('head fork (session dropdown menu)', () => {
  const t = (key: string) => EN[key] ?? key;
  const PARENT_SESSION = {
    id: 's-parent',
    name: 'Parent session',
    type: 'coding',
    task_id: null,
    workspace_id: 'w-1',
    executor: 'codex',
    completed_at: null,
  } as unknown as Session;

  /** Renders the REAL topbar model + breadcrumb; the forkHead input mirrors
   *  the App root's wiring (control/forking/onFork via dispatchHeadFork). */
  function renderTopbarMenu(
    harness: Harness,
    control: ReturnType<typeof headState>,
    forking = false,
  ) {
    function TopbarMenu() {
      const model = useTopbarModel({
        mode: 'sessions',
        activeTaskId: null,
        activeSubtaskId: null,
        activeSession: PARENT_SESSION,
        activeWorkspace: null,
        activeWorktreeName: null,
        workingTrees: [],
        refreshWorkingTrees: () => {},
        wtView: null,
        setWtView: () => {},
        viewedWorkingTreeId: () => null,
        activeSessionRecovering: false,
        forkHead: {
          control,
          forking,
          onFork: () => { dispatchHeadFork(harness.dispatcher.dispatch, 's-parent'); },
        },
        onAssignSessionTask: () => {},
        ops: harness.dispatcher,
        t,
      });
      return <PathBreadcrumb segments={model.pathSegments} sessionMenu={model.sessionMenu} />;
    }
    render(
      <LocaleProvider locale="en">
        <TopbarMenu />
      </LocaleProvider>,
    );
    // Open the session dropdown (click the menu-anchor segment).
    fireEvent.click(screen.getByText('Parent session'));
    return screen.getByTestId('menu-fork');
  }

  it('catalog missing → the menu item is present but greyed with the generic fallback reason', () => {
    const item = renderTopbarMenu(makeHarness(), headState(undefined, undefined));
    expect(item).toBeDisabled();
    expect(item).toHaveAttribute('title', EN['fork.unavailable']);
  });

  it('catalog supported:false → greyed with the PROXY reason', () => {
    const item = renderTopbarMenu(makeHarness(), headState(
      [{ id: 'session.fork', supported: false, reason: 'Runtime has no persistent fork.' }],
      { 'session.fork': { enabled: true } },
    ));
    expect(item).toBeDisabled();
    expect(item).toHaveAttribute('title', 'Runtime has no persistent fork.');
  });

  it('catalog supported but session snapshot disabled → greyed with the DYNAMIC reason', () => {
    const item = renderTopbarMenu(makeHarness(), headState(
      [{ id: 'session.fork', supported: true }],
      { 'session.fork': { enabled: false, reason: 'No Terminal Turn to fork from.' } },
    ));
    expect(item).toBeDisabled();
    expect(item).toHaveAttribute('title', 'No Terminal Turn to fork from.');
  });

  it('enabled → click dispatches the exact head anchor through dispatchHeadFork', () => {
    const harness = makeHarness();
    const item = renderTopbarMenu(harness, headState(
      [{ id: 'session.fork', supported: true }],
      { 'session.fork': { enabled: true } },
    ));
    expect(item).toBeEnabled();

    fireEvent.click(item);
    const forks = harness.transport.sentOfType('session:fork');
    expect(forks).toHaveLength(1);
    expect(forks[0]).toMatchObject({
      source_session_id: 's-parent',
      anchor: { type: 'head' },
    });
  });

  it('tasks-mode subtask menu ALSO shows the Fork entry (§15: standard control in both layouts)', () => {
    const harness = makeHarness();
    function TopbarMenu() {
      const model = useTopbarModel({
        mode: 'tasks',
        activeTaskId: 'task-1',
        activeSubtaskId: 's-parent',
        activeSession: PARENT_SESSION,
        activeWorkspace: null,
        activeWorktreeName: null,
        workingTrees: [],
        refreshWorkingTrees: () => {},
        wtView: null,
        setWtView: () => {},
        viewedWorkingTreeId: () => null,
        activeSessionRecovering: false,
        forkHead: {
          control: headState(
            [{ id: 'session.fork', supported: true }],
            { 'session.fork': { enabled: true } },
          ),
          forking: false,
          onFork: () => { dispatchHeadFork(harness.dispatcher.dispatch, 's-parent'); },
        },
        onAssignSessionTask: () => {},
        ops: harness.dispatcher,
        t,
      });
      return <PathBreadcrumb segments={model.pathSegments} sessionMenu={model.sessionMenu} />;
    }
    render(
      <LocaleProvider locale="en">
        <TopbarMenu />
      </LocaleProvider>,
    );
    fireEvent.click(screen.getByText('Parent session'));
    const item = screen.getByTestId('menu-fork');
    expect(item).toBeEnabled();

    fireEvent.click(item);
    expect(harness.transport.sentOfType('session:fork')).toHaveLength(1);
    expect(harness.transport.sentOfType('session:fork')[0]).toMatchObject({
      source_session_id: 's-parent',
      anchor: { type: 'head' },
    });
  });

  it('an in-flight fork greys the item as "forking" — a second submission is blocked locally', () => {
    const harness = makeHarness();
    const item = renderTopbarMenu(harness, headState(
      [{ id: 'session.fork', supported: true }],
      { 'session.fork': { enabled: true } },
    ), true);
    expect(item).toBeDisabled();
    expect(item).toHaveAttribute('title', EN['fork.forking']);

    fireEvent.click(item);
    expect(harness.transport.sentOfType('session:fork')).toHaveLength(0);
  });

  it('settled failure surfaces the DOMAIN ERROR; timed-out warns; success stays silent (§10.6: never auto-switches)', () => {
    const t2 = (key: string) => EN[key] ?? key;
    const run = (phase: OperationRun['phase']): OperationRun => ({
      id: `run-${phase}`,
      name: 'session.forkSession',
      entityKey: 'pending:session.forkSession:1',
      phase,
      startedAt: 1,
      ...(phase === 'failed'
        ? { error: 'No Terminal Turn at the requested boundary.' }
        : {}),
    });

    const failed = renderHook(() => useForkRunSettledToast(run('failed'), t2));
    expect(getSnapshot().toasts.map(toast => toast.message))
      .toContain('No Terminal Turn at the requested boundary.');
    failed.unmount();
    __resetFeedback();

    const timedOut = renderHook(() => useForkRunSettledToast(run('timed-out'), t2));
    expect(getSnapshot().toasts.some(toast => toast.kind === 'warning')).toBe(true);
    timedOut.unmount();
    __resetFeedback();

    renderHook(() => useForkRunSettledToast(run('confirmed'), t2));
    expect(getSnapshot().toasts).toHaveLength(0);
  });
});

// ─── Per-turn fork control on Terminal Turn boundaries ─────────────────────

describe('ForkFromTurnControl (transcript boundaries)', () => {
  /** Turn 1 terminal WITH Host-flowed identity, turn 2 terminal WITHOUT it,
   *  turn 3 still in flight (no turn-end). */
  function boundaryItems(): TranscriptItem[] {
    return [
      { kind: 'user', id: 'u1', text: 'first question', exec: 'codex', ts: 1, turn: 1 },
      { kind: 'assistant', id: 'a1', text: 'first answer', exec: 'codex', ts: 2, turn: 1 },
      {
        kind: 'turn-end', id: 'te-1', text: 'Turn 1 · complete', ts: 3, turn: 1,
        turn_id: 't_1', source_turn_id: 'provider-turn-1',
      },
      { kind: 'user', id: 'u2', text: 'second question', exec: 'codex', ts: 4, turn: 2 },
      { kind: 'assistant', id: 'a2', text: 'second answer', exec: 'codex', ts: 5, turn: 2 },
      { kind: 'turn-end', id: 'te-2', text: 'Turn 2 · complete', ts: 6, turn: 2 },
      { kind: 'user', id: 'u3', text: 'third question', exec: 'codex', ts: 7, turn: 3 },
    ];
  }

  function renderTranscript(
    harness: Harness,
    state: ReturnType<typeof atTurnState> | null,
    items: TranscriptItem[] = boundaryItems(),
  ) {
    return render(
      <Providers harness={harness}>
        <Transcript
          items={items}
          pending={false}
          onApprove={() => {}}
          forkAtTurn={state ? { sourceSessionId: 's-parent', state } : null}
        />
      </Providers>,
    );
  }

  it('a canonical terminal envelope preserves both identities and enables exact-turn Fork', () => {
    const harness = makeHarness();
    const terminal: EventEnvelope = {
      session_id: 's-parent',
      turn: 1,
      call_id: 'turn-completed-1',
      event: 'turn.completed',
      ts: 3,
      data: { stopReason: 'completed' },
      display: {
        type: 'state.turn-completed',
        data: { turnId: 't_1', sourceTurnId: 'provider-turn-1' },
      },
    };
    renderTranscript(
      harness,
      atTurnState(FORK_SUPPORTED, FORK_ENABLED),
      applyEnvelope([], terminal, 'codex'),
    );

    const button = screen.getByTestId('fork-turn-1');
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(harness.transport.sentOfType('session:fork')[0]).toMatchObject({
      anchor: { type: 'turn', turn_id: 't_1', source_turn_id: 'provider-turn-1' },
    });
  });

  it('only Terminal Turn boundaries render the control; the in-flight turn has none', () => {
    const harness = makeHarness();
    renderTranscript(harness, atTurnState(FORK_SUPPORTED, FORK_ENABLED));
    expect(screen.getByTestId('fork-turn-1')).toBeInTheDocument();
    expect(screen.getByTestId('fork-turn-2')).toBeInTheDocument();
    expect(screen.queryByTestId('fork-turn-3')).toBeNull();
  });

  it('no forkAtTurn prop (e.g. a Side Chat panel — never a fork source, §10.6) renders no controls', () => {
    const harness = makeHarness();
    renderTranscript(harness, null);
    expect(screen.queryByTestId('fork-turn-1')).toBeNull();
    expect(document.querySelectorAll('.turn-fork')).toHaveLength(0);
  });

  it('atTurn unsupported greys ONLY the per-turn control — the head menu entry stays enabled', () => {
    const harness = makeHarness();
    const head = headState(
      [{ id: 'session.fork', supported: true }, { id: 'session.fork.atTurn', supported: false }],
      { 'session.fork': { enabled: true } },
    );
    expect(head.enabled).toBe(true);
    render(
      <Providers harness={harness}>
        <Transcript
          items={boundaryItems()}
          pending={false}
          onApprove={() => {}}
          forkAtTurn={{
            sourceSessionId: 's-parent',
            state: atTurnState(
              [{ id: 'session.fork', supported: true }, { id: 'session.fork.atTurn', supported: false }],
              { 'session.fork': { enabled: true } },
            ),
          }}
        />
      </Providers>,
    );
    expect(screen.getByTestId('fork-turn-1')).toBeDisabled();
    expect(screen.getByTestId('fork-turn-2')).toBeDisabled();
  });

  it('enabled with Host-flowed identity → dispatch carries the EXACT turn_id + source_turn_id verbatim', () => {
    const harness = makeHarness();
    renderTranscript(harness, atTurnState(FORK_SUPPORTED, FORK_ENABLED));

    fireEvent.click(screen.getByTestId('fork-turn-1'));
    const forks = harness.transport.sentOfType('session:fork');
    expect(forks).toHaveLength(1);
    expect(forks[0]).toMatchObject({
      source_session_id: 's-parent',
      anchor: { type: 'turn', turn_id: 't_1', source_turn_id: 'provider-turn-1' },
    });
    // No head fallback, no adjacent-turn semantics, nothing derived from text.
    expect(JSON.stringify(forks[0])).not.toContain('"head"');
  });

  it('missing source_turn_id on the item → greyed with the generic reason (never fabricated)', () => {
    const harness = makeHarness();
    renderTranscript(harness, atTurnState(FORK_SUPPORTED, FORK_ENABLED));
    const button = screen.getByTestId('fork-turn-2');
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', EN['fork.fromTurnUnavailable']);

    fireEvent.click(button);
    expect(harness.transport.sentOfType('session:fork')).toHaveLength(0);
  });

  it('session snapshot disables atTurn → greyed with the DYNAMIC reason', () => {
    const harness = makeHarness();
    renderTranscript(harness, atTurnState(
      FORK_SUPPORTED,
      {
        'session.fork': { enabled: true },
        'session.fork.atTurn': { enabled: false, reason: 'History was rewritten after this Turn.' },
      },
    ));
    expect(screen.getByTestId('fork-turn-1')).toBeDisabled();
    expect(screen.getByTestId('fork-turn-1'))
      .toHaveAttribute('title', 'History was rewritten after this Turn.');
  });

  it('ForkFromTurnControl failure surfaces via the same error path', () => {
    const harness = makeHarness();
    render(
      <Providers harness={harness}>
        <ForkFromTurnControl
          sourceSessionId="s-parent"
          turn={1}
          turnId="t_1"
          sourceTurnId="provider-turn-1"
          state={atTurnState(FORK_SUPPORTED, FORK_ENABLED)}
        />
      </Providers>,
    );
    fireEvent.click(screen.getByTestId('fork-turn-1'));
    act(() => harness.transport.settle(false, {
      code: 'FORK_BOUNDARY_UNAVAILABLE',
      message: 'Boundary no longer exists.',
    }));
    const errorToasts = getSnapshot().toasts.filter(toast => toast.kind === 'error');
    expect(errorToasts.map(toast => toast.message)).toContain('Boundary no longer exists.');
  });
});

// ─── Origin display (§10.6) ────────────────────────────────────────────────

describe('fork origin display', () => {
  it('banner names the parent session and the boundary turn reference', () => {
    render(
      <LocaleProvider locale="en">
        <ForkOriginBanner
          origin={{ kind: 'fork', session_id: 's-parent', turn_id: 't_2', source_turn_id: 'provider-turn-2' }}
          parentName="Parent session"
        />
      </LocaleProvider>,
    );
    const banner = screen.getByTestId('fork-origin-banner');
    expect(banner).toHaveTextContent('Forked from Parent session');
    expect(banner).toHaveTextContent('t_2');
  });

  it('head fork shows no boundary; unknown parent falls back to a short id', () => {
    render(
      <LocaleProvider locale="en">
        <ForkOriginBanner origin={{ kind: 'fork', session_id: 's-parent-abcdef' }} />
      </LocaleProvider>,
    );
    const banner = screen.getByTestId('fork-origin-banner');
    expect(banner).toHaveTextContent('Forked from s-parent');
    expect(banner.textContent).not.toContain('turn');
  });

  it('fork copy never uses rewind / git / worktree / rollback vocabulary (§10.6/§23)', () => {
    const bannedEn = /rewind|worktree|rollback|roll back|\bgit\b|\bbranch|snapshot|isolat/iu;
    const bannedZh = /回滚|分支|工作树|快照|隔离|还原/u;
    const forkKeys = (messages: Record<string, string>) =>
      Object.entries(messages).filter(([key]) => key.startsWith('fork.'));
    expect(forkKeys(EN).length).toBeGreaterThan(0);
    // Key parity en/zh for the fork namespace.
    expect(forkKeys(EN).map(([key]) => key).sort())
      .toEqual(forkKeys(ZH).map(([key]) => key).sort());
    for (const [key, value] of forkKeys(EN)) {
      expect(bannedEn.test(value), `EN ${key}: "${value}"`).toBe(false);
    }
    for (const [key, value] of forkKeys(ZH)) {
      expect(bannedZh.test(value), `ZH ${key}: "${value}"`).toBe(false);
    }
  });

  it('SessionMain renders the origin banner and the per-turn control — the header pill is gone (head fork lives in the session menu)', () => {
    const harness = makeHarness();
    const session = {
      id: 's-fork',
      name: 'Forked session',
      type: 'coding',
      task_id: null,
      workspace_id: null,
      executor: 'codex',
      model: 'gpt-5.6-sol',
      approval_mode: 'ask',
      native_config_options: [],
      thinking_effort: null,
      status: 'done',
      completed_at: null,
      worktree_outcome: null,
      available_actions: FORK_ENABLED,
      origin: { kind: 'fork', session_id: 's-parent', turn_id: 't_1' },
    } as unknown as Session;
    render(
      <Providers harness={harness}>
        <SessionMain
          session={session}
          workspace={null}
          items={[
            { kind: 'user', id: 'u1', text: 'q', exec: 'codex', ts: 1, turn: 1 },
            { kind: 'assistant', id: 'a1', text: 'a', exec: 'codex', ts: 2, turn: 1 },
            {
              kind: 'turn-end', id: 'te-1', text: 'Turn 1 · complete', ts: 3, turn: 1,
              turn_id: 't_1', source_turn_id: 'provider-turn-1',
            },
          ]}
          hydrated
          pending={false}
          queue={[]}
          workingTreeId={null}
          branch={null}
          onSend={() => {}}
          onSendSkill={() => {}}
          onStop={() => {}}
          onApprove={() => {}}
          onQueueAdd={() => {}}
          onQueueRemove={() => {}}
          onQueueUpdate={() => {}}
          onQueueClear={() => {}}
          onQueueSendNow={() => {}}
          onSteer={() => {}}
          onSetMode={() => {}}
          onSetModel={() => {}}
          onSetEffort={() => {}}
          onSetServiceTier={() => {}}
          onSetNativeConfig={() => {}}
          onDelete={() => {}}
          onShowChanges={() => {}}
          onShowLastTurnChanges={() => {}}
          forkAtTurnControl={atTurnState(FORK_SUPPORTED, FORK_ENABLED)}
          originParentName="Parent session"
        />
      </Providers>,
    );
    // The .main-head-r pills were removed — no head-fork or side-chat buttons
    // in the session header anymore.
    expect(screen.queryByTestId('fork-head')).toBeNull();
    expect(screen.queryByTestId('sidechat-create')).toBeNull();
    expect(screen.getByTestId('fork-turn-1')).toBeEnabled();
    expect(screen.getByTestId('fork-origin-banner'))
      .toHaveTextContent('Forked from Parent session');
  });

  it('SessionMain without fork props renders no fork UI (sessions without the capability unchanged)', () => {
    const harness = makeHarness();
    const session = {
      id: 's-plain',
      name: 'Plain session',
      type: 'coding',
      task_id: null,
      workspace_id: null,
      executor: 'codex',
      model: 'gpt-5.6-sol',
      approval_mode: 'ask',
      native_config_options: [],
      thinking_effort: null,
      status: 'done',
      completed_at: null,
      worktree_outcome: null,
    } as unknown as Session;
    render(
      <Providers harness={harness}>
        <SessionMain
          session={session}
          workspace={null}
          items={[
            { kind: 'turn-end', id: 'te-1', text: 'Turn 1 · complete', ts: 3, turn: 1 },
          ]}
          hydrated
          pending={false}
          queue={[]}
          workingTreeId={null}
          branch={null}
          onSend={() => {}}
          onSendSkill={() => {}}
          onStop={() => {}}
          onApprove={() => {}}
          onQueueAdd={() => {}}
          onQueueRemove={() => {}}
          onQueueUpdate={() => {}}
          onQueueClear={() => {}}
          onQueueSendNow={() => {}}
          onSteer={() => {}}
          onSetMode={() => {}}
          onSetModel={() => {}}
          onSetEffort={() => {}}
          onSetServiceTier={() => {}}
          onSetNativeConfig={() => {}}
          onDelete={() => {}}
          onShowChanges={() => {}}
          onShowLastTurnChanges={() => {}}
        />
      </Providers>,
    );
    expect(screen.queryByTestId('fork-head')).toBeNull();
    expect(screen.queryByTestId('fork-turn-1')).toBeNull();
    expect(screen.queryByTestId('fork-origin-banner')).toBeNull();
  });
});

// ─── Legacy "Fork as <executor>" operation is a different feature ─────────

describe('legacy session.fork (fork-as-executor) unaffected', () => {
  it('still dispatches session:create, never session:fork', () => {
    const harness = makeHarness();
    harness.dispatcher.dispatch('session.fork', {
      workspaceId: 'w-1',
      executor: 'claude',
      name: 'Fork as Claude',
      approvalMode: 'ask',
    });
    const creates = harness.transport.sentOfType('session:create');
    expect(creates).toHaveLength(1);
    expect(creates[0]).toMatchObject({
      workspace_id: 'w-1',
      executor: 'claude',
      name: 'Fork as Claude',
      approval_mode: 'ask',
    });
    expect(harness.transport.sentOfType('session:fork')).toHaveLength(0);
  });
});
