import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  GianScreenshotCapture,
  Schedule,
  ScheduleRun,
  Session,
  Task,
  Workspace,
} from '@gian/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/App.js';
import type { GianDesktopNavigationTarget, GianScreenshotApi } from '../src/desktop-bridge.js';
import { __resetFeedback } from '../src/feedback.js';
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
};

const requests: Array<{ method: string; url: string }> = [];
const eventsHold: { current: Promise<void> } = { current: Promise.resolve() };
let releaseEvents = (): void => {};
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
    if (url === '/api/working_trees') return json([]);
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
    screenshotListeners.clear();
    eventsHold.current = Promise.resolve();
    releaseEvents = () => {};
  });

  afterEach(() => {
    releaseActiveLoads();
    releaseEvents();
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

  it('leaves the current selection in place for a missing session and for an archived session', async () => {
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
    expect(await screen.findByText('That session is archived.')).toBeInTheDocument();
    expect(attr('data-session-id')).toBe('keep');
    expect(attr('data-mode')).toBe('tasks');
    expect(attr('data-task-id')).toBe('');
    expect(attr('data-subtask-id')).toBe('');
    expect(screen.queryByTestId('session-row-old')).not.toBeInTheDocument();
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

  it('does not resurrect a session archived while its list lookup was in flight', async () => {
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
    releaseActiveLoads();
    await waitFor(() => expect(screen.getByText('That session is archived.')).toBeInTheDocument());
    expect(screen.queryByText('Stale')).not.toBeInTheDocument();
    expect(attr('data-session-id')).toBe('keep');
    expect(attr('data-mode')).toBe('tasks');
    expect(attr('data-task-id')).toBe('task-1');
    expect(attr('data-subtask-id')).toBe('keep');
    await expectOpenSession('keep', 'Keep');
    expect(requests.some(item => item.url.startsWith('/api/sessions/stale/events'))).toBe(false);
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
      expect(screen.queryByTestId('session-row-alpha')).toBeNull();
      const row = sessionRowInTask('Ship', 'Alpha');
      expect(row).not.toBeNull();
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
      expect(screen.queryByTestId('session-row-alpha')).toBeNull();
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

  it('does not open a session archived in the same turn as the notification', async () => {
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
      socket.fakeMessage({ type: 'session:updated', session: { id: 'stale', archived: 1 } });
      navigation.push(target('stale'));
    });
    await waitFor(() => expect(screen.getByText('That session is archived.')).toBeInTheDocument());
    expect(screen.queryByText('Stale')).not.toBeInTheDocument();
    expect(attr('data-session-id')).toBe('keep');
    expect(attr('data-task-id')).toBe('task-1');
    expect(attr('data-subtask-id')).toBe('keep');
    await expectOpenSession('keep', 'Keep');
    expect(requests.some(item => item.url.startsWith('/api/sessions/stale/events'))).toBe(false);
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
});
