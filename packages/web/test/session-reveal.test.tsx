/**
 * Explicit-navigation session reveal (issue #3): a search/Inbox/notification
 * selection opens the conversation in the main pane; the rail that lists the
 * session must expand the owning section/group, raise show-more caps, and
 * scroll the row into the rail's own scroll container. Only an explicit
 * navigation posts the intent — WS refreshes never do. A pending intent
 * carries its nonce: a superseded or retired intent never scrolls back.
 */
import { act, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { Session, Task, Workspace } from '@gian/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '../src/i18n/index.js';
import { SessionsSidebar } from '../src/components/SessionsSidebar.js';
import { TasksSidebar } from '../src/views/TasksView.js';
import {
  __resetSessionRevealForTest,
  peekSessionReveal,
  requestSessionReveal,
  retireSessionReveal,
} from '../src/presentation/session-reveal.js';
import { __resetScheduleBadgeForTest } from '../src/controllers/use-schedules.js';
import { __resetRemoteEnvironmentsForTest } from '../src/controllers/use-remote-environments.js';
import { createOperationStore } from '../src/operations/store.js';
import type { OperationDispatcher } from '../src/operations/dispatcher.js';
import {
  OperationDispatcherProvider,
  OperationStoreProvider,
} from '../src/operations/use-operations.js';
import { mockFetch } from './setup.js';

const COLLAPSE_KEYS = [
  'gian.sidebar.collapsed.workspace',
  'gian.sidebar.sections.collapsed',
  'gian.tasks.sections.collapsed',
  'gian.tasks.collapsed',
  'gian.tasks.completed-hidden',
];

function session(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    name: `Session ${id}`,
    type: 'subtask',
    task_id: null,
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
    created_at: '2026-08-04T00:00:00.000Z',
    updated_at: '2026-08-04T00:00:00.000Z',
    ...overrides,
  } as Session;
}

function workspace(id: string, overrides: Partial<Workspace> = {}): Workspace {
  return {
    id,
    name: `Repo ${id}`,
    path: `/tmp/${id}`,
    sort_order: 0,
    hidden: 0,
    pinned: 0,
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    name: `Task ${id}`,
    description: null,
    status: 'open',
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    pinned_at: null,
    sort_order: null,
    ...overrides,
  };
}

/** The rail sort puts the most recently updated first: row[N-1] is the LAST
 *  row of its group (beyond the 5-row show-more cap). */
function groupRows(prefix: string, count: number, overrides: Partial<Session> = {}): Session[] {
  return Array.from({ length: count }, (_, index) => session(`${prefix}-${index + 1}`, {
    updated_at: `2026-08-0${count - index}T00:00:00.000Z`,
    ...overrides,
  }));
}

function domRect(top: number, bottom: number): DOMRect {
  return {
    top, bottom, left: 0, right: 0, width: 0, height: bottom - top, x: 0, y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

let geometrySpy: { mockRestore: () => void } | null = null;

/** The rail's scroll container is 100px tall (viewport rows 0..100); each
 *  named row sits at its stubbed offset, including rows that render only
 *  after a cap raise. */
function stubGeometry(rows: Record<string, { top: number; bottom: number }>) {
  geometrySpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: HTMLElement) {
      const testid = this.getAttribute('data-testid');
      if (testid && rows[testid]) return domRect(rows[testid].top, rows[testid].bottom);
      if (this.classList.contains('sb-scroll')) return domRect(0, 100);
      return domRect(0, 0);
    },
  );
}

function captureScrollTop(container: HTMLElement): () => number {
  let value = 0;
  Object.defineProperty(container, 'scrollTop', {
    configurable: true,
    get: () => value,
    set: (next: number) => { value = next; },
  });
  return () => value;
}

function scrollContainer(): HTMLElement {
  const element = document.querySelector('.sb-scroll');
  if (!(element instanceof HTMLElement)) throw new Error('rail scroll container not rendered');
  return element;
}

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <LocaleProvider locale="en">
      <OperationStoreProvider store={createOperationStore()}>
        <OperationDispatcherProvider dispatcher={{ dispatch: vi.fn() } as unknown as OperationDispatcher}>
          {children}
        </OperationDispatcherProvider>
      </OperationStoreProvider>
    </LocaleProvider>
  );
}

