import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { login, whoAmI } from '../src/api.js';
import { useAppAuth } from '../src/controllers/use-app-auth.js';
import { createOperationHarness } from './operation-test-utils.js';

vi.mock('../src/api.js', () => ({
  whoAmI: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
}));

const mockedWhoAmI = vi.mocked(whoAmI);
const mockedLogin = vi.mocked(login);

describe('useAppAuth', () => {
  beforeEach(() => {
    mockedWhoAmI.mockReset();
    mockedLogin.mockReset();
  });

  afterEach(() => {
    delete window.gianDesktop;
  });

  it('holds the app at login when the HTTP session is absent', async () => {
    mockedWhoAmI.mockResolvedValue(null);

    const { result } = renderHook(() => useAppAuth(vi.fn()));

    expect(result.current.status).toBe('checking');
    await waitFor(() => expect(result.current.status).toBe('login'));
  });

  it('admits an existing login and authenticates again via the auth.login operation sink', async () => {
    mockedWhoAmI.mockResolvedValue({ user: 'admin' });
    const existing = renderHook(() => useAppAuth(vi.fn()));

    await waitFor(() => expect(existing.result.current.status).toBe('authenticated'));
    existing.unmount();

    // Phase 3b: the settled identity arrives through the auth sink — a
    // confirmed auth.login run signs the app in (no more onLoginOk prop).
    mockedWhoAmI.mockResolvedValue(null);
    mockedLogin.mockResolvedValue({ user: 'admin' });
    const { dispatcher } = createOperationHarness();
    const fresh = renderHook(() => useAppAuth(dispatcher.dispatch));
    await waitFor(() => expect(fresh.result.current.status).toBe('login'));

    await act(async () => {
      dispatcher.dispatch('auth.login', { username: 'admin', password: 'pw' });
    });
    await waitFor(() => expect(fresh.result.current.status).toBe('authenticated'));
    expect(fresh.result.current.identity).toEqual({ provider: 'host', username: 'admin' });
  });

  it('signs out through the auth.logout operation', async () => {
    mockedWhoAmI.mockResolvedValue({ user: 'admin' });
    const { dispatcher } = createOperationHarness();
    const { result } = renderHook(() => useAppAuth(dispatcher.dispatch));

    await waitFor(() => expect(result.current.status).toBe('authenticated'));
    act(() => result.current.signOut());
    await waitFor(() => expect(result.current.status).toBe('login'));
    expect(result.current.identity).toBeNull();
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

    const { result } = renderHook(() => useAppAuth(vi.fn()));

    await waitFor(() => expect(result.current.status).toBe('authenticated'));
    expect(result.current.identity?.provider).toBe('github');
    expect(mockedWhoAmI).not.toHaveBeenCalled();
  });
});
