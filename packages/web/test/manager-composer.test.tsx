// The per-Task Manager is a `type='manager'` Session variant, so its chat
// composer reuses the SAME shared <Composer> a normal session uses — now in the
// FULL variant (decision 2026-06-29): the Manager is a first-class session, so
// model / approval-mode / effort / slash / attachments / queue are all exposed
// and wired (via `managerHandlers`) to the manager session id. These tests pin:
//   1. Parity: the main Manager composer renders the shared `.composer-wrap >
//      .composer` chrome AND the full controls (model picker + PLAN/ASK/AUTO).
//   2. Stop: while the Manager turn is running the Send button becomes Stop and
//      clicking it triggers `onManagerStop` (→ `session:stop`).
//   3. Draft: unsent text is persisted (and restored) under the manager
//      session id via the shared Composer's localStorage draft mechanism.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Session, Task, Workspace } from '@gian/shared';
import { TasksView, type ManagerSubtaskCard, type ManagerComposerHandlers } from '../src/views/TasksView.js';
import { Transcript } from '../src/transcript/Transcript.js';
import type { TranscriptItem } from '../src/types.js';
import { LocaleProvider } from '../src/i18n/index.js';

// Composer statically imports these; the model-fetch / slash effects fire on
// mount, so they must resolve.
vi.mock('../src/api.js', () => ({
  loadProxyModels: vi.fn().mockResolvedValue([]),
  loadSlashCommands: vi.fn().mockResolvedValue([]),
}));

function mockHandlers(): ManagerComposerHandlers {
  return {
    onSetModel: vi.fn(), onSetMode: vi.fn(), onSetEffort: vi.fn(), onSetServiceTier: vi.fn(), onSendSkill: vi.fn(),
    onQueueAdd: vi.fn(), onQueueRemove: vi.fn(), onQueueReorder: vi.fn(), onQueueClear: vi.fn(),
    onQueueSendNow: vi.fn(), onApprove: vi.fn(),
  };
}

const TASK: Task = {
  id: 'task-1',
  name: 'Build the thing',
  description: null,
  status: 'open',
  created_at: '2026-06-29T00:00:00.000Z',
  updated_at: '2026-06-29T00:00:00.000Z',
};

const WORKSPACE: Workspace = {
  id: 'ws-1',
  name: 'Gian-Dev',
  path: '/Users/x/Coding/Gian-Dev',
  sort_order: 0,
  hidden: 0,
  created_at: '2026-06-29T00:00:00.000Z',
  updated_at: '2026-06-29T00:00:00.000Z',
};

function managerSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'mgr-1',
    name: 'Manager',
    type: 'manager',
    task_id: 'task-1',
    workspace_id: 'ws-1',
    executor: 'codex',
    model: 'gpt-5.5',
    approval_mode: 'ask',
    thinking_effort: 'xhigh',
    active_channel: 'web',
    status: 'done',
    archived: 0,
    unread: 0,
    worktree_path: null,
    branch: null,
    base_branch: null,
    worktree_outcome: null,
    native_session_id: null,
    summary: null,
    completed_at: null,
    created_at: '2026-06-29T00:00:00.000Z',
    updated_at: '2026-06-29T00:00:00.000Z',
    ...overrides,
  };
}

function renderTasks(opts: {
  session: Session | null;
  pending?: boolean;
  onManagerStop?: () => void;
  cards?: ManagerSubtaskCard[];
  sessions?: Session[];
  wsSend?: ReturnType<typeof vi.fn>;
} = { session: managerSession() }) {
  const onManagerStop = opts.onManagerStop ?? vi.fn();
  const wsSend = opts.wsSend ?? vi.fn();
  const sessions = opts.sessions ?? (opts.session ? [opts.session] : []);
  render(
    <LocaleProvider locale="en">
      <TasksView
        tasks={[TASK]}
        sessions={sessions}
        workspaces={[WORKSPACE]}
        ws={{ send: wsSend } as never}
        defaultTaskExecutor="claude"
        activeTaskId="task-1"
        activeSubtaskId={null}
        managerSession={opts.session}
        managerItems={[]}
        managerPending={opts.pending ?? false}
        managerCards={opts.cards ?? []}
        managerHandlers={opts.session ? mockHandlers() : null}
        managerQueue={[]}
        showManagerRaw={false}
        onToggleManagerRaw={vi.fn()}
        subtaskMain={null}
        onSelectTask={vi.fn()}
        onSelectSubtask={vi.fn()}
        onOpenSubtaskSession={vi.fn()}
        onManagerMount={vi.fn()}
        onManagerSend={vi.fn()}
        onManagerStop={onManagerStop}
        onCreateSubtask={vi.fn()}
      />
    </LocaleProvider>,
  );
  return { onManagerStop, wsSend };
}

