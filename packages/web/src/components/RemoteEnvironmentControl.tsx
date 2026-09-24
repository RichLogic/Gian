import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { authorizeRemoteAccount } from '../auth/github-authorization.js';
import { useT } from '../i18n/index.js';
import { remoteRequest, type RemoteEnvironment, type RemoteSessionChoice } from '../remote-environments.js';
import { useUpDrop } from './composer/option-drops.js';
import '../styles/remote-environments.css';

export function RemoteEnvironmentControl({ value, onChange, onTakeover, disabled = false, children }: {
  value: string; onChange(id: string): void; onTakeover?(session: RemoteSessionChoice): void;
  disabled?: boolean;
  children(control: ReactNode): ReactNode;
}) {
  const t = useT();
  const drop = useUpDrop(352);
  const popupId = useId();
  const [environments, setEnvironments] = useState<RemoteEnvironment[]>([]);
  const [adding, setAdding] = useState(false);
  const [origin, setOrigin] = useState('');
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const running = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [sessionList, setSessionList] = useState<{ environmentId: string; sessions: RemoteSessionChoice[] } | null>(null);
  const sessions = sessionList?.environmentId === value ? sessionList.sessions : null;
  const selected = environments.find(environment => environment.id === value);
  const label = value ? selected?.name ?? t('remote.host') : t('remote.local');
  const refresh = async () => {
    const result = await remoteRequest<{ environments: RemoteEnvironment[] }>('/environments');
    if (!Array.isArray(result.environments)) throw new Error('Invalid environments');
    setEnvironments(result.environments);
  };
  useEffect(() => { void refresh().catch(() => setError(true)); }, []);
  useEffect(() => () => running.current?.abort(), []);
  useEffect(() => {
    if (drop.open && drop.pos) drop.popRef.current?.querySelector<HTMLButtonElement>('.mp-row.active')?.focus();
  }, [drop.open, drop.pos]);
  async function run(action: (signal: AbortSignal) => Promise<void>) {
    if (disabled || busy || running.current) return;
    const abort = new AbortController();
    running.current = abort;
    setBusy(true); setError(false);
    try { await action(abort.signal); }
    catch (reason) { if (!abort.signal.aborted && !(reason instanceof Error && reason.message === 'cancelled')) setError(true); }
    finally { if (running.current === abort) running.current = null; if (!abort.signal.aborted) setBusy(false); }
  }
  function choose(id: string) {
    setSessionList(null); setAdding(false); drop.setOpen(false); onChange(id);
  }
  const control = <>
    <button ref={drop.btnRef} type="button" className={`composer-opt ns-host-btn${drop.open ? ' open' : ''}`}
      data-testid="ns-host-picker" disabled={disabled || busy} title={`${t('remote.host')}: ${label}`}
      aria-label={`${t('remote.host')}: ${label}`} aria-haspopup="dialog" aria-expanded={drop.open}
      aria-controls={drop.open ? popupId : undefined} onClick={() => drop.setOpen(open => !open)}>
      <span className="ns-host-label">{t('remote.host')}</span>
      <span className="name">{label}</span>
      <span className="caret cmp-caret" aria-hidden="true">▾</span>
    </button>
    {drop.open && drop.pos && createPortal(<div ref={drop.popRef} id={popupId}
      className="popover ns-host-pop" role="dialog" aria-label={t('remote.host')}
      style={{ left: drop.pos.left, bottom: drop.pos.bottom,
        maxHeight: Math.max(120, window.innerHeight - drop.pos.bottom - 8) }}
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); drop.setOpen(false); drop.btnRef.current?.focus(); }
      }}>
      <div className="mp-section-head"><span className="mp-section-title">{t('remote.host')}</span></div>
      <div className="mp-list">
        <button type="button" className={`mp-row${!value ? ' active' : ''}`} disabled={disabled || busy}
          aria-pressed={!value} onClick={() => choose('')}>
          <span className="mp-check">{!value ? '✓' : ''}</span>
          <span className="mp-row-body"><span className="mp-row-title">{t('remote.local')}</span></span>
        </button>
        {environments.map(environment => <button key={environment.id} type="button"
          className={`mp-row${value === environment.id ? ' active' : ''}`} disabled={disabled || busy}
          aria-pressed={value === environment.id} onClick={() => choose(environment.id)}>
          <span className="mp-check">{value === environment.id ? '✓' : ''}</span>
          <span className="mp-row-body">
            <span className="mp-row-title">{environment.name}</span>
            <span className="mp-row-hint">{environment.pending ? t('remote.awaitingConfirmation')
              : t(environment.connected ? 'remote.hostOnline' : 'remote.hostOffline')}</span>
          </span>
        </button>)}
      </div>
      <div className="ns-host-actions">
        <button type="button" className="mp-row" disabled={disabled || busy}
          aria-expanded={adding} onClick={() => { setAdding(!adding); setSessionList(null); }}>
          {t('remote.connectHost')}
        </button>
        {value && onTakeover && <button type="button" className="mp-row" disabled={disabled || busy}
          onClick={() => void run(async () => {
            const result = await remoteRequest<{ sessions: RemoteSessionChoice[] }>(`/environments/${value}/sessions`);
            setSessionList({ environmentId: value, sessions: result.sessions }); setAdding(false);
          })}>{t('remote.takeover')}</button>}
      </div>
    {adding && <div className="remote-environment-form">
      <label>{t('settings.remote.serverUrl')}<input type="url" value={origin} disabled={disabled || busy}
        onChange={event => setOrigin(event.target.value)} /></label>
      <label>{t('remote.hostName')}<input value={name} disabled={disabled || busy} onChange={event => setName(event.target.value)} /></label>
      <label>{t('remote.pairingCode')}<input value={code} disabled={disabled || busy} autoComplete="off" onChange={event => setCode(event.target.value)} /></label>
      <button type="button" className="btn primary" disabled={disabled || busy || !origin.trim() || !name.trim() || !code.trim()}
        onClick={() => void run(async signal => {
          await authorizeRemoteAccount(origin.trim(), 'controller', { signal });
          if (signal.aborted) return;
          const serverUrl = new URL(origin.trim()).origin;
          const result = await remoteRequest<{ environment: RemoteEnvironment }>('/environments',
            { server_url: serverUrl, name: name.trim(), code: code.trim() });
          if (signal.aborted) return;
          setCode(''); setOrigin(serverUrl); await refresh();
          if (!signal.aborted) choose(result.environment.id);
        })}>{t('remote.connectHost')}</button>
    </div>}
    {sessions && <div className="remote-environment-sessions">
      {sessions.length === 0 && <span>{t('remote.noSessions')}</span>}
      {sessions.map(session => <button key={session.id} type="button" className="btn secondary"
        disabled={disabled || busy} onClick={() => { setSessionList(null); drop.setOpen(false); onTakeover?.(session); }}>{session.name ?? session.id}</button>)}
    </div>}
    {error && <div role="alert">{t('remote.requestFailed')}{' '}
      <button type="button" className="btn secondary" disabled={disabled || busy} onClick={() => void run(refresh)}>{t('settings.remote.retry')}</button></div>}
    </div>, document.body)}
  </>;
  return children(control);
}
