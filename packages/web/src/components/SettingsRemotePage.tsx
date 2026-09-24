/**
 * Settings › Remote — two scopes:
 *
 * 控制这个 Gian (this Mac as a Host): Server enrollment lives behind one
 * connect button + dialog (URL / token / machine name only, no field notes);
 * once enrolled the card shows URL / remote name (editable) / status and a
 * single destructive disconnect that wipes everything (enrollment, pairings,
 * secrets — the merged meaning of the old Disconnect and Emergency Disable).
 * Paired devices reduce to name / status / last-seen / Revoke; adding a
 * device is a dialog with the QR grant.
 *
 * 控制其他 Gian (this Mac as a controller): remote environments (other Gian
 * Hosts) with a connect dialog (Server URL + pairing code + optional name)
 * and per-row removal.
 *
 * Pure presentation over `RemoteSettingsController` + the /api/remote
 * environment endpoints: every mutation goes through them, the enrollment
 * token is cleared from local UI state immediately on submit and is never
 * echoed back, and destructive actions stay behind confirmed commands.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import QRCode from 'qrcode';
import { confirm } from '../feedback.js';
import { useT } from '../i18n/index.js';
import { remoteRequest, type RemoteEnvironment } from '../remote-environments.js';
import { authorizeRemoteAccount } from '../auth/github-authorization.js';
import type {
  RemoteDeviceInfo,
  RemoteEnrollmentInfo,
  RemoteSettingsController,
  RemoteSettingsState,
} from '../remote-settings/types.js';

export function SettingsRemotePage({
  controller,
}: {
  controller: RemoteSettingsController | null;
}) {
  const t = useT();
  if (!controller) {
    return (
      <div className="s2-card" data-testid="settings-remote-unavailable">
        <p className="s2-help">{t('settings.remote.unavailable')}</p>
      </div>
    );
  }
  return <SettingsRemoteLoaded controller={controller} />;
}

function SettingsRemoteLoaded({ controller }: { controller: RemoteSettingsController }) {
  const t = useT();
  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);
  const enrollment = state.enrollment;
  const enrolled = enrollment.kind === 'connected' || enrollment.kind === 'disconnected'
    || enrollment.kind === 'disconnecting';
  const online = enrollment.kind === 'connected' && enrollment.link === 'online';

  return (
    <>
      {state.error && <div className="s2-card" role="alert">
        <p className="field-error">{t('settings.remote.error.' + state.error)}</p>
        <button className="btn secondary" onClick={() => void controller.refresh?.()}>
          {t('settings.remote.retry')}
        </button>
      </div>}
      <fieldset disabled={state.busy || state.error === 'load_failed'} className="rs-live-actions">
      <div className="s2-card" data-testid="settings-remote-enrollment">
        <h4 className="s2-subhead">{t('settings.remote.thisGian')}</h4>
        {enrollment.kind === 'loading' && <p className="s2-help">{t('settings.remote.loading')}</p>}
        {enrollment.kind === 'identity-changed' && (
          <IdentityChangedBlock controller={controller} enrollment={enrollment} />
        )}
        {enrolled && <ConnectedBlock controller={controller} enrollment={enrollment} />}
        {(enrollment.kind === 'not-enrolled' || enrollment.kind === 'connecting'
          || enrollment.kind === 'connect-failed') && (
          <EnrollGate controller={controller} state={state} />
        )}
      </div>
      {enrolled && (
        <div className="s2-card" data-testid="settings-remote-devices">
          <div className="rs-card-head">
            <h4 className="s2-subhead">{t('settings.remote.devices.title')}</h4>
            <button
              type="button"
              className="btn sm primary"
              disabled={!online}
              title={online ? undefined : t('settings.remote.pair.requiresConnection')}
              onClick={() => void controller.startPairing()}
            >
              {t('settings.remote.devices.add')}
            </button>
          </div>
          <DevicesBlock controller={controller} state={state} />
        </div>
      )}
      <div className="s2-card" data-testid="settings-remote-environments">
        <EnvironmentsBlock state={state} />
      </div>
      </fieldset>
      {state.pairing.kind !== 'idle' && (
        <PairingDialog controller={controller} state={state} />
      )}
      {state.pairing.kind === 'claimed' && (
        <PairingClaimDialog controller={controller} pairing={{ ...state.pairing, decision: state.busy ? 'pending' : state.pairing.decision }} />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Shared dialog shell (same overlay styling as the claim confirmation)
// ---------------------------------------------------------------------------

function Dialog({ label, onClose, children }: {
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="confirm-overlay" onClick={onClose}>
      <div
        className="confirm-modal rs-modal"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onClick={event => event.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 控制这个 Gian — connect dialog + enrolled info
// ---------------------------------------------------------------------------

function EnrollGate({ controller, state }: {
  controller: RemoteSettingsController;
  state: RemoteSettingsState;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const connecting = state.enrollment.kind === 'connecting';
  return (
    <div>
      <div className="rs-actions">
        <button
          type="button"
          className="btn primary"
          disabled={connecting}
          onClick={() => setOpen(true)}
        >
          {connecting ? t('settings.remote.connecting') : t('settings.remote.connectServer')}
        </button>
      </div>
      {open && <EnrollDialog controller={controller} state={state} onClose={() => setOpen(false)} />}
    </div>
  );
}

function EnrollDialog({ controller, state, onClose }: {
  controller: RemoteSettingsController;
  state: RemoteSettingsState;
  onClose: () => void;
}) {
  const t = useT();
  const enrollment = state.enrollment;
  const connecting = enrollment.kind === 'connecting';
  const [serverUrl, setServerUrl] = useState('');
  const [token, setToken] = useState('');
  const [hostName, setHostName] = useState('');

  let registrationUrl: string | undefined;
  let validOrigin: string | null = null;
  try {
    const url = new URL(serverUrl.trim());
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol === 'https:' || (url.protocol === 'http:' && loopback))
      && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/') {
      validOrigin = url.origin;
      registrationUrl = `${validOrigin}/enrollment`;
    }
  } catch { /* Wait for a complete Server URL. */ }
  // Success flips the page to the enrolled view; the dialog only needs to
  // stay open by itself for the connect-failed branch.
  useEffect(() => {
    if (enrollment.kind === 'connected') onClose();
  }, [enrollment.kind, onClose]);

  function submit() {
    const trimmedUrl = serverUrl.trim();
    const trimmedToken = token.trim();
    if (!validOrigin || !trimmedToken) return;
    // One-time token: hand it to the controller and clear it from UI state
    // immediately — it is never echoed back, even if enrollment fails.
    void controller.enroll({
      serverUrl: trimmedUrl,
      enrollmentToken: trimmedToken,
      ...(hostName.trim() ? { hostName: hostName.trim() } : {}),
    });
    setToken('');
  }

  return (
    <Dialog label={t('settings.remote.connectServer')} onClose={() => { if (!connecting) onClose(); }}>
      <div className="confirm-title">{t('settings.remote.connectServer')}</div>
      <div className="rs-form">
        <label className="rs-field">
          <span className="rs-field-label">{t('settings.remote.serverUrl')}</span>
          <input
            className="input"
            type="url"
            aria-label={t('settings.remote.serverUrl')}
            placeholder={t('settings.remote.serverUrl.placeholder')}
            value={serverUrl}
            disabled={connecting}
            autoFocus
            onChange={e => { setServerUrl(e.target.value); setToken(''); }}
          />
        </label>
        <label className="rs-field">
          <span className="rs-field-label">
            {t('settings.remote.enrollmentToken')}
            <span className="rs-info" tabIndex={0} role="note" aria-label={t('settings.remote.enrollmentToken.get')}>
              i
              <span className="rs-info-pop" role="tooltip">
                <p>{t('settings.remote.enrollmentToken.selfHosted')}</p>
                <code>gian-remote-server enrollment create</code>
                <p>{t('settings.remote.enrollmentToken.docker')}</p>
                <code>docker compose exec remote gian-remote-server enrollment create</code>
                <p>{t('settings.remote.enrollmentToken.admin')}</p>
                {registrationUrl && (
                  <p>
                    <a href={registrationUrl} target="_blank" rel="noopener noreferrer">
                      {t('settings.remote.enrollmentToken.web')}
                    </a>
                  </p>
                )}
              </span>
            </span>
          </span>
          <input
            className="input"
            type="password"
            autoComplete="off"
            aria-label={t('settings.remote.enrollmentToken')}
            value={token}
            disabled={connecting}
            onChange={e => setToken(e.target.value)}
          />
        </label>
        <label className="rs-field">
          <span className="rs-field-label">{t('settings.remote.hostName')}</span>
          <input
            className="input"
            type="text"
            aria-label={t('settings.remote.hostName')}
            placeholder={t('settings.remote.hostName.placeholder')}
            value={hostName}
            maxLength={256}
            disabled={connecting}
            onChange={e => setHostName(e.target.value)}
          />
        </label>
      </div>
      {state.error && state.error !== 'load_failed' && (
        <p className="field-error" role="alert">{t('settings.remote.error.' + state.error)}</p>
      )}
      {enrollment.kind === 'connect-failed' && (
        <p className="field-error" role="alert">
          {/GitHub/.test(enrollment.error)
            ? t('settings.remote.connectFailedAuth')
            : `${t('settings.remote.connectFailed')}: ${enrollment.error}`}
        </p>
      )}
      <div className="confirm-actions">
        <button type="button" className="btn sm ghost" disabled={connecting} onClick={onClose}>
          {t('settings.remote.pair.cancel')}
        </button>
        <button
          type="button"
          className="btn sm primary"
          disabled={connecting || !validOrigin || !token.trim()}
          onClick={submit}
        >
          {connecting ? t('settings.remote.connecting') : t('settings.remote.connect')}
        </button>
      </div>
    </Dialog>
  );
}

