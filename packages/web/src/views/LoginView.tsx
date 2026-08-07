import { useEffect, useRef, useState } from 'react';
import type {
  GitHubAuthError,
  GitHubAuthUnavailableReason,
  GitHubDeviceAuthorization,
} from '@gian/shared';
import { desktopBridge } from '../desktop-bridge.js';
import { AUTH_INVALID_CREDENTIALS } from '../operations/auth.js';
import { useOperationDispatch, useOperationRun } from '../operations/use-operations.js';
import { useT } from '../i18n/index.js';
import { OnboardingSteps } from './OnboardingView.js';

/**
 * Login surfaces. Phase 3b (UI Operation Layer): both login paths dispatch
 * pending auth operations (`auth.login` REST / `auth.githubLogin` desktop
 * bridge device flow, entity `auth:current`); the settled identity reaches
 * App through the auth sink wired by use-app-auth, and the run's phase drives
 * the submitting/disabled states and inline errors here.
 */
export function LoginView() {
  const githubAuth = desktopBridge()?.githubAuth;
  if (githubAuth) {
    return <GitHubLoginView />;
  }
  return <PasswordLoginView />;
}

function GitHubLoginView() {
  const t = useT();
  const dispatch = useOperationDispatch();
  const githubAuth = desktopBridge()?.githubAuth;
  const attemptRef = useRef(0);
  const [authorization, setAuthorization] = useState<GitHubDeviceAuthorization | null>(null);
  const [unavailable, setUnavailable] = useState<GitHubAuthUnavailableReason | null>(null);
  const [error, setError] = useState<GitHubAuthError | null>(null);
  const [phase, setPhase] = useState<'checking' | 'idle' | 'starting' | 'waiting'>('checking');
  const [copied, setCopied] = useState(false);
  // The in-flight auth.githubLogin run + the attempt that dispatched it.
  const [loginRun, setLoginRun] = useState<{ runId: string; attempt: number } | null>(null);
  const run = useOperationRun(loginRun?.runId);

  useEffect(() => {
    let alive = true;
    void githubAuth?.getState().then(state => {
      if (!alive) return;
      setUnavailable(state.status === 'unavailable' ? state.reason : null);
      setPhase('idle');
    }).catch(() => {
      if (!alive) return;
      setError('network');
      setPhase('idle');
    });
    return () => {
      alive = false;
      attemptRef.current += 1;
      void githubAuth?.cancel();
    };
  }, [githubAuth]);

  // Settle the run back into the phase machine: a failure returns to idle
  // with the error code; a stale attempt (canceled/superseded) ignores the
  // outcome entirely. Success signs in via the auth sink — App swaps this
  // view out, there is nothing local to do.
  useEffect(() => {
    if (!loginRun || !run || run.phase !== 'failed') return;
    if (loginRun.attempt !== attemptRef.current) return;
    setLoginRun(null);
    setAuthorization(null);
    setPhase('idle');
    setError((run.error ?? 'network') as GitHubAuthError);
  }, [loginRun, run?.phase, run?.error]);

  function startLogin() {
    if (!githubAuth) return;
    const attempt = ++attemptRef.current;
    setError(null);
    setCopied(false);
    setAuthorization(null);
    setPhase('starting');
    const dispatched = dispatch('auth.githubLogin', {
      onAuthorization: (next: GitHubDeviceAuthorization) => {
        if (attempt !== attemptRef.current) return;
        setAuthorization(next);
        setPhase('waiting');
      },
    });
    setLoginRun({ runId: dispatched.id, attempt });
  }

  function cancelLogin() {
    attemptRef.current += 1;
    void githubAuth?.cancel();
    setAuthorization(null);
    setError(null);
    setPhase('idle');
  }

  async function copyCode() {
    if (!authorization) return;
    try {
      await navigator.clipboard.writeText(authorization.userCode);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  const unavailableText = unavailable
    ? t(`login.github.unavailable.${unavailable}`)
    : null;
  const errorText = error ? t(`login.github.error.${error}`) : null;

  return (
    <div className="login-shell">
      <div className="login-card login-card-github">
        <OnboardingSteps active={1} />
        <div className="login-brand-mark" aria-hidden>G</div>
        <h1 className="login-brand">Gian</h1>
        <p className="login-intro">{t('login.github.intro')}</p>

        {authorization ? (
          <div className="login-device">
            <p>{t('login.github.code.help')}</p>
            <button
              className="login-device-code"
              type="button"
              onClick={() => void copyCode()}
              aria-label={t('login.github.code.copy')}
            >
              {authorization.userCode}
            </button>
            <span className="login-device-copy">
              {copied ? t('login.github.code.copied') : t('login.github.waiting')}
            </span>
            <a href={authorization.verificationUri} target="_blank" rel="noreferrer">
              {t('login.github.openAgain')}
            </a>
            <button className="login-cancel" type="button" onClick={cancelLogin}>
              {t('common.cancel')}
            </button>
          </div>
        ) : (
          <button
            className="login-submit login-github-submit"
            type="button"
            disabled={phase !== 'idle' || unavailable !== null}
            onClick={startLogin}
          >
            <GitHubMark />
            {phase === 'starting' || phase === 'checking'
              ? t('login.github.starting')
              : t('login.github.submit')}
          </button>
        )}

        {(unavailableText || errorText) && (
          <p className="login-error">{unavailableText ?? errorText}</p>
        )}
        <p className="login-privacy">{t('login.github.privacy')}</p>
      </div>
    </div>
  );
}

function GitHubMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="login-github-mark">
      <path fill="currentColor" d="M12 .7a11.5 11.5 0 0 0-3.64 22.4c.58.1.79-.25.79-.56v-2.23c-3.22.7-3.9-1.37-3.9-1.37-.52-1.34-1.28-1.7-1.28-1.7-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.57-.29-5.27-1.28-5.27-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.16 1.18a10.9 10.9 0 0 1 5.76 0c2.2-1.49 3.16-1.18 3.16-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.71 5.38-5.29 5.67.42.36.79 1.07.79 2.16v3.2c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .7Z" />
    </svg>
  );
}

function PasswordLoginView() {
  const t = useT();
  const dispatch = useOperationDispatch();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  // Busy state is the in-flight auth.login run (Phase 3b), not a local flag.
  const [runId, setRunId] = useState<string>();
  const run = useOperationRun(runId);
  const loading = run?.phase === 'pending';

  useEffect(() => {
    if (!run || run.phase !== 'failed') return;
    setError(
      run.error === AUTH_INVALID_CREDENTIALS
        ? t('login.error.invalid')
        : t('login.error.network'),
    );
  }, [run?.phase, run?.error, t]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setRunId(dispatch('auth.login', { username, password }).id);
  }

  return (
    <div className="login-shell">
      <div className="login-card">
        <h1 className="login-brand">Gian</h1>
        <form className="login-form" onSubmit={handleSubmit}>
          <div className="login-field">
            <label className="login-label" htmlFor="username">{t('login.username.label')}</label>
            <input
              id="username"
              className="login-input"
              type="text"
              autoComplete="username"
              autoFocus
              value={username}
              onChange={e => setUsername(e.target.value)}
              disabled={loading}
              required
            />
          </div>
          <div className="login-field">
            <label className="login-label" htmlFor="password">{t('login.password.label')}</label>
            <input
              id="password"
              className="login-input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              disabled={loading}
              required
            />
          </div>
          {error && <p className="login-error">{error}</p>}
          <button className="login-submit" type="submit" disabled={loading}>
            {loading ? t('login.submitting') : t('login.submit')}
          </button>
        </form>
      </div>
    </div>
  );
}
