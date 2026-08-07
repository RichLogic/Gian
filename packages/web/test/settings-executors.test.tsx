import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentInstallStatus,
  Executor,
  ProxyCapabilities,
  SystemConfig,
} from '@gian/shared';
import { SettingsBody } from '../src/components/SettingsBody.js';
import { renderWithOperations } from './operation-test-utils.js';
import { Toaster } from '../src/components/Toaster.js';
import { __resetFeedback } from '../src/feedback.js';
import * as api from '../src/api.js';

vi.mock('../src/api.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api.js')>('../src/api.js');
  return {
    ...actual,
    loadAgents: vi.fn(),
    loadProxyCapabilities: vi.fn(),
    setAgentCliPath: vi.fn(),
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
    delete window.gianDesktop;
    vi.mocked(api.loadAgents).mockResolvedValue(agents);
    vi.mocked(api.loadProxyCapabilities).mockImplementation(async id => capabilities(id));
    vi.mocked(api.setAgentCliPath).mockImplementation(async id => agent(
      id,
      id === 'claude' ? 'Claude Code' : id === 'codex' ? 'Codex' : 'Kimi Code',
    ));
    vi.mocked(api.setAgentProxyDefaults).mockImplementation(async id => agent(
      id,
      id === 'claude' ? 'Claude Code' : id === 'codex' ? 'Codex' : 'Kimi Code',
    ));
  });

  afterEach(() => {
    __resetFeedback();
  });

  function renderSettingsWithToaster() {
    return renderWithOperations(
      <>
        <SettingsBody config={config()} activeSection="executors" />
        <Toaster />
      </>,
    );
  }

  it('renders exactly three cards with Proxy-owned defaults inside each card', async () => {
    renderWithOperations(<SettingsBody config={config()} activeSection="executors" />);

    await waitFor(() => expect(screen.getAllByText('Claude Code')).toHaveLength(1));
    expect(screen.getAllByText('Codex')).toHaveLength(1);
    expect(screen.getAllByText('Kimi Code')).toHaveLength(1);
    // Claude + Codex: model, thinking/effort, mode. Kimi advertises no
    // models/modes, so it renders no defaults rows at all (2026-08-04).
    await waitFor(() => expect(screen.getAllByRole('combobox')).toHaveLength(6));
    const kimiCard = screen.getByText('Kimi Code').closest('.exec-row') as HTMLElement;
    expect(within(kimiCard).queryByRole('combobox')).toBeNull();
  });

  it('renders a Mode picker for Kimi when the proxy advertises modes (ACP probe, 2026-08-04)', async () => {
    vi.mocked(api.loadProxyCapabilities).mockImplementation(async id => (
      id === 'kimi'
        ? {
            protocolVersion: 'acp/1',
            models: [],
            modes: [
              { id: 'default', label: 'Default', description: '', isDefault: true },
              { id: 'plan', label: 'Plan', description: '', isDefault: false },
              { id: 'auto', label: 'Auto', description: '', isDefault: false },
              { id: 'yolo', label: 'YOLO', description: '', isDefault: false },
            ],
            slashCommands: [],
            sessionCapabilities: { load: true, list: true, resume: true, close: false },
          }
        : capabilities(id)
    ));
    renderWithOperations(<SettingsBody config={config()} activeSection="executors" />);

    const kimiCard = (await screen.findByText('Kimi Code')).closest('.exec-row') as HTMLElement;
    await waitFor(() => {
      expect(within(kimiCard).getAllByRole('combobox')).toHaveLength(1);
    });
    fireEvent.change(within(kimiCard).getByRole('combobox'), { target: { value: 'plan' } });
    await waitFor(() => {
      expect(api.setAgentProxyDefaults).toHaveBeenCalledWith('kimi', { mode: 'plan' });
    });
  });

  it('persists Mode through the Agent Proxy defaults endpoint', async () => {
    renderWithOperations(<SettingsBody config={config()} activeSection="executors" />);
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

  it('offers an update action when the installed Proxy is older than Gian', async () => {
    vi.mocked(api.loadAgents).mockResolvedValue([
      {
        ...agent('codex', 'Codex'),
        ready: false,
        proxy: {
          ...agent('codex', 'Codex').proxy,
          state: 'outdated',
          version: '0.1.0',
        },
      },
    ]);

    renderWithOperations(<SettingsBody config={config()} activeSection="executors" />);

    expect(await screen.findByRole('button', { name: 'Update proxy' })).toBeInTheDocument();
    expect(screen.getByText('0.1.0 · GitHub')).toBeInTheDocument();
  });

  it('confirms before persisting a changed CLI path and restarting the packaged app', async () => {
    const restartApp = vi.fn().mockResolvedValue(true);
    window.gianDesktop = { appVariant: 'production', restartApp };
    renderSettingsWithToaster();

    const pathInput = await screen.findByDisplayValue('/bin/claude');
    fireEvent.change(pathInput, { target: { value: '/Users/test/bin/claude-mix' } });
    fireEvent.blur(pathInput);

    expect(await screen.findByRole(
      'alertdialog',
      { name: 'Restart Gian?' },
      { timeout: 3_000 },
    )).toBeTruthy();
    expect(api.setAgentCliPath).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Restart' }));

    await waitFor(() => {
      expect(api.setAgentCliPath).toHaveBeenCalledWith(
        'claude',
        '/Users/test/bin/claude-mix',
      );
      expect(restartApp).toHaveBeenCalledOnce();
    });
  });

  it('restores the previous path without persisting when restart is declined', async () => {
    const restartApp = vi.fn().mockResolvedValue(true);
    window.gianDesktop = { appVariant: 'production', restartApp };
    renderSettingsWithToaster();

    const pathInput = await screen.findByDisplayValue('/bin/claude');
    fireEvent.change(pathInput, { target: { value: '/Users/test/bin/claude-mix' } });
    fireEvent.blur(pathInput);
    fireEvent.click(await screen.findByRole(
      'button',
      { name: 'Keep current path' },
      { timeout: 3_000 },
    ));

    await waitFor(() => expect(pathInput).toHaveValue('/bin/claude'));
    expect(api.setAgentCliPath).not.toHaveBeenCalled();
    expect(restartApp).not.toHaveBeenCalled();
  });

  it('does not restart when persisting a CLI path fails', async () => {
    const restartApp = vi.fn().mockResolvedValue(true);
    window.gianDesktop = { appVariant: 'production', restartApp };
    vi.mocked(api.setAgentCliPath).mockRejectedValueOnce(new Error('invalid CLI'));
    renderSettingsWithToaster();

    const pathInput = await screen.findByDisplayValue('/bin/claude');
    fireEvent.change(pathInput, { target: { value: '/missing/claude' } });
    fireEvent.blur(pathInput);
    fireEvent.click(await screen.findByRole(
      'button',
      { name: 'Restart' },
      { timeout: 3_000 },
    ));

    expect(await screen.findByRole('alert')).toHaveTextContent('invalid CLI');
    await waitFor(() => expect(pathInput).toHaveValue('/bin/claude'));
    expect(restartApp).not.toHaveBeenCalled();
  });

  it('mirrors the confirmed shell relaunch in GianDev without managing its external Host', async () => {
    const restartApp = vi.fn().mockResolvedValue(true);
    window.gianDesktop = { appVariant: 'development', restartApp };
    renderSettingsWithToaster();

    const pathInput = await screen.findByDisplayValue('/bin/codex');
    fireEvent.change(pathInput, { target: { value: '/Users/test/bin/codex-next' } });
    fireEvent.blur(pathInput);
    expect(api.setAgentCliPath).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole(
      'button',
      { name: 'Restart' },
      { timeout: 3_000 },
    ));

    await waitFor(() => {
      expect(api.setAgentCliPath).toHaveBeenCalledWith('codex', '/Users/test/bin/codex-next');
      expect(restartApp).toHaveBeenCalledOnce();
    });
  });
});
