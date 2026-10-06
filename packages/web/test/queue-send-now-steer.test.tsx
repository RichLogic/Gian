// Queue "Send now" follows the Proxy's turn.steer advertisement for every
// Provider, including while initialize capabilities are still loading.

import { act, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RefObject } from 'react';
import type { Session, Workspace } from '@gian/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearComposerCapabilityCaches,
  fetchSteerCached,
} from '../src/components/composer/capabilities.js';
import { useAppShortcuts } from '../src/controllers/use-app-shortcuts.js';
import type { OperationDispatcher } from '../src/operations/dispatcher.js';
import { LocaleProvider } from '../src/i18n/index.js';
import { loadProxyCapabilities } from '../src/api.js';
import { SessionMain } from '../src/views/SessionMain.js';
import type { QueueEntry } from '../src/types.js';
import { sessionContractFixture } from './fixtures/ws-contract.js';

vi.mock('../src/api.js', () => {
  const never = () => new Promise<never>(() => {});
  return {
    loadChanged: never,
    loadProxyModels: never,
    loadProxyCapabilities: vi.fn(async () => ({})),
    loadSlashCommands: never,
    loadSessionSlashCommands: never,
    loadNativeConfig: never,
    loadAgents: async () => [],
  };
});

const workspace: Workspace = {
  id: 'workspace-contract',
  name: 'Contract workspace',
  path: '/tmp/contract-workspace',
  sort_order: 0,
  hidden: 0,
  pinned: 0,
  created_at: '2026-08-08T00:00:00.000Z',
  updated_at: '2026-08-08T00:00:00.000Z',
};

const queued: QueueEntry[] = [{ id: 'queue-1', text: 'queued follow-up' }];

function renderQueue(session: Session) {
  const onQueueSendNow = vi.fn();
  render(
    <LocaleProvider locale="en">
      <SessionMain
        session={session}
        workspace={workspace}
        items={[]}
        hydrated
        pending={false}
        queue={queued}
        onSend={vi.fn()}
        onSendSkill={vi.fn()}
        onStop={vi.fn()}
        onApprove={vi.fn()}
        onQueueAdd={vi.fn()}
        onQueueRemove={vi.fn()}
        onQueueUpdate={vi.fn()}
        onQueueClear={vi.fn()}
        onQueueSendNow={onQueueSendNow}
        onSteer={vi.fn()}
        onSetMode={vi.fn()}
        onSetModel={vi.fn()}
        onSetEffort={vi.fn()}
        onSetServiceTier={vi.fn()}
        onSetNativeConfig={vi.fn()}
        onShowLastTurnChanges={vi.fn()}
      />
    </LocaleProvider>,
  );
  return { onQueueSendNow };
}

function queueDrawer() {
  const drawer = screen.getByText('queued follow-up').closest('.queue-drawer');
  expect(drawer).not.toBeNull();
  return within(drawer as HTMLElement);
}

describe('queue Send now follows turn.steer', () => {
  beforeEach(() => {
    localStorage.clear();
    clearComposerCapabilityCaches();
    vi.mocked(loadProxyCapabilities).mockReset().mockResolvedValue({});
  });

  it('shows Send now for Kimi once turn.steer is advertised', async () => {
    const user = userEvent.setup();
    vi.mocked(loadProxyCapabilities).mockResolvedValue({
      capabilities: { 'turn.steer': 1 },
    });
    const { onQueueSendNow } = renderQueue(sessionContractFixture({
      id: 'kimi-steer',
      executor: 'kimi',
      agent_id: 'agent-kimi',
    }));

    const queueUi = queueDrawer();
    await waitFor(() => {
      expect(queueUi.getByRole('button', { name: 'Send now' })).toBeInTheDocument();
    });
    await user.click(queueUi.getByRole('button', { name: 'Send now' }));
    expect(onQueueSendNow).toHaveBeenCalledTimes(1);
  });

  it('keeps Send now hidden when Kimi does not advertise turn.steer', async () => {
    renderQueue(sessionContractFixture({
      id: 'kimi-plain',
      executor: 'kimi',
      agent_id: 'agent-kimi-plain',
    }));

    await waitFor(() => {
      expect(vi.mocked(loadProxyCapabilities)).toHaveBeenCalled();
    });
    expect(queueDrawer().queryByRole('button', { name: 'Send now' })).not.toBeInTheDocument();
  });

  it('keeps Send now hidden on a completed Kimi session even when steer is advertised', async () => {
    vi.mocked(loadProxyCapabilities).mockResolvedValue({
      capabilities: { 'turn.steer': 1 },
    });
    renderQueue(sessionContractFixture({
      id: 'kimi-completed',
      executor: 'kimi',
      agent_id: 'agent-kimi-completed',
      completed_at: '2026-08-08T01:00:00.000Z',
    }));

    await waitFor(() => {
      expect(vi.mocked(loadProxyCapabilities)).toHaveBeenCalled();
    });
    expect(queueDrawer().queryByRole('button', { name: 'Send now' })).not.toBeInTheDocument();
  });
});

describe('queue.sendNow shortcut follows turn.steer', () => {
  beforeEach(() => {
    clearComposerCapabilityCaches();
    vi.mocked(loadProxyCapabilities).mockReset().mockResolvedValue({});
  });

  it('dispatches for a Kimi session after turn.steer is advertised', async () => {
    vi.mocked(loadProxyCapabilities).mockResolvedValue({
      capabilities: { 'turn.steer': 1 },
    });
    const session = sessionContractFixture({
      id: 'kimi-shortcut',
      executor: 'kimi',
      agent_id: 'agent-kimi-shortcut',
    });
    const dispatch = renderShortcuts(session);
    await fetchSteerCached(session.executor, session.agent_id);

    const event = pressSendNow();

    expect(event.defaultPrevented).toBe(true);
    expect(dispatch).toHaveBeenCalledWith('queue.sendNow', { sessionId: session.id });
  });

  it('does not dispatch for Kimi when turn.steer is absent', async () => {
    const session = sessionContractFixture({
      id: 'kimi-no-steer',
      executor: 'kimi',
      agent_id: 'agent-kimi-no-steer',
    });
    const dispatch = renderShortcuts(session);
    await fetchSteerCached(session.executor, session.agent_id);

    const event = pressSendNow();

    expect(event.defaultPrevented).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });
});

function renderShortcuts(session: Session) {
  const dispatch = vi.fn();
  const sessionsRef = { current: [session] } as RefObject<Session[]>;
  const ops = {
    dispatch,
    dispose: vi.fn(),
    store: {},
  } as unknown as OperationDispatcher;
  renderHook(() => useAppShortcuts({
    authenticated: true,
    activeSessionId: session.id,
    sessionsRef,
    ops,
    paletteOpen: false,
    setPaletteOpen: vi.fn(),
  }));
  return dispatch;
}

function pressSendNow(): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'Enter',
    metaKey: true,
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    document.dispatchEvent(event);
  });
  return event;
}
