import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  Approval,
  GianScreenshotCapture,
  InboxItemPublic,
  Schedule,
  ScheduleRun,
  Session,
  Task,
  Workspace,
} from '@gian/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkingTree } from '../src/api.js';
import { App } from '../src/App.js';
import { clearComposerCapabilityCaches } from '../src/components/composer/capabilities.js';
import { __resetInboxForTests } from '../src/controllers/inbox.js';
import { __resetPendingApprovals } from '../src/controllers/pending-approvals.js';
import type { GianDesktopNavigationTarget, GianScreenshotApi } from '../src/desktop-bridge.js';
import { __resetFeedback } from '../src/feedback.js';
import { makeInboxItem } from './inbox-fixtures.js';
import {
  FORK_NAVIGATION_STORAGE_KEY,
  reloadNavigationIntentClock,
  rememberForkNavigation,
  resetNavigationIntentSequence,
} from '../src/presentation/fork-navigation.js';
import { sessionContractFixture, stateSyncFixture } from './fixtures/ws-contract.js';
import { makeRun, makeSchedule } from './schedule-fixtures.js';
import { getMockWebSockets, mockFetch, resetMockWebSockets } from './setup.js';

const workspace: Workspace = {
  id: 'workspace-nav',
  name: 'Navigation workspace',
  path: '/tmp/navigation-workspace',
  sort_order: 0,
  hidden: 0,
  pinned: 0,
  created_at: '2026-08-08T00:00:00.000Z',
  updated_at: '2026-08-08T00:00:00.000Z',
};

const claudeMd = { exists: false, lines: 0, mtime: null };

const navigationTree: WorkingTree = {
  id: 'ws:workspace-nav',
  kind: 'workspace',
  label: 'gian-dev-release-0-6-7',
  path: workspace.path,
  branch: 'main',
  workspace_id: workspace.id,
  workspace_name: workspace.name,
  session_id: null,
  session_name: null,
};

const navigationRepo = {
  git: {
    isRepo: true,
    remote: null,
    defaultBranch: 'main',
    currentBranch: 'main',
    lastCommit: null,
    modifiedCount: 0,
    pendingOp: null,
  },
  claudeMd,
};

const navigationBranches = [{
  name: 'main',
  upstream: null,
  ahead: 0,
  behind: 0,
  gone: false,
  lastCommit: null,
  worktreePath: workspace.path,
  isWorktreeBranch: false,
  session: null,
}];

const navigationTrees = [{
  id: 'main',
  kind: 'main' as const,
  label: 'gian-dev-release-0-6-7',
  path: workspace.path,
  branch: 'main',
  isDirty: false,
  modifiedCount: 0,
  claudeMd,
}];

function worktreeSearchPage() {
  return {
    results: [{
      id: 'wt-nav',
      kind: 'worktree',
      title: 'gian-dev-release-0-6-7',
      ranges: [],
      target: {
        type: 'worktree',
        working_tree_id: 'ws:workspace-nav',
        workspace_id: workspace.id,
        session_id: null,
        archived: false,
      },
      updated_at: '2026-08-08T00:00:00.000Z',
      archived: false,
    }],
    next_cursor: null,
    coverage: { state: 'ready', complete: true, indexed: 1, pending: 0 },
  };
}

const task: Task = {
  id: 'task-1',
  name: 'Ship',
  description: null,
  status: 'open',
  created_at: '2026-08-08T00:00:00.000Z',
  updated_at: '2026-08-08T00:00:00.000Z',
  pinned_at: null,
};

const world: {
  sessions: Session[];
  /** Active list returned by GET /api/sessions when it should differ from the snapshot. */
  activeOverride: Session[] | null;
  archived: Session[];
  tasks: Task[];
  failActive: boolean;
  failArchived: boolean;
  schedules: Schedule[];
  schedule: Schedule;
  runs: ScheduleRun[];
  workingTrees: WorkingTree[];
  serveGit: boolean;
  sideChatCatalog: boolean;
} = {
  sessions: [],
  activeOverride: null,
  archived: [],
  tasks: [],
  failActive: false,
  failArchived: false,
  schedules: [],
  schedule: makeSchedule(),
  runs: [],
  workingTrees: [],
  serveGit: false,
  sideChatCatalog: false,
};

const requests: Array<{ method: string; url: string }> = [];
/** Canonical Inbox rows for the boot router: list, detail and read/unread all
 *  serve the SAME row per id so a mark-read can never morph the item's
 *  kind/target/display. Populated by deliverInboxSync, reset per case. */
const inboxRows = new Map<string, InboxItemPublic>();
const eventsHold: { current: Promise<void> } = { current: Promise.resolve() };
let releaseEvents = (): void => {};
const gitHold: { current: Promise<void> } = { current: Promise.resolve() };
let releaseGit = (): void => {};

function holdGitLoads(): void {
  gitHold.current = new Promise(resolve => {
    releaseGit = () => {
      releaseGit = () => {};
      resolve();
    };
  });
}

function releaseGitLoads(): void {
  releaseGit();
  gitHold.current = Promise.resolve();
}
const activeHold: { current: Promise<void> } = { current: Promise.resolve() };
let releaseActive = (): void => {};
let activeListResponses = 0;

function holdActiveLoads(): void {
  activeHold.current = new Promise(resolve => {
    releaseActive = () => {
      releaseActive = () => {};
      resolve();
    };
  });
}

function releaseActiveLoads(): void {
  releaseActive();
  activeHold.current = Promise.resolve();
}
const screenshotListeners = new Set<(capture: GianScreenshotCapture) => void>();

function session(overrides: Partial<Session>): Session {
  return sessionContractFixture({ workspace_id: workspace.id, ...overrides });
}

function target(sessionId: string, turn = 1): GianDesktopNavigationTarget {
  return { type: 'session', sessionId, turn, kind: 'turn-completed' };
}

