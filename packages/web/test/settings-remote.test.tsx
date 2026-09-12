/**
 * Settings › Remote (WP5 phase 3) — component tests over the fixture
 * `RemoteSettingsController`. Covers the enrollment states, the pairing
 * state machine (awaiting-claim → claimed → allow/reject, expired,
 * consumed), the confirmed revoke flow with its pending/reconciliation
 * states, and the redacted audit rendering.
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
import type { SystemConfig } from '@gian/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsBody } from '../src/components/SettingsBody.js';
import { SettingsRemotePage } from '../src/components/SettingsRemotePage.js';
import { Toaster } from '../src/components/Toaster.js';
import { __resetFeedback } from '../src/feedback.js';
import { createRemoteSettingsFixture } from '../src/remote-settings/fixture.js';
import type { RemoteSettingsFixture } from '../src/remote-settings/fixture.js';
import type { RemoteAuditEntry, RemoteDeviceInfo } from '../src/remote-settings/types.js';
import { renderWithOperations } from './operation-test-utils.js';

function renderRemote(fixture: RemoteSettingsFixture | null) {
  return render(
    <>
      <SettingsRemotePage controller={fixture} />
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
    lastSeenAt: Date.UTC(2026, 8, 1, 12, 0),
    activeConnections: 1,
    revokeStatus: 'active',
    ...overrides,
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

describe('Settings › Remote — enrollment', () => {
  it('enrolls: token is cleared from UI state immediately and never echoed', async () => {
    const fixture = createRemoteSettingsFixture();
    const enroll = vi.spyOn(fixture, 'enroll');
    renderRemote(fixture);

    fireEvent.change(screen.getByLabelText('Remote Server URL'), {
      target: { value: 'https://remote.example.com' },
    });
    const tokenInput = screen.getByLabelText('Enrollment token') as HTMLInputElement;
    fireEvent.change(tokenInput, { target: { value: 'one-time-secret-token' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    // Cleared synchronously on submit — the pending UI must not retain it.
    expect(tokenInput.value).toBe('');
    expect(enroll).toHaveBeenCalledWith({
      serverUrl: 'https://remote.example.com',
      enrollmentToken: 'one-time-secret-token',
    });

    // Pending → connected with the connected-view facts.
    await screen.findByTestId('remote-link-status');
    expect(screen.getByTestId('remote-link-status').textContent).toBe('Online');
    expect(screen.getByText('https://remote.example.com')).toBeTruthy();
    expect(screen.getByText("Rich's MacBook Pro")).toBeTruthy();
    // Fingerprint summary is rendered, token is nowhere in the document.
    expect(document.querySelector('.rs-fingerprint')?.textContent).toBeTruthy();
    expect(document.body.textContent).not.toContain('one-time-secret-token');
  });

  it('shows the connect-failed branch with the canonical error', async () => {
    const fixture = createRemoteSettingsFixture();
    fixture.failNextEnroll('invalid enrollment token');
    renderRemote(fixture);

    fireEvent.change(screen.getByLabelText('Remote Server URL'), {
      target: { value: 'https://remote.example.com' },
    });
    fireEvent.change(screen.getByLabelText('Enrollment token'), { target: { value: 'bad' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    const error = await screen.findByRole('alert');
    expect(error.textContent).toContain('Connection failed');
    expect(error.textContent).toContain('invalid enrollment token');
    expect(fixture.getState().enrollment.kind).toBe('connect-failed');
  });

  it('disconnect requires the danger confirm dialog, not a plain toggle', async () => {
    const fixture = createRemoteSettingsFixture({ enrolled: true });
    renderRemote(fixture);

    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    // Nothing happened yet — the confirm dialog owns the decision.
    expect(fixture.getState().enrollment.kind).toBe('connected');
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Disconnect' }));

    await waitFor(() => expect(fixture.getState().enrollment.kind).toBe('disconnected'));
    expect(await screen.findByTestId('remote-link-status')).toBeTruthy();
    expect(screen.getByTestId('remote-link-status').textContent).toBe('Disconnected');
    // Enrollment is kept: reconnect does not ask for a token again.
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
    await waitFor(() => expect(fixture.getState().enrollment.kind).toBe('connected'));
  });

  it('emergency disable requires a confirmed destructive dialog and drops enrollment', async () => {
    const fixture = createRemoteSettingsFixture({ enrolled: true, devices: [device()] });
    renderRemote(fixture);

    fireEvent.click(screen.getByRole('button', { name: 'Emergency disable' }));
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Emergency disable' }));

    await waitFor(() => expect(fixture.getState().enrollment.kind).toBe('not-enrolled'));
    // Back to the enrollment form; device list dropped with the enrollment.
    expect(await screen.findByLabelText('Enrollment token')).toBeTruthy();
    expect(fixture.getState().devices).toHaveLength(0);
  });

  it('blocks on server identity change and requires explicit confirmation', async () => {
    const fixture = createRemoteSettingsFixture({ enrolled: true });
    renderRemote(fixture);

    act(() => fixture.simulateServerIdentityChange());
    const warning = await screen.findByTestId('remote-identity-changed');
    expect(warning.textContent).toContain('Server identity changed');
    // Old and new fingerprints are both visible and distinct.
    const fingerprints = [...warning.querySelectorAll('.rs-fingerprint')].map(el => el.textContent);
    expect(fingerprints).toHaveLength(2);
    expect(fingerprints[0]).not.toBe(fingerprints[1]);

    // Confirming is an explicit command; afterwards the new fingerprint is pinned.
    fireEvent.click(screen.getByRole('button', { name: 'Trust new identity' }));
    await waitFor(() => expect(fixture.getState().enrollment.kind).toBe('connected'));
    const enrollment = fixture.getState().enrollment;
    if (enrollment.kind !== 'connected') throw new Error('expected connected');
    expect(enrollment.info.serverIdentityFingerprint.length).toBe(64);
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

describe('Settings › Remote — pairing', () => {
  async function createGrant(fixture: RemoteSettingsFixture) {
    fireEvent.click(screen.getByRole('button', { name: 'Generate QR + code' }));
    await waitFor(() => expect(fixture.getState().pairing.kind).toBe('awaiting-claim'));
  }

  it('requires an enrollment before creating a grant', () => {
    const fixture = createRemoteSettingsFixture();
    renderRemote(fixture);
    expect(screen.getByRole('button', { name: 'Generate QR + code' })).toHaveProperty('disabled', true);
    expect(screen.getByText('Connect to a Remote Server first.')).toBeTruthy();
  });

  it('creates one QR + one Crockford short code with a live countdown', async () => {
    const fixture = createRemoteSettingsFixture({ enrolled: true });
    renderRemote(fixture);
    await createGrant(fixture);

    const code = screen.getByTestId('pairing-short-code').textContent ?? '';
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    // QR rendered as SVG from the same grant payload.
    expect(screen.getByTestId('pairing-qr').querySelector('svg')).toBeTruthy();
    const countdown = screen.getByTestId('pairing-countdown').textContent ?? '';
    expect(countdown).toMatch(/^[45]:[0-5]\d$/);
  });

  it('claim shows the local confirmation with device metadata; Allow consumes the grant', async () => {
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
    expect(within(dialog).getByText('Android 16')).toBeTruthy();
    expect(within(dialog).getByText('Berlin · 85.214.x.x')).toBeTruthy();
    // Never an auto-allow affordance.
    expect(within(dialog).queryByText(/automatic/i)).toBeNull();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Allow device' }));
    await waitFor(() => expect(fixture.getState().pairing.kind).toBe('consumed'));
    expect(await screen.findByText('Pixel 10 is now paired.')).toBeTruthy();
    // The device appears in the paired list.
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
    expect(await screen.findByText('The claim was rejected. No device was paired.')).toBeTruthy();
    expect(fixture.getState().devices).toHaveLength(0);
  });

  it('shows the expired branch and offers a new grant', async () => {
    const fixture = createRemoteSettingsFixture({ enrolled: true });
    renderRemote(fixture);
    await createGrant(fixture);

    act(() => fixture.simulateExpire());
    expect(await screen.findByText(/grant expired/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Generate new code' }));
    await waitFor(() => expect(fixture.getState().pairing.kind).toBe('idle'));
  });
});

describe('Settings › Remote — devices and audit', () => {
  const auditEntry: RemoteAuditEntry = {
    id: 'audit-1',
    at: Date.UTC(2026, 8, 1, 12, 30),
    deviceId: 'device-1',
    method: 'session.send',
    commandIdSummary: '0190a3f2',
    result: 'succeeded',
  };

  it('lists devices with name, platform, created, last seen, connections, status', () => {
    const fixture = createRemoteSettingsFixture({ enrolled: true, devices: [device()] });
    renderRemote(fixture);
    const row = screen.getByTestId('remote-device-device-1');
    expect(row.textContent).toContain('iPhone 17');
    expect(row.textContent).toContain('iOS 26 · Safari');
    expect(row.textContent).toContain('Active');
    expect(screen.getByTestId('remote-device-status-device-1').textContent).toBe('Active');
  });

  it('revoke requires the danger confirm, then reports pending — never premature completion', async () => {
    const fixture = createRemoteSettingsFixture({ enrolled: true, devices: [device()] });
    renderRemote(fixture);

    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    expect(fixture.getState().devices[0]!.revokeStatus).toBe('active');
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog.textContent).toContain('iPhone 17');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke' }));

    // Host marked it, Server reconciliation still outstanding: the UI shows
    // the non-terminal state, not "Revoked".
    await waitFor(() =>
      expect(fixture.getState().devices[0]!.revokeStatus).toBe('pending-reconciliation'),
    );
    expect(screen.getByTestId('remote-device-status-device-1').textContent)
      .toBe('Revoked locally — Server reconciliation pending');
    expect(screen.getByTestId('remote-device-status-device-1').textContent).not.toBe('Revoked');

    // Only the Host-reported settlement removes it from Paired devices.
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

  it('renders the bounded audit redacted: time, method, command summary, result category only', () => {
    const fixture = createRemoteSettingsFixture({
      enrolled: true,
      devices: [device()],
      audit: { 'device-1': [auditEntry] },
    });
    renderRemote(fixture);

    fireEvent.click(screen.getByRole('button', { name: 'Recent remote activity' }));
    const table = screen.getByTestId('remote-audit');
    expect(table.textContent).toContain('session.send');
    expect(table.textContent).toContain('0190a3f2');
    expect(table.textContent).toContain('Succeeded');
    // No prompt, params, token, path, or ciphertext surface — the row holds
    // exactly the four redacted fields.
    const cells = [...table.querySelectorAll('tbody td')].map(td => td.textContent?.trim());
    expect(cells).toHaveLength(4);
    expect(cells.join(' ')).not.toMatch(/token|prompt|\/Users|secret/i);
  });

  it('shows the empty audit state', () => {
    const fixture = createRemoteSettingsFixture({ enrolled: true, devices: [device()] });
    renderRemote(fixture);
    fireEvent.click(screen.getByRole('button', { name: 'Recent remote activity' }));
    expect(screen.getByText('No remote activity recorded for this device.')).toBeTruthy();
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