function renderReposRail(sessions: Session[], workspaces: Workspace[] = [workspace('ws-1')]) {
  return render(
    <Wrapper>
      <SessionsSidebar
        mode="sessions"
        onSetMode={() => {}}
        listMode="sessions"
        onSetListMode={() => {}}
        workspaces={workspaces}
        sessions={sessions}
        activeSessionId={null}
        onNewWorkspace={() => {}}
        onEditWorkspace={() => {}}
        onNewForWorkspace={() => {}}
        onPinSession={() => {}}
        onArchiveSession={() => {}}
        onSelect={() => {}}
      />
    </Wrapper>,
  );
}

function renderTasksRail(sessions: Session[], tasks: Task[]) {
  return render(
    <Wrapper>
      <TasksSidebar
        mode="tasks"
        onSetMode={() => {}}
        listMode="tasks"
        onSetListMode={() => {}}
        tasks={tasks}
        sessions={sessions}
        workspaces={[]}
        activeSubtaskId={null}
        activeSessionId={null}
        onSelectSubtask={() => {}}
        onSelectSession={() => {}}
        onPinSession={() => {}}
        onArchiveSession={() => {}}
        onNewSession={() => {}}
      />
    </Wrapper>,
  );
}

beforeEach(() => {
  for (const key of COLLAPSE_KEYS) localStorage.removeItem(key);
  __resetSessionRevealForTest();
  __resetScheduleBadgeForTest();
  __resetRemoteEnvironmentsForTest();
  mockFetch(async input => {
    const url = String(input);
    if (url.startsWith('/api/schedules')) {
      return new Response(JSON.stringify({ schedules: [], next_cursor: null }), { status: 200 });
    }
    if (url.startsWith('/api/remote/environments')) {
      return new Response(JSON.stringify({ environments: [] }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
});

afterEach(() => {
  geometrySpy?.mockRestore();
  geometrySpy = null;
  __resetSessionRevealForTest();
});

describe('Repos rail reveal', () => {
  it('expands a collapsed workspace group and reveals the row', async () => {
    localStorage.setItem('gian.sidebar.collapsed.workspace', JSON.stringify(['ws-1']));
    const rows = groupRows('s', 3);
    renderReposRail(rows);
    expect(document.querySelector('[data-testid="session-row-s-2"]')).toBeNull();

    act(() => {
      requestSessionReveal({ sessionId: 's-2', surface: 'sessions', taskId: null });
    });

    expect(document.querySelector('[data-testid="session-row-s-2"]')).not.toBeNull();
    expect(peekSessionReveal()).toBeNull();
  });

  it('raises the show-more cap of an already-expanded group and scrolls the row into view', () => {
    // The exact previously-broken path: the group is expanded, the target sits
    // beyond the 5-row cap, the cap raise happens in the CHILD's effect and
    // the parent's scroll pass must re-run on the row-ready signal.
    const rows = groupRows('s', 8);
    stubGeometry({ 'session-row-s-8': { top: 500, bottom: 530 } });
    renderReposRail(rows);
    expect(document.querySelector('[data-testid="session-row-s-8"]')).toBeNull();
    const scrollTop = captureScrollTop(scrollContainer());

    act(() => {
      requestSessionReveal({ sessionId: 's-8', surface: 'sessions', taskId: null });
    });

    expect(document.querySelector('[data-testid="session-row-s-8"]')).not.toBeNull();
    // Row bottom 530 vs container bottom 100: scroll down by 430 + 8 margin.
    expect(scrollTop()).toBe(438);
    expect(peekSessionReveal()).toBeNull();
  });

  it('does not scroll when the target row is already visible', () => {
    const rows = groupRows('s', 3);
    stubGeometry({ 'session-row-s-2': { top: 20, bottom: 50 } });
    renderReposRail(rows);
    const scrollTop = captureScrollTop(scrollContainer());

    act(() => {
      requestSessionReveal({ sessionId: 's-2', surface: 'sessions', taskId: null });
    });

    expect(scrollTop()).toBe(0);
    expect(peekSessionReveal()).toBeNull();
  });

  it('a WS refresh without an intent never expands or scrolls', () => {
    localStorage.setItem('gian.sidebar.collapsed.workspace', JSON.stringify(['ws-1']));
    const rows = groupRows('s', 3);
    const view = renderReposRail(rows);
    view.rerender(
      <Wrapper>
        <SessionsSidebar
          mode="sessions"
          onSetMode={() => {}}
          listMode="sessions"
          onSetListMode={() => {}}
          workspaces={[workspace('ws-1')]}
          sessions={[...rows]}
          activeSessionId="s-1"
          onNewWorkspace={() => {}}
          onEditWorkspace={() => {}}
          onNewForWorkspace={() => {}}
          onPinSession={() => {}}
          onArchiveSession={() => {}}
          onSelect={() => {}}
        />
      </Wrapper>,
    );
    expect(document.querySelector('[data-testid="session-row-s-2"]')).toBeNull();
  });

  it('a superseded intent never scrolls back to the older target', () => {
    // A targets a session whose row is not loaded yet; B lands before A's
    // data arrives. Only B may reveal — when A's session later appears, the
    // rail must not move.
    const rows = [
      ...groupRows('s', 3),
      ...groupRows('late', 1, { workspace_id: 'ws-2' }),
    ];
    localStorage.setItem('gian.sidebar.collapsed.workspace', JSON.stringify(['ws-2']));
    const view = renderReposRail(
      rows.filter(row => row.id !== 'late-1'),
      [workspace('ws-1'), workspace('ws-2')],
    );
    act(() => {
      requestSessionReveal({ sessionId: 'late-1', surface: 'sessions', taskId: null });
    });
    act(() => {
      requestSessionReveal({ sessionId: 's-1', surface: 'sessions', taskId: null });
    });
    expect(peekSessionReveal()).toBeNull(); // B consumed

    view.rerender(
      <Wrapper>
        <SessionsSidebar
          mode="sessions"
          onSetMode={() => {}}
          listMode="sessions"
          onSetListMode={() => {}}
          workspaces={[workspace('ws-1'), workspace('ws-2')]}
          sessions={rows}
          activeSessionId="s-1"
          onNewWorkspace={() => {}}
          onEditWorkspace={() => {}}
          onNewForWorkspace={() => {}}
          onPinSession={() => {}}
          onArchiveSession={() => {}}
          onSelect={() => {}}
        />
      </Wrapper>,
    );
    // A's intent is gone: its collapsed group stays collapsed.
    expect(document.querySelector('[data-testid="session-row-late-1"]')).toBeNull();
  });

  it('a retired intent (navigation moved on) never reveals later arrivals', () => {
    const rows = groupRows('s', 3);
    localStorage.setItem('gian.sidebar.collapsed.workspace', JSON.stringify(['ws-1']));
    const view = renderReposRail(rows.filter(row => row.id !== 's-2'));
    act(() => {
      requestSessionReveal({ sessionId: 's-2', surface: 'sessions', taskId: null });
    });
    act(() => {
      retireSessionReveal();
    });
    view.rerender(
      <Wrapper>
        <SessionsSidebar
          mode="sessions"
          onSetMode={() => {}}
          listMode="sessions"
          onSetListMode={() => {}}
          workspaces={[workspace('ws-1')]}
          sessions={rows}
          activeSessionId={null}
          onNewWorkspace={() => {}}
          onEditWorkspace={() => {}}
          onNewForWorkspace={() => {}}
          onPinSession={() => {}}
          onArchiveSession={() => {}}
          onSelect={() => {}}
        />
      </Wrapper>,
    );
    expect(document.querySelector('[data-testid="session-row-s-2"]')).toBeNull();
    expect(peekSessionReveal()).toBeNull();
  });

  it('an archived read-only target drops the intent — it has no rail row', () => {
    const rows = [session('arch-1', { archived: 1 })];
    renderReposRail(rows);
    act(() => {
      requestSessionReveal({ sessionId: 'arch-1', surface: 'sessions', taskId: null });
    });
    expect(peekSessionReveal()).toBeNull();
    expect(document.querySelector('[data-testid="session-row-arch-1"]')).toBeNull();
  });
});

describe('Tasks rail reveal', () => {
  it('expands the doing section and the owning task group, then reveals the subtask', () => {
    localStorage.setItem('gian.tasks.sections.collapsed', JSON.stringify(['doing']));
    localStorage.setItem('gian.tasks.collapsed', JSON.stringify(['task-1']));
    const rows = [session('sub-1', { task_id: 'task-1', workspace_id: null })];
    renderTasksRail(rows, [task('task-1')]);
    expect(document.querySelector('[data-testid="session-row-sub-1"]')).toBeNull();

    act(() => {
      requestSessionReveal({ sessionId: 'sub-1', surface: 'tasks', taskId: 'task-1' });
    });

    expect(document.querySelector('[data-testid="session-row-sub-1"]')).not.toBeNull();
    expect(peekSessionReveal()).toBeNull();
  });

  it('raises the completed show-more cap of an already-expanded group and scrolls', () => {
    // Same child-effect gap as the Repos cap case, on the completed tail.
    const open = [session('sub-open', { task_id: 'task-1', workspace_id: null })];
    const completed = Array.from({ length: 7 }, (_, index) => session(`sub-c${index + 1}`, {
      task_id: 'task-1',
      workspace_id: null,
      completed_at: '2026-08-10T00:00:00.000Z',
      created_at: `2026-08-0${index + 1}T00:00:00.000Z`,
    }));
    stubGeometry({ 'session-row-sub-c7': { top: 500, bottom: 530 } });
    renderTasksRail([...open, ...completed], [task('task-1')]);
    expect(document.querySelector('[data-testid="session-row-sub-c7"]')).toBeNull();
    const scrollTop = captureScrollTop(scrollContainer());

    act(() => {
      requestSessionReveal({ sessionId: 'sub-c7', surface: 'tasks', taskId: 'task-1' });
    });

    expect(document.querySelector('[data-testid="session-row-sub-c7"]')).not.toBeNull();
    expect(scrollTop()).toBe(438);
    expect(peekSessionReveal()).toBeNull();
  });

  it('unhides a completed target when the task hides completed sessions', () => {
    localStorage.setItem('gian.tasks.completed-hidden', JSON.stringify(['task-1']));
    const rows = [session('sub-done', {
      task_id: 'task-1',
      workspace_id: null,
      completed_at: '2026-08-10T00:00:00.000Z',
    })];
    renderTasksRail(rows, [task('task-1')]);
    expect(document.querySelector('[data-testid="session-row-sub-done"]')).toBeNull();

    act(() => {
      requestSessionReveal({ sessionId: 'sub-done', surface: 'tasks', taskId: 'task-1' });
    });

    expect(document.querySelector('[data-testid="session-row-sub-done"]')).not.toBeNull();
    expect(peekSessionReveal()).toBeNull();
  });

  it('a standalone session expands the unassigned section', () => {
    localStorage.setItem('gian.tasks.sections.collapsed', JSON.stringify(['unassigned']));
    const rows = [session('free-1', { task_id: null, workspace_id: null })];
    renderTasksRail(rows, []);
    expect(document.querySelector('[data-testid="session-row-free-1"]')).toBeNull();

    act(() => {
      requestSessionReveal({ sessionId: 'free-1', surface: 'tasks', taskId: null });
    });

    expect(document.querySelector('[data-testid="session-row-free-1"]')).not.toBeNull();
    expect(peekSessionReveal()).toBeNull();
  });

  it('a subtask of a done task drops the intent — done tasks render no rows', () => {
    const rows = [session('sub-1', { task_id: 'task-1', workspace_id: null })];
    renderTasksRail(rows, [task('task-1', { status: 'done' })]);
    act(() => {
      requestSessionReveal({ sessionId: 'sub-1', surface: 'tasks', taskId: 'task-1' });
    });
    expect(peekSessionReveal()).toBeNull();
    expect(document.querySelector('[data-testid="session-row-sub-1"]')).toBeNull();
  });
});