function sameTarget(left: GianDesktopNavigationTarget, right: GianDesktopNavigationTarget): boolean {
  if (left.type !== 'session' || right.type !== 'session') return false;
  return left.sessionId === right.sessionId && left.turn === right.turn && left.kind === right.kind;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function installNavigation(initial: GianDesktopNavigationTarget | null) {
  let pending = initial;
  const listeners = new Set<(next: GianDesktopNavigationTarget) => void>();
  const acks: GianDesktopNavigationTarget[] = [];
  let readyCalls = 0;
  return {
    acks,
    get readyCalls() { return readyCalls; },
    api: {
      ready: async () => {
        readyCalls += 1;
        return pending;
      },
      acknowledge: async (next: GianDesktopNavigationTarget) => {
        if (!pending || !sameTarget(pending, next)) return false;
        acks.push(next);
        pending = null;
        return true;
      },
      onTarget: (listener: (next: GianDesktopNavigationTarget) => void) => {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
    },
    push(next: GianDesktopNavigationTarget) {
      pending = next;
      for (const listener of [...listeners]) listener(next);
    },
  };
}

const screenshotApi: GianScreenshotApi = {
  setTarget: async () => true,
  start: async () => ({ ok: true }),
  getState: async () => ({ shortcut: '', shortcutRegistered: false, capturing: false }),
  getPreferences: async () => ({ hideMainWindowDuringCapture: false }),
  setPreferences: async preferences => preferences,
  onCaptured: listener => {
    screenshotListeners.add(listener);
    return () => { screenshotListeners.delete(listener); };
  },
  onError: () => () => undefined,
};

function emitScreenshot(sessionId: string, label: string): void {
  const capture = {
    id: 'cap-1',
    target: { kind: 'session' as const, sessionId, label },
    filename: 'shot.png',
    mime: 'image/png' as const,
    bytes: new Uint8Array([1, 2, 3]),
  };
  for (const listener of screenshotListeners) listener(capture);
}

function attr(name: string): string | null {
  return screen.getByTestId('app-shell').getAttribute(name);
}

function sessionListGets(): number {
  return requests.filter(item => item.method === 'GET' && item.url === '/api/sessions').length;
}

function taskGroup(name: string): HTMLElement {
  const group = screen.getByText(name).closest('.tasks-list-task');
  if (!group) throw new Error(`missing task group ${name}`);
  return group as HTMLElement;
}

function sessionRowInTask(taskName: string, sessionName: string): HTMLElement | null {
  const title = [...taskGroup(taskName).querySelectorAll('.ri-title')]
    .find(node => node.textContent === sessionName);
  return title?.closest('.session-row') as HTMLElement | null ?? null;
}

function emitSync(): void {
  const socket = getMockWebSockets()[0]!;
  const sync = stateSyncFixture();
  sync.config.locale = 'en';
  sync.workspaces = [workspace];
  sync.sessions = world.sessions;
  sync.tasks = world.tasks;
  socket.fakeMessage(sync);
}

function plantStoredFork(sessionId: string, sequence: number | null): void {
  const body: { sessionId: string; runId: string; sequence?: number } = {
    sessionId,
    runId: 'run-fork',
  };
  if (sequence != null) body.sequence = sequence;
  sessionStorage.setItem(FORK_NAVIGATION_STORAGE_KEY, JSON.stringify(body));
  reloadNavigationIntentClock();
}

function rejectLastAssign(): void {
  const socket = getMockWebSockets()[0]!;
  const assign = socket.parsedSent<{ type: string; request_id?: string }>()
    .filter(frame => frame.type === 'session:assign_task')
    .at(-1);
  expect(assign?.request_id).toBeTruthy();
  act(() => {
    socket.fakeMessage({
      type: 'operation:result',
      request_id: assign!.request_id,
      request_type: 'session:assign_task',
      ok: false,
      error: { code: 'SESSION_ASSIGN_TASK_FAILED', message: 'task is no longer open' },
    });
  });
}

async function expectOpenSession(sessionId: string, name: string): Promise<void> {
  await waitFor(() => {
    expect(document.querySelector('.path-seg.session .path-seg-label')?.textContent).toBe(name);
  });
  expect(document.querySelector('.composer-bar')).not.toBeNull();
  await waitFor(() => {
    expect(requests.some(item => item.method === 'GET' && item.url.startsWith(`/api/sessions/${sessionId}/events`))).toBe(true);
    const subscribed = getMockWebSockets()[0]!
      .parsedSent<{ type: string; session_id?: string | null }>()
      .filter(frame => frame.type === 'events:subscribe');
    expect(subscribed.at(-1)?.session_id).toBe(sessionId);
  });
}

async function boot(navigation: ReturnType<typeof installNavigation>): Promise<void> {
  window.gianDesktop = { navigation: navigation.api, screenshot: screenshotApi };
  mockFetch(async (input, init) => {
    const url = requestUrl(input);
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    requests.push({ method, url });
    if (url === '/api/auth/me') return json({ user: 'fixture-user' });
    if (url === '/api/auth/ws-token') return json({ token: 'fixture-token' });
    if (url === '/api/settings') {
      const sync = stateSyncFixture();
      sync.config.locale = 'en';
      return json(sync.config);
    }
    if (url === '/api/agents' || url === '/api/agents?refresh=1') return json({ agents: [] });
    if (url === '/api/apps') return json({ apps: [] });
    if (url === '/api/workspaces') return json([workspace]);
    if (url === '/api/tasks') return json(world.tasks);
    if (url === '/api/working_trees' || url.startsWith('/api/working_trees?')) return json(world.workingTrees);
    if (world.serveGit && url === `/api/workspaces/${workspace.id}/repo-info`) {
      await gitHold.current;
      return json(navigationRepo);
    }
    if (world.serveGit && url === `/api/workspaces/${workspace.id}/branches`) {
      await gitHold.current;
      return json(navigationBranches);
    }
    if (world.serveGit && url === `/api/workspaces/${workspace.id}/trees`) {
      await gitHold.current;
      return json(navigationTrees);
    }
    if (url === '/api/proxy/codex/capabilities') {
      if (!world.sideChatCatalog) return json({ error: 'missing' }, 404);
      return json({ actions: [{ id: 'sidechat.create', supported: true }] });
    }
    if (url === '/api/sessions' && method === 'GET') {
      await activeHold.current;
      activeListResponses += 1;
      if (world.failActive) return json({ error: 'unavailable' }, 500);
      return json(world.activeOverride ?? world.sessions);
    }
    if (url === '/api/sessions?archived=true') {
      if (world.failArchived) return json({ error: 'unavailable' }, 500);
      return json(world.archived);
    }
    const inboxMutation = /^\/api\/inbox\/([^/]+)\/(read|unread)$/.exec(url);
    if (inboxMutation && method === 'POST') {
      const row = inboxRows.get(inboxMutation[1]!);
      const body = init?.body ? JSON.parse(String(init.body)) as { generation?: number } : {};
      if (!row || row.generation !== body.generation) {
        return json({ error: 'stale', message: 'generation moved' }, 409);
      }
      // Canonical read/unread mutate ONLY the read state (+ a revision bump);
      // the row's kind/target/display/actions/generation never move.
      const updated: InboxItemPublic = {
        ...row,
        revision: row.revision + 1,
        unread: inboxMutation[2] === 'unread',
        read_at: inboxMutation[2] === 'read' ? '2026-10-12T06:00:00.000Z' : null,
      };
      inboxRows.set(row.id, updated);
      return json(updated);
    }
    const inboxDetail = /^\/api\/inbox\/([^/]+)$/.exec(url);
    if (inboxDetail && method === 'GET') {
      const row = inboxRows.get(inboxDetail[1]!);
      return row ? json(row) : json({ error: 'not_found' }, 404);
    }
    if (url === '/api/inbox' || url.startsWith('/api/inbox?')) {
      const closedOnly = url.includes('status=closed');
      const rows = [...inboxRows.values()]
        .filter(row => closedOnly ? row.status !== 'pending' : row.status === 'pending');
      return json({ items: rows, next_cursor: null, pending_count: rows.length, inbox_revision: 10 });
    }
    if (url.includes('/events')) {
      await eventsHold.current;
      return json({ events: [], nextCursor: null, hasMore: false });
    }
    if (url.includes('/attachments') && method === 'POST') {
      return json({ path: 'shot.png', name: 'shot.png', size: 3, mime: 'image/png' });
    }
    if (url.startsWith('/api/schedules/sch-1/runs')) return json({ runs: world.runs, next_cursor: null });
    if (url === '/api/schedules/sch-1') return json(world.schedule);
    if (url.startsWith('/api/schedules')) return json({ schedules: world.schedules, next_cursor: null });
    if (url === '/api/proxies') {
      return json({
        proxies: [],
        catalog: { source: { id: null, sequence: null, state: 'empty', error: null }, items: [] },
      });
    }
    if (url.startsWith('/api/search')) {
      const query = new URL(url, 'http://gian.local').searchParams.get('q') ?? '';
      if (query.includes('gian-dev-release-0-6-7')) return json(worktreeSearchPage());
      return json({
        results: [],
        next_cursor: null,
        coverage: { state: 'ready', complete: true, indexed: 0, pending: 0 },
      });
    }
    return json({ error: `Unexpected fixture request: ${method} ${url}` }, 404);
  });
  render(<App />);
  await screen.findByTestId('app-shell');
  await waitFor(() => expect(navigation.readyCalls).toBeGreaterThan(0));
  await act(async () => { await Promise.resolve(); });
}

async function deliverSync(): Promise<void> {
  await waitFor(() => expect(getMockWebSockets().length).toBeGreaterThan(0));
  const socket = getMockWebSockets()[0]!;
  const sync = stateSyncFixture();
  sync.config.locale = 'en';
  sync.workspaces = [workspace];
  sync.sessions = world.sessions;
  sync.tasks = world.tasks;
  act(() => {
    socket.fakeOpen();
    socket.fakeMessage({ type: 'auth_ok', user: 'fixture-user' });
    socket.fakeMessage(sync);
  });
}

describe('P1a session navigation entries', () => {
  beforeEach(() => {
    localStorage.clear();
    requests.length = 0;
    inboxRows.clear();
    world.sessions = [];
    world.activeOverride = null;
    world.archived = [];
    world.tasks = [task];
    world.failActive = false;
    world.failArchived = false;
    activeListResponses = 0;
    activeHold.current = Promise.resolve();
    releaseActive = () => {};
    sessionStorage.clear();
    resetNavigationIntentSequence();
    __resetFeedback();
    world.schedules = [];
    world.schedule = makeSchedule();
    world.runs = [];
    world.workingTrees = [];
    world.serveGit = false;
    world.sideChatCatalog = false;
    releaseGitLoads();
    clearComposerCapabilityCaches();
    screenshotListeners.clear();
    eventsHold.current = Promise.resolve();
    releaseEvents = () => {};
  });

  afterEach(() => {
    releaseActiveLoads();
    releaseEvents();
    releaseGitLoads();
    clearComposerCapabilityCaches();
    sessionStorage.clear();
    __resetFeedback();
    delete window.gianDesktop;
  });

  it('holds a notification that arrives before the session snapshot and opens it once', async () => {
    const bound = session({ id: 'bound', name: 'Bound', type: 'subtask', task_id: 'task-1' });
    world.sessions = [bound];
    const navigation = installNavigation(target('bound', 4));
    await boot(navigation);

    expect(navigation.acks).toHaveLength(0);
    expect(attr('data-mode')).toBe('tasks');
    expect(attr('data-session-id')).toBe('');
    expect(attr('data-subtask-id')).toBe('');

    await deliverSync();

    await waitFor(() => expect(attr('data-session-id')).toBe('bound'));
    expect(attr('data-mode')).toBe('tasks');
    expect(attr('data-task-id')).toBe('task-1');
    expect(attr('data-subtask-id')).toBe('bound');
    expect(navigation.acks).toHaveLength(1);
    expect(navigation.acks[0]).toMatchObject({ type: 'session', sessionId: 'bound', turn: 4 });
  });

  it('lets a newer click replace an older ready target that is still waiting', async () => {
    world.sessions = [
      session({ id: 'alpha', name: 'Alpha' }),
      session({ id: 'bound', name: 'Bound', type: 'subtask', task_id: 'task-1' }),
    ];
    const navigation = installNavigation(target('alpha', 1));
    await boot(navigation);
    navigation.push(target('bound', 2));
    await act(async () => { await Promise.resolve(); });
    expect(navigation.acks).toHaveLength(0);

    await deliverSync();

    await waitFor(() => expect(attr('data-session-id')).toBe('bound'));
    expect(attr('data-mode')).toBe('tasks');
    expect(attr('data-task-id')).toBe('task-1');
    expect(navigation.acks.map(item => item.type === 'session' ? item.sessionId : item.type)).toEqual(['bound']);
  });

  it('keeps the current Tasks page ahead of an older explicit Repos choice', async () => {
    const user = userEvent.setup();
    world.sessions = [session({ id: 'bound', name: 'Bound', type: 'subtask', task_id: 'task-1' })];
    const navigation = installNavigation(null);
    await boot(navigation);
    await deliverSync();
    await user.click(await screen.findByTestId('sb-list-switch'));
    await user.click(await screen.findByTestId('sb-mode-project'));
    await waitFor(() => expect(attr('data-mode')).toBe('sessions'));
    expect(attr('data-explicit-list')).toBe('sessions');
    await waitFor(() => expect(screen.getByTestId('topbar-back')).not.toBeDisabled());
    await user.click(screen.getByTestId('topbar-back'));
    await waitFor(() => expect(attr('data-mode')).toBe('tasks'));
    expect(attr('data-explicit-list')).toBe('sessions');

    navigation.push(target('bound'));
    await waitFor(() => expect(attr('data-session-id')).toBe('bound'));
    expect(attr('data-mode')).toBe('tasks');
    expect(attr('data-task-id')).toBe('task-1');
    expect(attr('data-subtask-id')).toBe('bound');
    expect(attr('data-explicit-list')).toBe('sessions');
  });

  it('opens from Agents into Repos when no Repos or Tasks choice was recorded', async () => {
    const user = userEvent.setup();
    world.sessions = [session({ id: 'bound', name: 'Bound', type: 'subtask', task_id: 'task-1' })];
    const navigation = installNavigation(null);
    await boot(navigation);
    await deliverSync();
    await user.click(await screen.findByTestId('sb-nav-agents'));
    await waitFor(() => expect(attr('data-mode')).toBe('agents'));
    expect(attr('data-explicit-list')).toBe('');

    navigation.push(target('bound'));
    await waitFor(() => expect(attr('data-session-id')).toBe('bound'));
    expect(attr('data-mode')).toBe('sessions');
    expect(attr('data-task-id')).toBe('');
    expect(attr('data-subtask-id')).toBe('');
  });

  it('uses the Tasks list that was clicked from Agents', async () => {
    const user = userEvent.setup();
    world.sessions = [session({ id: 'bound', name: 'Bound', type: 'subtask', task_id: 'task-1' })];
    const navigation = installNavigation(null);
    await boot(navigation);
    await deliverSync();
    await user.click(await screen.findByTestId('sb-nav-agents'));
    await user.click(await screen.findByText('Bound'));
    await waitFor(() => expect(attr('data-mode')).toBe('tasks'));
    expect(attr('data-session-id')).toBe('bound');
    expect(attr('data-task-id')).toBe('task-1');
    expect(attr('data-subtask-id')).toBe('bound');
    expect(attr('data-explicit-list')).toBe('tasks');
  });

  it('keeps selection for a missing session and opens an archived notification read-only', async () => {
    const user = userEvent.setup();
    const keep = session({ id: 'keep', name: 'Keep' });
    world.sessions = [keep];
    world.archived = [session({ id: 'old', name: 'Old', archived: 1 })];
    const navigation = installNavigation(null);
    await boot(navigation);
    await deliverSync();
    await user.click(await screen.findByTestId('session-row-keep'));
    await waitFor(() => expect(attr('data-session-id')).toBe('keep'));

    navigation.push(target('gone'));
    await waitFor(() => expect(navigation.acks).toHaveLength(1));
    expect(await screen.findByText('That session is no longer available.')).toBeInTheDocument();
    expect(attr('data-session-id')).toBe('keep');
    expect(attr('data-mode')).toBe('tasks');
    expect(attr('data-task-id')).toBe('');
    expect(attr('data-subtask-id')).toBe('');
    expect(screen.queryByTestId('session-row-gone')).not.toBeInTheDocument();

    navigation.push(target('old'));
    await waitFor(() => expect(navigation.acks).toHaveLength(2));
    expect(await screen.findByTestId('archived-readonly-banner')).toBeInTheDocument();
    expect(attr('data-session-id')).toBe('old');
    expect(attr('data-mode')).toBe('tasks');
    expect(attr('data-task-id')).toBe('');
    expect(attr('data-subtask-id')).toBe('');
    expect(screen.queryByTestId('session-row-old')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(requests.some(item => item.method !== 'GET' && item.url.startsWith('/api/sessions/old'))).toBe(false);
  });

  it('does not acknowledge a session when the archive lookup fails', async () => {
    const user = userEvent.setup();
    world.sessions = [session({ id: 'keep', name: 'Keep' })];
    world.failArchived = true;
    const navigation = installNavigation(null);
    await boot(navigation);
    await deliverSync();
    await user.click(await screen.findByTestId('session-row-keep'));
    await waitFor(() => expect(attr('data-session-id')).toBe('keep'));

    navigation.push(target('gone'));
    await waitFor(() => {
      expect(requests.some(item => item.url === '/api/sessions?archived=true')).toBe(true);
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(navigation.acks).toHaveLength(0);
    expect(screen.queryByText('That session is no longer available.')).not.toBeInTheDocument();
    expect(screen.queryByText('That session is archived.')).not.toBeInTheDocument();
    expect(attr('data-session-id')).toBe('keep');
    expect(attr('data-mode')).toBe('tasks');
    expect(attr('data-task-id')).toBe('');
    expect(attr('data-subtask-id')).toBe('');

    world.failArchived = false;
    await deliverSync();
    await waitFor(() => expect(navigation.acks).toHaveLength(1));
    expect(await screen.findByText('That session is no longer available.')).toBeInTheDocument();
    expect(attr('data-session-id')).toBe('keep');
    expect(attr('data-mode')).toBe('tasks');
    expect(attr('data-task-id')).toBe('');
    expect(attr('data-subtask-id')).toBe('');
  });

  it('does not acknowledge a session lookup that failed to load', async () => {
    const user = userEvent.setup();
    world.sessions = [session({ id: 'keep', name: 'Keep' })];
    const navigation = installNavigation(null);
    await boot(navigation);
    await deliverSync();
    await user.click(await screen.findByTestId('session-row-keep'));
    await waitFor(() => expect(attr('data-session-id')).toBe('keep'));

    world.failActive = true;
    const before = requests.filter(item => item.url === '/api/sessions').length;
    navigation.push(target('gone'));
    await waitFor(() => {
      expect(requests.filter(item => item.url === '/api/sessions').length).toBeGreaterThan(before);
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(navigation.acks).toHaveLength(0);
    expect(attr('data-session-id')).toBe('keep');

    world.failActive = false;
    await deliverSync();
    await waitFor(() => expect(navigation.acks).toHaveLength(1));
    expect(attr('data-session-id')).toBe('keep');
    expect(attr('data-mode')).toBe('tasks');
  });

  it('keeps the command palette and the next-session shortcut on the current page', async () => {
    const user = userEvent.setup();
    world.sessions = [
      session({ id: 'alpha', name: 'Alpha' }),
      session({ id: 'beta', name: 'Beta' }),
    ];
    const navigation = installNavigation(null);
    await boot(navigation);
    await deliverSync();
    await user.click(await screen.findByTestId('session-row-alpha'));
    await waitFor(() => expect(attr('data-session-id')).toBe('alpha'));

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }));
    });
    await user.click(await screen.findByRole('button', { name: /Beta/ }));
    await waitFor(() => expect(attr('data-session-id')).toBe('beta'));
    expect(attr('data-mode')).toBe('tasks');
    expect(attr('data-task-id')).toBe('');
    expect(attr('data-subtask-id')).toBe('');

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Tab', ctrlKey: true, bubbles: true, cancelable: true,
      }));
    });
    await waitFor(() => expect(attr('data-session-id')).toBe('alpha'));
    expect(attr('data-mode')).toBe('tasks');
  });

  it('returns a screenshot to the session on the current page', async () => {
    const user = userEvent.setup();
    world.sessions = [
      session({ id: 'alpha', name: 'Alpha' }),
      session({ id: 'beta', name: 'Beta' }),
    ];
    const navigation = installNavigation(null);
    await boot(navigation);
    await deliverSync();
    await user.click(await screen.findByTestId('session-row-alpha'));
    await waitFor(() => expect(attr('data-session-id')).toBe('alpha'));

    act(() => { emitScreenshot('beta', 'Beta'); });
    await waitFor(() => expect(attr('data-session-id')).toBe('beta'));
    expect(attr('data-mode')).toBe('tasks');
    expect(attr('data-task-id')).toBe('');
  });

  it('opens a Timer conversation and a scheduled run without dropping the run focus', async () => {
    const user = userEvent.setup();
    // Keep history pending so a missing run row does not consume the focus.
    eventsHold.current = new Promise(resolve => { releaseEvents = resolve; });
    world.sessions = [session({ id: 'session-1', name: 'Release watch' })];
    world.schedules = [makeSchedule()];
    world.schedule = makeSchedule();
    world.runs = [makeRun()];
    const navigation = installNavigation(null);
    await boot(navigation);
    await deliverSync();
    await user.click(await screen.findByTestId('sb-list-switch'));
    await user.click(await screen.findByTestId('sb-mode-tasks'));
    await waitFor(() => expect(attr('data-explicit-list')).toBe('tasks'));
    await user.click(screen.getByTestId('sb-nav-timer'));
    await user.click(await screen.findByTestId('timer-row-sch-1'));
    await user.click(await screen.findByTestId('schedule-open-chat'));
    await waitFor(() => expect(attr('data-session-id')).toBe('session-1'));
    expect(attr('data-mode')).toBe('tasks');
    expect(attr('data-schedule-focus')).toBe('');

    await user.click(screen.getByTestId('sb-nav-timer'));
    await user.click(await screen.findByTestId('timer-row-sch-1'));
    await user.click(await screen.findByTestId('schedule-tab-runs'));
    await user.click(await screen.findByTestId('schedule-run-open-run-1'));
    await waitFor(() => expect(attr('data-schedule-focus')).toBe('session-1:run-1'));
    expect(attr('data-mode')).toBe('tasks');
    expect(attr('data-session-id')).toBe('session-1');
    expect(attr('data-task-id')).toBe('');
    expect(attr('data-subtask-id')).toBe('');
  });

  it('keeps Timer create-schedule on the new-session page', async () => {
    const user = userEvent.setup();
    const navigation = installNavigation(null);
    await boot(navigation);
    await deliverSync();
    await user.click(await screen.findByTestId('sb-nav-timer'));
    await user.click(await screen.findByTestId('timer-create'));
    await waitFor(() => expect(attr('data-mode')).toBe('sessions'));
    expect(attr('data-explicit-list')).toBe('sessions');
    expect(attr('data-session-id')).toBe('');
    expect(await screen.findByText(/Help me create a Gian scheduled task/)).toBeInTheDocument();
  });

  it('does not let a slow session lookup reclaim a session the user already opened', async () => {
    const user = userEvent.setup();
    const late = session({ id: 'late', name: 'Late' });
    world.sessions = [
      session({ id: 'alpha', name: 'Alpha' }),
      session({ id: 'beta', name: 'Beta' }),
    ];
    const navigation = installNavigation(null);
    await boot(navigation);
    await deliverSync();
    holdActiveLoads();
    const seen = activeListResponses;
    const lookups = requests.filter(item => item.url === '/api/sessions' && item.method === 'GET').length;
    navigation.push(target('late'));
    await waitFor(() => {
      expect(requests.filter(item => item.url === '/api/sessions' && item.method === 'GET').length)
        .toBeGreaterThan(lookups);
    });
    await user.click(await screen.findByTestId('session-row-beta'));
    await waitFor(() => expect(attr('data-session-id')).toBe('beta'));

    world.activeOverride = [...world.sessions, late];
    releaseActiveLoads();
    await waitFor(() => expect(activeListResponses).toBeGreaterThan(seen));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(attr('data-session-id')).toBe('beta');
    expect(attr('data-mode')).toBe('tasks');
    expect(attr('data-task-id')).toBe('');
    expect(attr('data-subtask-id')).toBe('');
  });

  it('lets a desktop click replace an in-app session lookup that is still waiting', async () => {
    const user = userEvent.setup();
    eventsHold.current = new Promise(resolve => { releaseEvents = resolve; });
    const late = session({ id: 'late', name: 'Late' });
    world.sessions = [
      session({ id: 'session-1', name: 'Release watch' }),
      session({ id: 'beta', name: 'Beta' }),
    ];
    world.schedules = [makeSchedule()];
    world.schedule = makeSchedule();
    world.runs = [makeRun({ target_session_id: 'late' })];
    const navigation = installNavigation(null);
    await boot(navigation);
    await deliverSync();
    await user.click(await screen.findByTestId('sb-list-switch'));
    await user.click(await screen.findByTestId('sb-mode-tasks'));
    await user.click(screen.getByTestId('sb-nav-timer'));
    await user.click(await screen.findByTestId('timer-row-sch-1'));
    await user.click(await screen.findByTestId('schedule-tab-runs'));
    holdActiveLoads();
    const seen = activeListResponses;
    const lookups = requests.filter(item => item.url === '/api/sessions' && item.method === 'GET').length;
    await user.click(await screen.findByTestId('schedule-run-open-run-1'));
    await waitFor(() => {
      expect(requests.filter(item => item.url === '/api/sessions' && item.method === 'GET').length)
        .toBeGreaterThan(lookups);
    });

    navigation.push(target('beta'));
    await waitFor(() => expect(attr('data-session-id')).toBe('beta'));
    world.activeOverride = [...world.sessions, late];
    releaseActiveLoads();
    await waitFor(() => expect(activeListResponses).toBeGreaterThan(seen));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(attr('data-session-id')).toBe('beta');
    expect(attr('data-mode')).toBe('tasks');
    expect(attr('data-task-id')).toBe('');
    expect(attr('data-subtask-id')).toBe('');
    expect(attr('data-schedule-focus')).toBe('');
  });

  it('does not let a slow session lookup reclaim an explicit page change or history step', async () => {
    const user = userEvent.setup();
    const late = session({ id: 'late', name: 'Late' });
    world.sessions = [session({ id: 'alpha', name: 'Alpha' })];
    const navigation = installNavigation(null);
    await boot(navigation);
    await deliverSync();
    await user.click(await screen.findByTestId('session-row-alpha'));
    await waitFor(() => expect(attr('data-session-id')).toBe('alpha'));
    await waitFor(() => expect(screen.getByTestId('topbar-back')).not.toBeDisabled());

    holdActiveLoads();
    const seen = activeListResponses;
    const lookups = requests.filter(item => item.url === '/api/sessions' && item.method === 'GET').length;
    navigation.push(target('late'));
    await waitFor(() => {
      expect(requests.filter(item => item.url === '/api/sessions' && item.method === 'GET').length)
        .toBeGreaterThan(lookups);
    });
    await user.click(screen.getByTestId('sb-nav-agents'));
    await waitFor(() => expect(attr('data-mode')).toBe('agents'));
    world.activeOverride = [...world.sessions, late];
    releaseActiveLoads();
    await waitFor(() => expect(activeListResponses).toBeGreaterThan(seen));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(attr('data-mode')).toBe('agents');
    expect(attr('data-session-id')).toBe('alpha');
    expect(attr('data-task-id')).toBe('');
    expect(attr('data-subtask-id')).toBe('');

    holdActiveLoads();
    const seenAgain = activeListResponses;
    navigation.push(target('late', 2));
    await user.click(screen.getByTestId('topbar-back'));
    await waitFor(() => expect(attr('data-mode')).toBe('tasks'));
    expect(attr('data-session-id')).toBe('alpha');
    await waitFor(() => expect(screen.getByTestId('topbar-forward')).not.toBeDisabled());
    await user.click(screen.getByTestId('topbar-forward'));
    await waitFor(() => expect(attr('data-mode')).toBe('agents'));
    releaseActiveLoads();
    await waitFor(() => expect(activeListResponses).toBeGreaterThan(seenAgain));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(attr('data-mode')).toBe('agents');
    expect(attr('data-session-id')).toBe('alpha');
    expect(attr('data-task-id')).toBe('');
    expect(attr('data-subtask-id')).toBe('');
  });

  it('keeps a scheduled run id when the first session load fails and a later snapshot retries', async () => {
    const user = userEvent.setup();
    eventsHold.current = new Promise(resolve => { releaseEvents = resolve; });
    const late = session({ id: 'late', name: 'Late' });
    world.sessions = [session({ id: 'session-1', name: 'Release watch' })];
    world.schedules = [makeSchedule()];
    world.schedule = makeSchedule();
    world.runs = [makeRun({ target_session_id: 'late' })];
    const navigation = installNavigation(null);
    await boot(navigation);
    await deliverSync();
    await user.click(await screen.findByTestId('sb-list-switch'));
    await user.click(await screen.findByTestId('sb-mode-tasks'));
    await waitFor(() => expect(attr('data-explicit-list')).toBe('tasks'));
    await user.click(screen.getByTestId('sb-nav-timer'));
    await user.click(await screen.findByTestId('timer-row-sch-1'));
    await user.click(await screen.findByTestId('schedule-tab-runs'));

    world.failActive = true;
    const before = requests.filter(item => item.url === '/api/sessions' && item.method === 'GET').length;
    await user.click(await screen.findByTestId('schedule-run-open-run-1'));
    await waitFor(() => {
      expect(requests.filter(item => item.url === '/api/sessions' && item.method === 'GET').length)
        .toBeGreaterThan(before);
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(attr('data-session-id')).toBe('');
    expect(attr('data-schedule-focus')).toBe('');
    expect(screen.queryByText('That session is no longer available.')).not.toBeInTheDocument();

    world.failActive = false;
    world.activeOverride = [...world.sessions, late];
    await deliverSync();
    await waitFor(() => expect(attr('data-schedule-focus')).toBe('late:run-1'));
    expect(attr('data-session-id')).toBe('late');
    expect(attr('data-mode')).toBe('tasks');
    expect(attr('data-task-id')).toBe('');
    expect(attr('data-subtask-id')).toBe('');
    expect(navigation.acks).toHaveLength(0);
  });

  it('keeps a pending notification ahead of fork recovery in the same snapshot', async () => {
    const bound = session({ id: 'bound', name: 'Bound', type: 'subtask', task_id: 'task-1' });
    const forked = session({ id: 'forked', name: 'Forked', type: 'subtask', task_id: 'task-1' });
    world.sessions = [bound, forked];
    world.tasks = [task];
    rememberForkNavigation('forked', 'run-fork');
    const navigation = installNavigation(target('bound', 4));
    await boot(navigation);
    expect(navigation.acks).toHaveLength(0);
    expect(attr('data-session-id')).toBe('');

    await deliverSync();
    await waitFor(() => expect(attr('data-session-id')).toBe('bound'));
    expect(attr('data-mode')).toBe('tasks');
    expect(attr('data-task-id')).toBe('task-1');
    expect(attr('data-subtask-id')).toBe('bound');
    expect(navigation.acks).toHaveLength(1);
    expect(navigation.acks[0]).toMatchObject({ type: 'session', sessionId: 'bound', turn: 4 });

    await deliverSync();
    await act(async () => { await Promise.resolve(); });
    expect(attr('data-session-id')).toBe('bound');
    expect(attr('data-mode')).toBe('tasks');
    expect(attr('data-task-id')).toBe('task-1');
    expect(attr('data-subtask-id')).toBe('bound');
  });

  it('opens a recovered fork on its task surface when no explicit navigation is waiting', async () => {
    const forked = session({ id: 'forked', name: 'Forked', type: 'subtask', task_id: 'task-1' });
    world.sessions = [forked];
    world.tasks = [task];
    rememberForkNavigation('forked', 'run-fork');
    const navigation = installNavigation(null);
    await boot(navigation);
    await deliverSync();
    await waitFor(() => expect(attr('data-session-id')).toBe('forked'));
    expect(attr('data-mode')).toBe('tasks');
    expect(attr('data-task-id')).toBe('task-1');
    expect(attr('data-subtask-id')).toBe('forked');
    await expectOpenSession('forked', 'Forked');
    expect(navigation.acks).toHaveLength(0);
  });

  it('does not let a later state_sync fork reclaim a session the user already opened', async () => {
    const user = userEvent.setup();
    const bound = session({ id: 'bound', name: 'Bound', type: 'subtask', task_id: 'task-1' });
    const fork = session({ id: 'fork-a', name: 'Fork A', type: 'subtask', task_id: 'task-1' });
    world.sessions = [bound];
    world.tasks = [task];
    rememberForkNavigation('fork-a', 'run-fork');
    const navigation = installNavigation(null);
    await boot(navigation);
    await deliverSync();
    await user.click(await screen.findByText('Bound'));
    await expectOpenSession('bound', 'Bound');
    expect(attr('data-task-id')).toBe('task-1');
    expect(attr('data-subtask-id')).toBe('bound');

    world.sessions = [bound, fork];
    await deliverSync();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(attr('data-session-id')).toBe('bound');
    expect(attr('data-mode')).toBe('tasks');
    expect(attr('data-task-id')).toBe('task-1');
    expect(attr('data-subtask-id')).toBe('bound');
    await expectOpenSession('bound', 'Bound');
    expect(requests.some(item => item.url.startsWith('/api/sessions/fork-a/events'))).toBe(false);
  });

  it('does not let a later state_sync fork reclaim an explicit Agents switch', async () => {
    const user = userEvent.setup();
    const bound = session({ id: 'bound', name: 'Bound', type: 'subtask', task_id: 'task-1' });
    const fork = session({ id: 'fork-a', name: 'Fork A', type: 'subtask', task_id: 'task-1' });
    world.sessions = [bound];
    world.tasks = [task];
    rememberForkNavigation('fork-a', 'run-fork');
    const navigation = installNavigation(null);
    await boot(navigation);
    await deliverSync();
    await user.click(screen.getByTestId('sb-nav-agents'));
    await screen.findByTestId('agents-view');

    world.sessions = [bound, fork];
    await deliverSync();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByTestId('agents-view')).toBeInTheDocument();
    expect(document.querySelector('.path-seg.session .path-seg-label')?.textContent ?? '').not.toBe('Fork A');
    expect(document.querySelector('.composer-bar')).toBeNull();
    expect(requests.some(item => item.url.startsWith('/api/sessions/fork-a/events'))).toBe(false);
    expect(attr('data-mode')).toBe('agents');
    expect(attr('data-session-id')).toBe('');
    expect(attr('data-task-id')).toBe('');
    expect(attr('data-subtask-id')).toBe('');
  });

  it('does not let a later session:created fork reclaim a session the user already opened', async () => {
    const user = userEvent.setup();
    const bound = session({ id: 'bound', name: 'Bound', type: 'subtask', task_id: 'task-1' });
    const fork = session({ id: 'fork-a', name: 'Fork A', type: 'subtask', task_id: 'task-1' });
    world.sessions = [bound];
    world.tasks = [task];
    rememberForkNavigation('fork-a', 'run-fork');
    const navigation = installNavigation(null);
    await boot(navigation);
    await deliverSync();
    await user.click(await screen.findByText('Bound'));
    await expectOpenSession('bound', 'Bound');

    const socket = getMockWebSockets()[0]!;
    act(() => {
      socket.fakeMessage({ type: 'session:created', origin: 'session-fork', session: fork });
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(attr('data-session-id')).toBe('bound');
    expect(attr('data-task-id')).toBe('task-1');
    expect(attr('data-subtask-id')).toBe('bound');
    await expectOpenSession('bound', 'Bound');
    expect(requests.some(item => item.url.startsWith('/api/sessions/fork-a/events'))).toBe(false);
  });

  it('opens a session:created fork on its task when no newer user intent exists', async () => {
    const parent = session({ id: 'parent', name: 'Parent' });
    const fork = session({ id: 'fork-a', name: 'Fork A', type: 'subtask', task_id: 'task-1' });
    world.sessions = [parent];
    world.tasks = [task];
    rememberForkNavigation('fork-a', 'run-fork');
    const navigation = installNavigation(null);
    await boot(navigation);
    await deliverSync();
    expect(attr('data-session-id')).toBe('');

    const socket = getMockWebSockets()[0]!;
    act(() => {
      socket.fakeMessage({ type: 'session:created', origin: 'session-fork', session: fork });
    });
    await expectOpenSession('fork-a', 'Fork A');
    expect(attr('data-mode')).toBe('tasks');
    expect(attr('data-session-id')).toBe('fork-a');
    expect(attr('data-task-id')).toBe('task-1');
    expect(attr('data-subtask-id')).toBe('fork-a');
    expect(navigation.acks).toHaveLength(0);
  });

  it('ignores a stale active body and opens the canonical archived row read-only', async () => {
    const user = userEvent.setup();
    const keep = session({ id: 'keep', name: 'Keep', type: 'subtask', task_id: 'task-1' });
    const stale = session({ id: 'stale', name: 'Stale', type: 'subtask', task_id: 'task-1' });
    world.sessions = [keep];
    world.tasks = [task];
    const navigation = installNavigation(null);
    await boot(navigation);
    await deliverSync();
    await user.click(await screen.findByText('Keep'));
    await expectOpenSession('keep', 'Keep');

    holdActiveLoads();
    const before = sessionListGets();
    navigation.push(target('stale'));
    await waitFor(() => expect(sessionListGets()).toBeGreaterThan(before));
    const socket = getMockWebSockets()[0]!;
    act(() => {
      socket.fakeMessage({ type: 'session:updated', session: { id: 'stale', archived: 1 } });
    });
    world.activeOverride = [keep, stale];
    world.archived = [{ ...stale, archived: 1 }];
    releaseActiveLoads();
    expect(await screen.findByTestId('archived-readonly-banner')).toBeInTheDocument();
    expect(screen.queryByTestId('session-row-stale')).not.toBeInTheDocument();
    expect(attr('data-session-id')).toBe('stale');
    expect(attr('data-mode')).toBe('tasks');
    expect(attr('data-task-id')).toBe('task-1');
    expect(attr('data-subtask-id')).toBe('stale');
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(requests.some(item => item.method !== 'GET' && item.url.startsWith('/api/sessions/stale'))).toBe(false);
    expect(navigation.acks).toHaveLength(1);
  });

  it('does not resurrect a session deleted while its list lookup was in flight', async () => {
    const user = userEvent.setup();
    const keep = session({ id: 'keep', name: 'Keep', type: 'subtask', task_id: 'task-1' });
    const stale = session({ id: 'stale', name: 'Stale', type: 'subtask', task_id: 'task-1' });
    world.sessions = [keep];
    world.tasks = [task];
    const navigation = installNavigation(null);
    await boot(navigation);
    await deliverSync();
    await user.click(await screen.findByText('Keep'));
    await expectOpenSession('keep', 'Keep');

    holdActiveLoads();
    const before = sessionListGets();
    navigation.push(target('stale'));
    await waitFor(() => expect(sessionListGets()).toBeGreaterThan(before));
    const socket = getMockWebSockets()[0]!;
    act(() => {
      socket.fakeMessage({ type: 'session:deleted', session_id: 'stale' });
    });
    world.activeOverride = [keep, stale];
    releaseActiveLoads();
    await waitFor(() => expect(screen.getByText('That session is no longer available.')).toBeInTheDocument());
    expect(screen.queryByText('Stale')).not.toBeInTheDocument();
    expect(attr('data-session-id')).toBe('keep');
    expect(attr('data-task-id')).toBe('task-1');
    expect(attr('data-subtask-id')).toBe('keep');
    await expectOpenSession('keep', 'Keep');
    expect(requests.some(item => item.url.startsWith('/api/sessions/stale/events'))).toBe(false);
  });

  it('navigates with the newer task when a snapshot updates ownership before the list body', async () => {
    const user = userEvent.setup();
    const oldTask = { ...task, id: 'task-old', name: 'Old task' };
    const newTask = { ...task, id: 'task-new', name: 'New task' };
    const keep = session({ id: 'keep', name: 'Keep', type: 'subtask', task_id: 'task-1' });
    const staleOld = session({ id: 'stale', name: 'Stale', type: 'subtask', task_id: 'task-old' });
    const staleNew = session({ id: 'stale', name: 'Stale', type: 'subtask', task_id: 'task-new' });
    world.sessions = [keep];
    world.tasks = [task, oldTask, newTask];
    const navigation = installNavigation(null);
    await boot(navigation);
    await deliverSync();
    await user.click(await screen.findByText('Keep'));
    await expectOpenSession('keep', 'Keep');

    holdActiveLoads();
    const before = sessionListGets();
    navigation.push(target('stale'));
    await waitFor(() => expect(sessionListGets()).toBeGreaterThan(before));
    world.sessions = [keep, staleNew];
    await deliverSync();
    world.activeOverride = [keep, staleOld];
    releaseActiveLoads();
    await expectOpenSession('stale', 'Stale');
    expect(attr('data-mode')).toBe('tasks');
    expect(attr('data-session-id')).toBe('stale');
    expect(attr('data-task-id')).toBe('task-new');
    expect(attr('data-subtask-id')).toBe('stale');
    expect(sessionRowInTask('New task', 'Stale')).not.toBeNull();
    expect(sessionRowInTask('Old task', 'Stale')).toBeNull();
  });

  it('opens the task shown on the row during assign overlay and returns with the row when assign fails', async () => {
    const user = userEvent.setup();
    const alpha = session({ id: 'alpha', name: 'Alpha', type: 'subtask', task_id: 'task-1' });
    const other = { ...task, id: 'task-2', name: 'Other' };
    world.sessions = [alpha];
    world.tasks = [task, other];
    const navigation = installNavigation(null);
    await boot(navigation);
    await deliverSync();
    const source = await waitFor(() => {
      const row = sessionRowInTask('Ship', 'Alpha');
      expect(row).not.toBeNull();
      return row!;
    });
    const dataTransfer = { effectAllowed: '', dropEffect: '', setData: () => {} };
    fireEvent.dragStart(source, { dataTransfer });
    const header = taskGroup('Other').querySelector('.task-group');
    if (!header) throw new Error('missing other task header');
    fireEvent.dragOver(header, { dataTransfer, clientY: 0 });
    fireEvent.drop(header, { dataTransfer });
    const moved = await waitFor(() => {
      expect(sessionRowInTask('Ship', 'Alpha')).toBeNull();
      const row = sessionRowInTask('Other', 'Alpha');
      expect(row).not.toBeNull();
      return row!;
    });
    await user.click(moved);
    await expectOpenSession('alpha', 'Alpha');
    expect(attr('data-mode')).toBe('tasks');
    expect(attr('data-task-id')).toBe('task-2');
    expect(attr('data-subtask-id')).toBe('alpha');
    expect(sessionRowInTask('Other', 'Alpha')).not.toBeNull();

    const socket = getMockWebSockets()[0]!;
    const assign = socket.parsedSent<{ type: string; request_id?: string }>()
      .filter(frame => frame.type === 'session:assign_task')
      .at(-1);
    expect(assign?.request_id).toBeTruthy();
    act(() => {
      socket.fakeMessage({
        type: 'operation:result',
        request_id: assign!.request_id,
        request_type: 'session:assign_task',
        ok: false,
        error: { code: 'SESSION_ASSIGN_TASK_FAILED', message: 'task is no longer open' },
      });
    });
    await waitFor(() => {
      expect(sessionRowInTask('Ship', 'Alpha')).not.toBeNull();
      expect(sessionRowInTask('Other', 'Alpha')).toBeNull();
      expect(attr('data-task-id')).toBe('task-1');
    });
    expect(attr('data-subtask-id')).toBe('alpha');
    expect(attr('data-session-id')).toBe('alpha');
    await expectOpenSession('alpha', 'Alpha');
  });

  it('does not let a stored high-sequence fork reclaim a choice made after reload', async () => {
    const user = userEvent.setup();
    const bound = session({ id: 'bound', name: 'Bound', type: 'subtask', task_id: 'task-1' });
    const fork = session({ id: 'fork-a', name: 'Fork A', type: 'subtask', task_id: 'task-1' });
    plantStoredFork('fork-a', 100);
    world.sessions = [bound];
    world.tasks = [task];
    const navigation = installNavigation(null);
    await boot(navigation);
    await deliverSync();
    await user.click(await screen.findByText('Bound'));
    await expectOpenSession('bound', 'Bound');

    world.sessions = [bound, fork];
    act(() => { emitSync(); });
    await act(async () => { await Promise.resolve(); });
    expect(attr('data-session-id')).toBe('bound');
    expect(attr('data-task-id')).toBe('task-1');
    expect(attr('data-subtask-id')).toBe('bound');
    await expectOpenSession('bound', 'Bound');
    expect(requests.some(item => item.url.startsWith('/api/sessions/fork-a/events'))).toBe(false);
  });

  it('does not let a stored high-sequence fork reclaim an Agents switch after reload', async () => {
    const user = userEvent.setup();
    const bound = session({ id: 'bound', name: 'Bound', type: 'subtask', task_id: 'task-1' });
    const fork = session({ id: 'fork-a', name: 'Fork A', type: 'subtask', task_id: 'task-1' });
    plantStoredFork('fork-a', 100);
    world.sessions = [bound];
    world.tasks = [task];
    const navigation = installNavigation(null);
    await boot(navigation);
    await deliverSync();
    await user.click(screen.getByTestId('sb-nav-agents'));
    await screen.findByTestId('agents-view');

    world.sessions = [bound, fork];
    act(() => { emitSync(); });
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByTestId('agents-view')).toBeInTheDocument();
    expect(document.querySelector('.path-seg.session .path-seg-label')?.textContent ?? '').not.toBe('Fork A');
    expect(document.querySelector('.composer-bar')).toBeNull();
    expect(requests.some(item => item.url.startsWith('/api/sessions/fork-a/events'))).toBe(false);
    expect(attr('data-mode')).toBe('agents');
    expect(attr('data-session-id')).toBe('');
    expect(attr('data-task-id')).toBe('');
    expect(attr('data-subtask-id')).toBe('');
  });

  it('still opens a stored fork after reload when the user has not chosen again', async () => {
    const forked = session({ id: 'forked', name: 'Forked', type: 'subtask', task_id: 'task-1' });
    plantStoredFork('forked', 100);
    world.sessions = [forked];
    world.tasks = [task];
    const navigation = installNavigation(null);
    await boot(navigation);
    await deliverSync();
    await expectOpenSession('forked', 'Forked');
    expect(attr('data-mode')).toBe('tasks');
    expect(attr('data-session-id')).toBe('forked');
    expect(attr('data-task-id')).toBe('task-1');
    expect(attr('data-subtask-id')).toBe('forked');
    expect(navigation.acks).toHaveLength(0);
  });

  it('still opens a legacy fork record that has no sequence', async () => {
    const forked = session({ id: 'forked', name: 'Forked', type: 'subtask', task_id: 'task-1' });
    plantStoredFork('forked', null);
    world.sessions = [forked];
    world.tasks = [task];
    const navigation = installNavigation(null);
    await boot(navigation);
    await deliverSync();
    await expectOpenSession('forked', 'Forked');
    expect(attr('data-task-id')).toBe('task-1');
    expect(attr('data-subtask-id')).toBe('forked');
  });

  it('does not let a legacy fork reclaim a choice made after reload', async () => {
    const user = userEvent.setup();
    const bound = session({ id: 'bound', name: 'Bound', type: 'subtask', task_id: 'task-1' });
    const fork = session({ id: 'fork-a', name: 'Fork A', type: 'subtask', task_id: 'task-1' });
    plantStoredFork('fork-a', null);
    world.sessions = [bound];
    world.tasks = [task];
    const navigation = installNavigation(null);
    await boot(navigation);
    await deliverSync();
    await user.click(await screen.findByText('Bound'));
    await expectOpenSession('bound', 'Bound');

    world.sessions = [bound, fork];
    act(() => { emitSync(); });
    await act(async () => { await Promise.resolve(); });
    await expectOpenSession('bound', 'Bound');
    expect(attr('data-task-id')).toBe('task-1');
    expect(attr('data-subtask-id')).toBe('bound');
    expect(requests.some(item => item.url.startsWith('/api/sessions/fork-a/events'))).toBe(false);
  });

  it('does not restore a fork that a newer navigation superseded before reload', async () => {
    const user = userEvent.setup();
    const bound = session({ id: 'bound', name: 'Bound', type: 'subtask', task_id: 'task-1' });
    const fork = session({ id: 'fork-a', name: 'Fork A', type: 'subtask', task_id: 'task-1' });
    plantStoredFork('fork-a', 100);
    world.sessions = [bound];
    world.tasks = [task];
    await boot(installNavigation(null));
    await deliverSync();
    await user.click(await screen.findByText('Bound'));
    await expectOpenSession('bound', 'Bound');
    expect(sessionStorage.getItem(FORK_NAVIGATION_STORAGE_KEY)).toBeNull();

    cleanup();
    resetMockWebSockets();
    reloadNavigationIntentClock();
    world.sessions = [bound, fork];
    const navigation = installNavigation(null);
    await boot(navigation);
    await deliverSync();
    await waitFor(() => expect(sessionRowInTask('Ship', 'Fork A')).not.toBeNull());
    expect(sessionRowInTask('Ship', 'Bound')).not.toBeNull();
    expect(sessionStorage.getItem(FORK_NAVIGATION_STORAGE_KEY)).toBeNull();
    expect(document.querySelector('.path-seg.session .path-seg-label')).toBeNull();
    expect(document.querySelector('.composer-bar')).toBeNull();
    expect(requests.some(item => item.url.startsWith('/api/sessions/fork-a/events'))).toBe(false);
    expect(attr('data-session-id')).toBe('');
    expect(attr('data-task-id')).toBe('');
    expect(attr('data-subtask-id')).toBe('');
    expect(navigation.acks).toHaveLength(0);
  });

  it('keeps a standalone session open when assigning it to a task fails', async () => {
    const user = userEvent.setup();
    const alpha = session({ id: 'alpha', name: 'Alpha', type: 'coding', task_id: null });
    world.sessions = [alpha];
    world.tasks = [task];
    const navigation = installNavigation(null);
    await boot(navigation);
    await deliverSync();
    const source = await screen.findByTestId('session-row-alpha');
    const header = taskGroup('Ship').querySelector('.task-group');
    if (!header) throw new Error('missing ship task header');
    const dataTransfer = { effectAllowed: '', dropEffect: '', setData: () => {} };
    fireEvent.dragStart(source, { dataTransfer });
    fireEvent.dragOver(header, { dataTransfer, clientY: 0 });
    fireEvent.drop(header, { dataTransfer });
    const moved = await waitFor(() => {
      const row = sessionRowInTask('Ship', 'Alpha');
      expect(row).not.toBeNull();
      expect(screen.getByTestId('session-row-alpha')).toBe(row);
      return row!;
    });
    await user.click(moved);
    await expectOpenSession('alpha', 'Alpha');
    expect(attr('data-mode')).toBe('tasks');
    expect(attr('data-task-id')).toBe('task-1');
    expect(attr('data-subtask-id')).toBe('alpha');
    expect(attr('data-session-id')).toBe('alpha');

    rejectLastAssign();
    await waitFor(() => {
      expect(screen.getByTestId('session-row-alpha')).toBeInTheDocument();
      expect(sessionRowInTask('Ship', 'Alpha')).toBeNull();
      expect(attr('data-task-id')).toBe('');
      expect(attr('data-subtask-id')).toBe('');
      expect(attr('data-session-id')).toBe('alpha');
    });
    await expectOpenSession('alpha', 'Alpha');
  });

  it('keeps a session open while releasing it from a task and restores the task when release fails', async () => {
    const user = userEvent.setup();
    const alpha = session({ id: 'alpha', name: 'Alpha', type: 'subtask', task_id: 'task-1' });
    const loose = session({ id: 'loose', name: 'Loose', type: 'coding', task_id: null });
    world.sessions = [alpha, loose];
    world.tasks = [task];
    const navigation = installNavigation(null);
    await boot(navigation);
    await deliverSync();
    const source = await waitFor(() => {
      const row = sessionRowInTask('Ship', 'Alpha');
      expect(row).not.toBeNull();
      return row!;
    });
    const section = screen.getByTestId('tasks-section-unassigned');
    const dataTransfer = { effectAllowed: '', dropEffect: '', setData: () => {} };
    fireEvent.dragStart(source, { dataTransfer });
    fireEvent.dragOver(section, { dataTransfer, clientY: 0 });
    fireEvent.drop(section, { dataTransfer });
    const moved = await screen.findByTestId('session-row-alpha');
    expect(sessionRowInTask('Ship', 'Alpha')).toBeNull();
    await user.click(moved);
    await expectOpenSession('alpha', 'Alpha');
    expect(attr('data-mode')).toBe('tasks');
    expect(attr('data-task-id')).toBe('');
    expect(attr('data-subtask-id')).toBe('');
    expect(attr('data-session-id')).toBe('alpha');

    rejectLastAssign();
    await waitFor(() => {
      expect(sessionRowInTask('Ship', 'Alpha')).not.toBeNull();
      expect(screen.getByTestId('session-row-alpha').closest('.tasks-list-task')).toBe(taskGroup('Ship'));
      expect(attr('data-task-id')).toBe('task-1');
      expect(attr('data-subtask-id')).toBe('alpha');
      expect(attr('data-session-id')).toBe('alpha');
    });
    await expectOpenSession('alpha', 'Alpha');
  });

  it('does not open a session deleted in the same turn as the notification', async () => {
    const user = userEvent.setup();
    const keep = session({ id: 'keep', name: 'Keep', type: 'subtask', task_id: 'task-1' });
    const stale = session({ id: 'stale', name: 'Stale', type: 'subtask', task_id: 'task-1' });
    world.sessions = [keep, stale];
    world.tasks = [task];
    const navigation = installNavigation(null);
    await boot(navigation);
    await deliverSync();
    await user.click(await screen.findByText('Keep'));
    await expectOpenSession('keep', 'Keep');

    const socket = getMockWebSockets()[0]!;
    act(() => {
      socket.fakeMessage({ type: 'session:deleted', session_id: 'stale' });
      navigation.push(target('stale'));
    });
    await waitFor(() => expect(screen.getByText('That session is no longer available.')).toBeInTheDocument());
    expect(screen.queryByText('Stale')).not.toBeInTheDocument();
    expect(attr('data-session-id')).toBe('keep');
    expect(attr('data-task-id')).toBe('task-1');
    expect(attr('data-subtask-id')).toBe('keep');
    await expectOpenSession('keep', 'Keep');
    expect(requests.some(item => item.url.startsWith('/api/sessions/stale/events'))).toBe(false);
    expect(navigation.acks).toHaveLength(1);
  });

  it('opens a session archived in the same turn as the notification read-only', async () => {
    const user = userEvent.setup();
    const keep = session({ id: 'keep', name: 'Keep', type: 'subtask', task_id: 'task-1' });
    const stale = session({ id: 'stale', name: 'Stale', type: 'subtask', task_id: 'task-1' });
    world.sessions = [keep, stale];
    world.tasks = [task];
    const navigation = installNavigation(null);
    await boot(navigation);
    await deliverSync();
    await user.click(await screen.findByText('Keep'));
    await expectOpenSession('keep', 'Keep');

    const socket = getMockWebSockets()[0]!;
    world.archived = [{ ...stale, archived: 1 }];
    act(() => {
      socket.fakeMessage({ type: 'session:updated', session: { id: 'stale', archived: 1 } });
      navigation.push(target('stale'));
    });
    expect(await screen.findByTestId('archived-readonly-banner')).toBeInTheDocument();
    expect(screen.queryByTestId('session-row-stale')).not.toBeInTheDocument();
    expect(attr('data-session-id')).toBe('stale');
    expect(attr('data-task-id')).toBe('task-1');
    expect(attr('data-subtask-id')).toBe('stale');
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(requests.some(item => item.method !== 'GET' && item.url.startsWith('/api/sessions/stale'))).toBe(false);
    expect(navigation.acks).toHaveLength(1);
  });

  it('does not open a session a same-turn snapshot has already removed', async () => {
    const user = userEvent.setup();
    const keep = session({ id: 'keep', name: 'Keep', type: 'subtask', task_id: 'task-1' });
    const stale = session({ id: 'stale', name: 'Stale', type: 'subtask', task_id: 'task-1' });
    world.sessions = [keep, stale];
    world.tasks = [task];
    const navigation = installNavigation(null);
    await boot(navigation);
    await deliverSync();
    await user.click(await screen.findByText('Keep'));
    await expectOpenSession('keep', 'Keep');

    world.sessions = [keep];
    act(() => {
      emitSync();
      navigation.push(target('stale'));
    });
    await waitFor(() => expect(screen.getByText('That session is no longer available.')).toBeInTheDocument());
    expect(screen.queryByText('Stale')).not.toBeInTheDocument();
    await expectOpenSession('keep', 'Keep');
    expect(attr('data-task-id')).toBe('task-1');
    expect(attr('data-subtask-id')).toBe('keep');
    expect(requests.some(item => item.url.startsWith('/api/sessions/stale/events'))).toBe(false);
    expect(navigation.acks).toHaveLength(1);
  });

  it('uses the snapshot task when a notification is resumed inside that snapshot', async () => {
    const oldTask = { ...task, id: 'task-old', name: 'Old task' };
    const newTask = { ...task, id: 'task-new', name: 'New task' };
    const staleOld = session({ id: 'stale', name: 'Stale', type: 'subtask', task_id: 'task-old' });
    const staleNew = session({ id: 'stale', name: 'Stale', type: 'subtask', task_id: 'task-new' });
    world.sessions = [staleOld];
    world.tasks = [oldTask, newTask];
    holdActiveLoads();
    const navigation = installNavigation(target('stale'));
    await boot(navigation);
    expect(navigation.acks).toHaveLength(0);
    releaseActiveLoads();
    await waitFor(() => expect(sessionRowInTask('Old task', 'Stale')).not.toBeNull());

    world.sessions = [staleNew];
    await deliverSync();
    await expectOpenSession('stale', 'Stale');
    expect(attr('data-mode')).toBe('tasks');
    expect(attr('data-session-id')).toBe('stale');
    expect(attr('data-task-id')).toBe('task-new');
    expect(attr('data-subtask-id')).toBe('stale');
    expect(sessionRowInTask('New task', 'Stale')).not.toBeNull();
    expect(sessionRowInTask('Old task', 'Stale')).toBeNull();
    expect(navigation.acks).toHaveLength(1);
  });

  it('opens the task from a same-turn snapshot instead of the previous render', async () => {
    const user = userEvent.setup();
    const oldTask = { ...task, id: 'task-old', name: 'Old task' };
    const newTask = { ...task, id: 'task-new', name: 'New task' };
    const keep = session({ id: 'keep', name: 'Keep', type: 'subtask', task_id: 'task-1' });
    const staleOld = session({ id: 'stale', name: 'Stale', type: 'subtask', task_id: 'task-old' });
    const staleNew = session({ id: 'stale', name: 'Stale', type: 'subtask', task_id: 'task-new' });
    world.sessions = [keep, staleOld];
    world.tasks = [task, oldTask, newTask];
    const navigation = installNavigation(null);
    await boot(navigation);
    await deliverSync();
    await user.click(await screen.findByText('Keep'));
    await expectOpenSession('keep', 'Keep');
    expect(sessionRowInTask('Old task', 'Stale')).not.toBeNull();

    world.sessions = [keep, staleNew];
    act(() => {
      emitSync();
      navigation.push(target('stale'));
    });
    await expectOpenSession('stale', 'Stale');
    expect(attr('data-mode')).toBe('tasks');
    expect(attr('data-session-id')).toBe('stale');
    expect(attr('data-task-id')).toBe('task-new');
    expect(attr('data-subtask-id')).toBe('stale');
    expect(sessionRowInTask('New task', 'Stale')).not.toBeNull();
    expect(sessionRowInTask('Old task', 'Stale')).toBeNull();
    expect(navigation.acks).toHaveLength(1);
  });

  async function openFontSizeFromSearch(user: ReturnType<typeof userEvent.setup>): Promise<boolean[]> {
    const scrolledWhileHidden: boolean[] = [];
    vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(function scroll(this: HTMLElement) {
      if (this.id !== 'settings-control-chat.fontSize') return;
      const sheet = this.closest('[data-testid="workbench-sheet"]');
      const concealed = this.closest('[hidden]') !== null
        || (sheet instanceof HTMLElement && sheet.style.display === 'none');
      scrolledWhileHidden.push(concealed);
    });
    await user.click(screen.getByTestId('dock-search'));
    const palette = await screen.findByPlaceholderText('Search sessions, messages, settings, commands…');
    await user.type(palette, '字号');
    await user.click(await screen.findByRole('button', { name: /^Font size/ }));
    return scrolledWhileHidden;
  }

  it('shows Font size after a Timer search when no Tasks/Repos choice was recorded', async () => {
    const user = userEvent.setup();
    const navigation = installNavigation(null);
    await boot(navigation);
    await deliverSync();
    expect(attr('data-mode')).toBe('tasks');
    expect(attr('data-explicit-list')).toBe('');
    await user.click(await screen.findByTestId('sb-nav-timer'));
    await waitFor(() => expect(attr('data-mode')).toBe('timer'));

    try {
      const scrolledWhileHidden = await openFontSizeFromSearch(user);
      await waitFor(() => expect(attr('data-mode')).toBe('sessions'));
      expect(attr('data-explicit-list')).toBe('');
      const control = await waitFor(() => {
        const anchor = document.getElementById('settings-control-chat.fontSize');
        expect(anchor).not.toBeNull();
        return anchor!;
      });
      const sheet = control!.closest('[data-testid="workbench-sheet"]') as HTMLElement | null;
      expect(sheet).not.toBeNull();
      expect(sheet!.style.display).not.toBe('none');
      expect(control!.closest('[hidden]')).toBeNull();
      await waitFor(() => expect(scrolledWhileHidden.length).toBeGreaterThan(0), { timeout: 3000 });
      expect(scrolledWhileHidden.every(concealed => concealed === false)).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('keeps an explicit Tasks choice when Font size is opened from Timer', async () => {
    const user = userEvent.setup();
    const navigation = installNavigation(null);
    await boot(navigation);
    await deliverSync();
    await user.click(await screen.findByTestId('sb-list-switch'));
    await user.click(await screen.findByTestId('sb-mode-tasks'));
    await waitFor(() => expect(attr('data-explicit-list')).toBe('tasks'));
    await user.click(screen.getByTestId('sb-nav-timer'));
    await waitFor(() => expect(attr('data-mode')).toBe('timer'));

    try {
      const scrolledWhileHidden = await openFontSizeFromSearch(user);
      await waitFor(() => expect(attr('data-mode')).toBe('tasks'));
      expect(attr('data-explicit-list')).toBe('tasks');
      const control = await waitFor(() => {
        const anchor = document.getElementById('settings-control-chat.fontSize');
        expect(anchor).not.toBeNull();
        return anchor!;
      });
      const sheet = control!.closest('[data-testid="workbench-sheet"]') as HTMLElement | null;
      expect(sheet!.style.display).not.toBe('none');
      await waitFor(() => expect(scrolledWhileHidden.length).toBeGreaterThan(0), { timeout: 3000 });
      expect(scrolledWhileHidden.every(concealed => concealed === false)).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
  });

  async function waitForNavigationTrees(): Promise<void> {
    await waitFor(() => {
      expect(requests.some(item => item.url === '/api/working_trees' || item.url.startsWith('/api/working_trees?'))).toBe(true);
      expect(requests.some(item => item.url === '/api/remote/working-trees')).toBe(true);
    });
    await act(async () => { await Promise.resolve(); });
  }

  function workbenchSheet(): HTMLElement {
    const node = document.querySelector('[data-testid="workbench-sheet"]');
    if (!(node instanceof HTMLElement)) throw new Error('missing workbench sheet');
    return node;
  }

  function navigationWorktreeRow(): HTMLElement {
    const row = document.querySelector('[data-wt-id="ws:workspace-nav"]');
    if (!(row instanceof HTMLElement)) throw new Error('missing worktree row');
    return row;
  }

  async function searchNavigationWorktree(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    await user.click(screen.getByTestId('dock-search'));
    const palette = await screen.findByPlaceholderText('Search sessions, messages, settings, commands…');
    await user.type(palette, 'gian-dev-release-0-6-7');
    await user.click(await screen.findByRole('button', { name: /^gian-dev-release-0-6-7/ }));
  }

  function spyWorktreeScrolls(): HTMLElement[] {
    const scrolled: HTMLElement[] = [];
    vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(function scroll(this: HTMLElement) {
      if (this.getAttribute('data-wt-id') === 'ws:workspace-nav') scrolled.push(this);
    });
    return scrolled;
  }

  it('shows the worktree row after a Timer search and scrolls it again when chosen again', async () => {
    world.serveGit = true;
    world.workingTrees = [navigationTree];
    const scrolled = spyWorktreeScrolls();
    try {
      const user = userEvent.setup();
      const navigation = installNavigation(null);
      await boot(navigation);
      await deliverSync();
      await waitForNavigationTrees();
      await user.click(await screen.findByTestId('sb-nav-timer'));
      await waitFor(() => expect(attr('data-mode')).toBe('timer'));
      await searchNavigationWorktree(user);
      await waitFor(() => expect(attr('data-mode')).toBe('sessions'));
      expect(attr('data-explicit-list')).toBe('');
      await waitFor(() => {
        expect(workbenchSheet().style.display).not.toBe('none');
        expect(navigationWorktreeRow().textContent).toContain('gian-dev-release-0-6-7');
      });
      await waitFor(() => expect(scrolled.length).toBeGreaterThan(0));
      expect(scrolled.every(node => node === navigationWorktreeRow())).toBe(true);
      const first = scrolled.length;
      await searchNavigationWorktree(user);
      await waitFor(() => expect(scrolled.length).toBeGreaterThan(first));
      expect(scrolled.at(-1)).toBe(navigationWorktreeRow());
      expect(workbenchSheet().style.display).not.toBe('none');
      expect(attr('data-mode')).toBe('sessions');
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('does not scroll a worktree row that arrives while the sheet is hidden', async () => {
    world.serveGit = true;
    world.workingTrees = [navigationTree];
    holdGitLoads();
    const scrolled = spyWorktreeScrolls();
    try {
      const user = userEvent.setup();
      const navigation = installNavigation(null);
      await boot(navigation);
      await deliverSync();
      await waitForNavigationTrees();
      await user.click(await screen.findByTestId('sb-nav-timer'));
      await waitFor(() => expect(attr('data-mode')).toBe('timer'));
      await searchNavigationWorktree(user);
      await waitFor(() => {
        expect(requests.some(item => item.url === `/api/workspaces/${workspace.id}/branches`)).toBe(true);
        expect(attr('data-mode')).toBe('sessions');
      });
      expect(scrolled).toEqual([]);
      await user.click(screen.getByTestId('sb-nav-timer'));
      await waitFor(() => expect(attr('data-mode')).toBe('timer'));
      expect(workbenchSheet().style.display).toBe('none');
      releaseGitLoads();
      await waitFor(() => expect(document.querySelector('[data-wt-id="ws:workspace-nav"]')).not.toBeNull());
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 80)); });
      expect(workbenchSheet().style.display).toBe('none');
      expect(scrolled).toEqual([]);
      await searchNavigationWorktree(user);
      await waitFor(() => {
        expect(workbenchSheet().style.display).not.toBe('none');
        expect(scrolled.length).toBeGreaterThan(0);
      });
      expect(scrolled.every(node => node.getAttribute('data-wt-id') === 'ws:workspace-nav')).toBe(true);
      expect(navigationWorktreeRow().textContent).toContain('gian-dev-release-0-6-7');
    } finally {
      releaseGitLoads();
      vi.restoreAllMocks();
    }
  });

  it('reveals a worktree hidden behind an open detail panel', async () => {
    world.serveGit = true;
    world.workingTrees = [navigationTree];
    world.sideChatCatalog = true;
    world.sessions = [session({
      id: 'side-host',
      name: 'Side host',
      type: 'subtask',
      task_id: 'task-1',
      available_actions: { 'sidechat.create': { enabled: true } },
    })];
    const scrolled = spyWorktreeScrolls();
    try {
      const user = userEvent.setup();
      const navigation = installNavigation(null);
      await boot(navigation);
      await deliverSync();
      await waitForNavigationTrees();
      await user.click(await screen.findByText('Side host'));
      await expectOpenSession('side-host', 'Side host');
      await searchNavigationWorktree(user);
      await waitFor(() => {
        expect(workbenchSheet().style.display).not.toBe('none');
        expect(navigationWorktreeRow().textContent).toContain('gian-dev-release-0-6-7');
      });
      await waitFor(() => expect(scrolled.length).toBeGreaterThan(0));
      const dock = await screen.findByTestId('dock-sidechat');
      await waitFor(() => expect((dock as HTMLButtonElement).disabled).toBe(false));
      await user.click(dock);
      await waitFor(() => expect(document.querySelector('.chat-context-panel')).not.toBeNull());
      expect(workbenchSheet().style.display).toBe('none');
      const before = scrolled.length;
      await searchNavigationWorktree(user);
      await waitFor(() => {
        expect(document.querySelector('.chat-context-panel')).toBeNull();
        expect(workbenchSheet().style.display).not.toBe('none');
        expect(scrolled.length).toBeGreaterThan(before);
      });
      expect(navigationWorktreeRow().textContent).toContain('gian-dev-release-0-6-7');
      expect(attr('data-mode') === 'tasks' || attr('data-mode') === 'sessions').toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('scrolls Font size only after a delayed anchor is in the visible sheet', async () => {
    let blockFont = true;
    const realGetElementById = document.getElementById.bind(document);
    const concealed: boolean[] = [];
    vi.spyOn(document, 'getElementById').mockImplementation((id: string) => {
      if (blockFont && id === 'settings-control-chat.fontSize') return null;
      return realGetElementById(id);
    });
    vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(function scroll(this: HTMLElement) {
      if (this.id !== 'settings-control-chat.fontSize') return;
      const sheet = this.closest('[data-testid="workbench-sheet"]');
      concealed.push(sheet instanceof HTMLElement && sheet.style.display === 'none');
    });
    try {
      const user = userEvent.setup();
      const navigation = installNavigation(null);
      await boot(navigation);
      await deliverSync();
      await user.click(await screen.findByTestId('sb-nav-timer'));
      await waitFor(() => expect(attr('data-mode')).toBe('timer'));
      await user.click(screen.getByTestId('dock-search'));
      const palette = await screen.findByPlaceholderText('Search sessions, messages, settings, commands…');
      await user.type(palette, '字号');
      await user.click(await screen.findByRole('button', { name: /^Font size/ }));
      await waitFor(() => expect(attr('data-mode')).toBe('sessions'));
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 120)); });
      expect(concealed).toEqual([]);
      blockFont = false;
      await waitFor(() => expect(concealed.length).toBeGreaterThan(0), { timeout: 3000 });
      expect(concealed.every(hidden => hidden === false)).toBe(true);
      expect(realGetElementById('settings-control-chat.fontSize')).not.toBeNull();
      expect(workbenchSheet().style.display).not.toBe('none');
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('cancels a pending Font size scroll when Archive replaces that navigation', async () => {
    let blockFont = true;
    const realGetElementById = document.getElementById.bind(document);
    const fontScrolls: string[] = [];
    vi.spyOn(document, 'getElementById').mockImplementation((id: string) => {
      if (blockFont && id === 'settings-control-chat.fontSize') return null;
      return realGetElementById(id);
    });
    vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(function scroll(this: HTMLElement) {
      if (this.id === 'settings-control-chat.fontSize') fontScrolls.push(this.id);
    });
    try {
      const user = userEvent.setup();
      const navigation = installNavigation(null);
      await boot(navigation);
      await deliverSync();
      await user.click(await screen.findByTestId('sb-nav-timer'));
      await waitFor(() => expect(attr('data-mode')).toBe('timer'));
      await user.click(screen.getByTestId('dock-search'));
      const fontPalette = await screen.findByPlaceholderText('Search sessions, messages, settings, commands…');
      await user.type(fontPalette, '字号');
      await user.click(await screen.findByRole('button', { name: /^Font size/ }));
      await waitFor(() => expect(attr('data-mode')).toBe('sessions'));
      await user.click(screen.getByTestId('dock-search'));
      const archivePalette = await screen.findByPlaceholderText('Search sessions, messages, settings, commands…');
      await user.type(archivePalette, 'Archive');
      await user.click(await screen.findByRole('button', { name: /^Archive/ }));
      await waitFor(() => {
        expect(document.querySelector('.s2-navitem.active')?.textContent).toBe('Archive');
      });
      blockFont = false;
      const chat = [...document.querySelectorAll('.s2-navitem')].find(node => node.textContent === 'Chat');
      expect(chat).toBeTruthy();
      await user.click(chat as HTMLElement);
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 400)); });
      expect(fontScrolls).toEqual([]);
      expect(realGetElementById('settings-control-chat.fontSize')).not.toBeNull();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('does not scroll Font size after leaving the arrived page and coming back', async () => {
    let blockFont = true;
    const realGetElementById = document.getElementById.bind(document);
    const fontScrolls: string[] = [];
    vi.spyOn(document, 'getElementById').mockImplementation((id: string) => {
      if (blockFont && id === 'settings-control-chat.fontSize') return null;
      return realGetElementById(id);
    });
    vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(function scroll(this: HTMLElement) {
      if (this.id === 'settings-control-chat.fontSize') fontScrolls.push(this.id);
    });
    try {
      const user = userEvent.setup();
      const navigation = installNavigation(null);
      await boot(navigation);
      await deliverSync();
      await user.click(await screen.findByTestId('sb-nav-timer'));
      await waitFor(() => expect(attr('data-mode')).toBe('timer'));
      await user.click(screen.getByTestId('dock-search'));
      const palette = await screen.findByPlaceholderText('Search sessions, messages, settings, commands…');
      await user.type(palette, '字号');
      await user.click(await screen.findByRole('button', { name: /^Font size/ }));
      await waitFor(() => expect(attr('data-mode')).toBe('sessions'));
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 80)); });
      expect(fontScrolls).toEqual([]);
      await user.click(screen.getByTestId('sb-nav-timer'));
      await waitFor(() => expect(attr('data-mode')).toBe('timer'));
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 80)); });
      blockFont = false;
      await user.click(await screen.findByTestId('sb-list-switch'));
      await user.click(await screen.findByTestId('sb-mode-project'));
      await waitFor(() => expect(attr('data-mode')).toBe('sessions'));
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 400)); });
      expect(fontScrolls).toEqual([]);
      expect(realGetElementById('settings-control-chat.fontSize')).not.toBeNull();
      expect(workbenchSheet().style.display).not.toBe('none');
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('does not let a Font size scroll survive a same-mode rail change', async () => {
    let blockFont = true;
    const realGetElementById = document.getElementById.bind(document);
    const fontScrolls: string[] = [];
    const livePolls = new Set<number>();
    const realSetTimeout = window.setTimeout.bind(window);
    const realClearTimeout = window.clearTimeout.bind(window);
    vi.spyOn(document, 'getElementById').mockImplementation((id: string) => {
      if (blockFont && id === 'settings-control-chat.fontSize') return null;
      return realGetElementById(id);
    });
    vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(function scroll(this: HTMLElement) {
      if (this.id !== 'settings-control-chat.fontSize') return;
      const sheet = this.closest('[data-testid="workbench-sheet"]');
      fontScrolls.push(sheet instanceof HTMLElement && sheet.style.display === 'none' ? 'hidden' : 'visible');
    });
    vi.spyOn(window, 'setTimeout').mockImplementation((handler, timeout, ...args) => {
      const id = realSetTimeout(() => {
        livePolls.delete(id as number);
        if (typeof handler === 'function') handler(...args);
      }, timeout as number) as unknown as number;
      if (timeout === 50) livePolls.add(id);
      return id;
    });
    vi.spyOn(window, 'clearTimeout').mockImplementation(id => {
      livePolls.delete(id as number);
      realClearTimeout(id as number);
    });
    try {
      const user = userEvent.setup();
      const navigation = installNavigation(null);
      await boot(navigation);
      await deliverSync();
      window.gianDesktop = {
        ...window.gianDesktop!,
        browser: {
          createTab: async () => null,
        } as NonNullable<NonNullable<Window['gianDesktop']>['browser']>,
      };
      await user.click(await screen.findByTestId('sb-list-switch'));
      await user.click(await screen.findByTestId('sb-mode-tasks'));
      await waitFor(() => expect(attr('data-explicit-list')).toBe('tasks'));
      expect(screen.getByTestId('dock-browser')).toBeEnabled();

      await user.click(screen.getByTestId('dock-search'));
      const palette = await screen.findByPlaceholderText('Search sessions, messages, settings, commands…');
      await user.type(palette, '字号');
      await user.click(await screen.findByRole('button', { name: /^Font size/ }));
      await waitFor(() => expect(attr('data-mode')).toBe('tasks'));
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
      expect(livePolls.size).toBeGreaterThan(0);
      expect(fontScrolls).toEqual([]);

      await user.click(screen.getByTestId('dock-browser'));
      expect(attr('data-mode')).toBe('tasks');
      expect(livePolls.size).toBe(0);
      blockFont = false;
      await user.click(screen.getByTestId('dock-settings'));
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 80)); });
      expect(fontScrolls).toEqual([]);
      expect(livePolls.size).toBe(0);
      expect(realGetElementById('settings-control-chat.fontSize')).not.toBeNull();
      expect(workbenchSheet().style.display).not.toBe('none');

      await user.click(screen.getByTestId('dock-search'));
      const again = await screen.findByPlaceholderText('Search sessions, messages, settings, commands…');
      await user.type(again, '字号');
      await user.click(await screen.findByRole('button', { name: /^Font size/ }));
      await waitFor(() => expect(fontScrolls).toEqual(['visible']));
      expect(livePolls.size).toBe(0);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('cancels a Font size scroll when the page is left and re-entered before the poll', async () => {
    let blockFont = true;
    let holdPolls = true;
    const realGetElementById = document.getElementById.bind(document);
    const fontScrolls: string[] = [];
    const held: Array<{ id: number; cleared: boolean; run: () => void }> = [];
    const realSetTimeout = window.setTimeout.bind(window);
    const realClearTimeout = window.clearTimeout.bind(window);
    vi.spyOn(document, 'getElementById').mockImplementation((id: string) => {
      if (blockFont && id === 'settings-control-chat.fontSize') return null;
      return realGetElementById(id);
    });
    vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(function scroll(this: HTMLElement) {
      if (this.id !== 'settings-control-chat.fontSize') return;
      const sheet = this.closest('[data-testid="workbench-sheet"]');
      fontScrolls.push(sheet instanceof HTMLElement && sheet.style.display === 'none' ? 'hidden' : 'visible');
    });
    vi.spyOn(window, 'setTimeout').mockImplementation((handler, timeout, ...args) => {
      if (holdPolls && timeout === 50 && typeof handler === 'function') {
        const id = realSetTimeout(() => {}, 60_000) as unknown as number;
        held.push({ id, cleared: false, run: () => { handler(...args); } });
        return id;
      }
      return realSetTimeout(handler as TimerHandler, timeout as number, ...args);
    });
    vi.spyOn(window, 'clearTimeout').mockImplementation(id => {
      const entry = held.find(item => item.id === (id as number));
      if (entry) entry.cleared = true;
      realClearTimeout(id as number);
    });
    try {
      const user = userEvent.setup();
      const navigation = installNavigation(null);
      await boot(navigation);
      await deliverSync();
      await user.click(await screen.findByTestId('sb-list-switch'));
      await user.click(await screen.findByTestId('sb-mode-tasks'));
      await waitFor(() => expect(attr('data-explicit-list')).toBe('tasks'));

      await user.click(screen.getByTestId('dock-search'));
      const palette = await screen.findByPlaceholderText('Search sessions, messages, settings, commands…');
      await user.type(palette, '字号');
      await user.click(await screen.findByRole('button', { name: /^Font size/ }));
      await waitFor(() => expect(attr('data-mode')).toBe('tasks'));
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
      expect(held.length).toBeGreaterThan(0);
      expect(held.every(entry => entry.cleared)).toBe(false);
      expect(fontScrolls).toEqual([]);

      await user.click(screen.getByTestId('sb-nav-timer'));
      expect(held.every(entry => entry.cleared)).toBe(true);
      expect(livePollCount(held)).toBe(0);
      await user.click(await screen.findByTestId('sb-list-switch'));
      await user.click(await screen.findByTestId('sb-mode-tasks'));
      await waitFor(() => expect(attr('data-mode')).toBe('tasks'));
      blockFont = false;
      expect(workbenchSheet().style.display).not.toBe('none');
      for (const entry of held) entry.run();
      await act(async () => { await Promise.resolve(); });
      expect(fontScrolls).toEqual([]);
      expect(held.every(entry => entry.cleared)).toBe(true);

      holdPolls = false;
      await user.click(screen.getByTestId('dock-search'));
      const again = await screen.findByPlaceholderText('Search sessions, messages, settings, commands…');
      await user.type(again, '字号');
      await user.click(await screen.findByRole('button', { name: /^Font size/ }));
      await waitFor(() => expect(fontScrolls).toEqual(['visible']));
    } finally {
      for (const entry of held) realClearTimeout(entry.id);
      vi.restoreAllMocks();
    }
  });
});

