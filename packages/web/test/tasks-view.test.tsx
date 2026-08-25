// Coverage for the beta-1.0 Tasks redesign (manager removed from the web):
//   - subtasksFor: pinned subtasks float to the top (pinned_at DESC), the rest
//     keep created_at DESC; user-completed subtasks sink to the bottom.
//   - The sidebar is two collapsible sections: 进行中 (In Progress) and
//     完成 (Done), task pin was removed (2026-08-03) — tasks sort by
//     created_at DESC.
//   - Task group rows carry a "⋯" menu (rename / completed-session
//     visibility / done-toggle / delete with confirm) and a "+" that opens
//     the task-context new-session form. The menu is portaled to <body> and
//     viewport-clamped (fixed) because the sidebar clips absolute overflow,
//     and closes on scroll/resize since it cannot track its anchor.
//   - Done rows keep the same menu (no "+") and are not selectable.
//   - Subtask rows carry hover pin (`session.pin`, open subtasks only) and a
//     complete/reopen toggle (task.completeSubtask / task.reopenSubtask),
//     disabled while a turn is running.
//   - Tasks exposes only the new-task action in its sidebar header; the
//     session-search button remains exclusive to Sessions view.
//   - All task mutations dispatch through the operation layer (Phase 3a):
//     rename/done/pin are optimistic overlays on `task:<id>`, create/delete
//     are pending (delete keeps the row visible with a pending affordance).
//   - The sidebar "+" creates a task with NO executor pick.
//   - A selected task (no session) shows the placeholder panel.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientToServerMessage, Session, Task, Workspace } from '@gian/shared';
import { completeSubtask, createSubtask, reopenSubtask } from '../src/api.js';
import { __resetFeedback, getSnapshot, resolveConfirm } from '../src/feedback.js';
import { LocaleProvider } from '../src/i18n/index.js';
import { createOperationDispatcher } from '../src/operations/dispatcher.js';
// Side effects: register the product Session/Task definitions (subtask pin
// routes through session.pin since Phase 2a; task + subtask mutations
// through the task operations since Phase 3a).
import '../src/operations/session.js';
import '../src/operations/task.js';
import { createOperationStore } from '../src/operations/store.js';
import { OperationDispatcherProvider, OperationStoreProvider } from '../src/operations/use-operations.js';
import { TasksView, subtasksFor } from '../src/views/TasksView.js';

vi.mock('../src/api.js', () => ({
  completeSubtask: vi.fn(),
  reopenSubtask: vi.fn(),
  createSubtask: vi.fn(),
  createWorkspace: vi.fn(),
  peekAgents: vi.fn(() => null),
  loadProxyModels: vi.fn().mockResolvedValue([]),
  loadProxyCapabilities: vi.fn().mockResolvedValue({ protocolVersion: 'test', models: [], modes: [], slashCommands: [] }),
  loadAgents: vi.fn().mockResolvedValue([
    {
      id: 'agent-codex-1',
      name: 'Codex',
      color: 'ink',
      proxy: 'codex',
      cliPath: '/bin/codex',
      defaults: { model: '', thinking: '', mode: '' },
      proxyName: 'Codex',
      ready: true,
      cli: { state: 'ready', path: '/bin/codex', version: '1.0.0', source: 'path' },
      plugin: { state: 'ready', path: '/proxy/codex', version: '0.1.0', source: 'github-release', defaults: { model: '', thinking: '', mode: '' } },
      officialInstallUrl: 'https://example.invalid',
    },
  ]),
}));

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    name: 'My task',
    description: null,
    status: 'open',
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
    pinned_at: null,
    ...overrides,
  };
}

function subtask(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sub-1',
    name: 'Sub session',
    type: 'subtask',
    task_id: 'task-1',
    workspace_id: 'ws-1',
    executor: 'codex',
    model: null,
    approval_mode: 'ask',
    executor_config: { schemaVersion: 1, values: {} },
    native_config_options: [],
    thinking_effort: null,
    service_tier: null,
    active_channel: 'web',
    status: 'done',
    archived: 0,
    pinned_at: null,
    unread: 0,
    worktree_path: null,
    branch: null,
    base_branch: null,
    worktree_outcome: null,
    native_session_id: null,
    summary: null,
    completed_at: null,
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
    ...overrides,
  };
}

