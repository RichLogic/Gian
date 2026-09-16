import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ProductExecutor, UserAgentStatus, Workspace } from '@gian/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../src/api.js';
import { LocaleProvider } from '../src/i18n/index.js';
import { SessionMain } from '../src/views/SessionMain.js';
import { sessionContractFixture } from './fixtures/ws-contract.js';
import { renderWithOperations } from './operation-test-utils.js';

vi.mock('../src/api.js', () => {
  const never = () => new Promise<never>(() => {});
  return {
    loadChanged: never,
    loadProxyModels: never,
    loadProxyCapabilities: never,
    loadSlashCommands: never,
    loadSessionSlashCommands: never,
    loadNativeConfig: never,
    loadAgents: vi.fn(),
    rebindDeletedSessionAgent: vi.fn(),
  };
});

const workspace: Workspace = {
  id: 'workspace-agent-rebind',
  name: 'Agent repair',
  path: '/tmp/agent-repair',
  sort_order: 0,
  hidden: 0,
  pinned: 0,
  created_at: '2026-09-14T00:00:00.000Z',
  updated_at: '2026-09-14T00:00:00.000Z',
};

function agent(id: string, name: string, pluginId: string, proxy: ProductExecutor): UserAgentStatus {
  return {
    id,
    name,
    pluginId,
    proxy,
    home: { kind: 'custom', path: `/Users/test/.${id}` },
    cliPath: null,
    defaults: { model: '', thinking: '', mode: '' },
    proxyName: proxy,
    ready: true,
    cli: { state: 'ready', path: '/runtime/cli', version: '1.0.0', source: 'managed' },
    plugin: {
      state: 'ready', path: '/runtime/proxy', version: '1.0.0', source: 'github-release',
      defaults: { model: '', thinking: '', mode: '' },
    },
    runtimeProfile: null,
    officialInstallUrl: '',
  };
}

function callbacks() {
  return {
    onSend: vi.fn(),
    onSendSkill: vi.fn(),
    onStop: vi.fn(),
    onApprove: vi.fn(),
    onQueueAdd: vi.fn(),
    onQueueRemove: vi.fn(),
    onQueueUpdate: vi.fn(),
    onQueueClear: vi.fn(),
    onQueueSendNow: vi.fn(),
    onSteer: vi.fn(),
    onSetMode: vi.fn(),
    onSetModel: vi.fn(),
    onSetEffort: vi.fn(),
    onSetServiceTier: vi.fn(),
    onSetNativeConfig: vi.fn(),
    onShowLastTurnChanges: vi.fn(),
    onOpenAgents: vi.fn(),
  };
}

function renderDeletedAgentSession(status: 'done' | 'running' = 'done') {
  const handlers = callbacks();
  renderWithOperations(
    <LocaleProvider locale="en">
      <SessionMain
        session={sessionContractFixture({
          id: 'session-deleted-agent',
          status,
          agent_id: 'agent-gone',
          agent_name: 'Deleted Codex',
          proxy_plugin_id: 'codex',
        })}
        workspace={workspace}
        items={[]}
        hydrated
        pending={false}
        queue={[]}
        {...handlers}
      />
    </LocaleProvider>,
  );
  return handlers;
}

describe('deleted Agent conversation recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.rebindDeletedSessionAgent).mockResolvedValue(sessionContractFixture({
      id: 'session-deleted-agent',
      agent_id: 'codex-current',
      agent_name: 'Current Codex',
      proxy_plugin_id: 'codex',
    }));
  });

  it('replaces the inline warning with a same-Proxy Agent chooser', async () => {
    vi.mocked(api.loadAgents).mockResolvedValue([
      agent('codex-current', 'Current Codex', 'codex', 'codex'),
      agent('claude-current', 'Current Claude', 'claude', 'claude'),
    ]);
    renderDeletedAgentSession();

    const dialog = await screen.findByRole('alertdialog', { name: 'Choose another Agent' });
    expect(screen.queryByTestId('agent-deleted-note')).not.toBeInTheDocument();
    expect(within(dialog).getByText('Current Codex')).toBeVisible();
    expect(within(dialog).queryByText('Current Claude')).not.toBeInTheDocument();

    await userEvent.click(within(dialog).getByTestId('deleted-agent-option-codex-current'));
    await waitFor(() => expect(api.rebindDeletedSessionAgent).toHaveBeenCalledWith(
      'session-deleted-agent',
      'codex-current',
    ));
  });

  it('routes to Agent Integrations when no same-Proxy Agent exists', async () => {
    vi.mocked(api.loadAgents).mockResolvedValue([
      agent('claude-current', 'Current Claude', 'claude', 'claude'),
    ]);
    const handlers = renderDeletedAgentSession();

    const dialog = await screen.findByRole('alertdialog', { name: 'Choose another Agent' });
    expect(within(dialog).getByTestId('deleted-agent-empty')).toHaveTextContent(
      'No codex Agent is available',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Open Agent Integrations' }));
    expect(handlers.onOpenAgents).toHaveBeenCalledTimes(1);
  });

  it('does not change Agent identity during an active Turn', async () => {
    vi.mocked(api.loadAgents).mockResolvedValue([
      agent('codex-current', 'Current Codex', 'codex', 'codex'),
    ]);
    renderDeletedAgentSession('running');

    const dialog = await screen.findByRole('alertdialog', { name: 'Choose another Agent' });
    expect(within(dialog).getByTestId('deleted-agent-option-codex-current')).toBeDisabled();
    expect(within(dialog).getByText(/active Turn or Interaction/)).toBeVisible();
    expect(api.rebindDeletedSessionAgent).not.toHaveBeenCalled();
  });
});
