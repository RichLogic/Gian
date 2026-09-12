/**
 * Pairing / auth pages (B1) — standalone, outside the app shell. Covers the
 * PC short-code page, the mobile QR grant landing, waiting-for-local-confirm
 * with cancel + countdown, and every failure terminal. Remembered device-key
 * authentication stays inside the app shell and uses its Host selector.
 *
 * Security copy is contractual: entering the code / scanning the QR never
 * grants access by itself — the user still confirms in Gian on the Mac.
 */

import { useEffect, useMemo, useState } from 'react';
import type { PairingFailure, PairingState } from '../controller/types.js';
import { useT } from '../i18n/index.js';
import { useRemoteActions, useRemoteState } from './controller-context.js';
import { Icon } from './icons.js';

const CODE_LENGTH = 8;

function Brand() {
  const t = useT();
  return (
    <span className="rw-pair-brand">
      <span className="rw-host-dot" aria-hidden="true" />
      {t('remote.brand')}
    </span>
  );
}

function TrustNote() {
  const t = useT();
  return <span className="rw-pair-hint">{t('pair.trust.note')}</span>;
}

/** Segmented 4+4 code input. */
function CodeInput({ onSubmit }: { onSubmit: (code: string) => void }) {
  const t = useT();
  const [value, setValue] = useState('');
  const chars = useMemo(() => {
    const clean = value.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, CODE_LENGTH);
    return clean.split('');
  }, [value]);

  return (
    <>
      <div className="rw-code-wrap">
        <input
          id="pair-code"
          className="rw-code-input"
          autoComplete="off"
          inputMode="text"
          aria-label={t('pair.code.field')}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') onSubmit(value);
          }}
        />
        <div className="rw-code" role="group" aria-hidden="true">
          {Array.from({ length: CODE_LENGTH }, (_, i) => (
            <span key={i}>
              {i === 4 && <span className="rw-code-dash">–</span>}
              <span
                className={`rw-code-ch${i === chars.length ? ' on' : ''}${chars[i] ? '' : ' dim'}`}
              >
                {chars[i] ?? '·'}
              </span>
            </span>
          ))}
        </div>
      </div>
      <button
        type="button"
        className="btn sm primary rw-pair-submit"
        disabled={chars.length !== CODE_LENGTH}
        onClick={() => onSubmit(value)}
      >
        {t('pair.code.submit')}
      </button>
    </>
  );
}

function EnterCodePage() {
  const t = useT();
  const actions = useRemoteActions();
  return (
    <div className="rw-pair">
      <div className="rw-pair-card">
        <Brand />
        <span className="rw-pair-title">{t('pair.code.title')}</span>
        <CodeInput onSubmit={(code) => actions.submitPairingCode(code)} />
        <p className="rw-pair-desc">{t('pair.code.desc')}</p>
        <span className="rw-pair-hint">{t('pair.code.qrHint')}</span>
        <TrustNote />
      </div>
    </div>
  );
}

function QrConfirmPage({ pairing }: { pairing: Extract<PairingState, { kind: 'qr-confirm' }> }) {
  const t = useT();
  const actions = useRemoteActions();
  return (
    <div className="rw-pair">
      <div className="rw-pair-card">
        <Brand />
        <span className="rw-pair-title">{t('pair.qr.title')}</span>
        <div className="rw-pair-field">
          <label>{t('pair.qr.hostLabel')}</label>
          <span className="rw-pair-input">{pairing.hostName}</span>
        </div>
        <div className="rw-pair-field">
          <label htmlFor="pair-device-name">{t('pair.qr.deviceLabel')}</label>
          <input
            id="pair-device-name"
            className="rw-input"
            value={pairing.deviceName}
            onChange={(event) => actions.setPairingDeviceName(event.target.value)}
          />
        </div>
        <p className="rw-pair-desc">{t('pair.qr.desc')}</p>
        <button type="button" className="btn sm primary rw-pair-submit" onClick={() => actions.confirmQrPairing()}>
          {t('pair.qr.confirm')}
        </button>
        <TrustNote />
      </div>
    </div>
  );
}

