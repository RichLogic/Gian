import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentInstallStatus,
  ConfigOption,
  Executor,
  ProxyCapabilities,
  SystemConfig,
} from '@gian/shared';
import { DEFAULT_TERMINAL_PREFERENCES } from '@gian/shared';
import { SettingsBody } from '../src/components/SettingsBody.js';
import { renderWithOperations } from './operation-test-utils.js';
import { Toaster } from '../src/components/Toaster.js';
import { __resetFeedback } from '../src/feedback.js';
import * as api from '../src/api.js';

const ASYNC_DIALOG_TEST_TIMEOUT_MS = 10_000;

vi.mock('../src/api.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api.js')>('../src/api.js');
  return {
    ...actual,
    loadAgents: vi.fn(),
    loadProxyCapabilities: vi.fn(),
    loadResolvedProxyCatalog: vi.fn(),
    setAgentCliPath: vi.fn(),
    setAgentProxyDefaults: vi.fn(),
    checkAgentProxyUpdate: vi.fn(),
    installAgentProxy: vi.fn(),
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
    font_scale_chat: 'md', chat_font_size: 14, chat_font_family: 'system',
    font_scale_code: 'md',
    terminal: { ...DEFAULT_TERMINAL_PREFERENCES },
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
      defaults: id === 'kimi' || id === 'grok' || id === 'dsh'
        ? { model: '', thinking: '', mode: '' }
        : { model: `${id}-model`, thinking: 'high', mode: 'ask' },
    },
    officialInstallUrl: 'https://example.invalid',
  };
}

function catalogOption(
  id: string,
  role: ConfigOption['role'],
  defaultValue: string,
  choices: string[],
): ConfigOption {
  return {
    id,
    displayName: id,
    binding: 'turn',
    role,
    control: 'select',
    required: false,
    defaultValue,
    choices: choices.map(value => ({ value, displayName: value })),
  };
}

/** Shape returned by GET /api/proxy/:executor/capabilities after gian.proxy/2.0. */
function v2Catalog(id: Executor): Record<string, unknown> {
  if (id === 'kimi' || id === 'grok') {
    return {
      catalogRevision: `${id}-v2`,
      input: [{ type: 'text' }],
      configOptions: [],
      slashCommands: [],
      capabilities: {},
    };
  }
  return {
    catalogRevision: `${id}-v2`,
    input: [{ type: 'text' }],
    configOptions: [
      catalogOption('model', 'model', `${id}-model`, [`${id}-model`]),
      catalogOption('effort', 'effort', 'high', ['high', 'xhigh']),
      catalogOption('permission_mode', 'approval_mode', 'ask', ['ask', 'auto']),
    ],
    slashCommands: [],
    capabilities: {},
  };
}

