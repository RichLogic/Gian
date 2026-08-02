import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GitHubAuthFinishResult } from '@gian/shared';
import { LocaleProvider } from '../src/i18n/index.js';
import { LoginView } from '../src/views/LoginView.js';

describe('GitHub LoginView', () => {
  afterEach(() => {
    delete window.gianDesktop;
  });

  it('shows the device code while waiting and admits the returned profile', async () => {
    let resolveFinish: ((result: GitHubAuthFinishResult) => void) | undefined;
    const finish = vi.fn(() => new Promise<GitHubAuthFinishResult>(resolve => {
      resolveFinish = resolve;
    }));
    window.gianDesktop = {
      githubAuth: {
        getState: vi.fn().mockResolvedValue({ status: 'signed_out' }),
        start: vi.fn().mockResolvedValue({
          ok: true,
          authorization: {
            userCode: 'ABCD-EFGH',
            verificationUri: 'https://github.com/login/device',
            expiresAt: new Date(Date.now() + 900_000).toISOString(),
          },
        }),
        finish,
        cancel: vi.fn(),
        signOut: vi.fn(),
      },
    };
    const onLoginOk = vi.fn();
    render(
      <LocaleProvider locale="en">
        <LoginView onLoginOk={onLoginOk} />
      </LocaleProvider>,
    );

    await userEvent.click(await screen.findByRole('button', { name: 'Continue with GitHub' }));
    expect(await screen.findByText('ABCD-EFGH')).toBeInTheDocument();
    expect(finish).toHaveBeenCalledOnce();

    resolveFinish?.({
      ok: true,
      user: {
        id: 42,
        login: 'octocat',
        name: 'The Octocat',
        avatarUrl: 'https://avatars.githubusercontent.com/u/42',
        profileUrl: 'https://github.com/octocat',
      },
    });
    await waitFor(() => expect(onLoginOk).toHaveBeenCalledWith({
      provider: 'github',
      user: expect.objectContaining({ id: 42, login: 'octocat' }),
    }));
  });
});
