import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { whoAmI } from '../src/api.js';
import { useAppAuth } from '../src/controllers/use-app-auth.js';

vi.mock('../src/api.js', () => ({
  whoAmI: vi.fn(),
}));

const mockedWhoAmI = vi.mocked(whoAmI);

describe('useAppAuth', () => {
  beforeEach(() => {
    mockedWhoAmI.mockReset();
  });

  afterEach(() => {
    delete window.gianDesktop;
  });

  it('holds the app at login when the HTTP session is absent', async () => {
    mockedWhoAmI.mockResolvedValue(null);

    const { result } = renderHook(() => useAppAuth());

    expect(result.current.status).toBe('checking');
    await waitFor(() => expect(result.current.status).toBe('login'));
  });

  it('admits an existing login and can resume after a successful login', async () => {
    mockedWhoAmI.mockResolvedValue({ user: 'admin' });
    const existing = renderHook(() => useAppAuth());

    await waitFor(() => expect(existing.result.current.status).toBe('authenticated'));
    existing.unmount();

    mockedWhoAmI.mockResolvedValue(null);
    const fresh = renderHook(() => useAppAuth());
    await waitFor(() => expect(fresh.result.current.status).toBe('login'));

    act(() => fresh.result.current.onLoginOk({ provider: 'host', username: 'admin' }));
    expect(fresh.result.current.status).toBe('authenticated');
  });

  it('uses the encrypted desktop GitHub identity instead of host password auth', async () => {
    window.gianDesktop = {
      githubAuth: {
        getState: vi.fn().mockResolvedValue({
          status: 'signed_in',
          user: {
            id: 42,
            login: 'octocat',
            name: 'The Octocat',
            avatarUrl: 'https://avatars.githubusercontent.com/u/42',
            profileUrl: 'https://github.com/octocat',
          },
        }),
        start: vi.fn(),
        finish: vi.fn(),
        cancel: vi.fn(),
        signOut: vi.fn(),
      },
    };

    const { result } = renderHook(() => useAppAuth());

    await waitFor(() => expect(result.current.status).toBe('authenticated'));
    expect(result.current.identity?.provider).toBe('github');
    expect(mockedWhoAmI).not.toHaveBeenCalled();
  });
});
