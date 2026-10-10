/**
 * Remote Control session markers: the sidebar row shows a globe-code badge
 * for sessions executing on a paired remote environment, flipping to globe-x
 * when the Host reports that environment disconnected (WS `remote:environments`
 * push, lazy REST hydration, state_sync re-fetch). Unknown/unhydrated
 * environments always read as connected — the disconnected glyph never shows
 * on a guess. The hover card's repo row and the header breadcrumb's
 * environment segment carry a neutral globe marker.
 */
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import type { ServerToClientMessage, Session } from '@gian/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider } from '../src/i18n/index.js';
import { SessionHoverCard, SessionRow } from '../src/components/SessionsSidebar.js';
import { PathBreadcrumb } from '../src/components/PathBreadcrumb.js';
import { useAppSocket } from '../src/controllers/use-app-socket.js';
import { __resetScheduleBadgeForTest } from '../src/controllers/use-schedules.js';
import {
  __resetRemoteEnvironmentsForTest,
  applyRemoteEnvironmentsSnapshot,
  useRemoteEnvironmentConnected,
} from '../src/controllers/use-remote-environments.js';
import { createOperationStore } from '../src/operations/store.js';
import type { OperationDispatcher } from '../src/operations/dispatcher.js';
import type { GianWs, WsListener, WsStateListener } from '../src/ws.js';
import { mockFetch } from './setup.js';

vi.mock('../src/api.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/api.js')>();
  return {
    ...actual,
    loadSessions: vi.fn(async () => []),
    loadTasks: vi.fn(async () => []),
    loadWorkspaces: vi.fn(async () => []),
  };
});

const localSession = {
  id: 'session-local',
  name: 'Local chat',
  workspace_id: 'ws-1',
  task_id: null,
  type: 'coding',
  executor: 'codex',
  status: 'done',
  unread: 0,
  archived: 0,
  pinned_at: null,
  completed_at: null,
  updated_at: '2026-10-01T08:00:00.000Z',
} as Session;

const remoteSession = {
  ...localSession,
  id: 'session-remote',
  name: 'test Remote',
  workspace_id: null,
  remote_execution: {
    environment_id: 'env-1',
    environment_name: 'Build box',
    host_id: 'host-1',
    remote_session_id: 'remote-1',
    repository_id: 'repo-1',
    repository_name: 'api',
  },
} as Session;

function environment(connected: boolean, id = 'env-1') {
  return { id, name: 'Build box', host_id: 'host-1', server_origin: 'https://remote.test', pending: false, connected };
}

