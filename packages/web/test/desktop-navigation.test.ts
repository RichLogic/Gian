import { describe, expect, it, vi } from 'vitest';
import type {
  GianDesktopNavigationApi,
  GianDesktopNavigationTarget,
} from '../src/desktop-bridge.js';
import { resolveSessionNavigation, subscribeDesktopNavigation, workbenchListMode } from '../src/desktop-navigation.js';

const targetA: GianDesktopNavigationTarget = {
  type: 'session',
  sessionId: 'session-a',
  turn: 1,
  kind: 'turn-completed',
};
const targetB: GianDesktopNavigationTarget = {
  type: 'session',
  sessionId: 'session-b',
  turn: 2,
  kind: 'approval',
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(next => { resolve = next; });
  return { promise, resolve };
}

describe('desktop navigation handshake', () => {
  it('drops a stale ready target after a newer live click arrives', async () => {
    const ready = deferred<GianDesktopNavigationTarget | null>();
    let live: ((target: GianDesktopNavigationTarget) => void) | null = null;
    const acknowledge = vi.fn(async () => true);
    const navigation: GianDesktopNavigationApi = {
      ready: () => ready.promise,
      acknowledge,
      onTarget: listener => {
        live = listener;
        return () => { live = null; };
      },
    };
    const handled: GianDesktopNavigationTarget[] = [];
    const unsubscribe = subscribeDesktopNavigation(navigation, target => handled.push(target));

    (live as (target: GianDesktopNavigationTarget) => void)(targetB);
    ready.resolve(targetA);
    await ready.promise;
    await Promise.resolve();

    expect(handled).toEqual([targetB]);
    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(acknowledge).toHaveBeenCalledWith(targetB);
    unsubscribe();
  });

  it('consumes a cold-start target once and ignores it after disposal', async () => {
    const firstReady = deferred<GianDesktopNavigationTarget | null>();
    const acknowledge = vi.fn(async () => true);
    const navigation: GianDesktopNavigationApi = {
      ready: () => firstReady.promise,
      acknowledge,
      onTarget: () => () => undefined,
    };
    const handled: GianDesktopNavigationTarget[] = [];
    subscribeDesktopNavigation(navigation, target => handled.push(target));
    firstReady.resolve(targetA);
    await firstReady.promise;
    await Promise.resolve();
    expect(handled).toEqual([targetA]);

    const lateReady = deferred<GianDesktopNavigationTarget | null>();
    const lateNavigation = { ...navigation, ready: () => lateReady.promise };
    const unsubscribe = subscribeDesktopNavigation(lateNavigation, target => handled.push(target));
    unsubscribe();
    lateReady.resolve(targetB);
    await lateReady.promise;
    await Promise.resolve();
    expect(handled).toEqual([targetA]);
  });

  it('holds a target that arrives before the session snapshot and delivers it once', async () => {
    const ready = deferred<GianDesktopNavigationTarget | null>();
    const acknowledge = vi.fn(async () => true);
    const navigation: GianDesktopNavigationApi = {
      ready: () => ready.promise,
      acknowledge,
      onTarget: () => () => undefined,
    };
    const handled: GianDesktopNavigationTarget[] = [];
    let snapshotReady = false;
    const retry: { retry: (() => void) | null } = { retry: null };
    subscribeDesktopNavigation(navigation, target => {
      if (!snapshotReady) return 'pending';
      handled.push(target);
      return 'settled';
    }, retry);
    ready.resolve(targetA);
    await ready.promise;
    await Promise.resolve();
    expect(handled).toEqual([]);
    expect(acknowledge).not.toHaveBeenCalled();

    snapshotReady = true;
    retry.retry?.();
    await Promise.resolve();
    expect(handled).toEqual([targetA]);
    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(acknowledge).toHaveBeenCalledWith(targetA);
  });

  it('lets a newer click replace an older ready target that is still waiting', async () => {
    const ready = deferred<GianDesktopNavigationTarget | null>();
    let live: ((target: GianDesktopNavigationTarget) => void) | null = null;
    const acknowledge = vi.fn(async () => true);
    const navigation: GianDesktopNavigationApi = {
      ready: () => ready.promise,
      acknowledge,
      onTarget: listener => {
        live = listener;
        return () => { live = null; };
      },
    };
    const handled: GianDesktopNavigationTarget[] = [];
    let snapshotReady = false;
    const retry: { retry: (() => void) | null } = { retry: null };
    subscribeDesktopNavigation(navigation, target => {
      if (!snapshotReady) return 'pending';
      handled.push(target);
      return 'settled';
    }, retry);

    ready.resolve(targetA);
    await ready.promise;
    await Promise.resolve();
    (live as (target: GianDesktopNavigationTarget) => void)(targetB);
    await Promise.resolve();
    expect(handled).toEqual([]);
    expect(acknowledge).not.toHaveBeenCalled();

    snapshotReady = true;
    retry.retry?.();
    await Promise.resolve();
    expect(handled).toEqual([targetB]);
    expect(acknowledge).toHaveBeenCalledTimes(1);
    expect(acknowledge).toHaveBeenCalledWith(targetB);
  });
});

