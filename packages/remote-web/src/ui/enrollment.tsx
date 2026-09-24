import { useEffect, useRef, useState } from 'react';
import {
  ACCOUNT_PROTOCOL, AUTH_PROTOCOL, accountLoginStartedSchema, adminCreateEnrollmentResultSchema,
  exportPublicJwk, generateCanonicalId, remoteAccountChallengePayload, signBytes,
  type AccountLoginStarted, type AdminCreateEnrollmentResult,
} from '@gian/remote-protocol';
import { useT } from '../i18n/index.js';
import { Icon } from './icons.js';

type Account = { id: string; login: string };
const PREFIX = '/api/v1/enrollment';

class EnrollmentUnavailableError extends Error {
  constructor(readonly retryAfterSeconds = 5) { super('githubUnavailable'); }
}

async function request(path: string, body?: unknown): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(`${PREFIX}${path}`, {
      method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', redirect: 'error',
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch { throw new EnrollmentUnavailableError(); }
  if (response.status === 408 || response.status === 429 || response.status >= 500) {
    const retryAfter = Number(response.headers.get('retry-after'));
    throw new EnrollmentUnavailableError(Number.isFinite(retryAfter) ? Math.min(60, Math.max(5, retryAfter)) : 5);
  }
  if (!response.ok) throw new Error(response.status === 403 ? 'denied' : response.status === 401 ? 'signedOut' : 'failed');
  return response.json() as Promise<Record<string, unknown>>;
}

function systemDark(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function EnrollmentPage() {
  const t = useT();
  const [account, setAccount] = useState<Account | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<{ started: AccountLoginStarted; signature: string } | null>(null);
  const [token, setToken] = useState<AdminCreateEnrollmentResult | null>(null);
  const [now, setNow] = useState(Date.now());
  const [copied, setCopied] = useState('');
  const generation = useRef(0);
  const openedForLogin = useRef<string | null>(null);

  useEffect(() => {
    // Follow the OS theme like the rest of Remote Web — never a hard-coded light page.
    const apply = () => {
      document.body.dataset.theme = systemDark() ? 'dark' : 'light';
      document.body.dataset.accent = 'azure';
    };
    apply();
    const query = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    query?.addEventListener('change', apply);
    const current = ++generation.current;
    void request('/account').then(result => {
      if (current === generation.current) setAccount(result.account as Account);
    }).catch(reason => {
      if (current === generation.current && reason instanceof Error && reason.message !== 'signedOut') setError(reason.message);
    }).finally(() => { if (current === generation.current) setBusy(false); });
    return () => { ++generation.current; query?.removeEventListener('change', apply); };
  }, []);

  useEffect(() => {
    if (!pending) return;
    // The whole point of the device login: take the user to GitHub without
    // making them hunt for the link. The visible button below stays as the
    // popup-blocked fallback.
    if (openedForLogin.current !== pending.started.login_id) {
      openedForLogin.current = pending.started.login_id;
      try { window.open(pending.started.verification_uri, '_blank', 'noopener,noreferrer'); } catch { /* fallback stays visible */ }
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let retrySeconds = pending.started.interval_seconds;
    const schedule = (seconds: number) => {
      timer = setTimeout(() => void poll(), Math.min(seconds * 1000, Math.max(0, pending.started.expires_at - Date.now())));
    };
    const poll = async () => {
      if (pending.started.expires_at <= Date.now()) { setPending(null); setError('expired'); return; }
      try {
        const result = await request('/account/poll', { protocol: ACCOUNT_PROTOCOL,
          login_id: pending.started.login_id, signature: pending.signature });
        if (cancelled) return;
        setError('');
        if (result.status === 'authorized') { setAccount(result.account as Account); setPending(null); }
        else if (result.status === 'pending') {
          retrySeconds = Math.max(5, Number(result.interval_seconds) || 5);
          schedule(retrySeconds);
        } else { setPending(null); setError(result.status === 'denied' ? 'denied' : 'expired'); }
      } catch (reason) {
        if (cancelled) return;
        if (reason instanceof EnrollmentUnavailableError) {
          retrySeconds = Math.min(60, Math.max(retrySeconds * 2, reason.retryAfterSeconds));
          setError('retrying');
          schedule(retrySeconds);
        } else { setPending(null); setError('failed'); }
      }
    };
    schedule(pending.started.interval_seconds);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [pending]);

  useEffect(() => {
    if (!token) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [token]);

  async function signIn() {
    setBusy(true); setError('');
    const current = generation.current;
    try {
      const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
      const started = accountLoginStartedSchema.parse(await request('/account/start', {
        protocol: ACCOUNT_PROTOCOL, peer: { role: 'controller', installation_id: generateCanonicalId(),
          public_key: await exportPublicJwk(pair.publicKey) },
      }));
      const signature = await signBytes(pair.privateKey, new TextEncoder().encode(remoteAccountChallengePayload(started.challenge)));
      if (current === generation.current) setPending({ started, signature });
    } catch (reason) {
      if (current === generation.current) setError(reason instanceof EnrollmentUnavailableError ? 'githubUnavailable'
        : reason instanceof Error && reason.message === 'denied' ? 'denied' : 'failed');
    }
    finally { if (current === generation.current) setBusy(false); }
  }
  async function generate() {
    setBusy(true); setError(''); setToken(null); setCopied('');
    try {
      const issued = adminCreateEnrollmentResultSchema.parse(await request('/tokens', { protocol: AUTH_PROTOCOL }));
      setNow(Date.now()); setToken(issued);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'failed');
      if (reason instanceof Error && ['denied', 'signedOut'].includes(reason.message)) setAccount(null);
    } finally { setBusy(false); }
  }
  async function signOut() {
    setBusy(true); setError(''); setToken(null); setCopied('');
    try { await request('/account/logout', {}); setAccount(null); }
    catch { setError('failed'); }
    finally { setBusy(false); }
  }
  async function cancelLogin() {
    if (!pending) return;
    const login = pending;
    setPending(null); setBusy(true); setError('');
    try {
      await request('/account/cancel', { protocol: ACCOUNT_PROTOCOL, login_id: login.started.login_id, signature: login.signature });
      setAccount(null);
    } catch { setError('failed'); }
    finally { setBusy(false); }
  }
  async function copy(value: string, name: string) {
    try { await navigator.clipboard.writeText(value); setCopied(name); }
    catch { setError('copyFailed'); }
  }

  const seconds = token ? Math.max(0, Math.ceil((token.expires_at - now) / 1000)) : 0;
  const ttl = token ? Math.max(1, Math.round((seconds / 300) * 100)) : 0;

  return <main className="rw-enroll">
    <header className="rw-enroll-top">
      <a href="/" className="rw-enroll-back"><Icon name="back" size={14} />{t('enrollment.remote')}</a>
    </header>
    <section className="rw-enroll-card">
      <span className="rw-enroll-brand">Gian Remote</span>
      <h1 className="rw-enroll-title">{t('enrollment.title')}</h1>
      <p className="rw-enroll-sub">{t('enrollment.subtitle')}</p>

      <div className="rw-enroll-server">
        <span className="rw-enroll-server-url" title={window.location.origin}>{window.location.origin}</span>
        <button type="button" className="btn xs secondary" onClick={() => void copy(window.location.origin, 'server')}>
          {copied === 'server' ? t('enrollment.copied') : t('enrollment.copy')}
        </button>
      </div>

      {busy && !pending && <span role="status" className="spinner" aria-label={t('enrollment.pending')} />}
      {error && <p role="alert" className="rw-enroll-error">{t(`enrollment.${error}`)}</p>}

      {!busy && !account && !pending && (
        <button type="button" className="btn primary rw-enroll-cta" onClick={() => void signIn()}>
          {t('account.signIn')}
        </button>
      )}

      {pending && (
        <div className="rw-enroll-login">
          <p className="rw-enroll-note">{t('enrollment.githubOpened')}</p>
          <div className="rw-enroll-code-row">
            <code className="rw-enroll-code">{pending.started.user_code}</code>
            <button type="button" className="btn xs secondary" onClick={() => void copy(pending.started.user_code, 'code')}>
              {copied === 'code' ? t('enrollment.copied') : t('enrollment.copyCode')}
            </button>
          </div>
          <a className="btn secondary rw-enroll-cta" href={pending.started.verification_uri} target="_blank" rel="noopener noreferrer">
            {t('account.authorize')}
          </a>
          <div className="rw-enroll-waiting">
            <span className="spinner" aria-hidden="true" />
            <span role="status">{t('enrollment.waitingAuth')}</span>
          </div>
          <button type="button" className="btn sm ghost" onClick={() => void cancelLogin()}>{t('common.cancel')}</button>
        </div>
      )}

      {account && (
        <div className="rw-enroll-account">
          <span className="rw-enroll-account-name">GitHub <strong>@{account.login}</strong></span>
          <button type="button" className="btn xs ghost" disabled={busy} onClick={() => void signOut()}>{t('enrollment.signOut')}</button>
        </div>
      )}

      {account && !token && (
        <button type="button" className="btn primary rw-enroll-cta" disabled={busy} onClick={() => void generate()}>
          <Icon name="plus" size={13} />{t('enrollment.generate')}
        </button>
      )}

      {account && token && (
        <div className="rw-enroll-token">
          <label className="rw-enroll-token-label" htmlFor="enrollment-token">Enrollment token</label>
          <div className="rw-enroll-token-row">
            <textarea id="enrollment-token" className="rw-enroll-token-value" readOnly rows={2}
              value={seconds > 0 ? token.enrollment_token : ''} aria-label="Enrollment token" />
            <button type="button" className="btn xs secondary" disabled={seconds === 0}
              onClick={() => void copy(token.enrollment_token, 'token')}>
              {copied === 'token' ? t('enrollment.copied') : t('enrollment.copy')}
            </button>
          </div>
          <div className="rw-enroll-ttl">
            <div className="rw-enroll-ttl-bar" aria-hidden="true">
              <div className="rw-enroll-ttl-fill" style={{ width: `${ttl}%` }} />
            </div>
            <span role="status" className="rw-enroll-ttl-text">
              {seconds > 0
                ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} · ${t('enrollment.singleUse')}`
                : t('enrollment.expired')}
            </span>
          </div>
          <p className="rw-enroll-note">{t('enrollment.tokenHint')}</p>
          <button type="button" className="btn secondary rw-enroll-cta" disabled={busy} onClick={() => void generate()}>
            <Icon name="plus" size={13} />{t('enrollment.generateAgain')}
          </button>
        </div>
      )}
    </section>
  </main>;
}
