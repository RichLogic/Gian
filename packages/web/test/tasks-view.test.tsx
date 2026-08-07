// Coverage for the beta-1.0 Tasks redesign (manager removed from the web):
//   - subtasksFor: pinned subtasks float to the top (pinned_at DESC), the rest
//     keep created_at DESC; user-completed subtasks sink to the bottom.
//   - The sidebar is two collapsible sections: 进行中 (In Progress) and
//     完成 (Done), task pin was removed (2026-08-03) — tasks sort by
//     created_at DESC.
//   - Task group rows carry a "⋯" menu (rename / done-toggle / delete
//     with confirm) and a "+" that opens the task-context new-session form.
//   - Done rows keep the same menu (no "+") and are not selectable.
//   - Subtask rows carry hover pin (`session.pin`, open subtasks only) and a
//     complete/reopen toggle (task.completeSubtask / task.reopenSubtask),
//     disabled while a turn is running.
//   - All task mutations dispatch through the operation layer (Phase 3a):
//     rename/done/pin are optimistic overlays on `task:<id>`, create/delete
//     are pending (delete keeps the row visible with a pending affordance).
//   - The sidebar "+" creates a task with NO executor pick.
//   - A selected task (no session) shows the placeholder panel.

import { render, screen, waitFor } from '@testing-library/react';
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
  loadAgents: vi.fn().mockResolvedValue([
    { id: 'codex', name: 'Codex', ready: true, cli: { state: 'ready', path: '/bin/codex', version: '1.0.0', source: 'path' }, proxy: { state: 'ready', path: '/proxy/codex', version: '0.1.0', source: 'github-release' }, officialInstallUrl: 'https://example.invalid' },
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
  const harness = operationHarness();
  render(
    <LocaleProvider locale="en">
      <harness.wrapper>
        <TasksView
          mode="tasks"
          onSetMode={vi.fn()}
          onOpenSearch={vi.fn()}
          tasks={[]}
          sessions={[]}
          workspaces={[workspace('ws-1')]}
          activeTaskId={null}
          activeSubtaskId={null}
          subtaskMain={null}
          onSelectTask={onSelectTask}
          onSelectSubtask={onSelectSubtask}
          onWorkspaceCreated={vi.fn()}
          {...props}
        />
      </harness.wrapper>
    </LocaleProvider>,
  );
  return { onSelectTask, onSelectSubtask, opSent: harness.sent };
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
  it('has no pin item — task pin was removed (2026-08-03)', async () => {
    renderTasks({ tasks: [task()] });
    await userEvent.click(screen.getByTestId('task-menu-task-1'));
    expect(screen.queryByRole('menuitem', { name: 'Pin to top' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Rename' })).toBeInTheDocument();
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
    const { onSelectSubtask } = renderTasks({ tasks: [task()], activeTaskId: 'task-1' });
    await userEvent.click(screen.getByTestId('task-new-session-task-1'));
    // Task context is shown read-only.
    expect(screen.getByTestId('ns-task-name')).toHaveTextContent('My task');
    vi.mocked(createSubtask).mockResolvedValue(subtask({ id: 'sub-new' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Create session' }));
    await waitFor(() => {
      expect(createSubtask).toHaveBeenCalledWith('task-1', {
        workspace_id: 'ws-1',
        executor: 'codex',
      });
    });
    await waitFor(() => {
      expect(onSelectSubtask).toHaveBeenCalledWith('task-1', 'sub-new');
    });
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
            onOpenSearch={vi.fn()}
            tasks={[task()]}
            sessions={[subtask()]}
            workspaces={[workspace('ws-1')]}
            activeTaskId={null}
            activeSubtaskId={null}
            subtaskMain={null}
            onSelectTask={vi.fn()}
            onSelectSubtask={vi.fn()}
            onWorkspaceCreated={vi.fn()}
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
            onOpenSearch={vi.fn()}
            tasks={[task()]}
            sessions={[subtask({ completed_at: '2026-08-01T04:00:00Z' })]}
            workspaces={[workspace('ws-1')]}
            activeTaskId={null}
            activeSubtaskId={null}
            subtaskMain={null}
            onSelectTask={vi.fn()}
            onSelectSubtask={vi.fn()}
            onWorkspaceCreated={vi.fn()}
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
            onOpenSearch={vi.fn()}
            tasks={[task()]}
            sessions={[]}
            workspaces={[workspace('ws-1')]}
            activeTaskId="task-1"
            activeSubtaskId={null}
            subtaskMain={null}
            onSelectTask={vi.fn()}
            onSelectSubtask={vi.fn()}
            onWorkspaceCreated={vi.fn()}
          />
        </harness.wrapper>
      </LocaleProvider>,
    );
    expect(container.querySelector('.tasks-detail-task-name')).toHaveTextContent('My task');
    expect(screen.getByText(/Pick a session from the list/)).toBeInTheDocument();
  });
});
