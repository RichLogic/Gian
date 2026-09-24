import { webcrypto } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ACCOUNT_PROTOCOL, AUTH_PROTOCOL, generateCanonicalId } from '@gian/remote-protocol';
import { EnrollmentPage } from '../src/ui/enrollment.js';
import { LocaleProvider } from '../src/i18n/index.js';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const show = () => render(<LocaleProvider locale="en"><EnrollmentPage /></LocaleProvider>);

async function pendingLogin(poll: () => Promise<Response>) {
  vi.stubGlobal('crypto', webcrypto);
  const proofs: unknown[] = [];
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    if (path.endsWith('/account')) return new Response('{}', { status: 401 });
    if (path.endsWith('/start')) return Response.json({ protocol: ACCOUNT_PROTOCOL,
      login_id: generateCanonicalId(), user_code: 'USER-CODE', verification_uri: 'https://github.com/login/device',
      interval_seconds: 5, expires_at: Date.now() + 300_000,
      challenge: { type: 'gian.remote.account_challenge/1', challenge_id: generateCanonicalId(), nonce: 'test-nonce',
        server_identity_fingerprint: 'a'.repeat(64), peer: body.peer, expires_at: Date.now() + 300_000 } });
    if (path.endsWith('/cancel')) return Response.json({ ok: true });
    proofs.push(body);
    return poll();
  }));
  show();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Sign in with GitHub' })).toBeEnabled());
  vi.useFakeTimers();
  fireEvent.click(screen.getByRole('button', { name: 'Sign in with GitHub' }));
  await vi.waitFor(async () => {
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText('USER-CODE')).toBeInTheDocument();
  });
  return proofs;
}