describe('resolveSessionNavigation (in-place jump)', () => {
  it('selects in place inside the Repos (sessions) view', () => {
    expect(resolveSessionNavigation(
      { sessionId: 's1' },
      { mode: 'sessions', session: { task_id: 'task-9' } },
    )).toEqual({ kind: 'select-in-sessions', sessionId: 's1' });
  });

  it('opens a task-bound session as the active Subtask inside the Tasks view', () => {
    expect(resolveSessionNavigation(
      { sessionId: 's1' },
      { mode: 'tasks', session: { task_id: 'task-9' } },
    )).toEqual({ kind: 'select-subtask-in-tasks', taskId: 'task-9', sessionId: 's1' });
  });

  it('opens a standalone session in the Tasks view without clearing the view', () => {
    expect(resolveSessionNavigation(
      { sessionId: 's1' },
      { mode: 'tasks', session: { task_id: null } },
    )).toEqual({ kind: 'select-standalone-in-tasks', sessionId: 's1' });
    expect(resolveSessionNavigation(
      { sessionId: 's1' },
      { mode: 'tasks', session: { task_id: '' } },
    )).toEqual({ kind: 'select-standalone-in-tasks', sessionId: 's1' });
  });

  it('reports a missing or archived session as unavailable in every surface', () => {
    for (const mode of ['sessions', 'tasks', 'agents', 'timer', 'custom', 'spaces'] as const) {
      expect(resolveSessionNavigation(
        { sessionId: 's1' },
        { mode, explicitListMode: 'tasks', session: null },
      )).toEqual({ kind: 'unavailable', sessionId: 's1', reason: 'missing' });
      expect(resolveSessionNavigation(
        { sessionId: 's1' },
        { mode, session: { task_id: null, archived: 1 } },
      )).toEqual({ kind: 'unavailable', sessionId: 's1', reason: 'archived' });
      expect(resolveSessionNavigation(
        { sessionId: 's1' },
        { mode, session: { task_id: 'task-9', archived: 1 } },
      )).toEqual({ kind: 'unavailable', sessionId: 's1', reason: 'archived' });
    }
  });

  it('opens an archived session read-only only for deep links that opted in', () => {
    // Search/Inbox/notification deep links (Issue #168): archived targets
    // select like active sessions; the transcript renders read-only.
    expect(resolveSessionNavigation(
      { sessionId: 's1' },
      { mode: 'sessions', session: { task_id: null, archived: 1 }, allowArchivedReadOnly: true },
    )).toEqual({ kind: 'select-in-sessions', sessionId: 's1' });
    expect(resolveSessionNavigation(
      { sessionId: 's1' },
      { mode: 'tasks', session: { task_id: 'task-9', archived: 1 }, allowArchivedReadOnly: true },
    )).toEqual({ kind: 'select-subtask-in-tasks', taskId: 'task-9', sessionId: 's1' });
    // Without the opt-in, archived stays unavailable (existing behavior).
    expect(resolveSessionNavigation(
      { sessionId: 's1' },
      { mode: 'sessions', session: { task_id: null, archived: 1 }, allowArchivedReadOnly: false },
    )).toEqual({ kind: 'unavailable', sessionId: 's1', reason: 'archived' });
  });

  it('falls back to Repos from non-conversation pages only when no list was chosen', () => {
    for (const mode of ['spaces', 'agents', 'timer', 'custom'] as const) {
      expect(resolveSessionNavigation(
        { sessionId: 's1' },
        { mode, session: { task_id: 'task-9' } },
      )).toEqual({ kind: 'fallback-sessions', sessionId: 's1' });
      expect(resolveSessionNavigation(
        { sessionId: 's1' },
        { mode, explicitListMode: null, session: { task_id: null } },
      )).toEqual({ kind: 'fallback-sessions', sessionId: 's1' });
    }
  });

  it('uses the explicit Repos or Tasks choice from non-conversation pages', () => {
    expect(resolveSessionNavigation(
      { sessionId: 's1' },
      { mode: 'agents', explicitListMode: 'tasks', session: { task_id: 'task-9' } },
    )).toEqual({ kind: 'select-subtask-in-tasks', taskId: 'task-9', sessionId: 's1' });
    expect(resolveSessionNavigation(
      { sessionId: 's1' },
      { mode: 'timer', explicitListMode: 'tasks', session: { task_id: null, archived: 0 } },
    )).toEqual({ kind: 'select-standalone-in-tasks', sessionId: 's1' });
    expect(resolveSessionNavigation(
      { sessionId: 's1' },
      { mode: 'custom', explicitListMode: 'sessions', session: { task_id: 'task-9' } },
    )).toEqual({ kind: 'select-in-sessions', sessionId: 's1' });
  });

  it('keeps the current Tasks or Repos view ahead of an older explicit choice', () => {
    expect(resolveSessionNavigation(
      { sessionId: 's1' },
      { mode: 'tasks', explicitListMode: 'sessions', session: { task_id: 'task-9' } },
    )).toEqual({ kind: 'select-subtask-in-tasks', taskId: 'task-9', sessionId: 's1' });
    expect(resolveSessionNavigation(
      { sessionId: 's1' },
      { mode: 'tasks', explicitListMode: 'sessions', session: { task_id: null } },
    )).toEqual({ kind: 'select-standalone-in-tasks', sessionId: 's1' });
    expect(resolveSessionNavigation(
      { sessionId: 's1' },
      { mode: 'sessions', explicitListMode: 'tasks', session: { task_id: 'task-9' } },
    )).toEqual({ kind: 'select-in-sessions', sessionId: 's1' });
  });

  it('lets a clicked list choose the surface from a non-conversation page', () => {
    expect(resolveSessionNavigation(
      { sessionId: 's1' },
      {
        mode: 'agents',
        explicitListMode: null,
        requestedListMode: 'tasks',
        session: { task_id: 'task-9' },
      },
    )).toEqual({ kind: 'select-subtask-in-tasks', taskId: 'task-9', sessionId: 's1' });
    expect(resolveSessionNavigation(
      { sessionId: 's1' },
      {
        mode: 'timer',
        explicitListMode: 'tasks',
        requestedListMode: 'sessions',
        session: { task_id: 'task-9' },
      },
    )).toEqual({ kind: 'select-in-sessions', sessionId: 's1' });
  });
});

describe('workbenchListMode', () => {
  it('uses Repos from Timer, Agents, and Custom when no list was chosen', () => {
    for (const mode of ['timer', 'agents', 'custom'] as const) {
      expect(workbenchListMode({ mode, explicitListMode: null })).toBe('sessions');
    }
  });

  it('keeps an explicit Tasks or Repos choice from a non-conversation page', () => {
    expect(workbenchListMode({ mode: 'timer', explicitListMode: 'tasks' })).toBe('tasks');
    expect(workbenchListMode({ mode: 'timer', explicitListMode: 'sessions' })).toBe('sessions');
    expect(workbenchListMode({ mode: 'agents', explicitListMode: 'tasks' })).toBe('tasks');
  });

  it('keeps the current Tasks or Repos page ahead of an older explicit choice', () => {
    expect(workbenchListMode({ mode: 'tasks', explicitListMode: 'sessions' })).toBe('tasks');
    expect(workbenchListMode({ mode: 'sessions', explicitListMode: 'tasks' })).toBe('sessions');
  });
});
