/**
 * Settings › Remote — Server enrollment, device pairing, paired devices and
 * the bounded remote-mutation audit (proposal §5, WP5 phase 3).
 *
 * Pure presentation over `RemoteSettingsController`: every mutation goes
 * through the controller and every rendered fact comes from its state. The
 * enrollment token is cleared from local UI state immediately on submit and
 * is never echoed back. Disconnect, emergency disable, and device revoke are
 * explicit confirmed commands, never toggles. The audit view renders only
 * redacted rows (time, method, command-id summary, result category).
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import QRCode from 'qrcode';
import { confirm } from '../feedback.js';
import { useT } from '../i18n/index.js';
import type {
  RemoteAuditEntry,
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
  const enrolled = state.enrollment.kind === 'connected' && state.enrollment.link === 'online';

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
        <EnrollmentBlock controller={controller} state={state} />
      </div>
      <div className="s2-card" data-testid="settings-remote-pairing">
        <h4 className="s2-subhead">{t('settings.remote.pair.title')}</h4>
        <PairingBlock controller={controller} state={state} enabled={enrolled} />
      </div>
      <div className="s2-card" data-testid="settings-remote-devices">
        <h4 className="s2-subhead">{t('settings.remote.devices.title')}</h4>
        <DevicesBlock controller={controller} state={state} />
      </div>
      </fieldset>
    </>
  );
}

// ---------------------------------------------------------------------------
// Server enrollment (§5.1)
// ---------------------------------------------------------------------------

function EnrollmentBlock({
  controller,
  state,
}: {
  controller: RemoteSettingsController;
  state: RemoteSettingsState;
}) {
  const t = useT();
  const [serverUrl, setServerUrl] = useState('');
  const [token, setToken] = useState('');
  const enrollment = state.enrollment;
  if (enrollment.kind === 'loading') return <p className="s2-help">{t('settings.remote.loading')}</p>;

  function submitEnrollment() {
    const trimmedUrl = serverUrl.trim();
    const trimmedToken = token.trim();
    if (!trimmedUrl || !trimmedToken) return;
    // One-time token: hand it to the controller and clear it from UI state
    // immediately — it is never echoed back, even if enrollment fails.
    void controller.enroll({ serverUrl: trimmedUrl, enrollmentToken: trimmedToken });
    setToken('');
  }

  if (enrollment.kind === 'identity-changed') {
    return <IdentityChangedBlock controller={controller} enrollment={enrollment} />;
  }

  if (
    enrollment.kind === 'connected' ||
    enrollment.kind === 'disconnected' ||
    enrollment.kind === 'disconnecting'
  ) {
    return <ConnectedBlock controller={controller} enrollment={enrollment} />;
  }

  const connecting = enrollment.kind === 'connecting';
  return (
    <div>
      <p className="s2-help">{t('settings.remote.help')}</p>
      <dl className="kv-grid">
        <dt>{t('settings.remote.serverUrl')}</dt>
        <dd>
          <input
            className="input"
            type="url"
            aria-label={t('settings.remote.serverUrl')}
            placeholder={t('settings.remote.serverUrl.placeholder')}
            value={serverUrl}
            disabled={connecting}
            onChange={e => setServerUrl(e.target.value)}
          />
        </dd>
        <dt>{t('settings.remote.enrollmentToken')}</dt>
        <dd>
          <input
            className="input"
            type="password"
            autoComplete="off"
            aria-label={t('settings.remote.enrollmentToken')}
            value={token}
            disabled={connecting}
            onChange={e => setToken(e.target.value)}
          />
          <span className="hint">{t('settings.remote.enrollmentToken.hint')}</span>
          <details className="rs-enrollment-help">
            <summary>{t('settings.remote.enrollmentToken.get')}</summary>
            <p className="hint">{t('settings.remote.enrollmentToken.selfHosted')}</p>
            <code>gian-remote-server enrollment create</code>
            <p className="hint">{t('settings.remote.enrollmentToken.docker')}</p>
            <code>docker compose exec remote gian-remote-server enrollment create</code>
            <p className="hint">{t('settings.remote.enrollmentToken.admin')}</p>
          </details>
        </dd>
      </dl>
      {enrollment.kind === 'connect-failed' && (
        <p className="field-error" role="alert">
          {t('settings.remote.connectFailed')}: {enrollment.error}
        </p>
      )}
      <div className="rs-actions">
        <button
          type="button"
          className="btn primary"
          disabled={connecting || !serverUrl.trim() || !token.trim()}
          onClick={submitEnrollment}
        >
          {connecting ? t('settings.remote.connecting') : t('settings.remote.connect')}
        </button>
      </div>
    </div>
  );
}

function PublicUrlEditor({ controller, info }: { controller: RemoteSettingsController; info: RemoteEnrollmentInfo }) {
  const t = useT();
  const current = info.publicUrl ?? info.serverUrl;
  const [value, setValue] = useState(current);
  useEffect(() => setValue(current), [current]);
  return <div className="rs-public-url">
    <label className="s2-subhead" htmlFor="remote-public-url">{t('settings.remote.publicUrl')}</label>
    <p className="hint">{t('settings.remote.publicUrl.hint')}</p>
    <div className="rs-actions">
      <input id="remote-public-url" type="url" className="input" value={value}
        onChange={event => setValue(event.target.value)} />
      <button className="btn secondary" disabled={!value.trim() || value.trim() === current}
        onClick={() => void controller.setPublicUrl?.(value.trim())}>{t('settings.remote.publicUrl.save')}</button>
    </div>
  </div>;
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

  function disconnect() {
    void confirm({
      title: t('settings.remote.disconnect'),
      message: t('settings.remote.disconnect.confirm'),
      confirmLabel: t('settings.remote.disconnect'),
      danger: true,
    }).then(ok => {
      if (ok) void controller.disconnect();
    });
  }

  function disable() {
    void confirm({
      title: t('settings.remote.disable'),
      message: t('settings.remote.disable.confirm'),
      dangerMessage: t('settings.remote.disable.danger'),
      confirmLabel: t('settings.remote.disable'),
      danger: true,
    }).then(ok => {
      if (ok) void controller.disableRemote();
    });
  }

  return (
    <div>
      <dl className="kv-grid">
        <dt>{t('settings.remote.serverUrl')}</dt>
        <dd className="rs-value">{info.serverUrl}</dd>
        <dt>{t('settings.remote.hostRemoteName')}</dt>
        <dd className="rs-value"><HostNameEditor controller={controller} name={info.hostRemoteName}
          enabled={enrollment.kind === 'connected' && enrollment.link === 'online'} /></dd>
        <dt>{t('settings.remote.status')}</dt>
        <dd className="rs-value" data-testid="remote-link-status">{linkLabel}</dd>
        <dt>{t('settings.remote.lastHeartbeat')}</dt>
        <dd className="rs-value">
          {info.lastHeartbeatAt ? formatDateTime(info.lastHeartbeatAt) : t('settings.remote.lastHeartbeat.never')}
        </dd>
        <dt>{t('settings.remote.fingerprint')}</dt>
        <dd className="rs-value">
          <Fingerprint fingerprint={info.serverIdentityFingerprint} />
        </dd>
      </dl>
      <div className="rs-actions">
        {enrollment.kind === 'disconnected' && (
          <button
            type="button"
            className="btn secondary"
            disabled={busy}
            onClick={() => void controller.reconnect()}
          >
            {t('settings.remote.reconnect')}
          </button>
        )}
        {enrollment.kind !== 'disconnected' && (
          <button type="button" className="btn secondary" disabled={busy} onClick={disconnect}>
            {t('settings.remote.disconnect')}
          </button>
        )}
        <button type="button" className="btn danger-ghost" disabled={busy} onClick={disable}>
          {t('settings.remote.disable')}
        </button>
      </div>
      {controller.setPublicUrl && <PublicUrlEditor controller={controller} info={info} />}
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
  if (!editing) return <div className="rs-actions">
    <span>{name}</span>
    {controller.setHostName && <button type="button" className="btn secondary" disabled={!enabled}
      onClick={() => setEditing(true)}>{t('settings.remote.hostName.rename')}</button>}
  </div>;
  return <div className="rs-actions">
    <input className="input" aria-label={t('settings.remote.hostRemoteName')} value={value} maxLength={256}
      onChange={event => setValue(event.target.value)} />
    <button type="button" className="btn secondary" disabled={!enabled || !value.trim() || value.trim() === name}
      onClick={() => void controller.setHostName?.(value.trim())}>{t('settings.remote.hostName.save')}</button>
    <button type="button" className="btn secondary" onClick={() => { setValue(name); setEditing(false); }}>
      {t('settings.remote.pair.cancel')}
    </button>
  </div>;
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
        <dd><Fingerprint fingerprint={enrollment.previousFingerprint} /></dd>
        <dt>{t('settings.remote.identityChanged.new')}</dt>
        <dd><Fingerprint fingerprint={enrollment.newFingerprint} /></dd>
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
// Pair new device (§5.2)
// ---------------------------------------------------------------------------

function PairingBlock({
  controller,
  state,
  enabled,
}: {
  controller: RemoteSettingsController;
  state: RemoteSettingsState;
  enabled: boolean;
}) {
  const t = useT();
  const pairing = state.pairing;
  const ticking = pairing.kind === 'awaiting-claim' || pairing.kind === 'claimed';
  const nowMs = useNowTicks(ticking);

  if (pairing.kind === 'idle') {
    return (
      <div>
        <p className="s2-help">{t('settings.remote.pair.help')}</p>
        {!enabled && <p className="hint">{t('settings.remote.pair.requiresConnection')}</p>}
        <div className="rs-actions">
          <button
            type="button"
            className="btn primary"
            disabled={!enabled}
            onClick={() => void controller.startPairing()}
          >
            {t('settings.remote.pair.create')}
          </button>
        </div>
      </div>
    );
  }

  if (pairing.kind === 'creating') {
    return <p className="s2-help">{t('settings.remote.pair.creating')}</p>;
  }

  if (pairing.kind === 'expired' || pairing.kind === 'rejected' || pairing.kind === 'consumed') {
    return (
      <div>
        <p className="s2-help">
          {pairing.kind === 'expired' && t('settings.remote.pair.expired')}
          {pairing.kind === 'rejected' && t('settings.remote.pair.rejected')}
          {pairing.kind === 'consumed' &&
            t('settings.remote.pair.consumed').replace('{name}', pairing.deviceName)}
        </p>
        <div className="rs-actions">
          <button type="button" className="btn secondary" onClick={() => void controller.cancelPairing()}>
            {t('settings.remote.pair.new')}
          </button>
        </div>
      </div>
    );
  }

  // awaiting-claim | claimed — one grant, one QR + one short code.
  const remaining = Math.max(0, pairing.expiresAt - nowMs);
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
          <div className="rs-actions">
            <button
              type="button"
              className="btn secondary"
              onClick={() => void controller.cancelPairing()}
            >
              {t('settings.remote.pair.cancel')}
            </button>
          </div>
        </div>
      </div>
      {pairing.kind === 'awaiting-claim' && pairing.qrPayload && remaining > 0 && (
        <PairingLink key={pairing.qrPayload} url={pairing.qrPayload} />
      )}
      {pairing.kind === 'claimed' && (
        <PairingClaimDialog controller={controller} pairing={{ ...pairing, decision: state.busy ? 'pending' : pairing.decision }} />
      )}
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
      <label className="rs-pair-label" htmlFor="remote-pairing-link">{t('settings.remote.pair.link')}</label>
      <div className="rs-actions">
        <input id="remote-pairing-link" className="input" type="text" readOnly value={url}
          onFocus={event => event.currentTarget.select()} />
        <button type="button" className="btn secondary" onClick={() => void copy()}>
          {t('settings.remote.pair.copyLink')}
        </button>
      </div>
      <p className="hint">{t('settings.remote.pair.linkHint')}</p>
      <span className="hint" role="status">
        {copyState === 'copied' && t('settings.remote.pair.linkCopied')}
        {copyState === 'failed' && t('settings.remote.pair.copyFailed')}
      </span>
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
// Paired devices + bounded audit (§5.4 / §5.6 / §5.8)
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
          audit={state.audit[device.id] ?? []}
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
  audit,
  controller,
}: {
  device: RemoteDeviceInfo;
  audit: RemoteAuditEntry[];
  controller: RemoteSettingsController;
}) {
  const t = useT();
  const [auditOpen, setAuditOpen] = useState(false);
  const revoking = device.revokeStatus === 'revoke-pending' || device.revokeStatus === 'pending-reconciliation';

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
        <div className="rs-device-id">
          <span className="rs-device-name">{device.name}</span>
          <span className="rs-device-platform">{device.platform}</span>
        </div>
        <dl className="rs-device-meta">
          <div>
            <dt>{t('settings.remote.devices.created')}</dt>
            <dd>{formatDateTime(device.createdAt)}</dd>
          </div>
          <div>
            <dt>{t('settings.remote.devices.lastSeen')}</dt>
            <dd>{device.lastSeenAt ? formatDateTime(device.lastSeenAt) : t('settings.remote.devices.lastSeen.never')}</dd>
          </div>
          <div>
            <dt>{t('settings.remote.devices.connections')}</dt>
            <dd>{device.activeConnections}</dd>
          </div>
          <div>
            <dt>{t('settings.remote.devices.status')}</dt>
            <dd data-testid={`remote-device-status-${device.id}`}>
              {t(REVOKE_STATUS_KEY[device.revokeStatus])}
            </dd>
          </div>
        </dl>
        <div className="rs-device-actions">
          <button
            type="button"
            className="btn sm secondary"
            aria-expanded={auditOpen}
            onClick={() => {
              if (!auditOpen) void controller.loadAudit?.(device.id);
              setAuditOpen(open => !open);
            }}
          >
            {t('settings.remote.audit.title')}
          </button>
          <button
            type="button"
            className="btn sm danger-ghost"
            disabled={revoking}
            onClick={revoke}
          >
            {revoking ? t('settings.remote.devices.revoking') : t('settings.remote.devices.revoke')}
          </button>
        </div>
      </div>
      {auditOpen && <AuditList entries={audit} />}
    </div>
  );
}

const AUDIT_RESULT_KEY: Record<RemoteAuditEntry['result'], string> = {
  pending: 'settings.remote.audit.result.pending',
  succeeded: 'settings.remote.audit.result.succeeded',
  failed: 'settings.remote.audit.result.failed',
  rejected: 'settings.remote.audit.result.rejected',
  'unknown-outcome': 'settings.remote.audit.result.unknown',
};

function AuditList({ entries }: { entries: RemoteAuditEntry[] }) {
  const t = useT();
  if (entries.length === 0) {
    return <p className="hint rs-audit-empty">{t('settings.remote.audit.empty')}</p>;
  }
  return (
    <table className="rs-audit" data-testid="remote-audit">
      <thead>
        <tr>
          <th>{t('settings.remote.audit.time')}</th>
          <th>{t('settings.remote.audit.method')}</th>
          <th>{t('settings.remote.audit.command')}</th>
          <th>{t('settings.remote.audit.result')}</th>
        </tr>
      </thead>
      <tbody>
        {entries.map(entry => (
          <tr key={entry.id}>
            <td>{formatDateTime(entry.at)}</td>
            <td><code>{entry.method}</code></td>
            <td><code>{entry.commandIdSummary}</code></td>
            <td>{t(AUDIT_RESULT_KEY[entry.result])}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

function Fingerprint({ fingerprint }: { fingerprint: string }) {
  // Summary only (§5.1): grouped prefix + suffix; the full value stays in the
  // tooltip for explicit comparison.
  const summary = `${groupHex(fingerprint.slice(0, 16))} … ${groupHex(fingerprint.slice(-8))}`;
  return (
    <code className="rs-fingerprint" title={groupHex(fingerprint)}>{summary}</code>
  );
}

function groupHex(value: string): string {
  return value.replace(/(.{4})(?=.)/g, '$1 ');
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
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(epochMs));
}