function WaitingPage({ pairing }: { pairing: Extract<PairingState, { kind: 'waiting' }> }) {
  const t = useT();
  const actions = useRemoteActions();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const remainingMs = Math.max(0, pairing.expiresAt - now);
  const mm = Math.floor(remainingMs / 60_000);
  const ss = Math.floor((remainingMs % 60_000) / 1000);

  return (
    <div className="rw-pair">
      <div className="rw-pair-card">
        <Brand />
        <span className="rw-pair-title">{t('pair.wait.title')}</span>
        <div className="rw-wait">
          <span className="spinner" role="status" aria-label={t('pair.wait.title')} />
          <span>{t('pair.wait.body')}</span>
        </div>
        <span className="rw-pair-hint">
          {t('pair.wait.hint')} · {mm}:{String(ss).padStart(2, '0')}
        </span>
        <button type="button" className="btn sm ghost" onClick={() => actions.cancelPairing()}>
          {t('common.cancel')}
        </button>
      </div>
    </div>
  );
}

const FAILURE_META: Record<
  PairingFailure,
  { titleKey: string; descKey: string; actionKey: string; disabled?: boolean; icon: 'warning' | 'wifi-off' | 'clock' | 'close' }
> = {
  invalid: { titleKey: 'pair.fail.expired.title', descKey: 'pair.fail.expired.desc', actionKey: 'pair.action.reenter', icon: 'close' },
  cancelled: { titleKey: 'pair.fail.cancelled.title', descKey: 'pair.fail.cancelled.desc', actionKey: 'pair.action.restart', icon: 'close' },
  expired: { titleKey: 'pair.fail.expired.title', descKey: 'pair.fail.expired.desc', actionKey: 'pair.action.reenter', icon: 'clock' },
  rejected: { titleKey: 'pair.fail.rejected.title', descKey: 'pair.fail.rejected.desc', actionKey: 'pair.action.restart', icon: 'warning' },
  'attempt-limit': { titleKey: 'pair.fail.rateLimited.title', descKey: 'pair.fail.rateLimited.desc', actionKey: 'pair.action.later', disabled: true, icon: 'close' },
  'already-claimed': { titleKey: 'pair.fail.alreadyClaimed.title', descKey: 'pair.fail.alreadyClaimed.desc', actionKey: 'pair.action.restart', icon: 'warning' },
  'host-offline': { titleKey: 'pair.fail.hostOffline.title', descKey: 'pair.fail.hostOffline.desc', actionKey: 'pair.action.retry', icon: 'wifi-off' },
};

function FailurePage({ pairing }: { pairing: Extract<PairingState, { kind: 'failed' }> }) {
  const t = useT();
  const actions = useRemoteActions();
  const meta = FAILURE_META[pairing.reason];
  return (
    <div className="rw-pair">
      <div className="rw-pair-card" data-pair-failure={pairing.reason}>
        <span className={`rw-fail-ico${pairing.reason === 'cancelled' || pairing.reason === 'expired' ? ' warn' : ''}`}>
          <Icon name={meta.icon} size={15} />
        </span>
        <span className="rw-fail-title">{t(meta.titleKey)}</span>
        <span className="rw-fail-desc">
          {t(meta.descKey, { host: pairing.hostName ?? '' })}
        </span>
        <span className="rw-fail-code">{pairing.reason.toUpperCase().replace(/-/g, '_')}</span>
        <button
          type="button"
          className="btn sm secondary"
          disabled={meta.disabled}
          onClick={() => actions.restartPairing()}
        >
          {t(meta.actionKey)}
        </button>
      </div>
    </div>
  );
}

export function PairingApp() {
  const state = useRemoteState();
  if (state.auth.kind !== 'pairing') return null;
  const pairing = state.auth.pairing;
  switch (pairing.kind) {
    case 'enter-code': return <EnterCodePage />;
    case 'qr-confirm': return <QrConfirmPage pairing={pairing} />;
    case 'waiting': return <WaitingPage pairing={pairing} />;
    case 'failed': return <FailurePage pairing={pairing} />;
  }
}