function workspace(id: string): Workspace {
  return {
    id,
    name: `WS ${id}`,
    path: `/tmp/${id}`,
    sort_order: 0,
    hidden: 0,
    pinned: 0,
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
  };
}

/** Operation-layer harness: every TasksView mutation dispatches through a
 *  real dispatcher bound to a capture transport (Phase 2a pin, Phase 3a
 *  task + subtask operations). */
function operationHarness() {
  const sent: ClientToServerMessage[] = [];
  const store = createOperationStore();
  const dispatcher = createOperationDispatcher({
    store,
    transport: {
      send: msg => sent.push(msg),
      onMessage: () => () => {},
      onState: listener => { listener('open', 0); return () => {}; },
    },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <OperationStoreProvider store={store}>
      <OperationDispatcherProvider dispatcher={dispatcher}>{children}</OperationDispatcherProvider>
    </OperationStoreProvider>
  );
  return { sent, store, wrapper };
}

function renderTasks(props: Partial<Parameters<typeof TasksView>[0]> = {}) {
  const onSelectTask = vi.fn();
  const onSelectSubtask = vi.fn();
  const onSetPendingFirstMessage = vi.fn();
  const harness = operationHarness();
  const view = render(
    <LocaleProvider locale="en">
      <harness.wrapper>
        <TasksView
          mode="tasks"
          onSetMode={vi.fn()}
          tasks={[]}
          sessions={[]}
          workspaces={[workspace('ws-1')]}
          activeTaskId={null}
          activeSubtaskId={null}
          subtaskMain={null}
          onSelectTask={onSelectTask}
          onSelectSubtask={onSelectSubtask}
          onNewWorkspace={vi.fn()}
          onSetPendingFirstMessage={onSetPendingFirstMessage}
          {...props}
        />
      </harness.wrapper>
    </LocaleProvider>,
  );
  return {
    onSelectTask,
    onSelectSubtask,
    onSetPendingFirstMessage,
    opSent: harness.sent,
    unmount: view.unmount,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(completeSubtask).mockResolvedValue(true);
  vi.mocked(reopenSubtask).mockResolvedValue(true);
  __resetFeedback();
  localStorage.clear();
});

describe('subtasksFor ordering', () => {
  it('puts pinned subtasks first (pinned_at DESC), then created_at DESC', () => {
    const sessions = [
      subtask({ id: 'a', created_at: '2026-08-01T03:00:00Z' }),
      subtask({ id: 'b', pinned_at: '2026-08-01T01:00:00Z', created_at: '2026-08-01T01:00:00Z' }),
      subtask({ id: 'c', created_at: '2026-08-01T02:00:00Z' }),
      subtask({ id: 'd', pinned_at: '2026-08-01T02:00:00Z', created_at: '2026-08-01T00:00:00Z' }),
    ];
    expect(subtasksFor(sessions, 'task-1').map(s => s.id)).toEqual(['d', 'b', 'a', 'c']);
  });

  it('sinks completed subtasks to the bottom (created_at DESC), pins ignored', () => {
    const sessions = [
      subtask({ id: 'a', created_at: '2026-08-01T01:00:00Z' }),
      subtask({ id: 'b', completed_at: '2026-08-01T02:00:00Z', created_at: '2026-08-01T03:00:00Z' }),
      subtask({ id: 'c', pinned_at: '2026-08-01T02:00:00Z', created_at: '2026-08-01T02:00:00Z' }),
      subtask({ id: 'd', completed_at: '2026-08-01T01:00:00Z', pinned_at: '2026-08-01T03:00:00Z', created_at: '2026-08-01T04:00:00Z' }),
    ];
    expect(subtasksFor(sessions, 'task-1').map(s => s.id)).toEqual(['c', 'a', 'd', 'b']);
  });

  it('ignores sessions of other tasks and non-subtask types', () => {
    const sessions = [
      subtask({ id: 'a' }),
      subtask({ id: 'b', task_id: 'task-2' }),
      subtask({ id: 'c', type: 'coding' }),
    ];
    expect(subtasksFor(sessions, 'task-1').map(s => s.id)).toEqual(['a']);
  });
});

describe('task group row actions', () => {
  it('portals the menu to <body> with fixed viewport-clamped positioning', async () => {
    // 2026-08-14: the sidebar clips absolutely-positioned overflow, which cut
    // long labels off at the rail's left edge — the popover must live outside
    // the sidebar tree and opt into the fixed-position variant.
    renderTasks({ tasks: [task()] });
    await userEvent.click(screen.getByTestId('task-menu-task-1'));
    const menu = screen.getByRole('menu');
    expect(menu).toHaveClass('ws-kebab-pop', 'ws-kebab-pop--fixed');
    expect(menu.parentElement).toBe(document.body);
    expect(menu.closest('.sidebar')).toBeNull();
    expect(screen.getByTestId('task-menu-task-1').closest('.ws-kebab-anchor')).not.toContainElement(menu);
  });

  it('closes the portaled menu on scroll and window resize', async () => {
    // The popover is position: fixed, so it cannot track the anchor when the
    // sidebar scrolls — close instead of leaving it detached mid-air.
    renderTasks({ tasks: [task()] });
    await userEvent.click(screen.getByTestId('task-menu-task-1'));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.scroll(screen.getByTestId('task-menu-task-1'));
    expect(screen.queryByRole('menu')).toBeNull();

    await userEvent.click(screen.getByTestId('task-menu-task-1'));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.resize(window);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('has no pin item — task pin was removed (2026-08-03)', async () => {
    renderTasks({ tasks: [task()] });
    await userEvent.click(screen.getByTestId('task-menu-task-1'));
    expect(screen.queryByRole('menuitem', { name: 'Pin to top' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Rename' })).toBeInTheDocument();
  });

  it('hides and restores only this Task\'s completed Session rows', async () => {
    const props: Partial<Parameters<typeof TasksView>[0]> = {
      tasks: [
        task({ id: 'task-1', name: 'First task' }),
        task({ id: 'task-2', name: 'Second task', created_at: '2026-08-02T00:00:00Z' }),
      ],
      sessions: [
        subtask({ id: 'finished-1', name: 'First completed', completed_at: '2026-08-02T01:00:00Z' }),
        subtask({ id: 'turn-done-1', name: 'Turn done but not completed', status: 'done' }),
        subtask({ id: 'running-1', name: 'Still running', status: 'running' }),
        subtask({
          id: 'finished-2',
          name: 'Second completed',
          task_id: 'task-2',
          completed_at: '2026-08-02T02:00:00Z',
        }),
      ],
      activeTaskId: 'task-1',
      activeSubtaskId: 'finished-1',
      subtaskMain: <div>Selected completed detail</div>,
    };
    const firstRender = renderTasks(props);

    expect(screen.getByText('First completed')).toBeInTheDocument();
    expect(screen.getByText('Second completed')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('task-menu-task-1'));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Hide completed' }));

    expect(screen.queryByText('First completed')).toBeNull();
    expect(screen.getByText('Turn done but not completed')).toBeInTheDocument();
    expect(screen.getByText('Still running')).toBeInTheDocument();
    expect(screen.getByText('Second completed')).toBeInTheDocument();
    expect(screen.getByText('Selected completed detail')).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('gian.tasks.completed-hidden') ?? '[]')).toEqual(['task-1']);

    firstRender.unmount();
    renderTasks(props);
    expect(screen.queryByText('First completed')).toBeNull();
    await userEvent.click(screen.getByTestId('task-menu-task-1'));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Show completed' }));
    expect(screen.getByText('First completed')).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('gian.tasks.completed-hidden') ?? '[]')).toEqual([]);
  });

  it('renames inline via the menu', async () => {
    const { opSent } = renderTasks({ tasks: [task()] });
    await userEvent.click(screen.getByTestId('task-menu-task-1'));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Rename' }));
    const input = screen.getByLabelText('Task name');
    await userEvent.clear(input);
    await userEvent.type(input, 'Renamed{Enter}');
    expect(opSent.at(-1)).toMatchObject({ type: 'task:update', task_id: 'task-1', name: 'Renamed' });
    expect((opSent.at(-1) as { request_id?: string })?.request_id).toBeTruthy();
  });

  it('marks the task done via task:update status', async () => {
    const { opSent } = renderTasks({ tasks: [task()] });
    await userEvent.click(screen.getByTestId('task-menu-task-1'));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Mark done' }));
    expect(opSent.at(-1)).toMatchObject({ type: 'task:update', task_id: 'task-1', status: 'done' });
  });

  it('open tasks cannot be deleted — no Delete item (2026-08-03)', async () => {
    renderTasks({ tasks: [task()] });
    await userEvent.click(screen.getByTestId('task-menu-task-1'));
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).toBeNull();
  });

  it('blocks mark-done while a subtask is running', async () => {
    const { opSent } = renderTasks({
      tasks: [task()],
      sessions: [subtask({ status: 'running' })],
    });
    await userEvent.click(screen.getByTestId('task-menu-task-1'));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Mark done' }));
    expect(opSent.some(msg => msg.type === 'task:update')).toBe(false);
    expect(getSnapshot().toasts.some(t => t.kind === 'error')).toBe(true);
  });

  it('deletes a DONE task after the confirm dialog', async () => {
    const { opSent } = renderTasks({ tasks: [task({ status: 'done' })] });
    await userEvent.click(screen.getByTestId('tasks-section-done'));
    await userEvent.click(screen.getByTestId('task-menu-task-1'));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    const confirmRec = getSnapshot().confirms[0];
    expect(confirmRec?.message).toContain('My task');
    resolveConfirm(confirmRec!.id, true);
    await waitFor(() => {
      expect(opSent.some(msg => msg.type === 'task:delete'
        && (msg as { task_id?: string }).task_id === 'task-1')).toBe(true);
    });
    // Destructive-pending row treatment (proposal §5): the row stays visible
    // with a pending affordance until task:deleted lands.
    expect(await screen.findByTestId('task-deleting-task-1')).toBeInTheDocument();
  });

  it('opens the task-context new-session form from "+" and creates a subtask', async () => {
    const { onSelectSubtask, onSetPendingFirstMessage } = renderTasks({ tasks: [task()], activeTaskId: 'task-1' });
    await userEvent.click(screen.getByTestId('task-new-session-task-1'));
    // The task association is carried by the create route, not repeated in
    // the empty center of the New Session page.
    expect(screen.queryByTestId('ns-task-name')).not.toBeInTheDocument();
    vi.mocked(createSubtask).mockResolvedValue(subtask({ id: 'sub-new' }));
    // The composer auto-selects the only ready agent (codex in this mock);
    // Send enables once a first message is typed.
    await userEvent.type(await screen.findByTestId('ns-title-input'), 'Child title');
    await userEvent.click(screen.getByTestId('ns-model-chip'));
    await userEvent.click(await screen.findByRole('switch', { name: 'Fast' }));
    await userEvent.type(await screen.findByTestId('ns-message-input'), 'first subtask message');
    await userEvent.click(screen.getByTestId('ns-send'));
    // The first message is stashed for the session:created socket handler…
    expect(onSetPendingFirstMessage).toHaveBeenCalledWith({
      scope: { kind: 'task', id: 'task-1' },
      text: 'first subtask message',
      attachments: [],
    });
    await waitFor(() => {
      expect(createSubtask).toHaveBeenCalledWith('task-1', {
        workspace_id: 'ws-1',
        agent_id: 'agent-codex-1',
        executor: 'codex',
        name: 'Child title',
        service_tier: 'fast',
      });
    });
    await waitFor(() => {
      expect(onSelectSubtask).toHaveBeenCalledWith('task-1', 'sub-new');
    });
    // Confirmed creation is the only boundary that discards the Task draft.
    await userEvent.click(screen.getByTestId('task-new-session-task-1'));
    expect(await screen.findByTestId('ns-title-input')).toHaveValue('');
    expect(screen.getByTestId('ns-message-input')).toHaveValue('');
  });

  it('lets a sidebar Session replace New Session while preserving separate Task drafts', async () => {
    const taskOne = task({ id: 'task-1', name: 'Task one' });
    const taskTwo = task({
      id: 'task-2',
      name: 'Task two',
      created_at: '2026-08-02T00:00:00Z',
      updated_at: '2026-08-02T00:00:00Z',
    });
    const sessionOne = subtask({ id: 'sub-1', task_id: 'task-1', name: 'Task one session' });
    const sessionTwo = subtask({ id: 'sub-2', task_id: 'task-2', name: 'Task two session' });
    const { onSelectSubtask } = renderTasks({
      tasks: [taskOne, taskTwo],
      sessions: [sessionOne, sessionTwo],
    });

    await userEvent.click(screen.getByTestId('task-new-session-task-1'));
    await userEvent.type(await screen.findByTestId('ns-title-input'), 'Draft for task one');
    await userEvent.type(screen.getByTestId('ns-message-input'), 'continue task one');

    // Selecting any existing Session must win immediately over the draft UI.
    await userEvent.click(screen.getByText('Task two session'));
    expect(onSelectSubtask).toHaveBeenCalledWith('task-2', 'sub-2');
    expect(screen.queryByTestId('ns-message-input')).toBeNull();

    await userEvent.click(screen.getByTestId('task-new-session-task-2'));
    expect(await screen.findByTestId('ns-title-input')).toHaveValue('');
    expect(screen.getByTestId('ns-message-input')).toHaveValue('');
    await userEvent.type(screen.getByTestId('ns-message-input'), 'continue task two');

    await userEvent.click(screen.getByText('Task one session'));
    expect(screen.queryByTestId('ns-message-input')).toBeNull();
    await userEvent.click(screen.getByTestId('task-new-session-task-1'));
    expect(await screen.findByTestId('ns-title-input')).toHaveValue('Draft for task one');
    expect(screen.getByTestId('ns-message-input')).toHaveValue('continue task one');
  });
});

describe('sections (进行中 / 完成)', () => {
  it('renders open tasks under In Progress and done tasks under Done, both collapsible', async () => {
    renderTasks({
      tasks: [
        task({ id: 'task-1', name: 'Open one' }),
        task({ id: 'task-2', name: 'Done one', status: 'done', created_at: '2026-08-02T00:00:00Z' }),
      ],
    });
    // Open tasks render directly (no section header); 完成 collapsed by default.
    expect(screen.getByText('Open one')).toBeInTheDocument();
    expect(screen.queryByText('Done one')).toBeNull();
    await userEvent.click(screen.getByTestId('tasks-section-done'));
    expect(screen.getByText('Done one')).toBeInTheDocument();
    // 完成 row is struck + greyed and carries no "+".
    expect(screen.getByText('Done one').closest('.done-task-group')).not.toBeNull();
    expect(screen.queryByTestId('task-new-session-task-2')).toBeNull();
  });
});

describe('done group', () => {
  it('shows the menu without pin or "+" on done rows; reopen via menu', async () => {
    const { opSent } = renderTasks({ tasks: [task({ status: 'done' })] });
    await userEvent.click(screen.getByTestId('tasks-section-done'));
    await userEvent.click(screen.getByTestId('task-menu-task-1'));
    expect(screen.queryByRole('menuitem', { name: 'Pin to top' })).toBeNull();
    // Done tasks can't be renamed (2026-08-03).
    expect(screen.queryByRole('menuitem', { name: 'Rename' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Hide all completed sessions' })).toBeNull();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Reopen' }));
    expect(opSent.at(-1)).toMatchObject({ type: 'task:update', task_id: 'task-1', status: 'open' });
    expect(screen.queryByTestId('task-new-session-task-1')).toBeNull();
  });
});

describe('subtask row actions', () => {
  it('pins via session.pin (operation layer, request-correlated)', async () => {
    const { opSent } = renderTasks({ tasks: [task()], sessions: [subtask()] });
    const row = screen.getByText('Sub session').closest('.session-row')!;
    await userEvent.hover(row);
    await userEvent.click(screen.getByTestId('subtask-pin-sub-1'));
    expect(opSent.at(-1)).toMatchObject({ type: 'session:pin', session_id: 'sub-1', pinned: true });
    expect((opSent.at(-1) as { request_id?: string })?.request_id).toBeTruthy();
  });

  it('a completed subtask cannot be pinned — no pin button', () => {
    renderTasks({
      tasks: [task()],
      sessions: [subtask({ completed_at: '2026-08-01T04:00:00Z' })],
    });
    expect(screen.queryByTestId('subtask-pin-sub-1')).toBeNull();
    // The reopen toggle is still there (hover action).
    expect(screen.getByTestId('subtask-complete-sub-1')).toBeInTheDocument();
  });

  it('completes via REST /complete and reopens via /reopen (operation layer)', async () => {
    const harness = operationHarness();
    const { rerender } = render(
      <LocaleProvider locale="en">
        <harness.wrapper>
          <TasksView
            mode="tasks"
            onSetMode={vi.fn()}
            tasks={[task()]}
            sessions={[subtask()]}
            workspaces={[workspace('ws-1')]}
            activeTaskId={null}
            activeSubtaskId={null}
            subtaskMain={null}
            onSelectTask={vi.fn()}
            onSelectSubtask={vi.fn()}
            onNewWorkspace={vi.fn()}
          />
        </harness.wrapper>
      </LocaleProvider>,
    );
    await userEvent.click(screen.getByTestId('subtask-complete-sub-1'));
    expect(completeSubtask).toHaveBeenCalledWith('sub-1');

    rerender(
      <LocaleProvider locale="en">
        <harness.wrapper>
          <TasksView
            mode="tasks"
            onSetMode={vi.fn()}
            tasks={[task()]}
            sessions={[subtask({ completed_at: '2026-08-01T04:00:00Z' })]}
            workspaces={[workspace('ws-1')]}
            activeTaskId={null}
            activeSubtaskId={null}
            subtaskMain={null}
            onSelectTask={vi.fn()}
            onSelectSubtask={vi.fn()}
            onNewWorkspace={vi.fn()}
          />
        </harness.wrapper>
      </LocaleProvider>,
    );
    await userEvent.click(screen.getByTestId('subtask-complete-sub-1'));
    expect(reopenSubtask).toHaveBeenCalledWith('sub-1');
  });

  it('hides the complete toggle while the turn is running (pin stays)', () => {
    renderTasks({ tasks: [task()], sessions: [subtask({ status: 'running' })] });
    expect(screen.queryByTestId('subtask-complete-sub-1')).toBeNull();
    expect(screen.getByTestId('subtask-pin-sub-1')).toBeTruthy();
  });
});

describe('new task form', () => {
  it('does not render the Sessions search button', () => {
    renderTasks();
    expect(screen.queryByTestId('sb-open-search')).toBeNull();
    expect(screen.getByTestId('sb-new-task')).toBeTruthy();
  });

  it('creates a task without any executor pick', async () => {
    const { opSent } = renderTasks();
    await userEvent.click(screen.getByTestId('sb-new-task'));
    await userEvent.type(screen.getByLabelText('Task name'), 'Fresh task');
    await userEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(opSent.at(-1)).toMatchObject({ type: 'task:create', name: 'Fresh task' });
    expect((opSent.at(-1) as { request_id?: string })?.request_id).toBeTruthy();
  });
});

describe('task detail placeholder', () => {
  it('shows the task name and pick/create hint when only a task is selected', () => {
    const harness = operationHarness();
    const { container } = render(
      <LocaleProvider locale="en">
        <harness.wrapper>
          <TasksView
            mode="tasks"
            onSetMode={vi.fn()}
            tasks={[task()]}
            sessions={[]}
            workspaces={[workspace('ws-1')]}
            activeTaskId="task-1"
            activeSubtaskId={null}
            subtaskMain={null}
            onSelectTask={vi.fn()}
            onSelectSubtask={vi.fn()}
            onNewWorkspace={vi.fn()}
          />
        </harness.wrapper>
      </LocaleProvider>,
    );
    expect(container.querySelector('.tasks-detail-task-name')).toHaveTextContent('My task');
    expect(screen.getByText(/Pick a session from the list/)).toBeInTheDocument();
  });
});