function mockRemoteEnvironments(environments: Array<ReturnType<typeof environment>>) {
  mockFetch(async input => {
    const url = String(input);
    if (url.startsWith('/api/remote/environments')) {
      return new Response(JSON.stringify({ environments }), { status: 200 });
    }
    if (url.startsWith('/api/schedules')) {
      return new Response(JSON.stringify({ schedules: [], next_cursor: null }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
}

function renderRow(session: Session) {
  return render(
    <LocaleProvider locale="en">
      <SessionRow session={session} active={false} onSelect={() => {}} onPin={() => {}} onArchive={() => {}} />
    </LocaleProvider>,
  );
}

describe('SessionRow remote badge', () => {
  beforeEach(() => {
    __resetScheduleBadgeForTest();
    __resetRemoteEnvironmentsForTest();
  });

  it('shows globe-code for a remote session once its environment is known connected', async () => {
    mockRemoteEnvironments([environment(true)]);
    renderRow(remoteSession);

    const badge = await screen.findByTestId(`session-remote-${remoteSession.id}`);
    expect(badge).toHaveClass('ri-remote-badge');
    await waitFor(() => expect(badge).toHaveAttribute('title', 'Runs on a remote environment'));
    expect(badge).not.toHaveClass('disconnected');
    // Placement: inside .ri-row1, immediately before the title (gutter glyph).
    expect(badge.parentElement?.classList.contains('ri-row1')).toBe(true);
    expect(badge.nextElementSibling?.classList.contains('ri-title')).toBe(true);
    // A local session reserves no gutter slot.
    expect(screen.queryByTestId(`session-remote-${localSession.id}`)).toBeNull();
  });

  it('flips to globe-x when the environment is disconnected, and back on recovery', async () => {
    mockRemoteEnvironments([environment(false)]);
    renderRow(remoteSession);

    const badge = await screen.findByTestId(`session-remote-${remoteSession.id}`);
    await waitFor(() => expect(badge).toHaveClass('disconnected'));
    expect(badge).toHaveAttribute('title', 'Remote environment disconnected');

    act(() => applyRemoteEnvironmentsSnapshot([environment(true)]));
    await waitFor(() => expect(badge).not.toHaveClass('disconnected'));
    expect(badge).toHaveAttribute('title', 'Runs on a remote environment');
  });

  it('never shows globe-x for unknown or unhydrated environments', async () => {
    // Hydrated, but the session's environment is absent from the snapshot.
    mockRemoteEnvironments([environment(false, 'env-other')]);
    renderRow(remoteSession);

    const badge = await screen.findByTestId(`session-remote-${remoteSession.id}`);
    await waitFor(() => expect(badge).toHaveAttribute('title', 'Runs on a remote environment'));
    expect(badge).not.toHaveClass('disconnected');
  });
});

describe('SessionHoverCard remote repo row', () => {
  beforeEach(() => {
    __resetRemoteEnvironmentsForTest();
  });

  const rect = { right: 120, top: 40 } as DOMRect;
  const cardProps = { rect, keepOpen: () => {}, scheduleClose: () => {}, close: () => {} };

  it('prepends a globe to the repo row for remote sessions only', () => {
    mockRemoteEnvironments([]);
    render(
      <LocaleProvider locale="en">
        <SessionHoverCard session={remoteSession} {...cardProps} />
        <SessionHoverCard session={localSession} workspaceName="Gian-Dev" {...cardProps} />
      </LocaleProvider>,
    );
    const remoteCard = screen.getByTestId(`session-hover-card-${remoteSession.id}`);
    const remoteIcons = remoteCard.querySelectorAll('.shc-repo svg');
    expect(remoteIcons).toHaveLength(2);
    const localCard = screen.getByTestId(`session-hover-card-${localSession.id}`);
    expect(localCard.querySelectorAll('.shc-repo svg')).toHaveLength(1);
  });
});

describe('PathBreadcrumb remote environment segment', () => {
  it('marks a remote environment segment with a globe icon', () => {
    const { container } = render(
      <LocaleProvider locale="en">
        <PathBreadcrumb segments={[
          { kind: 'environment', label: 'Build box', remote: true },
          { kind: 'workspace', label: 'api' },
          { kind: 'session', label: 'test Remote' },
        ]} />
      </LocaleProvider>,
    );
    expect(screen.getByTestId('path-seg-remote').querySelector('[data-icon="globe"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-icon="globe"]')).toHaveLength(1);
  });

  it('renders no globe for the local environment segment', () => {
    render(
      <LocaleProvider locale="en">
        <PathBreadcrumb segments={[
          { kind: 'environment', label: 'This Mac' },
          { kind: 'workspace', label: 'Gian-Dev' },
        ]} />
      </LocaleProvider>,
    );
    expect(screen.queryByTestId('path-seg-remote')).toBeNull();
  });
});

class FakeWs {
  private listeners = new Set<WsListener>();

  connect = vi.fn();
  disconnect = vi.fn();
  send = vi.fn();

  onMessage(listener: WsListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onState(listener: WsStateListener): () => void {
    listener('closed', 0);
    return () => {};
  }

  emit(message: ServerToClientMessage): void {
    for (const listener of this.listeners) listener(message);
  }
}

function setupSocket() {
  const ws = new FakeWs();
  const operationStore = createOperationStore();
  const ops = { dispatch: vi.fn() } as unknown as OperationDispatcher;
  renderHook(() => {
    const [, setPendingBySession] = useState<Record<string, boolean>>({});
    useAppSocket({
      authStatus: 'authenticated',
      ws: ws as unknown as GianWs,
      sessionsRef: { current: [] },
      itemsBySessionRef: { current: {} },
      activeSessionIdRef: { current: null },
      pendingFirstMessageRef: { current: null },
      setWsState: vi.fn(),
      setWsAttempt: vi.fn(),
      setAuthed: vi.fn(),
      setWorkspaces: vi.fn(),
      setSessions: vi.fn(),
      setSideChats: vi.fn(),
      sideChatsRef: { current: [] },
      setItemsBySidechat: vi.fn(),
      setPendingBySidechat: vi.fn(),
      setTasks: vi.fn(),
      setSystemConfig: vi.fn(),
      setRunner: vi.fn(),
      setActiveSessionId: vi.fn(),
      setActiveTaskId: vi.fn(),
      setActiveSubtaskId: vi.fn(),
      setItemsBySession: vi.fn(),
      setPendingBySession,
      setQueueBySession: vi.fn(),
      setPlanStateBySession: vi.fn(),
      markSessionHistoryLive: vi.fn(),
      rebuildSessionHistory: vi.fn(),
      operationStore,
      ops,
    });
  });
  return { ws };
}

function stateSync(): ServerToClientMessage {
  return {
    type: 'state_sync',
    runner: {},
    sessions: [],
    workspaces: [],
    tasks: [],
    approvals: [],
    config: {},
  } as unknown as ServerToClientMessage;
}

describe('useAppSocket remote:environments wiring', () => {
  beforeEach(() => {
    __resetRemoteEnvironmentsForTest();
  });

  it('applies remote:environments pushes to the connectivity store', async () => {
    mockRemoteEnvironments([]);
    const { ws } = setupSocket();
    const probe = renderHook(() => useRemoteEnvironmentConnected('env-1'));
    await waitFor(() => expect(probe.result.current).toBeUndefined());

    act(() => ws.emit({ type: 'remote:environments', environments: [environment(false)] }));
    expect(probe.result.current).toBe(false);

    act(() => ws.emit({ type: 'remote:environments', environments: [environment(true)] }));
    expect(probe.result.current).toBe(true);
  });

  it('re-fetches environments on state_sync', async () => {
    let fetches = 0;
    mockFetch(async input => {
      const url = String(input);
      if (url.startsWith('/api/remote/environments')) {
        fetches += 1;
        return new Response(JSON.stringify({ environments: [environment(true)] }), { status: 200 });
      }
      return new Response(JSON.stringify({ schedules: [], next_cursor: null }), { status: 200 });
    });
    const { ws } = setupSocket();
    // Nobody subscribed yet — state_sync alone must re-pull the snapshot.
    act(() => ws.emit(stateSync()));
    await waitFor(() => expect(fetches).toBe(1));
  });
});
