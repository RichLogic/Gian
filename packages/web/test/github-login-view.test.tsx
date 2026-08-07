import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GitHubAuthFinishResult } from '@gian/shared';
import { LocaleProvider } from '../src/i18n/index.js';
import { wireAuthSink, type AuthIdentity } from '../src/operations/auth.js';
import { LoginView } from '../src/views/LoginView.js';
import { createOperationHarness } from './operation-test-utils.js';

describe('GitHub LoginView', () => {
  afterEach(() => {
    delete window.gianDesktop;
    wireAuthSink(null);
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
    // Phase 3b: the view dispatches auth.githubLogin; the settled identity
    // arrives through the auth sink (use-app-auth's role in product).
    const signedIn: AuthIdentity[] = [];
    wireAuthSink({ signedIn: identity => signedIn.push(identity), signedOut: () => {} });
    const { wrapper } = createOperationHarness();
    render(
      <LocaleProvider locale="en">
        <LoginView />
      </LocaleProvider>,
      { wrapper },
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
    await waitFor(() => expect(signedIn).toHaveLength(1));
    expect(signedIn[0]).toEqual({
      provider: 'github',
      user: expect.objectContaining({ id: 42, login: 'octocat' }),
    });
  });
});
