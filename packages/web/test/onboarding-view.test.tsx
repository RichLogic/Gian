import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  OnboardingState,
  ProductExecutor,
  ProxyCatalogEntry,
  UserAgentStatus,
} from '@gian/shared';
import {
  completeOnboarding,
  createAgent,
  installAgentCli,
  installAgentProxy,
  loadAgentDraftDefaults,
  loadAgents,
  loadProxies,
  saveOnboardingProjectRoot,
  updateAgent,
} from '../src/api.js';
import { LocaleProvider } from '../src/i18n/index.js';
import { OnboardingView } from '../src/views/OnboardingView.js';
import { createOperationHarness } from './operation-test-utils.js';

vi.mock('../src/api.js', () => ({
  completeOnboarding: vi.fn(),
  createAgent: vi.fn(),
  installAgentCli: vi.fn(),
  installAgentProxy: vi.fn(),
  loadAgentDraftDefaults: vi.fn(),
  loadAgents: vi.fn(),
  loadProxies: vi.fn(),
  pickWorkspaceFolder: vi.fn(),
  saveOnboardingProjectRoot: vi.fn(),
  updateAgent: vi.fn(),
}));

const PROXIES: ProxyCatalogEntry[] = [
  { id: 'claude', name: 'Claude Code', defaultColor: 'ember', tagline: 'Anthropic Claude Code agent', officialInstallUrl: 'https://example.invalid/claude' },
  { id: 'codex', name: 'Codex', defaultColor: 'ink', tagline: 'OpenAI Codex agent', officialInstallUrl: 'https://example.invalid/codex' },
  { id: 'kimi', name: 'Kimi Code', defaultColor: 'citron', tagline: 'Moonshot Kimi Code agent', officialInstallUrl: 'https://example.invalid/kimi' },
  { id: 'dsh', name: 'DeepSeek Harness', defaultColor: 'teal', tagline: 'DeepSeek Harness agent', officialInstallUrl: 'https://example.invalid/dsh' },
];

const AGENT_COLORS: Record<ProductExecutor, UserAgentStatus['color']> = {
  claude: 'ember',
  codex: 'ink',
  kimi: 'citron',
  dsh: 'teal',
};

function agent(kind: ProductExecutor, name: string, ready = true): UserAgentStatus {
  return {
    id: `agent-${kind}-1`,
    name,
    color: AGENT_COLORS[kind],
    proxy: kind,
    cliPath: ready ? `/bin/${kind}` : null,
    defaults: { model: '', thinking: '', mode: '' },
    proxyName: name,
    ready,
    cli: ready
      ? { state: 'ready', path: `/bin/${kind}`, version: '1.0.0', source: 'path' }
      : { state: 'missing', path: null, version: null, source: null },
    plugin: ready
      ? {
          state: 'ready', path: `/proxy/${kind}`, version: '0.1.0', source: 'github-release',
          defaults: { model: '', thinking: '', mode: '' },
        }
      : {
          state: 'missing', path: `/proxy/${kind}`, version: null, source: 'github-release',
          defaults: { model: '', thinking: '', mode: '' },
        },
    officialInstallUrl: 'https://example.invalid',
  };
}

const readyAgents = [
  agent('codex', 'Codex'),
  agent('claude', 'Claude Code'),
  agent('kimi', 'Kimi Code'),
];

function state(agents = readyAgents): OnboardingState {
  return {
    completed: false,
    projectRoot: '~/Coding',
    agents,
  };
}

const githubIdentity = {
  provider: 'github' as const,
  user: {
    id: 42,
    login: 'octocat',
    name: 'The Octocat',
    avatarUrl: 'https://avatars.githubusercontent.com/u/42',
    profileUrl: 'https://github.com/octocat',
  },
};

