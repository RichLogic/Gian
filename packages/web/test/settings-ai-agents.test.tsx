import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ProductExecutor,
  ProxyCapabilities,
  ProxyCatalogEntry,
  SystemConfig,
  UserAgentStatus,
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
    loadProxies: vi.fn(),
    loadAgentDraftDefaults: vi.fn(),
    loadProxyCapabilities: vi.fn(),
    loadResolvedProxyCatalog: vi.fn(),
    createAgent: vi.fn(),
    updateAgent: vi.fn(),
    deleteAgent: vi.fn(),
    checkAgentProxyUpdate: vi.fn(),
    installAgentCli: vi.fn(),
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

const PROXIES: ProxyCatalogEntry[] = [
  { id: 'claude', name: 'Claude Code', logo: { light: '/logos/claude-light.png', dark: '/logos/claude-dark.png' }, tagline: 'Anthropic Claude Code agent', officialInstallUrl: 'https://example.invalid/claude' },
  { id: 'codex', name: 'Codex', logo: { light: '/logos/codex-light.png', dark: '/logos/codex-dark.png' }, tagline: 'OpenAI Codex agent', officialInstallUrl: 'https://example.invalid/codex' },
  { id: 'kimi', name: 'Kimi Code', logo: { light: '/logos/kimi-light.png', dark: '/logos/kimi-dark.png' }, tagline: 'Moonshot Kimi Code agent', officialInstallUrl: 'https://example.invalid/kimi' },
  { id: 'dsh', name: 'DeepSeek Harness', logo: { light: '/logos/dsh-light.png', dark: '/logos/dsh-dark.png' }, tagline: 'DeepSeek Harness agent', officialInstallUrl: 'https://example.invalid/dsh' },
];

let nextAgentSeq = 0;

function agent(overrides: Partial<UserAgentStatus> & { proxy: ProductExecutor }): UserAgentStatus {
  nextAgentSeq += 1;
  const proxy = overrides.proxy;
  return {
    id: overrides.id ?? `agent-${proxy}-${nextAgentSeq}`,
    name: overrides.name ?? PROXIES.find(entry => entry.id === proxy)!.name,
    proxy,
    cliPath: overrides.cliPath ?? `/bin/${proxy}`,
    defaults: overrides.defaults ?? { model: '', thinking: '', mode: '' },
    proxyName: PROXIES.find(entry => entry.id === proxy)!.name,
    ready: overrides.ready ?? true,
    cli: overrides.cli ?? { state: 'ready', path: `/bin/${proxy}`, version: '1.0.0', source: 'path' },
    plugin: overrides.plugin ?? {
      state: 'ready',
      path: `/proxy/${proxy}`,
      version: '0.1.0',
      source: 'development',
      defaults: { model: '', thinking: '', mode: '' },
    },
    runtimeProfile: overrides.runtimeProfile ?? null,
    officialInstallUrl: `https://example.invalid/${proxy}`,
  };
}

function capabilities(proxy: ProductExecutor): ProxyCapabilities {
  const model = {
    id: `${proxy}-model`,
    model: `${proxy}-model`,
    displayName: `${proxy} model`,
    description: '',
    hidden: false,
    isDefault: true,
  };
  return {
    protocolVersion: '0.1.0',
    models: [{ ...model, defaultEffort: 'high', supportedEfforts: ['high', 'xhigh'] }],
    modes: [
      { id: 'ask', label: 'Ask', description: '', isDefault: true },
      { id: 'auto', label: 'Auto', description: '', isDefault: false },
    ],
    slashCommands: [],
  };
}

function renderSettings() {
  return renderWithOperations(
    <>
      <Toaster />
      <SettingsBody config={config()} activeSection="executors" />
    </>,
  );
}

