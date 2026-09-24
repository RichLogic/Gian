import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { authorizeRemoteAccount, cancelGitHubAuthorization, getGitHubAuthorization } from '../src/auth/github-authorization.js';
import { GitHubAuthorizationHost } from '../src/components/GitHubAuthorizationHost.js';

const origin = 'https://remote.test';
const response = (status: 'pending' | 'authorized' | 'denied', serverUrl = origin) => Response.json({
  account: { status, server_url: serverUrl, user_code: 'DEVICE-CODE',
    verification_uri: 'https://github.com/login/device', expires_at: Date.now() + 60_000, interval_seconds: 5, login: 'owner' },
});
const outcome = (promise: Promise<void>) => promise.then(() => 'authorized', error => String(error.message));
afterEach(async () => { cancelGitHubAuthorization(); await Promise.resolve(); vi.useRealTimers(); });

describe('App-owned GitHub authorization', () => {
  it('reuses a verified Remote session without showing another login surface', async () => {
    const fetchFn = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response('authorized'));
    render(<GitHubAuthorizationHost login="owner" />);
    await act(async () => { await authorizeRemoteAccount(origin, 'host', { fetchFn }); });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(getGitHubAuthorization()).toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledWith('/api/remote/account/start', expect.objectContaining({
      body: JSON.stringify({ server_url: origin }), credentials: 'same-origin', cache: 'no-store',
    }));
  });

  it('shows one shared account confirmation and resumes the original intent after verification', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/start')) return response('pending');
      calls += 1;
      if (calls === 1) return new Response('{}', { status: 503, headers: { 'retry-after': '10' } });
      return response('authorized');
    });
    render(<GitHubAuthorizationHost login="owner" />);
    let pending!: Promise<string>;
    const resumed = vi.fn();
    await act(async () => { pending = outcome(authorizeRemoteAccount(origin, 'controller', { fetchFn }).then(resumed)); });
    expect(screen.getByRole('dialog', { name: 'Confirm GitHub account' })).toBeInTheDocument();
    expect((screen.getByRole('dialog').closest('[data-github-authorization-layer]') as HTMLElement).style.zIndex).toBe('1400');
    expect(screen.getByText(origin)).toBeInTheDocument();
    expect(screen.getByText('DEVICE-CODE')).toBeInTheDocument();
    expect(resumed).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(screen.getByText('DEVICE-CODE')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Retrying');
    await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
    expect(calls).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(await pending).toBe('authorized');
    expect(resumed).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(fetchFn.mock.calls.every(([path]) => String(path).startsWith('/api/remote/controller/account/'))).toBe(true);
  });

  it('cancelling account confirmation never resumes the queued connection', async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn(async (_input: RequestInfo | URL) => response('pending'));
    render(<GitHubAuthorizationHost login="owner" />);
    const resumed = vi.fn();
    let pending!: Promise<string>;
    await act(async () => { pending = outcome(authorizeRemoteAccount(origin, 'host', { fetchFn }).then(resumed)); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); });
    expect(await pending).toBe('cancelled');
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(resumed).not.toHaveBeenCalled();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('disposal fences a late cached-authorization response', async () => {
    let finish!: (value: Response) => void;
    const fetchFn = vi.fn((_input: RequestInfo | URL) => new Promise<Response>(resolve => { finish = resolve; }));
    const controller = new AbortController();
    const resumed = vi.fn();
    const pending = outcome(authorizeRemoteAccount(origin, 'host', { fetchFn, signal: controller.signal }).then(resumed));
    controller.abort();
    finish(response('authorized'));
    expect(await pending).toBe('cancelled');
    expect(resumed).not.toHaveBeenCalled();
    expect(getGitHubAuthorization()).toBeNull();
  });

  it('an answer for another Server cannot resume the pending connection', async () => {
    render(<GitHubAuthorizationHost login="owner" />);
    const fetchFn = vi.fn(async (_input: RequestInfo | URL) => response('authorized', 'https://other.test'));
    const resumed = vi.fn();
    let pending!: Promise<string>;
    await act(async () => { pending = outcome(authorizeRemoteAccount(origin, 'host', { fetchFn }).then(resumed)); });
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(resumed).not.toHaveBeenCalled();
    await act(async () => { cancelGitHubAuthorization(); });
    expect(await pending).toBe('cancelled');
  });

  it('expiry stops polling without silently restarting GitHub or the original connection', async () => {
    vi.useFakeTimers();
    render(<GitHubAuthorizationHost login="owner" />);
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/start')
      ? response('pending') : new Response('{}', { status: 503 }));
    let pending!: Promise<string>;
    await act(async () => { pending = outcome(authorizeRemoteAccount(origin, 'host', { fetchFn })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(screen.getByRole('alert')).toHaveTextContent('expired');
    const calls = fetchFn.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(fetchFn).toHaveBeenCalledTimes(calls);
    await act(async () => { cancelGitHubAuthorization(); });
    expect(await pending).toBe('cancelled');
  });
});
