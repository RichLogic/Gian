/**
 * FIXTURE adapter for the Remote Settings controller — tests and dev preview
 * only. This module must never ship in the production bundle: the only
 * production-side import is the dev-gated dynamic import in
 * `dev-entry.ts`, which Rollup drops when `import.meta.env.DEV` is false.
 *
 * It implements `RemoteSettingsController` with in-memory state and
 * deterministic, scripted transitions so every UI branch (enrollment states,
 * pairing state machine, revoke pending/reconciliation, audit rendering) can
 * be exercised without the Host remote subsystem. It does NOT pretend to be
 * a backend: nothing here persists, and the `simulate*` helpers exist so a
 * human or a test can drive the transitions a real Host connector would
 * report.
 */

import type {
  PairingClaimInfo,
  RemoteAuditEntry,
  RemoteDeviceInfo,
  RemoteEnrollmentInfo,
  RemoteSettingsController,
  RemoteSettingsState,
} from './types.js';

export const FIXTURE_GRANT_TTL_MS = 5 * 60 * 1000;

export interface RemoteSettingsFixtureOptions {
  /** Pre-enrolled state (default: not enrolled). */
  enrolled?: boolean;
  serverUrl?: string;
  hostRemoteName?: string;
  fingerprint?: string;
  devices?: RemoteDeviceInfo[];
  audit?: Record<string, RemoteAuditEntry[]>;
  now?: () => number;
}