function capabilities(id: Executor): ProxyCapabilities {
  if (id === 'kimi' || id === 'grok' || id === 'dsh') {
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
    agent('dsh', 'DeepSeek Harness'),
    agent('grok', 'Grok Build'),
  ];

  beforeEach(() => {
    delete window.gianDesktop;
    // Reset implementations as well as calls so an unconsumed one-shot
    // failure from a timed-out test cannot leak into the next case.
    vi.mocked(api.loadAgents).mockReset().mockResolvedValue(agents);
    vi.mocked(api.loadProxyCapabilities).mockReset().mockImplementation(async id => capabilities(id));
    vi.mocked(api.loadResolvedProxyCatalog).mockReset();
    vi.mocked(api.setAgentCliPath).mockReset().mockImplementation(async id => agent(
      id,
      id === 'claude' ? 'Claude Code'
        : id === 'codex' ? 'Codex'
          : id === 'dsh' ? 'DeepSeek Harness'
          : id === 'grok' ? 'Grok Build' : 'Kimi Code',
    ));
    vi.mocked(api.setAgentProxyDefaults).mockReset().mockImplementation(async id => agent(
      id,
      id === 'claude' ? 'Claude Code'
        : id === 'codex' ? 'Codex'
          : id === 'dsh' ? 'DeepSeek Harness'
          : id === 'grok' ? 'Grok Build' : 'Kimi Code',
    ));
    vi.mocked(api.checkAgentProxyUpdate).mockReset();
    vi.mocked(api.installAgentProxy).mockReset();
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

  it('renders all four shipping executor cards with Proxy-owned defaults', async () => {
    renderWithOperations(<SettingsBody config={config()} activeSection="executors" />);

    await waitFor(() => expect(screen.getAllByText('Claude Code')).toHaveLength(1));
    expect(screen.getAllByText('Codex')).toHaveLength(1);
    expect(screen.getAllByText('Kimi Code')).toHaveLength(1);
    expect(screen.getAllByText('DeepSeek Harness')).toHaveLength(1);
    expect(screen.queryByText('Grok Build')).toBeNull();
    // Claude + Codex: model, thinking/effort, mode. Kimi/DSH advertise no
    // legacy models/modes in this fixture, so they render no defaults rows.
    await waitFor(() => expect(screen.getAllByRole('combobox')).toHaveLength(6));
    const kimiCard = screen.getByText('Kimi Code').closest('.exec-row') as HTMLElement;
    expect(within(kimiCard).queryByRole('combobox')).toBeNull();
    const dshCard = screen.getByText('DeepSeek Harness').closest('.exec-row') as HTMLElement;
    expect(within(dshCard).queryByRole('combobox')).toBeNull();
  });

  it('renders defaults from a gian.proxy/2.0 catalog that has no models array', async () => {
    vi.mocked(api.loadProxyCapabilities).mockImplementation(async id => (
      v2Catalog(id) as unknown as ProxyCapabilities
    ));
    renderWithOperations(<SettingsBody config={config()} activeSection="executors" />);

    await waitFor(() => expect(screen.getAllByText('Claude Code')).toHaveLength(1));
    expect(screen.getAllByText('Codex')).toHaveLength(1);
    await waitFor(() => expect(screen.getAllByRole('combobox')).toHaveLength(9));
    const claudeCard = screen.getByText('Claude Code').closest('.exec-row') as HTMLElement;
    expect(within(claudeCard).getByRole('combobox', { name: 'Model' })).toHaveValue('claude-model');
    const dshCard = screen.getByText('DeepSeek Harness').closest('.exec-row') as HTMLElement;
    const dshModel = within(dshCard).getByRole('combobox', { name: 'Model' });
    expect(dshModel).toHaveValue('');
    expect(within(dshModel).getByRole('option', { name: 'dsh-model' })).toBeInTheDocument();
  });

  it('reloads DSH defaults after saving Catalog-backed values', async () => {
    let dsh = agent('dsh', 'DeepSeek Harness');
    vi.mocked(api.loadAgents).mockImplementation(async () => [dsh]);
    vi.mocked(api.loadProxyCapabilities).mockResolvedValue(
      v2Catalog('dsh') as unknown as ProxyCapabilities,
    );
    vi.mocked(api.setAgentProxyDefaults).mockImplementation(async (_id, patch) => {
      dsh = {
        ...dsh,
        proxy: {
          ...dsh.proxy,
          defaults: { ...dsh.proxy.defaults, ...patch },
        },
      };
      return dsh;
    });

    const first = renderWithOperations(
      <SettingsBody config={config()} activeSection="executors" />,
    );
    const firstCard = (await screen.findByText('DeepSeek Harness')).closest('.exec-row') as HTMLElement;
    const model = await within(firstCard).findByRole('combobox', { name: 'Model' });
    fireEvent.change(model, { target: { value: 'dsh-model' } });
    await waitFor(() => expect(model).toHaveValue('dsh-model'));

    const effort = within(firstCard).getByRole('combobox', { name: 'Thinking' });
    fireEvent.change(effort, { target: { value: 'xhigh' } });
    await waitFor(() => expect(effort).toHaveValue('xhigh'));

    const mode = within(firstCard).getByRole('combobox', { name: 'Mode' });
    fireEvent.change(mode, { target: { value: 'auto' } });
    await waitFor(() => expect(mode).toHaveValue('auto'));
    expect(dsh.proxy.defaults).toEqual({ model: 'dsh-model', thinking: 'xhigh', mode: 'auto' });

    first.unmount();
    renderWithOperations(<SettingsBody config={config()} activeSection="executors" />);
    const reloaded = (await screen.findByText('DeepSeek Harness')).closest('.exec-row') as HTMLElement;
    await waitFor(() => {
      expect(within(reloaded).getByRole('combobox', { name: 'Model' })).toHaveValue('dsh-model');
      expect(within(reloaded).getByRole('combobox', { name: 'Thinking' })).toHaveValue('xhigh');
      expect(within(reloaded).getByRole('combobox', { name: 'Mode' })).toHaveValue('auto');
    });
  });

  it('resolves effort choices for the selected model before persisting defaults', async () => {
    const defaultCatalog = {
      catalogRevision: 'claude-models-v2',
      input: [{ type: 'text' }],
      configOptions: [
        catalogOption('model', 'model', 'default', ['default', 'opus']),
        catalogOption('effort', 'effort', 'medium', ['low', 'medium', 'high']),
        catalogOption('permission_mode', 'approval_mode', 'ask', ['ask', 'auto']),
      ],
      slashCommands: [],
      capabilities: { 'catalog.resolve': 1 },
    };
    const claude = {
      ...agent('claude', 'Claude Code'),
      proxy: {
        ...agent('claude', 'Claude Code').proxy,
        defaults: { model: 'default', thinking: 'medium', mode: 'ask' },
      },
    };
    vi.mocked(api.loadAgents).mockResolvedValue([
      claude,
      agent('codex', 'Codex'),
      agent('kimi', 'Kimi Code'),
      agent('dsh', 'DeepSeek Harness'),
    ]);
    vi.mocked(api.loadProxyCapabilities).mockImplementation(async id => (
      id === 'claude' ? defaultCatalog as unknown as ProxyCapabilities : capabilities(id)
    ));
    vi.mocked(api.loadResolvedProxyCatalog).mockResolvedValue({
      ...defaultCatalog,
      configOptions: [
        catalogOption('model', 'model', 'opus', ['default', 'opus']),
        catalogOption('effort', 'effort', 'high', ['low', 'high', 'max']),
        catalogOption('permission_mode', 'approval_mode', 'ask', ['ask', 'auto']),
      ],
      resolvedDefaults: { sessionConfig: {}, turnConfig: { effort: 'high' } },
    });
    renderWithOperations(<SettingsBody config={config()} activeSection="executors" />);

    const claudeCard = (await screen.findByText('Claude Code')).closest('.exec-row') as HTMLElement;
    const model = await within(claudeCard).findByRole('combobox', { name: 'Model' });
    fireEvent.change(model, { target: { value: 'opus' } });

    await waitFor(() => expect(api.loadResolvedProxyCatalog).toHaveBeenCalledWith('claude', {
      catalogRevision: 'claude-models-v2',
      sessionConfig: {},
      turnConfig: { model: 'opus' },
    }));
    await waitFor(() => expect(api.setAgentProxyDefaults).toHaveBeenCalledWith('claude', {
      model: 'opus',
      thinking: '',
    }));
    const effort = within(claudeCard).getByRole('combobox', { name: 'Effort' });
    expect(within(effort).getByRole('option', { name: 'max' })).toBeInTheDocument();
    expect(within(effort).queryByRole('option', { name: 'medium' })).toBeNull();
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

  it('hides the manual update check for development-source proxies', async () => {
    // The default fixture's proxy.source is 'development'.
    renderWithOperations(<SettingsBody config={config()} activeSection="executors" />);
    await screen.findByText('Claude Code');
    expect(screen.queryByRole('button', { name: 'Check for updates' })).toBeNull();
  });

  function githubReleaseAgent(id: Executor, name: string, version: string): AgentInstallStatus {
    return {
      ...agent(id, name),
      proxy: { ...agent(id, name).proxy, version, source: 'github-release' },
    };
  }

  it('checks for a Proxy update and offers the update when one is available', async () => {
    vi.mocked(api.loadAgents).mockResolvedValue([githubReleaseAgent('claude', 'Claude Code', '0.1.0')]);
    vi.mocked(api.checkAgentProxyUpdate).mockResolvedValue({
      managed: true,
      currentVersion: '0.1.0',
      latestVersion: '0.2.0',
      updateAvailable: true,
    });
    vi.mocked(api.installAgentProxy).mockResolvedValue({
      agent: githubReleaseAgent('claude', 'Claude Code', '0.2.0'),
    });

    renderWithOperations(<SettingsBody config={config()} activeSection="executors" />);

    const check = await screen.findByTestId('claude-proxy-check-update');
    fireEvent.click(check);
    const hint = await screen.findByTestId('claude-proxy-update-available');
    expect(hint).toHaveTextContent('0.2.0');
    expect(api.checkAgentProxyUpdate).toHaveBeenCalledWith('claude');

    fireEvent.click(within(hint).getByRole('button', { name: 'Update proxy' }));
    await waitFor(() => {
      expect(api.installAgentProxy).toHaveBeenCalledWith('claude');
    });
    // A completed update clears the stale check hint.
    await waitFor(() => {
      expect(screen.queryByTestId('claude-proxy-update-available')).toBeNull();
    });
  });

  it('reports up to date when no newer Proxy release exists', async () => {
    vi.mocked(api.loadAgents).mockResolvedValue([githubReleaseAgent('claude', 'Claude Code', '0.2.0')]);
    vi.mocked(api.checkAgentProxyUpdate).mockResolvedValue({
      managed: true,
      currentVersion: '0.2.0',
      latestVersion: '0.2.0',
      updateAvailable: false,
    });

    renderWithOperations(<SettingsBody config={config()} activeSection="executors" />);

    fireEvent.click(await screen.findByTestId('claude-proxy-check-update'));
    expect(await screen.findByTestId('claude-proxy-up-to-date')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Update proxy' })).toBeNull();
  });

  it('shows a Version-row hint only when the CLI version differs from the recommended value', async () => {
    vi.mocked(api.loadAgents).mockResolvedValue([
      {
        ...agent('claude', 'Claude Code'),
        cli: {
          state: 'ready',
          path: '/bin/claude',
          version: '1.0.4',
          recommendedVersion: '1.0.3',
          source: 'path',
        },
      },
    ]);
    renderWithOperations(<SettingsBody config={config()} activeSection="executors" />);
    expect(await screen.findByTestId('claude-cli-version-mismatch')).toHaveTextContent('1.0.3');
  });

  it('confirms before persisting a changed CLI path and restarting the packaged app', async () => {
    const restartApp = vi.fn().mockResolvedValue(true);
    window.gianDesktop = { appVariant: 'production', restartApp };
    renderSettingsWithToaster();

    const pathInput = await screen.findByDisplayValue('/bin/claude');
    act(() => {
      fireEvent.change(pathInput, { target: { value: '/Users/test/bin/claude-mix' } });
      fireEvent.blur(pathInput);
    });

    expect(await screen.findByRole(
      'alertdialog',
      { name: 'Restart Gian?' },
      { timeout: 5_000 },
    )).toBeTruthy();
    expect(api.setAgentCliPath).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Restart' }));

    await waitFor(() => {
      expect(api.setAgentCliPath).toHaveBeenCalledWith(
        'claude',
        '/Users/test/bin/claude-mix',
      );
      expect(restartApp).toHaveBeenCalledOnce();
    }, { timeout: 5_000 });
  }, ASYNC_DIALOG_TEST_TIMEOUT_MS);

  it('restores the previous path without persisting when restart is declined', async () => {
    const restartApp = vi.fn().mockResolvedValue(true);
    window.gianDesktop = { appVariant: 'production', restartApp };
    renderSettingsWithToaster();

    const pathInput = await screen.findByDisplayValue('/bin/claude');
    act(() => {
      fireEvent.change(pathInput, { target: { value: '/Users/test/bin/claude-mix' } });
      fireEvent.blur(pathInput);
    });
    fireEvent.click(await screen.findByRole(
      'button',
      { name: 'Keep current path' },
      { timeout: 5_000 },
    ));

    await waitFor(() => expect(pathInput).toHaveValue('/bin/claude'));
    expect(api.setAgentCliPath).not.toHaveBeenCalled();
    expect(restartApp).not.toHaveBeenCalled();
  }, ASYNC_DIALOG_TEST_TIMEOUT_MS);

  it('does not restart when persisting a CLI path fails', async () => {
    const restartApp = vi.fn().mockResolvedValue(true);
    window.gianDesktop = { appVariant: 'production', restartApp };
    vi.mocked(api.setAgentCliPath).mockRejectedValueOnce(new Error('invalid CLI'));
    renderSettingsWithToaster();

    const pathInput = await screen.findByDisplayValue('/bin/claude');
    act(() => {
      fireEvent.change(pathInput, { target: { value: '/missing/claude' } });
      fireEvent.blur(pathInput);
    });
    fireEvent.click(await screen.findByRole(
      'button',
      { name: 'Restart' },
      { timeout: 5_000 },
    ));

    expect(await screen.findByRole('alert')).toHaveTextContent('invalid CLI');
    await waitFor(() => expect(pathInput).toHaveValue('/bin/claude'));
    expect(restartApp).not.toHaveBeenCalled();
  }, 15_000);

  it('mirrors the confirmed shell relaunch in GianDev without managing its external Host', async () => {
    const restartApp = vi.fn().mockResolvedValue(true);
    window.gianDesktop = { appVariant: 'development', restartApp };
    renderSettingsWithToaster();

    const pathInput = await screen.findByDisplayValue('/bin/codex');
    act(() => {
      fireEvent.change(pathInput, { target: { value: '/Users/test/bin/codex-next' } });
      fireEvent.blur(pathInput);
    });
    expect(api.setAgentCliPath).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole(
      'button',
      { name: 'Restart' },
      { timeout: 5_000 },
    ));

    await waitFor(() => {
      expect(api.setAgentCliPath).toHaveBeenCalledWith('codex', '/Users/test/bin/codex-next');
      expect(restartApp).toHaveBeenCalledOnce();
    }, { timeout: 5_000 });
  }, 15_000);
});