function livePollCount(held: Array<{ cleared: boolean }>): number {
  return held.filter(entry => !entry.cleared).length;
}

/** Issue #1: an Inbox approve/reject must reach the Host with the EXACT
 *  native option id of the pending approval (opaque executor ids, never a
 *  guessed one) plus the expected_inbox occurrence fence. An approval whose
 *  canonical record is not synced must never dispatch — the click opens the
 *  canonical card instead. */
function approvalFixture(id: string, sessionId: string): Approval {
  return {
    id,
    session_id: sessionId,
    turn_id: `turn-${id}`,
    turn_number: 2,
    category: 'command',
    title: 'Run the opaque tool',
    command: 'opaque-tool',
    reason: null,
    status: 'pending',
    native_options: [
      { optionId: `opaque-allow-${id}`, label: 'Proceed', kind: 'allow_once' },
      { optionId: `opaque-deny-${id}`, label: 'Stop', kind: 'reject_once' },
    ],
    resolved_by: null,
    resolved_at: null,
    created_at: '2026-10-12T01:00:00.000Z',
  };
}

function approvalInboxItem(
  itemId: string,
  approvalId: string,
  sessionId: string,
  generation: number,
  title: string,
): InboxItemPublic {
  return makeInboxItem({
    id: itemId,
    source_kind: 'session.approval',
    generation,
    title,
    target: { type: 'session', session_id: sessionId, turn: 2, interaction_id: approvalId },
    display: { kind: 'session.approval', interaction_id: approvalId, category: 'command' },
    actions: ['open', 'approve', 'reject'],
  });
}