describe('SettingsBody AI Agents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nextAgentSeq = 0;
    __resetFeedback();
    delete (window as { gianDesktop?: unknown }).gianDesktop;
    vi.mocked(api.loadAgents).mockResolvedValue([agent({ proxy: 'claude' })]);
    vi.mocked(api.loadProxies).mockResolvedValue(PROXIES);
    vi.mocked(api.loadAgentDraftDefaults).mockImplementation(async proxy => ({
      name: PROXIES.find(entry => entry.id === proxy)!.name,
      cliPath: null,
    }));
    vi.mocked(api.loadProxyCapabilities).mockImplementation(async proxy => capabilities(proxy as ProductExecutor));
    vi.mocked(api.loadResolvedProxyCatalog).mockImplementation(async proxy => capabilities(proxy as ProductExecutor) as never);
    vi.mocked(api.createAgent).mockImplementation(async input => agent({
      proxy: input.proxy,
      name: input.name,
      cliPath: input.cliPath ?? null,
    }));
    vi.mocked(api.updateAgent).mockImplementation(async (id, patch) => {
      const base = agent({ proxy: 'claude' });
      return {
        ...base,
        id,
        name: patch.name ?? base.name,
        cliPath: patch.cliPath !== undefined ? patch.cliPath : base.cliPath,
        proxy: patch.proxy ?? base.proxy,
        defaults: { ...base.defaults, ...patch.defaults },
      };
    });
    vi.mocked(api.deleteAgent).mockResolvedValue(undefined);
  });

  it('shows the empty state with the add entry points and opens the catalog modal', async () => {
    vi.mocked(api.loadAgents).mockResolvedValue([]);
    renderSettings();

    expect(await screen.findByText(/No Agents yet/)).toBeInTheDocument();
    const addButtons = screen.getAllByRole('button', { name: 'Add Agent' });
    expect(addButtons.length).toBeGreaterThanOrEqual(2);

    fireEvent.click(addButtons[0]!);
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Pick a Proxy');
    // Four catalog radios, no Grok anywhere.
    for (const entry of PROXIES) {
      expect(within(dialog).getByText(entry.name)).toBeInTheDocument();
    }
    expect(within(dialog).queryByText(/Grok/)).toBeNull();

    fireEvent.click(within(dialog).getByText('Codex'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Continue' }));
    // Draft card inserts at the top with the kind's name and Logo.
    const draftCard = await screen.findByTestId('agent-draft-card');
    expect(within(draftCard).getByLabelText('Name')).toHaveValue('Codex');
    expect(within(draftCard).getByText('draft')).toBeInTheDocument();
    expect(api.loadAgentDraftDefaults).toHaveBeenCalledWith('codex');
  });

  it('shows a red consequence warning for an allowed unverified Runtime Profile', async () => {
    const codex = agent({ proxy: 'codex' });
    codex.runtimeProfile = {
      id: 'profile-unverified',
      agentId: codex.id,
      proxy: 'codex',
      cliPath: '/bin/codex',
      cliVersion: '0.147.0',
      configHome: '/Users/test/.codex',
      cliFingerprint: 'runtime-new',
      proxyVersion: '0.2.8',
      verifiedCliVersions: ['0.146.0'],
      verification: 'unverified',
      skill: { name: 'gian-session', version: '0.2.8', state: 'ready' },
    };
    vi.mocked(api.loadAgents).mockResolvedValue([codex]);
    renderSettings();
    const warning = await screen.findByRole('alert');
    expect(warning).toHaveClass('danger-hint');
    expect(warning).toHaveTextContent(/may prevent Session resume/i);
    expect(screen.getByText('ready')).toBeInTheDocument();
  });

  it('disables Save & Restart while the draft name is taken and re-enables after rename', async () => {
    vi.mocked(api.loadAgents).mockResolvedValue([agent({ proxy: 'claude', name: 'Claude Work' })]);
    renderSettings();

    fireEvent.click((await screen.findAllByRole('button', { name: 'Add Agent' }))[0]!);
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    const draftCard = await screen.findByTestId('agent-draft-card');

    const nameInput = within(draftCard).getByLabelText('Name');
    fireEvent.change(nameInput, { target: { value: ' claude work ' } });
    expect(within(draftCard).getByText('An Agent with this name already exists.')).toBeInTheDocument();
    expect(within(draftCard).getByRole('button', { name: 'Save & Restart' })).toBeDisabled();

    fireEvent.change(nameInput, { target: { value: 'Claude Personal' } });
    expect(within(draftCard).queryByText('An Agent with this name already exists.')).toBeNull();
    expect(within(draftCard).getByRole('button', { name: 'Save & Restart' })).toBeEnabled();

    fireEvent.click(within(draftCard).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('agent-draft-card')).toBeNull();
  });

  it('saves a draft through the restart confirm on desktop', async () => {
    const restartApp = vi.fn().mockResolvedValue(true);
    (window as { gianDesktop?: unknown }).gianDesktop = { appVariant: 'production', restartApp };
    renderSettings();

    fireEvent.click((await screen.findAllByRole('button', { name: 'Add Agent' }))[0]!);
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    const draftCard = await screen.findByTestId('agent-draft-card');
    fireEvent.change(within(draftCard).getByLabelText('Name'), { target: { value: 'Claude Work' } });
    fireEvent.change(within(draftCard).getByLabelText('Path'), {
      target: { value: '/Users/test/bin/claude' },
    });
    fireEvent.click(within(draftCard).getByRole('button', { name: 'Save & Restart' }));

    expect(await screen.findByRole('alertdialog', { name: 'Restart Gian?' }, { timeout: 5_000 })).toBeTruthy();
    expect(api.createAgent).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Restart' }));

    await waitFor(() => {
      expect(api.createAgent).toHaveBeenCalledWith({
        name: 'Claude Work',
        proxy: 'claude',
        cliPath: '/Users/test/bin/claude',
      });
      expect(restartApp).toHaveBeenCalledOnce();
    }, { timeout: 5_000 });
  }, ASYNC_DIALOG_TEST_TIMEOUT_MS);

  it('renders a saved ready Agent: inline name, Proxy kind, versions, and Defaults', async () => {
    const saved = agent({
      proxy: 'claude',
      name: 'Claude Work',
      defaults: { model: 'claude-model', thinking: 'high', mode: 'ask' },
    });
    vi.mocked(api.loadAgents).mockResolvedValue([saved]);
    renderSettings();

    // Title IS the name (inline edit), Proxy row shows the kind select.
    expect(await screen.findByDisplayValue('Claude Work')).toBeInTheDocument();
    expect(screen.getByText('ready')).toBeInTheDocument();
    const proxySelect = screen.getByRole('combobox', { name: 'Proxy' });
    expect(proxySelect).toHaveValue('claude');
    expect(screen.getByText('1.0.0')).toBeInTheDocument();
    // Defaults three columns, write-through (no restart on change).
    const modelSelect = await screen.findByRole('combobox', { name: 'Model' });
    expect(modelSelect).toHaveValue('claude-model');
    fireEvent.change(modelSelect, { target: { value: '' } });
    await waitFor(() => {
      expect(api.updateAgent).toHaveBeenCalledWith(saved.id, {
        defaults: { model: '' },
      });
    });
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('echoes the resolved CLI path when the Agent has no explicit cliPath', async () => {
    const autoResolved = agent({
      proxy: 'codex',
      cli: { state: 'ready', path: '/opt/homebrew/bin/codex', version: '0.146.0', source: 'official-user' },
    });
    autoResolved.cliPath = null;
    vi.mocked(api.loadAgents).mockResolvedValue([autoResolved]);
    renderSettings();

    const pathInput = await screen.findByDisplayValue('/opt/homebrew/bin/codex');
    // Blurring without edits must not persist anything (no restart prompt).
    fireEvent.blur(pathInput);
    expect(api.updateAgent).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('renames a saved Agent write-through on blur', async () => {
    const saved = agent({ proxy: 'claude', name: 'Claude Work' });
    vi.mocked(api.loadAgents).mockResolvedValue([saved]);
    renderSettings();

    const nameInput = await screen.findByDisplayValue('Claude Work');
    fireEvent.change(nameInput, { target: { value: 'Claude Personal' } });
    fireEvent.blur(nameInput);

    await waitFor(() => {
      expect(api.updateAgent).toHaveBeenCalledWith(saved.id, { name: 'Claude Personal' });
    });
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('renders Proxy-owned light and dark Logo assets and no color control', async () => {
    const saved = agent({ proxy: 'claude' });
    vi.mocked(api.loadAgents).mockResolvedValue([saved]);
    renderSettings();

    await screen.findByRole('textbox', { name: 'Name' });
    expect(document.querySelector('img[src="/api/proxies/claude/logo/light"]')).toBeTruthy();
    expect(document.querySelector('img[src="/api/proxies/claude/logo/dark"]')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Color' })).toBeNull();
  });

  it('deletes a saved Agent through the delete + restart confirms', async () => {
    const restartApp = vi.fn().mockResolvedValue(true);
    (window as { gianDesktop?: unknown }).gianDesktop = { appVariant: 'production', restartApp };
    const saved = agent({ proxy: 'claude', name: 'Claude Work' });
    vi.mocked(api.loadAgents).mockResolvedValue([saved]);
    renderSettings();

    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    const deleteDialog = await screen.findByRole('alertdialog', { name: 'Delete this Agent?' });
    expect(deleteDialog).toHaveTextContent('no longer run turns');
    fireEvent.click(within(deleteDialog).getByRole('button', { name: 'Delete & Restart' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Restart' }, { timeout: 5_000 }));
    await waitFor(() => {
      expect(api.deleteAgent).toHaveBeenCalledWith(saved.id);
      expect(restartApp).toHaveBeenCalledOnce();
    }, { timeout: 5_000 });
  }, ASYNC_DIALOG_TEST_TIMEOUT_MS);

  it('changes the CLI path only after the restart confirm, and keeps it when declined', async () => {
    const restartApp = vi.fn().mockResolvedValue(true);
    (window as { gianDesktop?: unknown }).gianDesktop = { appVariant: 'production', restartApp };
    const saved = agent({ proxy: 'claude' });
    vi.mocked(api.loadAgents).mockResolvedValue([saved]);
    renderSettings();

    const pathInput = await screen.findByDisplayValue('/bin/claude');
    fireEvent.change(pathInput, { target: { value: '/Users/test/bin/claude-mix' } });
    fireEvent.blur(pathInput);
    fireEvent.click(await screen.findByRole('button', { name: 'Keep current path' }, { timeout: 5_000 }));
    await waitFor(() => expect(pathInput).toHaveValue('/bin/claude'));
    expect(api.updateAgent).not.toHaveBeenCalled();
    expect(restartApp).not.toHaveBeenCalled();

    fireEvent.change(pathInput, { target: { value: '/Users/test/bin/claude-mix' } });
    fireEvent.blur(pathInput);
    fireEvent.click(await screen.findByRole('button', { name: 'Restart' }, { timeout: 5_000 }));
    await waitFor(() => {
      expect(api.updateAgent).toHaveBeenCalledWith(saved.id, {
        cliPath: '/Users/test/bin/claude-mix',
      });
      expect(restartApp).toHaveBeenCalledOnce();
    }, { timeout: 5_000 });
  }, ASYNC_DIALOG_TEST_TIMEOUT_MS);

  it('switches the Proxy kind on a saved card through the restart confirm', async () => {
    const restartApp = vi.fn().mockResolvedValue(true);
    (window as { gianDesktop?: unknown }).gianDesktop = { appVariant: 'production', restartApp };
    const saved = agent({ proxy: 'claude' });
    vi.mocked(api.loadAgents).mockResolvedValue([saved]);
    renderSettings();

    fireEvent.change(await screen.findByRole('combobox', { name: 'Proxy' }), {
      target: { value: 'codex' },
    });
    expect(api.updateAgent).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'Restart' }, { timeout: 5_000 }));
    await waitFor(() => {
      expect(api.updateAgent).toHaveBeenCalledWith(saved.id, {
        proxy: 'codex',
        cliPath: null,
      });
      expect(restartApp).toHaveBeenCalledOnce();
    }, { timeout: 5_000 });
  }, ASYNC_DIALOG_TEST_TIMEOUT_MS);

  it('shows the vendored plugin version with a Dev tag and a check button on development builds', async () => {
    vi.mocked(api.loadAgents).mockResolvedValue([agent({
      proxy: 'claude',
      plugin: {
        state: 'ready',
        path: '/proxy/claude',
        version: '0.2.1',
        source: 'development',
        defaults: { model: '', thinking: '', mode: '' },
      },
    })]);
    vi.mocked(api.checkAgentProxyUpdate).mockResolvedValue({
      managed: false,
      currentVersion: '0.2.1',
      latestVersion: null,
      updateAvailable: false,
    });
    renderSettings();

    expect((await screen.findAllByText(/0\.2\.1/)).length).toBeGreaterThan(0);
    expect(screen.getByText('· Dev', { exact: false })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
    await waitFor(() => {
      expect(api.checkAgentProxyUpdate).toHaveBeenCalledWith('claude');
    });
    expect(await screen.findByText(/Development build — Proxy updates ship with Gian/)).toBeInTheDocument();
    // No update action exists outside the managed channel.
    expect(screen.queryByRole('button', { name: 'Update proxy' })).toBeNull();
  });

  it('shows install buttons on a not-ready Agent and checks Proxy updates on GitHub sources', async () => {
    vi.mocked(api.loadAgents).mockResolvedValue([agent({
      proxy: 'dsh',
      ready: false,
      cliPath: null,
      cli: { state: 'missing', path: null, version: null, source: null },
      plugin: {
        state: 'ready',
        path: '/proxy/dsh',
        version: '0.1.0',
        source: 'github-release',
        defaults: { model: '', thinking: '', mode: '' },
      },
    })]);
    vi.mocked(api.checkAgentProxyUpdate).mockResolvedValue({
      managed: true,
      currentVersion: '0.1.0',
      latestVersion: '0.2.0',
      updateAvailable: true,
    });
    renderSettings();

    expect((await screen.findAllByText('setup required')).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Install official CLI' })).toBeInTheDocument();
    // No Defaults on a not-ready card.
    expect(screen.queryByRole('combobox', { name: 'Model' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));
    expect(await screen.findByText('Proxy 0.2.0 is available.')).toBeInTheDocument();
    expect(api.checkAgentProxyUpdate).toHaveBeenCalledWith('dsh');
  });
});
