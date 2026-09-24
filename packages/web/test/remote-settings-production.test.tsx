import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { RemoteSettingsSnapshot } from '@gian/shared';
import { createRemoteSettingsController } from '../src/remote-settings/production.js';
import { SettingsRemotePage } from '../src/components/SettingsRemotePage.js';

function connected(): RemoteSettingsSnapshot {
  return {
    enrolled: true, host_id: 'host', host_name: 'This Mac',
    server_url: 'http://127.0.0.1:18787', public_url: 'https://phone.example.test',
    connection: 'online', last_heartbeat_at: '2026-09-06T10:00:00Z',
    server_identity_fingerprint: 'a'.repeat(64), pending_identity_fingerprint: null,
    identity_changed_at: null, pairing: null, pending_pairings: [], devices: [],
  };
}
const response = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('Remote Settings real Host adapter', () => {
  it.each(['remote_auth_required', 'enrollment_rejected', 'remote_unavailable', 'invalid_url', 'invalid_host_name'])(
    'preserves the safe %s category without replaying enrollment or retaining its token', async category => {
      let posts = 0;
      const controller = createRemoteSettingsController({ authorizeAccount: async () => {}, fetchFn: vi.fn(async (_path, init) => {
        if (init?.method === 'POST') {
          posts += 1;
          return new Response(JSON.stringify({ error: category, details: 'secret-token' }), { status: 400 });
        }
        return response({ ...connected(), enrolled: false });
      }) });
      try {
        await controller.refresh?.();
        await controller.enroll({ serverUrl: 'https://remote.test', enrollmentToken: 'secret-token' });
        expect(controller.getState().error).toBe(category);
        expect(controller.getState().enrollment.kind).toBe('not-enrolled');
        expect(JSON.stringify(controller.getState())).not.toContain('secret-token');
        expect(posts).toBe(1);
      } finally { controller.dispose?.(); }
    },
  );

  it('never renders an arbitrary server error or credential-bearing message', async () => {
    const controller = createRemoteSettingsController({ authorizeAccount: async () => {}, fetchFn: vi.fn(async (_path, init) =>
      init?.method === 'POST'
        ? new Response(JSON.stringify({ error: 'private-token transport details' }), { status: 400 })
        : response({ ...connected(), enrolled: false })) });
    try {
      await controller.refresh?.();
      await controller.enroll({ serverUrl: 'https://remote.test', enrollmentToken: 'private-token' });
      expect(controller.getState().error).toBe('operation_failed');
      expect(JSON.stringify(controller.getState())).not.toContain('private-token');
    } finally { controller.dispose?.(); }
  });

  it('renders the actual Host status, creates and restores its real code, and requests only local Host routes', async () => {
    let backend = connected();
    const requests: Array<[string, RequestInit | undefined]> = [];
    const fetchFn = vi.fn(async (path: RequestInfo | URL, init?: RequestInit) => {
      requests.push([String(path), init]);
      if (String(path) === '/api/remote/pairings') {
        backend = { ...backend, pairing: {
          id: 'grant', status: 'pending_claim', code: 'ABCD-1234',
          qr_payload: 'https://phone.example.test/pair#nonce=opaque-grant',
          device_name: null, platform: null, user_agent: null, claimed_network: null,
          claimed_at: null, created_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 300_000).toISOString(),
        } };
        return response({ code: 'ABCD-1234' });
      }
      return response(backend);
    });
    const controller = createRemoteSettingsController({ fetchFn, pollIntervalMs: 60_000 });
    const view = render(<SettingsRemotePage controller={controller} />);
    try {
      expect(screen.getByText('Loading Remote connection status…')).toBeTruthy();
      await screen.findByText('This Mac');
      expect(screen.getByTestId('remote-link-status').textContent).toBe('Online');
      fireEvent.click(screen.getByRole('button', { name: 'Add' }));
      await screen.findByText('ABCD-1234');
      view.unmount();
      const restored = createRemoteSettingsController({ fetchFn, pollIntervalMs: 60_000 });
      render(<SettingsRemotePage controller={restored} />);
      await screen.findByText('ABCD-1234');
      restored.dispose?.();
      expect(requests.every(([path]) => path.startsWith('/api/remote/'))).toBe(true);
      expect(requests.every(([, init]) => init?.cache === 'no-store')).toBe(true);
    } finally { view.unmount(); controller.dispose?.(); }
  });

  it('does not replace a mutation result with an older poll response', async () => {
    const slow = deferred<Response>();
    let backend = connected();
    let reads = 0;
    const controller = createRemoteSettingsController({ fetchFn: vi.fn(async (_path, init) => {
      if (init?.method === 'POST') { backend = { ...backend, connection: 'disconnected' }; return response(backend); }
      if (++reads === 2) return slow.promise;
      return response(backend);
    }) });
    try {
      await controller.refresh?.();
      const polling = controller.refresh?.();
      await controller.disconnect();
      slow.resolve(response(connected()));
      await polling;
      expect(controller.getState().enrollment.kind).toBe('disconnected');
    } finally { controller.dispose?.(); }
  });

  it('recovers committed state after a lost mutation response without replaying the action or exposing the token', async () => {
    let backend = { ...connected(), enrolled: false };
    let posts = 0;
    const controller = createRemoteSettingsController({ authorizeAccount: async () => {}, fetchFn: vi.fn(async (_path, init) => {
      if (init?.method === 'POST') { ++posts; backend = connected(); throw new Error('secret-token transport detail'); }
      return response(backend);
    }) });
    try {
      await controller.refresh?.();
      await controller.enroll({ serverUrl: 'https://server.test', enrollmentToken: 'secret-token' });
      expect(controller.getState().enrollment.kind).toBe('connected');
      expect(controller.getState().error).toBe('operation_failed');
      expect(JSON.stringify(controller.getState())).not.toContain('secret-token');
      expect(posts).toBe(1);
    } finally { controller.dispose?.(); }
  });

  it('waits for App-owned account confirmation before sending enrollment, then resumes the intent exactly once', async () => {
    const authorization = deferred<void>();
    const authorizeAccount = vi.fn(() => authorization.promise);
    const writes: string[] = [];
    const controller = createRemoteSettingsController({ authorizeAccount, fetchFn: vi.fn(async (path, init) => {
      if (init?.method === 'POST') writes.push(String(path));
      return response(connected());
    }) });
    try {
      await controller.refresh?.();
      const pending = controller.enroll({ serverUrl: 'https://server.test', enrollmentToken: 'secret-enrollment-token' });
      expect(authorizeAccount).toHaveBeenCalledWith('https://server.test', expect.any(AbortSignal));
      expect(writes).toEqual([]);
      expect(JSON.stringify(controller.getState())).not.toContain('secret-enrollment-token');
      authorization.resolve();
      await pending;
      expect(writes).toEqual(['/api/remote/enroll']);
    } finally { controller.dispose?.(); }
  });

  it('cancelling App-owned confirmation does not enroll, clear existing pairings, or report an operation failure', async () => {
    let posts = 0;
    const controller = createRemoteSettingsController({ authorizeAccount: async () => { throw new Error('cancelled'); },
      fetchFn: vi.fn(async (_path, init) => { if (init?.method === 'POST') ++posts; return response(connected()); }) });
    try {
      await controller.refresh?.();
      await controller.enroll({ serverUrl: 'https://server.test', enrollmentToken: 'fixture-token' });
      expect(posts).toBe(0);
      expect(controller.getState().error).toBeNull();
      expect(controller.getState().enrollment.kind).toBe('connected');
    } finally { controller.dispose?.(); }
  });

  it('serializes UI mutations and keeps confirmation pending until the Host result', async () => {
    const pending = deferred<Response>();
    let posts = 0;
    const controller = createRemoteSettingsController({ fetchFn: vi.fn(async (_path, init) => {
      if (init?.method === 'POST') { ++posts; return pending.promise; }
      return response(connected());
    }) });
    try {
      await controller.refresh?.();
      const first = controller.startPairing();
      await controller.startPairing();
      expect(controller.getState().busy).toBe(true);
      expect(posts).toBe(1);
      pending.resolve(response({}));
      await first;
      expect(controller.getState().busy).toBe(false);
    } finally { controller.dispose?.(); }
  });

  it('rejects old or malformed Host state and provides retry instead of fabricating a disconnected account', async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(response({ enrolled: false, devices: [] }))
      .mockImplementation(async () => response(connected()));
    const controller = createRemoteSettingsController({ fetchFn });
    try {
      await controller.refresh?.();
      expect(controller.getState().error).toBe('load_failed');
      expect(controller.getState().enrollment.kind).toBe('loading');
      await controller.refresh?.();
      expect(controller.getState().error).toBeNull();
      expect(controller.getState().enrollment.kind).toBe('connected');
    } finally { controller.dispose?.(); }
  });

  it('requires local Allow for a claimed device and binds the decision to its exact pairing id', async () => {
    const backend = connected();
    backend.pairing = {
      id: 'claim/one', status: 'pending_confirmation', code: null, qr_payload: null,
      device_name: 'My phone', platform: 'iOS', user_agent: 'Safari/605',
      claimed_network: null, claimed_at: new Date().toISOString(),
      created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 300_000).toISOString(),
    };
    const fetchFn = vi.fn(async () => response(backend));
    const controller = createRemoteSettingsController({ fetchFn, pollIntervalMs: 60_000 });
    const view = render(<SettingsRemotePage controller={controller} />);
    try {
      await screen.findByRole('alertdialog');
      expect(screen.getByText('My phone')).toBeTruthy();
      expect(fetchFn.mock.calls.length).toBe(1);
      fireEvent.click(screen.getByRole('button', { name: 'Allow device' }));
      await waitFor(() => expect(fetchFn).toHaveBeenCalledWith('/api/remote/pairings/claim%2Fone/confirm', expect.objectContaining({ method: 'POST' })));
    } finally { view.unmount(); controller.dispose?.(); }
  });
});