function deliverInboxSync(items: InboxItemPublic[], approvals: Approval[]): void {
  const socket = getMockWebSockets()[0]!;
  const sync = stateSyncFixture();
  sync.config.locale = 'en';
  sync.workspaces = [workspace];
  sync.sessions = world.sessions;
  sync.tasks = world.tasks;
  sync.approvals = approvals;
  sync.inbox = {
    inbox_revision: 10,
    pending_count: items.length,
    items,
    truncated: false,
  };
  for (const item of items) inboxRows.set(item.id, item);
  act(() => {
    socket.fakeOpen();
    socket.fakeMessage({ type: 'auth_ok', user: 'fixture-user' });
    socket.fakeMessage(sync);
  });
}

interface ResolveFrame {
  type: string;
  session_id?: string;
  approval_id?: string;
  decision?: string;
  native_option_id?: string;
  expected_inbox?: { id: string; generation: number };
}

function resolveFrames(): ResolveFrame[] {
  return getMockWebSockets()[0]!
    .parsedSent<ResolveFrame>()
    .filter(frame => frame.type === 'approval:resolve');
}

describe('Inbox approval decisions bind the exact native option (issue #1)', () => {
  beforeEach(() => {
    localStorage.clear();
    requests.length = 0;
    inboxRows.clear();
    world.sessions = [];
    world.activeOverride = null;
    world.archived = [];
    world.tasks = [task];
    world.failActive = false;
    world.failArchived = false;
    world.schedules = [];
    world.runs = [];
    world.workingTrees = [];
    world.serveGit = false;
    world.sideChatCatalog = false;
    sessionStorage.clear();
    resetNavigationIntentSequence();
    __resetFeedback();
    __resetInboxForTests();
    __resetPendingApprovals();
    clearComposerCapabilityCaches();
    screenshotListeners.clear();
  });

  afterEach(() => {
    __resetFeedback();
    __resetInboxForTests();
    __resetPendingApprovals();
    inboxRows.clear();
    clearComposerCapabilityCaches();
    sessionStorage.clear();
    delete window.gianDesktop;
  });

  it('approve/reject dispatch approval:resolve with the opaque native option id and the exact expected_inbox', async () => {
    world.sessions = [session({ id: 'session-ap', name: 'Approver' })];
    await boot(installNavigation(null));
    deliverInboxSync(
      [
        approvalInboxItem('inbox-allow', 'ap-allow', 'session-ap', 5, 'Allow opaque tool?'),
        approvalInboxItem('inbox-reject', 'ap-reject', 'session-ap', 7, 'Reject opaque tool?'),
      ],
      [approvalFixture('ap-allow', 'session-ap'), approvalFixture('ap-reject', 'session-ap')],
    );
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('dock-inbox'));
    await user.click(await screen.findByText('Allow opaque tool?'));
    await screen.findByTestId('inbox-detail-inbox-allow');
    await user.click(screen.getByTestId('inbox-action-approve'));
    await waitFor(() => expect(resolveFrames()).toHaveLength(1));
    expect(resolveFrames()[0]).toMatchObject({
      session_id: 'session-ap',
      approval_id: 'ap-allow',
      decision: 'allow_once',
      native_option_id: 'opaque-allow-ap-allow',
      expected_inbox: { id: 'inbox-allow', generation: 5 },
    });

    await user.keyboard('{Escape}');
    await user.click(await screen.findByText('Reject opaque tool?'));
    await screen.findByTestId('inbox-detail-inbox-reject');
    await user.click(screen.getByTestId('inbox-action-reject'));
    await waitFor(() => expect(resolveFrames()).toHaveLength(2));
    expect(resolveFrames()[1]).toMatchObject({
      session_id: 'session-ap',
      approval_id: 'ap-reject',
      decision: 'decline',
      native_option_id: 'opaque-deny-ap-reject',
      expected_inbox: { id: 'inbox-reject', generation: 7 },
    });
  });

  it('an approval with no synced canonical record never dispatches — it opens the card instead', async () => {
    world.sessions = [session({ id: 'session-ap', name: 'Approver' })];
    await boot(installNavigation(null));
    // state_sync carries NO record for ap-unknown: NOT SYNCED must not read
    // as "no native options" — dispatching would reproduce
    // INVALID_APPROVAL_OPTION.
    deliverInboxSync(
      [approvalInboxItem('inbox-unknown', 'ap-unknown', 'session-ap', 3, 'Unsynced approval?')],
      [],
    );
    const user = userEvent.setup();
    await user.click(await screen.findByTestId('dock-inbox'));
    await user.click(await screen.findByText('Unsynced approval?'));
    await screen.findByTestId('inbox-detail-inbox-unknown');
    await user.click(screen.getByTestId('inbox-action-approve'));
    // The click navigates to the owning session's canonical card…
    await waitFor(() => expect(attr('data-session-id')).toBe('session-ap'));
    // …and never sent a decision the Host would reject.
    expect(resolveFrames()).toEqual([]);
  });
});