function defaultFingerprint(seed: string): string {
  // Display-only fixture fingerprint: deterministic 64-char hex.
  let h = 0x811c9dc5;
  let out = '';
  while (out.length < 64) {
    for (let i = 0; i < seed.length; i++) {
      h ^= seed.charCodeAt(i) + out.length;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    out += h.toString(16).padStart(8, '0');
  }
  return out.slice(0, 64);
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function fixtureShortCode(rand: () => number): string {
  let raw = '';
  for (let i = 0; i < 8; i++) raw += CROCKFORD[Math.floor(rand() * 32) % 32];
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

export interface RemoteSettingsFixture extends RemoteSettingsController {
  /** Drive the transition the Host would report when a browser claims the
   *  current grant. */
  simulateClaim(claim?: Partial<PairingClaimInfo>): void;
  /** Drive the transition the Host would report when the grant lapses. */
  simulateExpire(): void;
  /** Drive the blocking identity-change warning (§5.1). */
  simulateServerIdentityChange(newFingerprint?: string): void;
  /** Complete a pending/reconciling revoke as the Host would. */
  simulateRevokeSettled(deviceId: string): void;
  /** Test hooks for enrol outcomes. */
  failNextEnroll(message: string): void;
}

export function createRemoteSettingsFixture(
  options: RemoteSettingsFixtureOptions = {},
): RemoteSettingsFixture {
  const now = options.now ?? (() => Date.now());
  const serverUrl = options.serverUrl ?? 'https://remote.example.com';
  const fingerprint = options.fingerprint ?? defaultFingerprint(`server:${serverUrl}`);

  const info: RemoteEnrollmentInfo = {
    serverUrl,
    hostRemoteName: options.hostRemoteName ?? "Rich's MacBook Pro",
    serverIdentityFingerprint: fingerprint,
    lastHeartbeatAt: options.enrolled ? now() : null,
  };

  let state: RemoteSettingsState = {
    enrollment: options.enrolled
      ? { kind: 'connected', info, link: 'online' }
      : { kind: 'not-enrolled' },
    pairing: { kind: 'idle' },
    devices: options.devices ?? [],
    audit: options.audit ?? {},
  };

  const listeners = new Set<() => void>();
  let expiryTimer: ReturnType<typeof setTimeout> | null = null;
  let nextEnrollError: string | null = null;
  let deviceSeq = 0;
  let auditSeq = 0;

  function emit(next: RemoteSettingsState): void {
    state = next;
    for (const listener of listeners) listener();
  }

  function clearExpiryTimer(): void {
    if (expiryTimer !== null) clearTimeout(expiryTimer);
    expiryTimer = null;
  }

  function scheduleExpiry(): void {
    clearExpiryTimer();
    if (state.pairing.kind !== 'awaiting-claim') return;
    const remaining = state.pairing.expiresAt - now();
    expiryTimer = setTimeout(() => {
      if (state.pairing.kind === 'awaiting-claim') {
        emit({ ...state, pairing: { kind: 'expired' } });
      }
    }, Math.max(remaining, 0));
  }

  function appendAudit(entry: Omit<RemoteAuditEntry, 'id'>): void {
    auditSeq += 1;
    const list = state.audit[entry.deviceId] ?? [];
    // Bounded per device (§5.8): keep the newest 1000 in the fixture too.
    const nextList = [{ ...entry, id: `audit-${auditSeq}` }, ...list].slice(0, 1000);
    emit({ ...state, audit: { ...state.audit, [entry.deviceId]: nextList } });
  }

  const fixture: RemoteSettingsFixture = {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async enroll(input) {
      clearExpiryTimer();
      emit({ ...state, enrollment: { kind: 'connecting', serverUrl: input.serverUrl } });
      // Yield so the pending state is observable before the canonical result.
      await Promise.resolve();
      if (nextEnrollError) {
        const message = nextEnrollError;
        nextEnrollError = null;
        emit({
          ...state,
          enrollment: { kind: 'connect-failed', serverUrl: input.serverUrl, error: message },
        });
        return;
      }
      const nextInfo: RemoteEnrollmentInfo = {
        serverUrl: input.serverUrl,
        hostRemoteName: info.hostRemoteName,
        serverIdentityFingerprint: fingerprint,
        lastHeartbeatAt: now(),
      };
      emit({ ...state, enrollment: { kind: 'connected', info: nextInfo, link: 'online' } });
    },

    async disconnect() {
      if (state.enrollment.kind !== 'connected') return;
      const current = state.enrollment.info;
      emit({ ...state, enrollment: { kind: 'disconnecting', info: current } });
      await Promise.resolve();
      emit({ ...state, enrollment: { kind: 'disconnected', info: current } });
    },

    async reconnect() {
      if (state.enrollment.kind !== 'disconnected') return;
      const current = state.enrollment.info;
      emit({ ...state, enrollment: { kind: 'connecting', serverUrl: current.serverUrl } });
      await Promise.resolve();
      emit({
        ...state,
        enrollment: {
          kind: 'connected',
          info: { ...current, lastHeartbeatAt: now() },
          link: 'online',
        },
      });
    },

    async disableRemote() {
      if (
        state.enrollment.kind !== 'connected' &&
        state.enrollment.kind !== 'disconnected' &&
        state.enrollment.kind !== 'identity-changed'
      ) {
        return;
      }
      const current = state.enrollment.info;
      emit({ ...state, enrollment: { kind: 'disconnecting', info: current } });
      await Promise.resolve();
      clearExpiryTimer();
      emit({
        enrollment: { kind: 'not-enrolled' },
        pairing: { kind: 'idle' },
        devices: [],
        audit: {},
      });
    },

    async setHostName(name) {
      const current = state.enrollment;
      if (current.kind !== 'connected') return;
      emit({ ...state, enrollment: { ...current, info: { ...current.info, hostRemoteName: name.trim() } } });
    },

    async confirmServerIdentityChange() {
      if (state.enrollment.kind !== 'identity-changed') return;
      const changed = state.enrollment;
      await Promise.resolve();
      emit({
        ...state,
        enrollment: {
          kind: 'connected',
          info: {
            ...changed.info,
            serverIdentityFingerprint: changed.newFingerprint,
            lastHeartbeatAt: now(),
          },
          link: 'online',
        },
      });
    },

    async rejectServerIdentityChange() {
      if (state.enrollment.kind !== 'identity-changed') return;
      const changed = state.enrollment;
      await Promise.resolve();
      emit({ ...state, enrollment: { kind: 'disconnected', info: changed.info } });
    },

    async startPairing() {
      if (state.enrollment.kind !== 'connected') return;
      emit({ ...state, pairing: { kind: 'creating' } });
      await Promise.resolve();
      const code = fixtureShortCode(() => Math.random());
      const qrPayload = `${(info.publicUrl ?? info.serverUrl).replace(/\/$/, '')}/#nonce=fixture-grant-${code.replace('-', '')}`;
      emit({
        ...state,
        pairing: {
          kind: 'awaiting-claim',
          code,
          qrPayload,
          expiresAt: now() + FIXTURE_GRANT_TTL_MS,
        },
      });
      scheduleExpiry();
    },

    async confirmPairingClaim(decision) {
      if (state.pairing.kind !== 'claimed' || state.pairing.decision !== 'idle') return;
      const claimed = state.pairing;
      emit({ ...state, pairing: { ...claimed, decision: 'pending' } });
      await Promise.resolve();
      clearExpiryTimer();
      if (decision === 'reject') {
        emit({ ...state, pairing: { kind: 'rejected' } });
        return;
      }
      deviceSeq += 1;
      const device: RemoteDeviceInfo = {
        id: `device-${deviceSeq}`,
        name: claimed.claim.deviceName,
        platform: `${claimed.claim.os} · ${claimed.claim.browser}`,
        createdAt: now(),
        lastSeenAt: now(),
        activeConnections: 1,
        revokeStatus: 'active',
      };
      emit({
        ...state,
        pairing: { kind: 'consumed', deviceName: claimed.claim.deviceName },
        devices: [...state.devices, device],
      });
    },

    async cancelPairing() {
      clearExpiryTimer();
      emit({ ...state, pairing: { kind: 'idle' } });
    },

    async revokeDevice(deviceId) {
      const device = state.devices.find(d => d.id === deviceId);
      if (!device || device.revokeStatus !== 'active') return;
      // Host applies revoked_at first; Server notification / route close is
      // still outstanding, so this is NOT a completed revoke (§5.6).
      const mark = (revokeStatus: RemoteDeviceInfo['revokeStatus']) =>
        state.devices.map(d => (d.id === deviceId ? { ...d, revokeStatus, activeConnections: 0 } : d));
      emit({ ...state, devices: mark('revoke-pending') });
      await Promise.resolve();
      // Fixture: simulate the Server being unreachable, so the row shows the
      // pending-reconciliation state until simulateRevokeSettled() is driven.
      emit({ ...state, devices: mark('pending-reconciliation') });
      appendAudit({
        at: now(),
        deviceId,
        method: 'device.revoke',
        commandIdSummary: `revk${deviceId.slice(-4)}`,
        result: 'succeeded',
      });
    },

    simulateClaim(claim = {}) {
      if (state.pairing.kind !== 'awaiting-claim') return;
      clearExpiryTimer();
      emit({
        ...state,
        pairing: {
          ...state.pairing,
          kind: 'claimed',
          decision: 'idle',
          claim: {
            deviceName: claim.deviceName ?? 'iPhone 17',
            browser: claim.browser ?? 'Safari',
            os: claim.os ?? 'iOS 26',
            networkOrigin: claim.networkOrigin ?? 'Shanghai · 223.104.x.x',
            claimedAt: claim.claimedAt ?? now(),
          },
        },
      });
    },

    simulateExpire() {
      if (state.pairing.kind !== 'awaiting-claim' && state.pairing.kind !== 'claimed') return;
      clearExpiryTimer();
      emit({ ...state, pairing: { kind: 'expired' } });
    },

    simulateServerIdentityChange(newFingerprint) {
      if (state.enrollment.kind !== 'connected' && state.enrollment.kind !== 'disconnected') return;
      const current = state.enrollment.info;
      emit({
        ...state,
        enrollment: {
          kind: 'identity-changed',
          info: current,
          previousFingerprint: current.serverIdentityFingerprint,
          newFingerprint: newFingerprint ?? defaultFingerprint(`changed:${current.serverUrl}`),
          detectedAt: now(),
        },
      });
    },

    simulateRevokeSettled(deviceId) {
      emit({
        ...state,
        devices: state.devices.map(d =>
          d.id === deviceId && d.revokeStatus !== 'active' ? { ...d, revokeStatus: 'revoked' } : d,
        ),
      });
    },

    failNextEnroll(message) {
      nextEnrollError = message;
    },
  };

  return fixture;
}