describe('separate enrollment page', () => {
  it('keeps the authorization code through network errors and Retry-After, then completes the same login', async () => {
    let calls = 0;
    const proofs = await pendingLogin(async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('network unavailable');
      if (calls === 2) return new Response('{}', { status: 503, headers: { 'retry-after': '20' } });
      return Response.json({ protocol: ACCOUNT_PROTOCOL, status: 'authorized', account: { id: '42', login: 'owner' } });
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(screen.getByText('USER-CODE')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Retrying');
    expect(screen.queryByRole('button', { name: 'Sign in with GitHub' })).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
    expect(calls).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(calls).toBe(2);
    expect(screen.getByText('USER-CODE')).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(19_000); });
    expect(calls).toBe(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.getByText('@owner')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(proofs).toHaveLength(3);
    expect(proofs[1]).toEqual(proofs[0]);
    expect(proofs[2]).toEqual(proofs[0]);
  });

  it('cancels backoff without another poll or restoring the old code', async () => {
    const poll = vi.fn(async () => new Response('{}', { status: 503 }));
    await pendingLogin(poll);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(poll).toHaveBeenCalledTimes(1);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(poll).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('USER-CODE')).toBeNull();
    expect(screen.getByRole('button', { name: 'Sign in with GitHub' })).toBeEnabled();
  });

  it('bounds temporary failure retries by the original login deadline', async () => {
    const poll = vi.fn(async () => new Response('{}', { status: 503 }));
    await pendingLogin(poll);
    await act(async () => { await vi.advanceTimersByTimeAsync(300_000); });
    expect(screen.queryByText('USER-CODE')).toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent('Expired');
    const attempts = poll.mock.calls.length;
    expect(attempts).toBeGreaterThan(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(poll).toHaveBeenCalledTimes(attempts);
  });

  it('does not retry an actual authentication rejection', async () => {
    const poll = vi.fn(async () => new Response('{}', { status: 401 }));
    await pendingLogin(poll);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(poll).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('USER-CODE')).toBeNull();
    expect(screen.getByRole('button', { name: 'Sign in with GitHub' })).toBeEnabled();
  });

  it('offers login and remote-control navigation without starting pairing or OAuth automatically', async () => {
    const request = vi.fn(async (_path: string) => new Response('{}', { status: 401 }));
    vi.stubGlobal('fetch', request);
    show();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign in with GitHub' })).toBeEnabled());
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[0]).toBe('/api/v1/enrollment/account');
    expect(screen.getByRole('link', { name: 'Remote control' })).toHaveAttribute('href', '/');
    expect(screen.queryByRole('button', { name: 'Generate enrollment token' })).toBeNull();
  });

  it('shows the signed-in account, issues a token, expires it and signs out only enrollment', async () => {
    const paths: string[] = [];
    const expiresAt = Date.now() + 300_000;
    vi.stubGlobal('fetch', vi.fn(async (path: string) => {
      paths.push(path);
      if (path.endsWith('/tokens')) return Response.json({ protocol: AUTH_PROTOCOL,
        enrollment_id: generateCanonicalId(), enrollment_token: 'one-time-enrollment-secret', expires_at: expiresAt });
      return Response.json({ account: { id: '42', login: 'owner' } });
    }));
    show();
    await screen.findByText('@owner');
    vi.useFakeTimers();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Generate enrollment token' })); });
    expect(screen.getByDisplayValue('one-time-enrollment-secret')).toBeInTheDocument();
    vi.setSystemTime(expiresAt);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.getByLabelText('Enrollment token')).toHaveValue('');
    expect(screen.getByText('Expired')).toBeInTheDocument();
    vi.useRealTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign in with GitHub' })).toBeEnabled());
    expect(paths).toEqual(['/api/v1/enrollment/account', '/api/v1/enrollment/tokens', '/api/v1/enrollment/account/logout']);
    expect(localStorage.length).toBe(0);
  });

  it('signs the login challenge and shows allowlist denial without exposing token issuance', async () => {
    vi.stubGlobal('crypto', webcrypto);
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      calls.push({ path, body });
      if (path.endsWith('/account')) return new Response('{}', { status: 401 });
      if (path.endsWith('/start')) return Response.json({ protocol: ACCOUNT_PROTOCOL,
        login_id: generateCanonicalId(), user_code: 'USER-CODE', verification_uri: 'https://github.com/login/device',
        interval_seconds: 5, expires_at: Date.now() + 300_000,
        challenge: { type: 'gian.remote.account_challenge/1', challenge_id: generateCanonicalId(), nonce: 'test-nonce',
          server_identity_fingerprint: 'a'.repeat(64), peer: body.peer, expires_at: Date.now() + 300_000 } });
      return Response.json({ protocol: ACCOUNT_PROTOCOL, status: 'denied' });
    }));
    show();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign in with GitHub' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with GitHub' }));
    await screen.findByText('USER-CODE');
    expect(screen.getByRole('link', { name: 'Authorize on GitHub' })).toHaveAttribute('href', 'https://github.com/login/device');
    // The polling timer already exists; advance wall time by a real interval.
    await screen.findByRole('alert', {}, { timeout: 7000 });
    expect(screen.getByRole('alert')).toHaveTextContent('not allowed');
    const proof = calls.find(call => call.path.endsWith('/poll'))!.body;
    expect(typeof proof.signature).toBe('string');
    expect(proof).not.toHaveProperty('access_token');
    expect(screen.queryByRole('button', { name: 'Generate enrollment token' })).toBeNull();
  }, 10_000);

  it('opens the GitHub device page in a new tab and offers to copy the user code', async () => {
    vi.stubGlobal('crypto', webcrypto);
    const open = vi.fn();
    vi.stubGlobal('open', open);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      if (path.endsWith('/account')) return new Response('{}', { status: 401 });
      if (path.endsWith('/start')) return Response.json({ protocol: ACCOUNT_PROTOCOL,
        login_id: generateCanonicalId(), user_code: 'WXYZ-1234', verification_uri: 'https://github.com/login/device',
        interval_seconds: 5, expires_at: Date.now() + 300_000,
        challenge: { type: 'gian.remote.account_challenge/1', challenge_id: generateCanonicalId(), nonce: 'test-nonce',
          server_identity_fingerprint: 'a'.repeat(64), peer: body.peer, expires_at: Date.now() + 300_000 } });
      return Response.json({ protocol: ACCOUNT_PROTOCOL, status: 'pending', interval_seconds: 5 });
    }));
    show();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign in with GitHub' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with GitHub' }));

    await screen.findByText('WXYZ-1234');
    // The authorization page opens by itself; the button stays as fallback.
    await waitFor(() => expect(open).toHaveBeenCalledWith('https://github.com/login/device', '_blank', 'noopener,noreferrer'));
    expect(screen.getByRole('link', { name: 'Authorize on GitHub' })).toHaveAttribute('href', 'https://github.com/login/device');

    fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));
    await screen.findByText('Copied');
    expect(writeText).toHaveBeenCalledWith('WXYZ-1234');
  });

  it('a 503 from the Server reports a temporarily unavailable GitHub, not a generic failure', async () => {
    vi.stubGlobal('crypto', webcrypto);
    vi.stubGlobal('fetch', vi.fn(async (path: string) => {
      if (path.endsWith('/account')) return new Response('{}', { status: 401 });
      return new Response('{"error":{"code":"UPSTREAM_FAILED"}}', { status: 503 });
    }));
    show();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign in with GitHub' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Sign in with GitHub' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('temporarily unavailable');
  });
});
