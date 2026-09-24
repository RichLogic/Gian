/**
 * Settings › Remote — component tests over the fixture
 * `RemoteSettingsController` plus a stubbed /api/remote fetch for the
 * environments block. Covers the two scopes (控制这个 Gian / 控制其他 Gian),
 * the connect dialog contract (three fields, no field notes, token never
 * retained), the merged destructive disconnect, the Add-device grant dialog,
 * the confirmed revoke flow, and environment pair/remove.
 *
 * These are fixture/browser-layer tests only: they prove the UI state
 * branches against the typed contract, not the Host remote backend.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import {
  DEFAULT_LAYOUT_PREFERENCES,
  DEFAULT_TERMINAL_PREFERENCES,
  DEFAULT_TOOL_PREFERENCES,
} from '@gian/shared';
import type { RemoteSettingsSnapshot, SystemConfig } from '@gian/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsBody } from '../src/components/SettingsBody.js';
import { SettingsRemotePage } from '../src/components/SettingsRemotePage.js';
import { Toaster } from '../src/components/Toaster.js';
import { GitHubAuthorizationHost } from '../src/components/GitHubAuthorizationHost.js';
import { __resetFeedback } from '../src/feedback.js';
import type { RemoteEnvironment } from '../src/remote-environments.js';
import { createRemoteSettingsFixture } from '../src/remote-settings/fixture.js';
import type { RemoteSettingsFixture } from '../src/remote-settings/fixture.js';
import type { RemoteDeviceInfo, RemoteSettingsController } from '../src/remote-settings/types.js';
import { createRemoteSettingsController } from '../src/remote-settings/production.js';
import { renderWithOperations } from './operation-test-utils.js';

function renderRemote(fixture: RemoteSettingsController | null) {
  return render(
    <>
      <SettingsRemotePage controller={fixture} />
      <GitHubAuthorizationHost login="RichLogic" />
      <Toaster />
    </>,
  );
}

function device(overrides: Partial<RemoteDeviceInfo> = {}): RemoteDeviceInfo {
  return {
    id: 'device-1',
    name: 'iPhone 17',
    platform: 'iOS 26 · Safari',
    createdAt: Date.UTC(2026, 7, 30, 9, 0),
    lastSeenAt: Date.now() - 3 * 60_000,
    activeConnections: 1,
    revokeStatus: 'active',
    ...overrides,
  };
}

function environment(overrides: Partial<RemoteEnvironment> = {}): RemoteEnvironment {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Mac mini',
    host_id: '22222222-2222-4222-8222-222222222222',
    server_origin: 'https://remote.example.com',
    pending: false,
    connected: true,
    ...overrides,
  };
}

/** Stub the /api/remote environment endpoints the page calls directly. */
function stubEnvironments(initial: RemoteEnvironment[]) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  let environments = [...initial];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.url;
    const path = new URL(url, 'http://localhost').pathname;
    const method = init?.method ?? 'GET';
    if (path === '/api/remote/controller/account/start' && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { server_url: string };
      calls.push({ method, path, body });
      return Response.json({ account: { status: 'authorized', server_url: body.server_url,
        login: 'RichLogic', expires_at: Date.now() + 300_000 } });
    }
    if (path === '/api/remote/environments' && method === 'GET') {
      calls.push({ method, path });
      return Response.json({ environments });
    }
    if (path === '/api/remote/environments' && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { server_url: string; code: string; name: string };
      calls.push({ method, path, body });
      const created = environment({ name: body.name });
      environments = [...environments, created];
      return Response.json({ environment: created });
    }
    const removeMatch = /^\/api\/remote\/environments\/([0-9a-f-]+)$/.exec(path);
    if (removeMatch && method === 'DELETE') {
      calls.push({ method, path });
      environments = environments.filter(item => item.id !== removeMatch[1]);
      return Response.json({ ok: true });
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  return {
    calls,
    restore() { globalThis.fetch = original; },
  };
}

beforeEach(() => __resetFeedback());

describe('Settings › Remote — availability', () => {
  it('renders the unavailable state when no controller is wired', () => {
    renderRemote(null);
    expect(screen.getByTestId('settings-remote-unavailable')).toBeTruthy();
    expect(screen.queryByTestId('settings-remote-enrollment')).toBeNull();
  });
});

