/**
 * Host selector — the only Host chrome in the header (breadcrumb never
 * repeats the Host). Status is always text + dot, never color alone.
 */

import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n/index.js';
import { useRemoteActions, useRemoteState } from './controller-context.js';
import { Icon } from './icons.js';

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function HostStatusText({
  online,
  reconnecting,
}: {
  online: boolean;
  reconnecting: boolean;
}) {
  const t = useT();
  const label = reconnecting
    ? t('host.status.reconnecting')
    : online
      ? t('host.status.connected')
      : t('host.status.offline');
  return <small className="rw-host-status">{label}</small>;
}

export function HostSelector() {
  const t = useT();
  const state = useRemoteState();
  const actions = useRemoteActions();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const current = state.hosts.find((h) => h.id === state.currentHostId) ?? null;
  const reconnecting = state.connection.kind === 'relay_reconnecting' || state.connection.kind === 'resyncing';
  const online = state.connection.kind === 'online';

  useEffect(() => {
    if (!open) return;
    const onDocClick = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className={`rw-host${open ? ' open' : ''}`} ref={rootRef}>
      <button
        type="button"
        className="rw-host-btn"
        aria-label={t('host.selector.label')}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((v) => !v)}
      >
        <span className={`rw-host-dot${online ? '' : ' off'}`} aria-hidden="true" />
        <span className="rw-host-current">{current?.name ?? '—'}</span>
        <HostStatusText online={online} reconnecting={reconnecting} />
        <Icon name="caret-down" size={10} />
      </button>
      {open && (
        <div className="rw-host-pop" role="menu" aria-label={t('host.selector.label')}>
          {state.hosts.map((host) => (
            <button
              key={host.id}
              type="button"
              role="menuitemradio"
              aria-checked={host.id === state.currentHostId}
              className={`rw-host-row${host.id === state.currentHostId ? ' is-current' : ''}${host.online ? '' : ' is-off'}`}
              onClick={() => {
                setOpen(false);
                if (state.auth.kind === 'challenge-login') actions.challengeLogin(host.id);
                else actions.selectHost(host.id);
              }}
            >
              <span className={`rw-host-dot${host.online ? '' : ' off'}`} aria-hidden="true" />
              <span className="rw-host-name">
                {host.name}
                <small>
                  {host.online
                    ? `${t('host.row.sessions', { count: host.sessionCount })} · ${t('host.status.online')}`
                    : `${t('host.status.offline')}${host.lastSeenAt ? ` · ${t('host.row.lastSeen', { time: formatTime(host.lastSeenAt) })}` : ''}`}
                </small>
              </span>
              {host.id === state.currentHostId && <span className="rw-host-check" aria-hidden="true">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
