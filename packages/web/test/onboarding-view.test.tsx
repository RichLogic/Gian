import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentInstallStatus, Executor, OnboardingState } from '@gian/shared';
import {
  completeOnboarding,
  installAgentCli,
  installAgentProxy,
  loadAgents,
  saveOnboardingProjectRoot,
} from '../src/api.js';
import { LocaleProvider } from '../src/i18n/index.js';
import { OnboardingView } from '../src/views/OnboardingView.js';
import { createOperationHarness } from './operation-test-utils.js';

vi.mock('../src/api.js', () => ({
  completeOnboarding: vi.fn(),
  installAgentCli: vi.fn(),
  installAgentProxy: vi.fn(),
  loadAgents: vi.fn(),
  pickWorkspaceFolder: vi.fn(),
  saveOnboardingProjectRoot: vi.fn(),
  setAgentCliPath: vi.fn(),
}));

function agent(id: Executor, name: string, ready = true): AgentInstallStatus {
  return {
    id,
    name,
    ready,
    cli: ready
      ? { state: 'ready', path: `/bin/${id}`, version: '1.0.0', source: 'path' }
      : { state: 'missing', path: null, version: null, source: null },
    proxy: ready
      ? {
          state: 'ready', path: `/proxy/${id}`, version: '0.1.0', source: 'github-release',
          defaults: { model: '', thinking: '', mode: '' },
        }
      : {
          state: 'missing', path: `/proxy/${id}`, version: null, source: 'github-release',
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

describe('OnboardingView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadAgents).mockResolvedValue(readyAgents);
    vi.mocked(installAgentProxy).mockImplementation(async id => ({ agent: agent(id, id, true) }) as never);
    vi.mocked(installAgentCli).mockImplementation(async id => ({ agent: agent(id, id, true) }) as never);
    vi.mocked(saveOnboardingProjectRoot).mockResolvedValue({ projectRoot: '~/Coding' });
    vi.mocked(completeOnboarding).mockResolvedValue({ ...state(), completed: true });
  });

  it('shows an already connected GitHub account as the explicit first step', async () => {
    const { wrapper } = createOperationHarness();
    render(
      <LocaleProvider locale="en">
        <OnboardingView
          identity={{
            provider: 'github',
            user: {
              id: 42,
              login: 'octocat',
              name: 'The Octocat',
              avatarUrl: 'https://avatars.githubusercontent.com/u/42',
              profileUrl: 'https://github.com/octocat',
            },
          }}
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
  });

  it('finishes agent setup and shows the Agent worktree directory', async () => {
    const onComplete = vi.fn();
    const { wrapper } = createOperationHarness();
    render(
      <LocaleProvider locale="en">
        <OnboardingView
          identity={{
            provider: 'github',
            user: {
              id: 42,
              login: 'octocat',
              name: 'The Octocat',
              avatarUrl: 'https://avatars.githubusercontent.com/u/42',
              profileUrl: 'https://github.com/octocat',
            },
          }}
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

  it('installs both the proxy and official CLI before the first Agent can continue', async () => {
    const missingAgents = [
      agent('codex', 'Codex', false),
      agent('claude', 'Claude Code', false),
      agent('kimi', 'Kimi Code', false),
    ];
    const codexReady = [agent('codex', 'Codex'), missingAgents[1]!, missingAgents[2]!];
    vi.mocked(loadAgents).mockResolvedValue(codexReady);
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
});
