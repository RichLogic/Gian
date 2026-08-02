import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentInstallStatus, Executor, OnboardingState } from '@gian/shared';
import {
  completeOnboarding,
  installAgentCli,
  installAgentProxy,
  loadAgents,
  saveOnboardingWorkspace,
} from '../src/api.js';
import { LocaleProvider } from '../src/i18n/index.js';
import { OnboardingView } from '../src/views/OnboardingView.js';

vi.mock('../src/api.js', () => ({
  completeOnboarding: vi.fn(),
  installAgentCli: vi.fn(),
  installAgentProxy: vi.fn(),
  loadAgents: vi.fn(),
  pickWorkspaceFolder: vi.fn(),
  saveOnboardingWorkspace: vi.fn(),
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
    workspaceRoot: '~/Coding',
    workspaceDirectory: '/Users/test/Coding/workspaces',
    agents,
  };
}

describe('OnboardingView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadAgents).mockResolvedValue(readyAgents);
    vi.mocked(saveOnboardingWorkspace).mockResolvedValue({
      workspaceRoot: '~/Coding',
      workspaceDirectory: '/Users/test/Coding/workspaces',
    });
    vi.mocked(completeOnboarding).mockResolvedValue({ ...state(), completed: true });
  });

  it('finishes agent setup and persists the project/workspaces directory', async () => {
    const onComplete = vi.fn();
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
    );

    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByRole('heading', { name: 'Choose your project directory' })).toBeInTheDocument();
    expect(screen.getByText('~/Coding/workspaces')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Finish setup' }));

    await waitFor(() => expect(saveOnboardingWorkspace).toHaveBeenCalledWith('~/Coding'));
    expect(completeOnboarding).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ completed: true }));
  });

  it('installs both the proxy and official CLI before enabling continue', async () => {
    const missingCodex = agent('codex', 'Codex', false);
    render(
      <LocaleProvider locale="en">
        <OnboardingView
          identity={null}
          initialState={state([missingCodex, readyAgents[1]!, readyAgents[2]!])}
          onComplete={vi.fn()}
        />
      </LocaleProvider>,
    );

    const continueButton = screen.getByRole('button', { name: 'Continue' });
    expect(continueButton).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Set up' }));

    await waitFor(() => expect(installAgentProxy).toHaveBeenCalledWith('codex'));
    expect(installAgentCli).toHaveBeenCalledWith('codex');
    await waitFor(() => expect(continueButton).toBeEnabled());
  });
});