function ConnectedBlock({
  controller,
  enrollment,
}: {
  controller: RemoteSettingsController;
  enrollment:
    | { kind: 'connected'; info: RemoteEnrollmentInfo; link: 'online' | 'reconnecting' | 'offline' }
    | { kind: 'disconnected'; info: RemoteEnrollmentInfo }
    | { kind: 'disconnecting'; info: RemoteEnrollmentInfo };
}) {
  const t = useT();
  const info = enrollment.info;
  const busy = enrollment.kind === 'disconnecting';
  const linkLabel =
    enrollment.kind === 'disconnected'
      ? t('settings.remote.disconnected')
      : enrollment.kind === 'disconnecting'
        ? t('settings.remote.disconnecting')
        : t(`settings.remote.status.${enrollment.link}`);

  // One destructive action: disconnect AND delete everything (enrollment,
  // pairings, signing secret) — the merged meaning of the old Disconnect and
  // Emergency Disable buttons.
  function disconnect() {
    void confirm({
      title: t('settings.remote.disconnect'),
      message: t('settings.remote.disconnect.confirm'),
      dangerMessage: t('settings.remote.disconnect.danger'),
      confirmLabel: t('settings.remote.disconnect'),
      danger: true,
    }).then(ok => {
      if (ok) void controller.disableRemote();
    });
  }

  return (
    <div>
      <div className="rs-kv">
        <div className="rs-kv-row">
          <span className="rs-kv-label">{t('settings.remote.url')}</span>
          <span className="rs-kv-value" title={info.serverUrl}>{info.serverUrl}</span>
          <span className="rs-kv-act" />
        </div>
        <div className="rs-kv-row">
          <span className="rs-kv-label">{t('settings.remote.hostRemoteName')}</span>
          <HostNameEditor controller={controller} name={info.hostRemoteName}
            enabled={enrollment.kind === 'connected' && enrollment.link === 'online'} />
        </div>
        <div className="rs-kv-row">
          <span className="rs-kv-label">{t('settings.remote.status')}</span>
          <span className="rs-kv-value" data-testid="remote-link-status">{linkLabel}</span>
          <span className="rs-kv-act" />
        </div>
      </div>
      <div className="rs-actions">
        {(enrollment.kind === 'disconnected' || (enrollment.kind === 'connected' && enrollment.link !== 'online')) && (
          <button
            type="button"
            className="btn secondary"
            disabled={busy}
            onClick={() => void controller.reconnect()}
          >
            {t('settings.remote.reconnect')}
          </button>
        )}
        <button type="button" className="btn danger-ghost" disabled={busy} onClick={disconnect}>
          {busy ? t('settings.remote.disconnecting') : t('settings.remote.disconnect')}
        </button>
      </div>
    </div>
  );
}

