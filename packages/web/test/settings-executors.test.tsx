import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentInstallStatus,
  Executor,
  ProxyCapabilities,
  SystemConfig,
} from '@gian/shared';
import { SettingsBody } from '../src/components/SettingsBody.js';
import * as api from '../src/api.js';

vi.mock('../src/api.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api.js')>('../src/api.js');
  return {
    ...actual,
    loadAgents: vi.fn(),
    loadProxyCapabilities: vi.fn(),
    setAgentProxyDefaults: vi.fn(),
  };
});

function config(): SystemConfig {
  return {
    host: '127.0.0.1',
    port: 8991,
    workspace_root: '~/Coding',
    theme: 'warm',
    accent: 'ember',
    density: 'cozy',
    locale: 'en',
    font_scale_chrome: 'md',
    font_scale_chat: 'md',
    font_scale_code: 'md',
    default_claude_model: '',
    default_claude_effort: '',
    default_codex_model: '',
    default_codex_effort: '',
    default_task_executor: 'claude',
    auth_username: '',
    external_editors: [],
  };
}

function agent(id: Executor, name: string): AgentInstallStatus {
  return {
    id,
    name,
    ready: true,
    cli: { state: 'ready', path: `/bin/${id}`, version: '1.0.0', source: 'path' },
    proxy: {
      state: 'ready',
      path: `/proxy/${id}`,
      version: '0.1.0',
      source: 'development',
      defaults: id === 'kimi'
        ? { model: '', thinking: '', mode: '' }
        : { model: `${id}-model`, thinking: 'high', mode: 'ask' },
    },
    officialInstallUrl: 'https://example.invalid',
  };
}

function capabilities(id: Executor): ProxyCapabilities {
  if (id === 'kimi') {
    return {
      protocolVersion: 'acp/1',
      models: [],
      modes: [],
      slashCommands: [],
      sessionCapabilities: { load: true, list: true, resume: true, close: false },
    };
  }
  const model = {
    id: `${id}-model`,
    model: `${id}-model`,
    displayName: `${id} model`,
    description: '',
    hidden: false,
    isDefault: true,
  };
  return id === 'claude'
    ? {
        protocolVersion: '0.1.0',
        models: [{ ...model, defaultEffort: 'high', supportedEfforts: ['high', 'xhigh'] }],
        modes: [
          { id: 'ask', label: 'Ask', description: '', isDefault: true },
          { id: 'auto', label: 'Auto', description: '', isDefault: false },
        ],
        slashCommands: [],
      }
    : {
        protocolVersion: '0.1.0',
        models: [{ ...model, defaultThinking: 'high', supportedThinking: ['high', 'xhigh'] }],
        modes: [
          { id: 'ask', label: 'Ask', description: '', isDefault: true },
          { id: 'auto', label: 'Auto', description: '', isDefault: false },
        ],
        slashCommands: [],
      };
}

describe('SettingsBody Executors', () => {
  const agents = [
    agent('claude', 'Claude Code'),
    agent('codex', 'Codex'),
    agent('kimi', 'Kimi Code'),
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.loadAgents).mockResolvedValue(agents);
    vi.mocked(api.loadProxyCapabilities).mockImplementation(async id => capabilities(id));
    vi.mocked(api.setAgentProxyDefaults).mockImplementation(async id => agent(
      id,
      id === 'claude' ? 'Claude Code' : id === 'codex' ? 'Codex' : 'Kimi Code',
    ));
  });

  it('renders exactly three cards with Proxy-owned defaults inside each card', async () => {
    render(<SettingsBody config={config()} activeSection="executors" onChange={() => {}} />);

    await waitFor(() => expect(screen.getAllByText('Claude Code')).toHaveLength(1));
    expect(screen.getAllByText('Codex')).toHaveLength(2); // card + task PM choice
    expect(screen.getAllByText('Kimi Code')).toHaveLength(1);
    await waitFor(() => expect(screen.getAllByRole('combobox')).toHaveLength(6));
    expect(screen.getByText('Configured per session by the Proxy')).toBeTruthy();
  });

  it('persists Mode through the Agent Proxy defaults endpoint', async () => {
    render(<SettingsBody config={config()} activeSection="executors" onChange={() => {}} />);
    const heading = await screen.findByText('Claude Code');
    const card = heading.closest('.exec-row');
    expect(card).toBeTruthy();
    await waitFor(() => {
      expect(within(card as HTMLElement).getAllByRole('combobox')).toHaveLength(3);
    });
    const selects = within(card as HTMLElement).getAllByRole('combobox');
    fireEvent.change(selects[2]!, { target: { value: 'auto' } });

    await waitFor(() => {
      expect(api.setAgentProxyDefaults).toHaveBeenCalledWith('claude', { mode: 'auto' });
    });
  });
});