describe('Manager composer reuses the shared session composer', () => {
  beforeEach(() => { localStorage.clear(); });

  it('renders the FULL shared composer — model picker + approval-mode + Send', () => {
    renderTasks();

    // Shared composer structure (same `.composer-wrap > .composer` a session uses).
    expect(document.querySelector('.composer-wrap')).not.toBeNull();
    expect(document.querySelector('.composer')).not.toBeNull();
    // The old hand-written specialization is gone.
    expect(document.querySelector('.tasks-manager-composer')).toBeNull();

    // Full variant: the Manager is a first-class session, so it exposes the
    // model picker and an approval control + Send — same as a normal session.
    // The approval control differs by executor: claude keeps the PLAN/ASK/AUTO
    // segmented control (.composer-mode); codex uses the 4-preset up-drop
    // (.cmp-approval-btn). Accept either so the test is executor-agnostic.
    expect(document.querySelector('.cmp-model-wrap')).not.toBeNull(); // model picker
    expect(document.querySelector('.composer-mode, .cmp-approval-btn')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy();
  });

  it('shows Stop (not Send) while the Manager turn is running and triggers onManagerStop on click', async () => {
    const user = userEvent.setup();
    const { onManagerStop } = renderTasks({
      session: managerSession({ status: 'running' }),
      pending: true,
    });

    // Send is replaced by Stop while a turn is in flight.
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    const stop = screen.getByRole('button', { name: 'Stop' });
    await user.click(stop);
    expect(onManagerStop).toHaveBeenCalledTimes(1);
  });

  it('persists the unsent draft under the manager session id', async () => {
    const user = userEvent.setup();
    renderTasks({ session: managerSession({ id: 'mgr-42' }) });

    const ta = screen.getByPlaceholderText('Ask the Manager…');
    await user.type(ta, 'draft for the manager');

    expect(localStorage.getItem('gian.composer.draft.v1.mgr-42')).toBe('draft for the manager');
  });

  it('restores a saved draft for that manager session on mount', () => {
    localStorage.setItem('gian.composer.draft.v1.mgr-7', 'remembered text');
    renderTasks({ session: managerSession({ id: 'mgr-7' }) });

    const ta = screen.getByPlaceholderText('Ask the Manager…') as HTMLTextAreaElement;
    expect(ta.value).toBe('remembered text');
  });

  it('shows a disabled placeholder composer until the manager session is ensured', () => {
    renderTasks({ session: null });

    // The shared composer chrome is still present (no reflow), but inert.
    expect(document.querySelector('.composer')).not.toBeNull();
    const ta = screen.getByPlaceholderText('Ask the Manager…') as HTMLTextAreaElement;
    expect(ta.disabled).toBe(true);
  });
});

describe('Task executor picker', () => {
  beforeEach(() => { localStorage.clear(); });

  it('closes after selecting Kimi and creates the Task with executor=kimi', async () => {
    const user = userEvent.setup();
    const wsSend = vi.fn();
    renderTasks({ session: managerSession(), wsSend });

    const newButton = screen.getByRole('button', { name: 'New' });
    await user.hover(newButton);
    expect(newButton).toHaveAttribute('aria-expanded', 'true');

    await user.click(screen.getByRole('menuitem', { name: 'Kimi Code' }));
    expect(newButton).toHaveAttribute('aria-expanded', 'false');
    expect(document.querySelector('.sb-newtask.open')).toBeNull();

    await user.type(screen.getByRole('textbox', { name: 'Task name' }), 'Kimi task');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(wsSend).toHaveBeenCalledWith({
      type: 'task:create',
      name: 'Kimi task',
      executor: 'kimi',
    });
  });
});

describe('Manager status on the Manager child row (row-end StatusIcon)', () => {
  beforeEach(() => { localStorage.clear(); });

  it('shows the running spinner on the Manager row when the Manager is running', () => {
    // The Manager child row's row-end glyph IS the Manager-as-session
    // StatusIcon (moved off the retired parent task row, 2026-07-31).
    renderTasks({ session: managerSession({ status: 'running' }), pending: true });
    const managerRow = document.querySelector('.manager-row');
    expect(managerRow).not.toBeNull();
    expect(managerRow!.querySelector('.ri-status.running')).not.toBeNull();
  });

  it('shows no running spinner on the Manager row when the Manager is idle', () => {
    renderTasks({ session: managerSession({ status: 'done' }) });
    expect(document.querySelector('.manager-row .ri-status.running')).toBeNull();
  });

  it('shows a running pill in the Manager panel head when running', () => {
    renderTasks({ session: managerSession({ status: 'running' }), pending: true });
    expect(document.querySelector('.main-head .manager-status.running')).not.toBeNull();
  });
});

describe('Inline manual subtask-created cards', () => {
  beforeEach(() => { localStorage.clear(); });

  const createdCard: ManagerSubtaskCard = {
    id: 'sub-1', status: 'created', name: 'Wire the thing',
    workspaceLabel: 'Gian-Dev', executor: 'codex', prompt: 'do the wiring', ts: 1000, acked: false,
  };

  it('renders a static "created" card inline in the conversation', () => {
    renderTasks({ session: managerSession(), cards: [createdCard] });
    const card = document.querySelector('.manager-subtask-card.created');
    expect(card).not.toBeNull();
    expect(card!.textContent).toContain('Subtask created');
    expect(card!.textContent).toContain('Wire the thing');
    // Non-interactive: it's a plain div, no buttons/inputs.
    expect(card!.querySelector('button')).toBeNull();
    expect(card!.querySelector('input')).toBeNull();
  });
});

describe('Transcript card timeline interleave (Codex review #3)', () => {
  it('places an extra between the items whose timestamps bracket its afterTs', () => {
    const items: TranscriptItem[] = [
      { kind: 'user', id: 'u1', text: 'FIRST_MSG', exec: 'codex', ts: 100, turn: 0 } as TranscriptItem,
      { kind: 'user', id: 'u2', text: 'SECOND_MSG', exec: 'codex', ts: 300, turn: 1 } as TranscriptItem,
    ];
    render(
      <LocaleProvider locale="en">
        <Transcript
          items={items}
          pending={false}
          onApprove={() => {}}
          extras={[{ id: 'c1', afterTs: 200, node: <div>CARD_NODE</div> }]}
        />
      </LocaleProvider>,
    );
    const text = document.querySelector('.transcript')!.textContent ?? '';
    // Order: FIRST (ts100) → CARD (afterTs200) → SECOND (ts300).
    expect(text.indexOf('FIRST_MSG')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('FIRST_MSG')).toBeLessThan(text.indexOf('CARD_NODE'));
    expect(text.indexOf('CARD_NODE')).toBeLessThan(text.indexOf('SECOND_MSG'));
  });

  it('places an extra after all items when its afterTs is the latest', () => {
    const items: TranscriptItem[] = [
      { kind: 'user', id: 'u1', text: 'ONLY_MSG', exec: 'codex', ts: 100, turn: 0 } as TranscriptItem,
    ];
    render(
      <LocaleProvider locale="en">
        <Transcript
          items={items}
          pending={false}
          onApprove={() => {}}
          extras={[{ id: 'c1', afterTs: 999, node: <div>TAIL_CARD</div> }]}
        />
      </LocaleProvider>,
    );
    const text = document.querySelector('.transcript')!.textContent ?? '';
    expect(text.indexOf('ONLY_MSG')).toBeLessThan(text.indexOf('TAIL_CARD'));
  });
});