function HostNameEditor({ controller, name, enabled }: {
  controller: RemoteSettingsController; name: string; enabled: boolean;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  useEffect(() => { setValue(name); setEditing(false); }, [name]);
  if (!editing) return <>
    <span className="rs-kv-value">{name}</span>
    <span className="rs-kv-act">
      {controller.setHostName && <button type="button" className="btn xs secondary" disabled={!enabled}
        onClick={() => setEditing(true)}>{t('settings.remote.hostName.rename')}</button>}
    </span>
  </>;
  return <>
    <input className="input rs-info-value" aria-label={t('settings.remote.hostRemoteName')} value={value} maxLength={256}
      onChange={event => setValue(event.target.value)} />
    <span className="rs-kv-act">
      <button type="button" className="btn xs secondary" disabled={!enabled || !value.trim() || value.trim() === name}
        onClick={() => void controller.setHostName?.(value.trim())}>{t('settings.remote.hostName.save')}</button>
      <button type="button" className="btn xs ghost" onClick={() => { setValue(name); setEditing(false); }}>
        {t('settings.remote.pair.cancel')}
      </button>
    </span>
  </>;
}

function IdentityChangedBlock({
  controller,
  enrollment,
}: {
  controller: RemoteSettingsController;
  enrollment: Extract<RemoteSettingsState['enrollment'], { kind: 'identity-changed' }>;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);

  function decide(accept: boolean) {
    setBusy(true);
    const action = accept
      ? controller.confirmServerIdentityChange(enrollment.newFingerprint)
      : controller.rejectServerIdentityChange();
    void action.finally(() => setBusy(false));
  }

  return (
    <div className="rs-warn" role="alert" data-testid="remote-identity-changed">
      <h4 className="rs-warn-title">{t('settings.remote.identityChanged.title')}</h4>
      <p>{t('settings.remote.identityChanged.message')}</p>
      <dl className="kv-grid">
        <dt>{t('settings.remote.identityChanged.previous')}</dt>
        <dd><code className="rs-fingerprint">{enrollment.previousFingerprint}</code></dd>
        <dt>{t('settings.remote.identityChanged.new')}</dt>
        <dd><code className="rs-fingerprint">{enrollment.newFingerprint}</code></dd>
      </dl>
      <p className="hint">{t('settings.remote.identityChanged.note')}</p>
      <div className="rs-actions">
        <button
          type="button"
          className="btn danger"
          disabled={busy}
          onClick={() => decide(true)}
        >
          {t('settings.remote.identityChanged.confirm')}
        </button>
        <button
          type="button"
          className="btn secondary"
          disabled={busy}
          onClick={() => decide(false)}
        >
          {t('settings.remote.identityChanged.reject')}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Paired devices (this Mac as Host) + the Add-device grant dialog
// ---------------------------------------------------------------------------

function DevicesBlock({
  controller,
  state,
}: {
  controller: RemoteSettingsController;
  state: RemoteSettingsState;
}) {
  const t = useT();
  const pairedDevices = state.devices.filter(device => device.revokeStatus !== 'revoked');
  if (pairedDevices.length === 0) {
    return <p className="s2-help">{t('settings.remote.devices.empty')}</p>;
  }
  return (
    <div className="rs-device-list">
      {pairedDevices.map(device => (
        <DeviceRow
          key={device.id}
          device={device}
          controller={controller}
        />
      ))}
    </div>
  );
}

const REVOKE_STATUS_KEY: Record<RemoteDeviceInfo['revokeStatus'], string> = {
  active: 'settings.remote.devices.status.active',
  'revoke-pending': 'settings.remote.devices.status.revokePending',
  'pending-reconciliation': 'settings.remote.devices.status.pendingReconciliation',
  revoked: 'settings.remote.devices.status.revoked',
};

function DeviceRow({
  device,
  controller,
}: {
  device: RemoteDeviceInfo;
  controller: RemoteSettingsController;
}) {
  const t = useT();
  const revoking = device.revokeStatus === 'revoke-pending' || device.revokeStatus === 'pending-reconciliation';
  const connected = device.revokeStatus === 'active' && device.activeConnections > 0;

  function revoke() {
    void confirm({
      title: t('settings.remote.devices.revoke'),
      message: t('settings.remote.devices.revoke.confirm').replace('{name}', device.name),
      dangerMessage: t('settings.remote.devices.revoke.danger'),
      confirmLabel: t('settings.remote.devices.revoke'),
      danger: true,
    }).then(ok => {
      if (ok) void controller.revokeDevice(device.id);
    });
  }

  return (
    <div className="rs-device" data-testid={`remote-device-${device.id}`}>
      <div className="rs-device-main">
        <span className="rs-device-name">{device.name}</span>
        <span className="rs-device-sub" data-testid={`remote-device-status-${device.id}`}>
          {connected && device.lastSeenAt
            ? t('settings.remote.devices.connectedMeta').replace('{time}', relativeTime(device.lastSeenAt, t))
            : t(REVOKE_STATUS_KEY[device.revokeStatus])}
        </span>
      </div>
      <button
        type="button"
        className="btn sm danger-ghost"
        disabled={revoking}
        onClick={revoke}
      >
        {revoking ? t('settings.remote.devices.revoking') : t('settings.remote.devices.revoke')}
      </button>
    </div>
  );
}

function PairingDialog({
  controller,
  state,
}: {
  controller: RemoteSettingsController;
  state: RemoteSettingsState;
}) {
  const t = useT();
  const pairing = state.pairing;
  const ticking = pairing.kind === 'awaiting-claim' || pairing.kind === 'claimed';
  const nowMs = useNowTicks(ticking);
  const close = () => void controller.cancelPairing();

  return (
    <Dialog label={t('settings.remote.devices.add')} onClose={close}>
      <div className="confirm-title">{t('settings.remote.devices.add')}</div>
      {pairing.kind === 'creating' && <p className="s2-help">{t('settings.remote.pair.creating')}</p>}
      {(pairing.kind === 'expired' || pairing.kind === 'rejected' || pairing.kind === 'consumed') && (
        <div>
          <p className="s2-help">
            {pairing.kind === 'expired' && t('settings.remote.pair.expired')}
            {pairing.kind === 'rejected' && t('settings.remote.pair.rejected')}
            {pairing.kind === 'consumed' &&
              t('settings.remote.pair.consumed').replace('{name}', pairing.deviceName)}
          </p>
          <div className="confirm-actions">
            <button type="button" className="btn sm ghost" onClick={close}>
              {t('settings.remote.pair.cancel')}
            </button>
            <button type="button" className="btn sm primary" onClick={() => void controller.startPairing()}>
              {t('settings.remote.pair.new')}
            </button>
          </div>
        </div>
      )}
      {(pairing.kind === 'awaiting-claim' || pairing.kind === 'claimed') && (
        <PairingGrantView
          pairing={pairing}
          remaining={Math.max(0, pairing.expiresAt - nowMs)}
          onCancel={close}
        />
      )}
    </Dialog>
  );
}

function PairingGrantView({
  pairing,
  remaining,
  onCancel,
}: {
  pairing: Extract<RemoteSettingsState['pairing'], { kind: 'awaiting-claim' | 'claimed' }>;
  remaining: number;
  onCancel: () => void;
}) {
  const t = useT();
  return (
    <div>
      <p className="s2-help">{t('settings.remote.pair.awaiting')}</p>
      <div className="rs-pair-grant">
        {pairing.qrPayload && <QrCodeImage value={pairing.qrPayload} label={t('settings.remote.pair.qr')} />}
        <div className="rs-pair-side">
          <div className="rs-pair-field">
            <span className="rs-pair-label">{t('settings.remote.pair.code')}</span>
            {pairing.code
              ? <code className="rs-code" data-testid="pairing-short-code">{pairing.code}</code>
              : <span className="hint">{t('settings.remote.pair.restoreHint')}</span>}
          </div>
          <div className="rs-pair-field">
            <span className="rs-pair-label">{t('settings.remote.pair.expiresIn')}</span>
            <span className="rs-countdown" data-testid="pairing-countdown">
              {formatCountdown(remaining)}
            </span>
          </div>
        </div>
      </div>
      {pairing.kind === 'awaiting-claim' && pairing.qrPayload && remaining > 0 && (
        <PairingLink key={pairing.qrPayload} url={pairing.qrPayload} />
      )}
      <div className="confirm-actions">
        <button type="button" className="btn sm ghost" onClick={onCancel}>
          {t('settings.remote.pair.cancel')}
        </button>
      </div>
    </div>
  );
}

function PairingLink({ url }: { url: string }) {
  const t = useT();
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  }
  return (
    <div className="rs-pair-link">
      <div className="rs-actions">
        <input className="input" type="text" readOnly value={url} aria-label={t('settings.remote.pair.link')}
          onFocus={event => event.currentTarget.select()} />
        <button type="button" className="btn secondary" onClick={() => void copy()}>
          {copyState === 'copied'
            ? t('settings.remote.pair.linkCopied')
            : copyState === 'failed'
              ? t('settings.remote.pair.copyFailed')
              : t('settings.remote.pair.copyLink')}
        </button>
      </div>
    </div>
  );
}

function PairingClaimDialog({
  controller,
  pairing,
}: {
  controller: RemoteSettingsController;
  pairing: Extract<RemoteSettingsState['pairing'], { kind: 'claimed' }>;
}) {
  const t = useT();
  const busy = pairing.decision === 'pending';

  return (
    <div className="confirm-overlay">
      <div
        className="confirm-modal rs-claim-modal"
        role="alertdialog"
        aria-modal="true"
        aria-label={t('settings.remote.pair.claim.title')}
      >
        <div className="confirm-title">{t('settings.remote.pair.claim.title')}</div>
        <dl className="kv-grid rs-claim-grid">
          <dt>{t('settings.remote.pair.claim.device')}</dt>
          <dd className="rs-value">{pairing.claim.deviceName}</dd>
          <dt>{t('settings.remote.pair.claim.browser')}</dt>
          <dd className="rs-value">{pairing.claim.browser}</dd>
          <dt>{t('settings.remote.pair.claim.os')}</dt>
          <dd className="rs-value">{pairing.claim.os}</dd>
          <dt>{t('settings.remote.pair.claim.network')}</dt>
          <dd className="rs-value">{pairing.claim.networkOrigin}</dd>
          <dt>{t('settings.remote.pair.claim.requestedAt')}</dt>
          <dd className="rs-value">{formatDateTime(pairing.claim.claimedAt)}</dd>
        </dl>
        <div className="confirm-danger" role="alert">
          {t('settings.remote.pair.claim.security')}
        </div>
        <div className="confirm-actions">
          <button
            type="button"
            className="btn sm ghost"
            disabled={busy}
            onClick={() => void controller.confirmPairingClaim('reject', pairing.pairingId)}
          >
            {t('settings.remote.pair.reject')}
          </button>
          <button
            type="button"
            className="btn sm primary"
            disabled={busy}
            onClick={() => void controller.confirmPairingClaim('allow', pairing.pairingId)}
          >
            {busy ? t('settings.remote.pair.confirming') : t('settings.remote.pair.allow')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 控制其他 Gian — remote environments (this Mac as controller)
// ---------------------------------------------------------------------------

function EnvironmentsBlock({ state }: {
  state: RemoteSettingsState;
}) {
  const t = useT();
  const [environments, setEnvironments] = useState<RemoteEnvironment[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const enrolledUrl = state.enrollment.kind === 'connected' || state.enrollment.kind === 'disconnected'
    ? state.enrollment.info.serverUrl
    : '';

  const refresh = () => {
    setLoadFailed(false);
    void remoteRequest<{ environments: RemoteEnvironment[] }>('/environments')
      .then(result => setEnvironments(Array.isArray(result.environments) ? result.environments : []))
      .catch(() => setLoadFailed(true));
  };
  useEffect(refresh, []);

  function remove(environment: RemoteEnvironment) {
    void confirm({
      title: t('settings.remote.env.remove'),
      message: t('settings.remote.env.removeConfirm').replace('{name}', environment.name),
      confirmLabel: t('settings.remote.env.remove'),
      danger: true,
    }).then(ok => {
      if (!ok) return;
      void remoteRequest(`/environments/${environment.id}`, undefined, 'DELETE')
        .then(refresh)
        .catch(refresh);
    });
  }

  return (
    <div>
      <div className="rs-card-head">
        <h4 className="s2-subhead">{t('settings.remote.otherGian')}</h4>
        <button type="button" className="btn sm primary" onClick={() => setConnectOpen(true)}>
          {t('settings.remote.connect')}
        </button>
      </div>
      {loadFailed && <p className="field-error" role="alert">{t('settings.remote.env.loadFailed')}</p>}
      {environments?.length === 0 && <p className="s2-help">{t('settings.remote.env.empty')}</p>}
      {environments && environments.length > 0 && (
        <div className="rs-device-list">
          {environments.map(environment => (
            <div className="rs-device" key={environment.id} data-testid={`remote-environment-${environment.id}`}>
              <div className="rs-device-main">
                <span className="rs-device-name">{environment.name}</span>
                <span className="rs-device-sub">
                  {environment.connected
                    ? t('settings.remote.env.connected')
                    : environment.pending
                      ? t('settings.remote.env.pending')
                      : t('settings.remote.env.offline')}
                </span>
              </div>
              <button type="button" className="btn sm danger-ghost" onClick={() => remove(environment)}>
                {t('settings.remote.env.remove')}
              </button>
            </div>
          ))}
        </div>
      )}
      {connectOpen && (
        <EnvironmentDialog
          defaultServerUrl={enrolledUrl}
          onClose={() => setConnectOpen(false)}
          onPaired={() => { setConnectOpen(false); refresh(); }}
        />
      )}
    </div>
  );
}

function EnvironmentDialog({ defaultServerUrl, onClose, onPaired }: {
  defaultServerUrl: string;
  onClose: () => void;
  onPaired: () => void;
}) {
  const t = useT();
  const [serverUrl, setServerUrl] = useState(defaultServerUrl);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<'invalid' | 'failed' | null>(null);
  const running = useRef<AbortController | null>(null);
  const origin = serverUrl.trim();
  useEffect(() => () => running.current?.abort(), []);

  async function submit() {
    if (!origin || !code.trim() || busy || running.current) return;
    const abort = new AbortController();
    running.current = abort;
    setBusy(true);
    setError(null);
    try {
      await authorizeRemoteAccount(origin, 'controller', { signal: abort.signal });
      if (abort.signal.aborted) return;
      await remoteRequest<{ environment: RemoteEnvironment }>('/environments', {
        server_url: new URL(origin).origin, code: code.trim(), name: name.trim() || origin,
      });
      if (!abort.signal.aborted) onPaired();
    } catch (cause) {
      if (!abort.signal.aborted && !(cause instanceof Error && cause.message === 'cancelled')) setError('failed');
    } finally {
      if (running.current === abort) running.current = null;
      if (!abort.signal.aborted) setBusy(false);
    }
  }

  return (
    <Dialog label={t('settings.remote.env.connect')} onClose={onClose}>
      <div className="confirm-title">{t('settings.remote.env.connect')}</div>
      <div className="rs-form">
        <label className="rs-field">
          <span className="rs-field-label">{t('settings.remote.serverUrl')}</span>
          <input
            className="input"
            type="url"
            aria-label={t('settings.remote.serverUrl')}
            placeholder={t('settings.remote.serverUrl.placeholder')}
            value={serverUrl}
            disabled={busy}
            autoFocus={!defaultServerUrl}
            onChange={e => setServerUrl(e.target.value)}
          />
        </label>
        <label className="rs-field">
          <span className="rs-field-label">{t('settings.remote.env.code')}</span>
          <input
            className="input"
            type="text"
            autoComplete="off"
            aria-label={t('settings.remote.env.code')}
            value={code}
            disabled={busy}
            autoFocus={Boolean(defaultServerUrl)}
            onChange={e => setCode(e.target.value)}
          />
        </label>
        <label className="rs-field">
          <span className="rs-field-label">{t('settings.remote.env.name')}</span>
          <input
            className="input"
            type="text"
            aria-label={t('settings.remote.env.name')}
            placeholder={t('settings.remote.env.nameOptional')}
            value={name}
            maxLength={256}
            disabled={busy}
            onChange={e => setName(e.target.value)}
          />
        </label>
      </div>
      {error && (
        <p className="field-error" role="alert">{t('settings.remote.env.failed')}</p>
      )}
      <div className="confirm-actions">
        <button type="button" className="btn sm ghost" disabled={busy} onClick={onClose}>
          {t('settings.remote.pair.cancel')}
        </button>
        <button
          type="button"
          className="btn sm primary"
          disabled={busy || !origin || !code.trim()}
          onClick={submit}
        >
          {busy ? t('settings.remote.connecting') : t('settings.remote.connect')}
        </button>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function relativeTime(epochMs: number, t: (key: string) => string): string {
  const minutes = Math.floor((Date.now() - epochMs) / 60_000);
  if (minutes < 1) return t('settings.remote.time.now');
  if (minutes < 60) return t('settings.remote.time.minutes').replace('{n}', String(minutes));
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('settings.remote.time.hours').replace('{n}', String(hours));
  const days = Math.floor(hours / 24);
  if (days < 30) return t('settings.remote.time.days').replace('{n}', String(days));
  return formatDateTime(epochMs);
}

function QrCodeImage({ value, label }: { value: string; label: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void QRCode.toString(value, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' })
      .then(rendered => { if (alive) setSvg(rendered); })
      .catch(() => { if (alive) setSvg(null); });
    return () => { alive = false; };
  }, [value]);
  return (
    <div
      className="rs-qr"
      role="img"
      aria-label={label}
      data-testid="pairing-qr"
      // SVG is generated locally by the qrcode library from the controller's
      // grant payload — no user markup is interpolated.
      dangerouslySetInnerHTML={svg ? { __html: svg } : undefined}
    />
  );
}

function useNowTicks(active: boolean): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return nowMs;
}

function formatCountdown(ms: number): string {
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatDateTime(epochMs: number): string {
  return new Date(epochMs).toLocaleString();
}