describe('Settings › Remote — 控制这个 Gian', () => {
  it.each([
    ['http://127.0.0.1:18787/', 'http://127.0.0.1:18787'],
    ['https://remote.example.com/', 'https://remote.example.com'],
    ['http://remote.example.com', null],
    ['https://secret@remote.example.com', null],
    ['https://remote.example.com/another-path', null],
  ])('only permits valid Server origins and never offers inline GitHub login: %s', async (url, origin) => {
    const fixture = createRemoteSettingsFixture();
    fixture.startAccountLogin = vi.fn(async () => {});
    renderRemote(fixture);
    fireEvent.click(screen.getByRole('button', { name: 'Connect Remote Server' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Remote Server URL'), { target: { value: url } });
    fireEvent.change(within(dialog).getByLabelText('Enrollment token'), { target: { value: 'fixture-token' } });
    const button = within(dialog).queryByRole('button', { name: 'Sign in to Remote with GitHub' });
    expect(button).toBeNull();
    expect(fixture.startAccountLogin).not.toHaveBeenCalled();
    const connect = within(dialog).getByRole('button', { name: 'Connect' });
    if (origin) expect(connect).toBeEnabled();
    else expect(connect).toBeDisabled();
  });

  it('confirms Host identity in the App dialog, keeps polling pending states, then submits the original enrollment once', async () => {
    vi.useFakeTimers();
    const environments = stubEnvironments([]);
    const url = 'https://remote.example.com';
    let backend: RemoteSettingsSnapshot = {
      enrolled: false, account: null, host_id: null, host_name: null, server_url: null,
      public_url: null, connection: 'offline', last_heartbeat_at: null,
      server_identity_fingerprint: null, pending_identity_fingerprint: null,
      identity_changed_at: null, pairing: null, pending_pairings: [], devices: [],
    };
    let polls = 0;
    const enrollments: unknown[] = [];
    const fetchFn: typeof fetch = async (path, init) => {
      if (String(path) === '/api/remote/account/start') {
        expect(JSON.parse(String(init?.body))).toEqual({ server_url: url });
        backend = { ...backend, account: { status: 'pending', server_url: url, user_code: 'HOST-CODE',
          verification_uri: 'https://github.com/login/device', expires_at: Date.now() + 300_000, interval_seconds: 5 } };
      }
      if (String(path) === '/api/remote/account/poll' && ++polls === 3) {
        backend = { ...backend, account: { status: 'authorized', server_url: url, login: 'RichLogic', expires_at: Date.now() + 300_000 } };
      }
      if (String(path) === '/api/remote/enroll') {
        enrollments.push(JSON.parse(String(init?.body)));
        if (backend.account?.status !== 'authorized') return Response.json({ error: 'remote_auth_required' }, { status: 401 });
        backend = { ...backend, enrolled: true, host_id: 'host', host_name: 'Studio Mac', server_url: url,
          server_identity_fingerprint: 'a'.repeat(64), connection: 'online' };
      }
      return Response.json(backend);
    };
    const controller = createRemoteSettingsController({ fetchFn, pollIntervalMs: 60_000 });
    const view = renderRemote(controller);
    try {
      await act(async () => { await controller.refresh?.(); });
      fireEvent.click(screen.getByRole('button', { name: 'Connect Remote Server' }));
      const dialog = screen.getByRole('dialog', { name: 'Connect Remote Server' });
      fireEvent.change(within(dialog).getByLabelText('Remote Server URL'), { target: { value: url } });
      fireEvent.change(within(dialog).getByLabelText('Machine name'), { target: { value: 'Studio Mac' } });
      const token = within(dialog).getByLabelText('Enrollment token') as HTMLInputElement;
      fireEvent.change(token, { target: { value: 'first-secret' } });
      await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Connect' })); });
      expect(token.value).toBe('');
      expect(enrollments).toHaveLength(0);
      expect(within(dialog).queryByText('HOST-CODE')).toBeNull();
      const authorization = screen.getByRole('dialog', { name: 'Confirm GitHub account' });
      expect(within(authorization).getByText('HOST-CODE')).toBeTruthy();
      expect((within(dialog).getByLabelText('Remote Server URL') as HTMLInputElement).value).toBe(url);
      expect((within(dialog).getByLabelText('Machine name') as HTMLInputElement).value).toBe('Studio Mac');
      for (let i = 1; i <= 3; i++) {
        await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
        expect(polls).toBe(i);
      }
      expect(enrollments).toEqual([
        { server_url: url, enrollment_token: 'first-secret', host_name: 'Studio Mac' },
      ]);
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(screen.getByTestId('remote-link-status').textContent).toBe('Online');
      expect(document.body.textContent).not.toMatch(/first-secret|fresh-secret/);
      await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
      expect(polls).toBe(3);
    } finally { view.unmount(); controller.dispose?.(); environments.restore(); vi.useRealTimers(); }
  });

  it('does not independently poll an account from inside the enrollment form', async () => {
    vi.useFakeTimers();
    const environments = stubEnvironments([]);
    const fixture = createRemoteSettingsFixture();
    const state = fixture.getState();
    state.account = { status: 'pending', server_url: 'https://remote.example.com', user_code: 'HOST-CODE',
      verification_uri: 'https://github.com/login/device', expires_at: Date.now() + 300_000, interval_seconds: 1 };
    fixture.startAccountLogin = vi.fn(async () => {});
    fixture.pollAccountLogin = vi.fn(async () => {});
    const view = renderRemote(fixture);
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Connect Remote Server' }));
      const dialog = screen.getByRole('dialog');
      fireEvent.change(within(dialog).getByLabelText('Remote Server URL'), { target: { value: 'https://remote.example.com' } });
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      expect(fixture.pollAccountLogin).not.toHaveBeenCalled();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
      expect(fixture.pollAccountLogin).not.toHaveBeenCalled();
    } finally { view.unmount(); environments.restore(); vi.useRealTimers(); }
  });

  it('not enrolled shows only the connect button; the dialog holds the three fields and no field notes', () => {
    renderRemote(createRemoteSettingsFixture());
    expect(screen.queryByTestId('remote-account-login')).toBeNull();
    expect(screen.queryByRole('button', { name: /GitHub/ })).toBeNull();
    expect(screen.queryByLabelText('Enrollment token')).toBeNull();
    expect(screen.queryByTestId('settings-remote-devices')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Connect Remote Server' }));
    const dialog = screen.getByRole('dialog', { name: 'Connect Remote Server' });
    expect(within(dialog).getByLabelText('Remote Server URL')).toBeTruthy();
    expect(within(dialog).getByLabelText('Enrollment token')).toBeTruthy();
    expect(within(dialog).getByLabelText('Machine name')).toBeTruthy();
    // No under-field hint text anywhere in the dialog.
    expect(dialog.querySelector('.hint')).toBeNull();
  });

  it('the token "i" tooltip explains how to obtain a token and links the HTTPS registration page', () => {
    renderRemote(createRemoteSettingsFixture());
    fireEvent.click(screen.getByRole('button', { name: 'Connect Remote Server' }));
    const dialog = screen.getByRole('dialog', { name: 'Connect Remote Server' });
    fireEvent.change(within(dialog).getByLabelText('Remote Server URL'), {
      target: { value: 'https://remote.example.com' },
    });
    const info = within(dialog).getByRole('note', { name: 'How do I get an enrollment token?' });
    expect(info.textContent).toContain('gian-remote-server enrollment create');
    expect(info.textContent).toContain('docker compose exec remote gian-remote-server enrollment create');
    expect(info.textContent).toContain('not the administrator key');
    const link = within(info).getByRole('link', { name: 'Open Host registration' });
    expect(link).toHaveAttribute('href', 'https://remote.example.com/enrollment');

    fireEvent.change(within(dialog).getByLabelText('Remote Server URL'), {
      target: { value: 'https://secret@remote.example.com' },
    });
    expect(within(info).queryByRole('link')).toBeNull();
  });

  it('enrolls with an optional machine name: token is cleared immediately and never echoed', async () => {
    const fixture = createRemoteSettingsFixture();
    const enroll = vi.spyOn(fixture, 'enroll');
    renderRemote(fixture);

    fireEvent.click(screen.getByRole('button', { name: 'Connect Remote Server' }));
    const dialog = screen.getByRole('dialog', { name: 'Connect Remote Server' });
    fireEvent.change(within(dialog).getByLabelText('Remote Server URL'), {
      target: { value: 'https://remote.example.com' },
    });
    fireEvent.change(within(dialog).getByLabelText('Machine name'), { target: { value: '  Home Mac  ' } });
    const tokenInput = within(dialog).getByLabelText('Enrollment token') as HTMLInputElement;
    fireEvent.change(tokenInput, { target: { value: 'one-time-secret-token' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Connect' }));

    // Cleared synchronously on submit — the pending UI must not retain it.
    expect(tokenInput.value).toBe('');
    expect(enroll).toHaveBeenCalledWith({
      serverUrl: 'https://remote.example.com',
      enrollmentToken: 'one-time-secret-token',
      hostName: 'Home Mac',
    });

    await screen.findByTestId('remote-link-status');
    expect(screen.getByTestId('remote-link-status').textContent).toBe('Online');
    expect(screen.getByText('https://remote.example.com')).toBeTruthy();
    expect(document.body.textContent).not.toContain('one-time-secret-token');
  });

  it('omits the machine name when the field is left empty', async () => {
    const fixture = createRemoteSettingsFixture();
    const enroll = vi.spyOn(fixture, 'enroll');
    renderRemote(fixture);
    fireEvent.click(screen.getByRole('button', { name: 'Connect Remote Server' }));
    const dialog = screen.getByRole('dialog', { name: 'Connect Remote Server' });
    fireEvent.change(within(dialog).getByLabelText('Remote Server URL'), {
      target: { value: 'https://remote.example.com' },
    });
    fireEvent.change(within(dialog).getByLabelText('Enrollment token'), { target: { value: 't' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Connect' }));
    expect(enroll).toHaveBeenCalledWith({
      serverUrl: 'https://remote.example.com',
      enrollmentToken: 't',
    });
    await screen.findByTestId('remote-link-status');
  });

  it('keeps the dialog open with the canonical error when enrollment fails', async () => {
    const fixture = createRemoteSettingsFixture();
    fixture.failNextEnroll('invalid enrollment token');
    renderRemote(fixture);

    fireEvent.click(screen.getByRole('button', { name: 'Connect Remote Server' }));
    const dialog = screen.getByRole('dialog', { name: 'Connect Remote Server' });
    fireEvent.change(within(dialog).getByLabelText('Remote Server URL'), {
      target: { value: 'https://remote.example.com' },
    });
    fireEvent.change(within(dialog).getByLabelText('Enrollment token'), { target: { value: 'bad' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Connect' }));

    const error = await within(dialog).findByRole('alert');
    expect(error.textContent).toContain('Connection failed');
    expect(error.textContent).toContain('invalid enrollment token');
    expect(fixture.getState().enrollment.kind).toBe('connect-failed');
  });

  it('edits the remote computer name without re-enrollment', async () => {
    const fixture = createRemoteSettingsFixture({ enrolled: true });
    const rename = vi.fn(fixture.setHostName!);
    fixture.setHostName = rename;
    renderRemote(fixture);
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    const input = screen.getByRole('textbox', { name: 'Host Name' });
    fireEvent.change(input, { target: { value: '  Home Mac  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
    await screen.findByText('Home Mac');
    expect(rename).toHaveBeenCalledWith('Home Mac');
    expect(fixture.getState().enrollment.kind).toBe('connected');
  });

  it('one merged disconnect: confirmed once, it wipes enrollment and devices', async () => {
    const fixture = createRemoteSettingsFixture({ enrolled: true, devices: [device()] });
    const disable = vi.spyOn(fixture, 'disableRemote');
    renderRemote(fixture);

    // There is exactly one destructive action — no second "disable" variant.
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(fixture.getState().enrollment.kind).toBe('connected');
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('removes the local enrollment');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Disconnect' }));

    await waitFor(() => expect(fixture.getState().enrollment.kind).toBe('not-enrolled'));
    expect(disable).toHaveBeenCalledTimes(1);
    expect(fixture.getState().devices).toHaveLength(0);
    // Back to the connect button; the device card is gone with the enrollment.
    expect(await screen.findByRole('button', { name: 'Connect Remote Server' })).toBeTruthy();
    expect(screen.queryByTestId('settings-remote-devices')).toBeNull();
  });

  it('blocks on server identity change and requires explicit confirmation', async () => {
    const fixture = createRemoteSettingsFixture({ enrolled: true });
    renderRemote(fixture);

    act(() => fixture.simulateServerIdentityChange());
    const warning = await screen.findByTestId('remote-identity-changed');
    expect(warning.textContent).toContain('Server identity changed');
    const fingerprints = [...warning.querySelectorAll('.rs-fingerprint')].map(el => el.textContent);
    expect(fingerprints).toHaveLength(2);
    expect(fingerprints[0]).not.toBe(fingerprints[1]);

    fireEvent.click(screen.getByRole('button', { name: 'Trust new identity' }));
    await waitFor(() => expect(fixture.getState().enrollment.kind).toBe('connected'));
  });

  it('rejecting an identity change keeps the Host disconnected', async () => {
    const fixture = createRemoteSettingsFixture({ enrolled: true });
    renderRemote(fixture);

    act(() => fixture.simulateServerIdentityChange());
    await screen.findByTestId('remote-identity-changed');
    fireEvent.click(screen.getByRole('button', { name: 'Keep disconnected' }));
    await waitFor(() => expect(fixture.getState().enrollment.kind).toBe('disconnected'));
  });
});

describe('Settings › Remote — devices', () => {
  async function createGrant(fixture: RemoteSettingsFixture) {
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(fixture.getState().pairing.kind).toBe('awaiting-claim'));
  }

  it('Add opens the grant dialog with one QR + one Crockford short code + countdown', async () => {
    const fixture = createRemoteSettingsFixture({ enrolled: true });
    renderRemote(fixture);
    await createGrant(fixture);

    const dialog = screen.getByRole('dialog', { name: 'Add' });
    const code = within(dialog).getByTestId('pairing-short-code').textContent ?? '';
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(within(dialog).getByTestId('pairing-qr').querySelector('svg')).toBeTruthy();
    expect(within(dialog).getByTestId('pairing-countdown').textContent ?? '').toMatch(/^[45]:[0-5]\d$/);
  });

  it('copies the exact QR invitation with a selectable fallback', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const fixture = createRemoteSettingsFixture({ enrolled: true });
    renderRemote(fixture);
    try {
      await createGrant(fixture);
      const pairing = fixture.getState().pairing;
      if (pairing.kind !== 'awaiting-claim') throw new Error('expected unclaimed invitation');
      const link = screen.getByRole('textbox', { name: 'Pairing link' }) as HTMLInputElement;
      expect(link.value).toBe(pairing.qrPayload);
      expect(link.readOnly).toBe(true);
      expect(new URL(link.value).hash).toContain('nonce=');
      fireEvent.click(screen.getByRole('button', { name: 'Copy pairing link' }));
      await screen.findByText('Pairing link copied.');
      expect(writeText).toHaveBeenCalledWith(pairing.qrPayload);
    } finally {
      if (original) Object.defineProperty(navigator, 'clipboard', original);
      else Reflect.deleteProperty(navigator, 'clipboard');
    }
  });

  it('claim shows the local confirmation; Allow consumes the grant and lists the device', async () => {
    const fixture = createRemoteSettingsFixture({ enrolled: true });
    renderRemote(fixture);
    await createGrant(fixture);

    act(() => fixture.simulateClaim({
      deviceName: 'Pixel 10',
      browser: 'Chrome',
      os: 'Android 16',
      networkOrigin: 'Berlin · 85.214.x.x',
    }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Confirm this device?')).toBeTruthy();
    expect(within(dialog).getByText('Pixel 10')).toBeTruthy();
    expect(within(dialog).getByText('Chrome')).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Allow device' }));
    await waitFor(() => expect(fixture.getState().pairing.kind).toBe('consumed'));
    expect(fixture.getState().devices.map(d => d.name)).toContain('Pixel 10');
  });

  it('Reject is an explicit command and leaves no device behind', async () => {
    const fixture = createRemoteSettingsFixture({ enrolled: true });
    renderRemote(fixture);
    await createGrant(fixture);

    act(() => fixture.simulateClaim());
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reject' }));

    await waitFor(() => expect(fixture.getState().pairing.kind).toBe('rejected'));
    expect(fixture.getState().devices).toHaveLength(0);
  });

  it('the expired branch offers a fresh grant in place', async () => {
    const fixture = createRemoteSettingsFixture({ enrolled: true });
    renderRemote(fixture);
    await createGrant(fixture);

    act(() => fixture.simulateExpire());
    const dialog = screen.getByRole('dialog', { name: 'Add' });
    expect(within(dialog).getByText(/grant expired/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Generate new code' }));
    await waitFor(() => expect(fixture.getState().pairing.kind).toBe('awaiting-claim'));
  });

  it('a connected device row shows only name, last-seen status and Revoke', () => {
    const fixture = createRemoteSettingsFixture({ enrolled: true, devices: [device()] });
    renderRemote(fixture);
    const row = screen.getByTestId('remote-device-device-1');
    expect(row.textContent).toContain('iPhone 17');
    expect(screen.getByTestId('remote-device-status-device-1').textContent)
      .toContain('Connected · last seen');
    expect(within(row).getByRole('button', { name: 'Revoke' })).toBeTruthy();
    // The old metadata (platform, created, connections, audit) stays out.
    expect(row.textContent).not.toContain('iOS 26 · Safari');
    expect(row.textContent).not.toContain('Created');
    expect(within(row).queryByRole('button', { name: 'Recent remote activity' })).toBeNull();
  });

  it('revoke requires the danger confirm, then reports pending — never premature completion', async () => {
    const fixture = createRemoteSettingsFixture({ enrolled: true, devices: [device()] });
    renderRemote(fixture);

    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    expect(fixture.getState().devices[0]!.revokeStatus).toBe('active');
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('iPhone 17');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }));

    await waitFor(() =>
      expect(fixture.getState().devices[0]!.revokeStatus).toBe('pending-reconciliation'),
    );
    expect(screen.getByTestId('remote-device-status-device-1').textContent)
      .toBe('Revoked locally — Server reconciliation pending');

    act(() => fixture.simulateRevokeSettled('device-1'));
    await waitFor(() =>
      expect(screen.queryByTestId('remote-device-device-1')).toBeNull(),
    );
    expect(screen.getByText('No devices paired yet.')).toBeTruthy();
  });

  it('hides already-revoked records but keeps pending reconciliation visible', () => {
    const fixture = createRemoteSettingsFixture({
      enrolled: true,
      devices: [
        device({ id: 'revoked', name: 'Old phone', revokeStatus: 'revoked' }),
        device({ id: 'pending', name: 'Pending phone', revokeStatus: 'pending-reconciliation' }),
      ],
    });
    renderRemote(fixture);

    expect(screen.queryByText('Old phone')).toBeNull();
    expect(screen.getByText('Pending phone')).toBeTruthy();
    expect(screen.getByTestId('remote-device-status-pending').textContent)
      .toBe('Revoked locally — Server reconciliation pending');
  });
});

describe('Settings › Remote — 控制其他 Gian', () => {
  it('lists environments with name and status; remove goes through the confirmed DELETE', async () => {
    const stub = stubEnvironments([environment()]);
    renderRemote(createRemoteSettingsFixture());
    try {
      expect(await screen.findByText('Mac mini')).toBeTruthy();
      expect(screen.getByText('Connected')).toBeTruthy();

      fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
      const dialog = await screen.findByRole('alertdialog');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));

      await waitFor(() => expect(stub.calls.some(call => call.method === 'DELETE'
        && call.path === '/api/remote/environments/11111111-1111-4111-8111-111111111111')).toBe(true));
      await waitFor(() => expect(screen.queryByText('Mac mini')).toBeNull());
      expect(await screen.findByText('No other Gian connected yet.')).toBeTruthy();
    } finally {
      stub.restore();
    }
  });

  it('the connect dialog pairs with Server URL + code (+ optional name), prefilled from the enrollment', async () => {
    const stub = stubEnvironments([]);
    renderRemote(createRemoteSettingsFixture({ enrolled: true }));
    try {
      fireEvent.click(await screen.findByRole('button', { name: 'Connect' }));
      const dialog = screen.getByRole('dialog', { name: 'Connect another Gian' });
      expect((within(dialog).getByLabelText('Remote Server URL') as HTMLInputElement).value)
        .toBe('https://remote.example.com');
      fireEvent.change(within(dialog).getByLabelText('Pairing code'), { target: { value: 'ABCD-EFGH' } });
      fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'Mac mini' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Connect' }));

      await waitFor(() => expect(stub.calls.some(call => call.method === 'POST' && call.path === '/api/remote/environments')).toBe(true));
      const post = stub.calls.find(call => call.method === 'POST' && call.path === '/api/remote/environments')!;
      expect(stub.calls.some(call => call.path === '/api/remote/controller/account/start')).toBe(true);
      expect(post.body).toEqual({
        server_url: 'https://remote.example.com',
        code: 'ABCD-EFGH',
        name: 'Mac mini',
      });
      await screen.findByText('Mac mini');
    } finally {
      stub.restore();
    }
  });

  it('controller authorization uses the App account dialog and never the Host-role login or an unconfirmed pair request', async () => {
    const original = globalThis.fetch;
    const requests: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = String(input);
      requests.push(path);
      if (path === '/api/remote/environments') return Response.json({ environments: [] });
      if (path === '/api/remote/controller/account/start') return Response.json({ account: {
        status: 'pending', server_url: 'https://remote.example.com', user_code: 'CONTROLLER-CODE',
        verification_uri: 'https://github.com/login/device', expires_at: Date.now() + 300_000, interval_seconds: 5,
      } });
      return new Response('unauthorized', { status: 401 });
    }) as typeof fetch;
    const fixture = createRemoteSettingsFixture({ enrolled: true });
    const startLogin = vi.fn().mockResolvedValue(undefined);
    fixture.startAccountLogin = startLogin;
    renderRemote(fixture);
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
      const dialog = screen.getByRole('dialog', { name: 'Connect another Gian' });
      fireEvent.change(within(dialog).getByLabelText('Pairing code'), { target: { value: 'ABCD-EFGH' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Connect' }));

      const authorization = await screen.findByRole('dialog', { name: 'Confirm GitHub account' });
      expect(within(authorization).getByText('CONTROLLER-CODE')).toBeTruthy();
      expect(within(dialog).queryByTestId('environment-account-login')).toBeNull();
      expect(startLogin).not.toHaveBeenCalled();
      expect(requests).toEqual(['/api/remote/environments', '/api/remote/controller/account/start']);
      await act(async () => { fireEvent.click(within(authorization).getByRole('button', { name: 'Cancel' })); });
      expect(screen.queryByRole('dialog', { name: 'Confirm GitHub account' })).toBeNull();
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('Settings › Remote — SettingsBody integration', () => {
  function settingsConfig(): SystemConfig {
    return {
      host: '127.0.0.1', port: 8991, workspace_root: '~/Coding',
      theme: 'warm', accent: 'ember', density: 'cozy', locale: 'en',
      font_scale_chrome: 'md', font_scale_chat: 'md', font_scale_code: 'md',
      chat_font_size: 14, chat_font_family: 'system',
      terminal: { ...DEFAULT_TERMINAL_PREFERENCES },
      keymap: { preset: 'default', bindings: {} },
      layout: { ...DEFAULT_LAYOUT_PREFERENCES },
      tools: structuredClone(DEFAULT_TOOL_PREFERENCES),
      default_claude_model: '', default_claude_effort: '',
      default_codex_model: '', default_codex_effort: '',
      auth_username: '', external_editors: [], open_apps: {},
    };
  }

  it('exposes the Remote section in the Settings nav and anchors it', () => {
    const fixture = createRemoteSettingsFixture();
    const { container } = renderWithOperations(
      <SettingsBody
        config={settingsConfig()}
        activeSection="remote"
        remoteController={fixture}
      />,
    );
    const navigation = container.querySelector('.settings2-internal-nav')!;
    expect(within(navigation as HTMLElement).getByRole('button', { name: 'Remote' })).toBeTruthy();
    expect(document.getElementById('settings-section-remote')).not.toBeNull();
    expect(screen.getByTestId('settings-remote-enrollment')).toBeTruthy();
  });
});