describe('OnboardingView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete (window as { gianDesktop?: unknown }).gianDesktop;
    vi.mocked(loadAgents).mockResolvedValue(readyAgents);
    vi.mocked(loadProxies).mockResolvedValue(PROXIES);
    vi.mocked(loadAgentDraftDefaults).mockImplementation(async kind => ({
      name: PROXIES.find(entry => entry.id === kind)!.name,
      color: PROXIES.find(entry => entry.id === kind)!.defaultColor,
      cliPath: null,
    }));
    vi.mocked(createAgent).mockImplementation(async input => agent(input.proxy, input.name));
    vi.mocked(updateAgent).mockImplementation(async (id, patch) => ({
      ...agent('claude', 'Claude Code'),
      id,
      ...patch,
      defaults: { model: '', thinking: '', mode: '' },
    }));
    vi.mocked(installAgentProxy).mockImplementation(async () => ({ agent: {} }) as never);
    vi.mocked(installAgentCli).mockImplementation(async () => ({ agent: {} }) as never);
    vi.mocked(saveOnboardingProjectRoot).mockResolvedValue({ projectRoot: '~/Coding' });
    vi.mocked(completeOnboarding).mockResolvedValue({ ...state(), completed: true });
  });

  it('shows an already connected GitHub account as the explicit first step', async () => {
    const { wrapper } = createOperationHarness();
    render(
      <LocaleProvider locale="en">
        <OnboardingView
          identity={githubIdentity}
          initialState={state()}
          onComplete={vi.fn()}
        />
      </LocaleProvider>,
      { wrapper },
    );

    expect(screen.getByRole('heading', { name: 'Your GitHub account is ready' })).toBeInTheDocument();
    expect(screen.getByText('@octocat')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Initialize your agents' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByRole('heading', { name: 'Initialize your agents' })).toBeInTheDocument();
    expect(screen.getByText('Codex')).toBeInTheDocument();
    expect(screen.queryByText(/Grok/)).not.toBeInTheDocument();
  });

  it('finishes agent setup and shows the Agent worktree directory', async () => {
    const onComplete = vi.fn();
    const { wrapper } = createOperationHarness();
    render(
      <LocaleProvider locale="en">
        <OnboardingView
          identity={githubIdentity}
          initialState={state()}
          onComplete={onComplete}
        />
      </LocaleProvider>,
      { wrapper },
    );

    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByRole('heading', { name: 'Choose your project directory' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Project root' })).toHaveValue('~/Coding');
    expect(screen.queryByText('~/Coding')).not.toBeInTheDocument();
    expect(screen.getByText('~/Coding/worktrees')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Finish setup' }));

    await waitFor(() => expect(saveOnboardingProjectRoot).toHaveBeenCalledWith('~/Coding'));
    expect(completeOnboarding).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ completed: true }));
  });

  it('allows continuing when any one Agent is ready', async () => {
    const missingCodex = agent('codex', 'Codex', false);
    const missingKimi = agent('kimi', 'Kimi Code', false);
    const { wrapper } = createOperationHarness();
    render(
      <LocaleProvider locale="en">
        <OnboardingView
          identity={null}
          initialState={state([missingCodex, readyAgents[1]!, missingKimi])}
          onComplete={vi.fn()}
        />
      </LocaleProvider>,
      { wrapper },
    );

    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
  });

  it('adds a missing Agent from the catalog without restarting mid-wizard', async () => {
    const restartApp = vi.fn().mockResolvedValue(true);
    (window as { gianDesktop?: unknown }).gianDesktop = { appVariant: 'production', restartApp };
    vi.mocked(loadAgents).mockResolvedValue([readyAgents[0]!, readyAgents[1]!]);
    const { wrapper } = createOperationHarness();
    render(
      <LocaleProvider locale="en">
        <OnboardingView
          identity={null}
          initialState={state([readyAgents[0]!, readyAgents[1]!])}
          onComplete={vi.fn()}
        />
      </LocaleProvider>,
      { wrapper },
    );

    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    // kimi/dsh have no saved Agent — they render as Add rows.
    const addRow = await screen.findByTestId('onboarding-add-kimi');
    await userEvent.click(addRow.querySelector('button')!);

    await waitFor(() => expect(createAgent).toHaveBeenCalledWith({
      name: 'Kimi Code',
      proxy: 'kimi',
      color: 'citron',
      cliPath: null,
    }));
    // Never a restart while the wizard is open.
    expect(restartApp).not.toHaveBeenCalled();
  });

  it('installs both the proxy and official CLI before the first Agent can continue', async () => {
    const missingAgents = [
      agent('codex', 'Codex', false),
      agent('claude', 'Claude Code', false),
      agent('kimi', 'Kimi Code', false),
    ];
    const codexReady = [agent('codex', 'Codex'), missingAgents[1]!, missingAgents[2]!];
    vi.mocked(loadAgents)
      .mockResolvedValueOnce(missingAgents)
      .mockResolvedValue(codexReady);
    const { wrapper } = createOperationHarness();
    render(
      <LocaleProvider locale="en">
        <OnboardingView
          identity={null}
          initialState={state(missingAgents)}
          onComplete={vi.fn()}
        />
      </LocaleProvider>,
      { wrapper },
    );

    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    const continueButton = screen.getByRole('button', { name: 'Continue' });
    expect(continueButton).toBeDisabled();
    await userEvent.click(screen.getAllByRole('button', { name: 'Set up' })[0]!);

    await waitFor(() => expect(installAgentProxy).toHaveBeenCalledWith('codex'));
    expect(installAgentCli).toHaveBeenCalledWith('codex');
    await waitFor(() => expect(continueButton).toBeEnabled());
  });

  it('saves a CLI path write-through without restarting mid-wizard', async () => {
    const restartApp = vi.fn().mockResolvedValue(true);
    (window as { gianDesktop?: unknown }).gianDesktop = { appVariant: 'production', restartApp };
    const { wrapper } = createOperationHarness();
    render(
      <LocaleProvider locale="en">
        <OnboardingView
          identity={null}
          initialState={state()}
          onComplete={vi.fn()}
        />
      </LocaleProvider>,
      { wrapper },
    );

    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    const pathInput = (await screen.findAllByDisplayValue('/bin/claude'))[0]!;
    await userEvent.clear(pathInput);
    await userEvent.type(pathInput, '/Users/test/bin/claude-mix');
    const row = pathInput.closest('article')!;
    await userEvent.click(within(row).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(updateAgent).toHaveBeenCalledWith('agent-claude-1', {
      cliPath: '/Users/test/bin/claude-mix',
    }));
    expect(restartApp).not.toHaveBeenCalled();
  });
});
