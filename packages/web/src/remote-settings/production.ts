import type { RemoteSettingsSnapshot, RemoteSettingsPairing, RemoteSettingsAuditEntry } from '@gian/shared';
import type { RemoteSettingsController, RemoteSettingsState, RemotePairingState, RemoteAuditEntry } from './types.js';

export interface RemoteSettingsOptions {
  fetchFn?: typeof fetch;
  pollIntervalMs?: number;
}

const initialState = (): RemoteSettingsState => ({
  enrollment: { kind: 'loading' }, pairing: { kind: 'idle' }, devices: [], audit: {},
});
const time = (value: string | null): number | null => value ? Date.parse(value) : null;
const browserName = (ua: string | null): string => {
  if (!ua) return '—';
  if (/Edg\//.test(ua)) return 'Edge';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Chrome\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua)) return 'Safari';
  return '—';
};

function projectPairing(pairing: RemoteSettingsPairing | null): RemotePairingState {
  if (!pairing) return { kind: 'idle' };
  const grant = { pairingId: pairing.id, code: pairing.code ?? '', qrPayload: pairing.qr_payload ?? '', expiresAt: Date.parse(pairing.expires_at) };
  if (pairing.status === 'pending_claim') return { kind: 'awaiting-claim', ...grant };
  if (pairing.status === 'pending_confirmation') return {
    kind: 'claimed', ...grant, decision: 'idle',
    claim: {
      deviceName: pairing.device_name ?? pairing.platform ?? '—',
      browser: browserName(pairing.user_agent), os: pairing.platform ?? '—',
      networkOrigin: pairing.claimed_network ?? '—',
      claimedAt: time(pairing.claimed_at) ?? Date.parse(pairing.created_at),
    },
  };
  if (pairing.status === 'expired') return { kind: 'expired' };
  if (pairing.status === 'rejected') return { kind: 'rejected' };
  return { kind: 'consumed', deviceName: pairing.device_name ?? pairing.platform ?? '—' };
}

export function projectRemoteSettings(snapshot: RemoteSettingsSnapshot): RemoteSettingsState {
  const info = {
    serverUrl: snapshot.server_url ?? '', publicUrl: snapshot.public_url ?? snapshot.server_url ?? '',
    hostRemoteName: snapshot.host_name ?? '—',
    serverIdentityFingerprint: snapshot.server_identity_fingerprint ?? '',
    lastHeartbeatAt: time(snapshot.last_heartbeat_at),
  };
  const enrollment: RemoteSettingsState['enrollment'] = !snapshot.enrolled
    ? { kind: 'not-enrolled' }
    : snapshot.pending_identity_fingerprint ? {
      kind: 'identity-changed', info,
      previousFingerprint: info.serverIdentityFingerprint,
      newFingerprint: snapshot.pending_identity_fingerprint,
      detectedAt: time(snapshot.identity_changed_at) ?? 0,
    }
    : snapshot.connection === 'disconnected' ? { kind: 'disconnected', info }
      : { kind: 'connected', info, link: snapshot.connection };
  return {
    enrollment, pairing: projectPairing(snapshot.pairing), audit: {},
    devices: snapshot.devices.map(device => ({
      id: device.id, name: device.name, platform: device.platform,
      createdAt: Date.parse(device.created_at), lastSeenAt: time(device.last_seen_at),
      activeConnections: device.active_connections, revokeStatus: device.revoke_status,
    })),
  };
}

function snapshotFrom(value: unknown): RemoteSettingsSnapshot {
  const snapshot = value as RemoteSettingsSnapshot;
  if (!snapshot || typeof snapshot.enrolled !== 'boolean' || !Array.isArray(snapshot.devices)
      || !Array.isArray(snapshot.pending_pairings)
      || !['online', 'offline', 'reconnecting', 'disconnected'].includes(snapshot.connection)
      || (snapshot.enrolled && (!snapshot.server_url || !snapshot.server_identity_fingerprint))
      || !Object.hasOwn(snapshot, 'pairing')) throw new Error('invalid_snapshot');
  return snapshot;
}

/** No localStorage, tokens, optimistic authorization, or synthetic device state. */
export function createRemoteSettingsController(options: RemoteSettingsOptions = {}): RemoteSettingsController {
  const fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
  const listeners = new Set<() => void>();
  const requests = new Set<AbortController>();
  let state = initialState();
  let snapshot: RemoteSettingsSnapshot | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let reads = 0;
  let mutations = 0;
  let polling = 0;

  const emit = (next: RemoteSettingsState) => {
    if (disposed) return;
    state = next;
    for (const listener of listeners) listener();
  };
  const request = async (path: string, data?: unknown): Promise<unknown> => {
    const abort = new AbortController();
    requests.add(abort);
    const timeout = setTimeout(() => abort.abort(), 15_000);
    try {
      const response = await fetchFn('/api/remote' + path, {
        ...(data === undefined ? {} : { method: 'POST', body: JSON.stringify(data) }),
        headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        cache: 'no-store', signal: abort.signal,
      });
      if (!response.ok) throw new Error('request_failed');
      return await response.json();
    } finally { clearTimeout(timeout); requests.delete(abort); }
  };
  const refresh = async () => {
    const read = ++reads;
    const mutation = mutations;
    try {
      const next = snapshotFrom(await request('/settings'));
      if (disposed || read !== reads || mutation !== mutations) return;
      snapshot = next;
      const projected = projectRemoteSettings(next);
      if (state.busy && projected.pairing.kind === 'claimed') projected.pairing.decision = 'pending';
      emit({ ...projected, audit: state.audit, busy: state.busy,
        error: state.error === 'load_failed' ? null : state.error });
    } catch {
      if (!disposed && read === reads && mutation === mutations) emit({ ...state, error: 'load_failed' });
    }
  };
  const tick = async (generation: number) => {
    if (disposed || !listeners.size || generation !== polling) return;
    if (!state.busy) await refresh();
    if (!disposed && listeners.size && generation === polling) {
      timer = setTimeout(() => { void tick(generation); }, options.pollIntervalMs ?? 1500);
    }
  };
  const mutate = async (path: string, data: unknown = {}, transient?: Partial<RemoteSettingsState>) => {
    if (disposed || state.busy || !snapshot || state.error === 'load_failed') return;
    ++mutations;
    ++reads; // Any read started before this action must not overwrite its result.
    emit({ ...state, ...transient, busy: true, error: null });
    try {
      await request(path, data);
      await refresh();
    } catch {
      // The request might have committed before the connection failed; recover
      // canonical state, never automatically replay a mutation.
      await refresh();
      emit({ ...state, error: state.error === 'load_failed' ? 'load_failed' : 'operation_failed' });
    } finally {
      const pairing = state.pairing.kind === 'claimed' ? { ...state.pairing, decision: 'idle' as const } : state.pairing;
      emit({ ...state, pairing, busy: false });
    }
  };
  const pairingPath = (action: string): string | null =>
    snapshot?.pairing ? '/pairings/' + encodeURIComponent(snapshot.pairing.id) + '/' + action : null;
  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) void tick(++polling);
      return () => {
        listeners.delete(listener);
        if (!listeners.size) { clearTimeout(timer); ++reads; ++polling; }
      };
    },
    refresh,
    enroll: input => mutate('/enroll', { server_url: input.serverUrl, enrollment_token: input.enrollmentToken },
      { enrollment: { kind: 'connecting', serverUrl: input.serverUrl } }),
    disconnect: () => mutate('/disconnect'),
    reconnect: () => mutate('/reconnect'),
    disableRemote: () => mutate('/disable'),
    setPublicUrl: url => mutate('/public-url', { public_url: url }),
    confirmServerIdentityChange: expected => mutate('/enrollment/confirm-identity',
      { expected_fingerprint: expected ?? snapshot?.pending_identity_fingerprint }),
    rejectServerIdentityChange: () => mutate('/enrollment/reject-identity'),
    startPairing: () => mutate('/pairings', {}, { pairing: { kind: 'creating' } }),
    confirmPairingClaim: (decision, displayedPairingId) => {
      const id = displayedPairingId ?? snapshot?.pairing?.id;
      const path = id ? '/pairings/' + encodeURIComponent(id) + '/' + (decision === 'allow' ? 'confirm' : 'reject') : null;
      return path ? mutate(path) : Promise.resolve();
    },
    cancelPairing: () => {
      const path = pairingPath('cancel');
      return path ? mutate(path) : Promise.resolve();
    },
    revokeDevice: id => mutate('/devices/' + encodeURIComponent(id) + '/revoke'),
    async loadAudit(id) {
      const mutation = mutations;
      try {
        const response = await request('/devices/' + encodeURIComponent(id) + '/audit') as { entries: RemoteSettingsAuditEntry[] };
        if (disposed || mutation !== mutations || !snapshot?.devices.some(device => device.id === id)) return;
        const result: Record<RemoteSettingsAuditEntry['resultCategory'], RemoteAuditEntry['result']> = {
          accepted: 'pending', succeeded: 'succeeded', failed: 'failed', denied: 'rejected',
          expired: 'rejected', precondition_failed: 'rejected', unknown_outcome: 'unknown-outcome',
        };
        const entries = response.entries.map(entry => ({
          id: entry.id, deviceId: id, at: Date.parse(entry.createdAt), method: entry.method,
          commandIdSummary: entry.commandId.slice(0, 8), result: result[entry.resultCategory] ?? 'unknown-outcome',
        }));
        emit({ ...state, audit: { ...state.audit, [id]: entries } });
      } catch { emit({ ...state, error: 'operation_failed' }); }
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      for (const request of requests) request.abort();
      listeners.clear();
    },
  };
}
