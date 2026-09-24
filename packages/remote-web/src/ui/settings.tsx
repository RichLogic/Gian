/**
 * Remote Settings (B9, mockup F7/F8): theme (light/warm/dark) + accent
 * swatches, Host pairings with self-revoke ("disconnect this Host", danger
 * two-step), and "sign out of this browser" (ends the refresh family and
 * clears decrypted caches — NOT a device revoke). No account section, no
 * management of other devices.
 */

import { useState } from 'react';
import type { AccentName, RemoteHostEntry, ThemeName } from '../controller/types.js';
import { useT } from '../i18n/index.js';
import { useRemoteActions, useRemoteState } from './controller-context.js';
import { Icon } from './icons.js';
import { hostDisplayName } from '../host-selection.js';

const THEMES: ThemeName[] = ['light', 'warm', 'dark', 'system'];
const ACCENTS: Array<{ id: AccentName; swatch: string }> = [
  { id: 'rose', swatch: 'oklch(0.62 0.15 5)' },
  { id: 'azure', swatch: 'oklch(0.62 0.13 230)' },
  { id: 'moss', swatch: 'oklch(0.62 0.11 150)' },
  { id: 'plum', swatch: 'oklch(0.62 0.14 320)' },
];

function HostRow({ host }: { host: RemoteHostEntry }) {
  const t = useT();
  const state = useRemoteState();
  const actions = useRemoteActions();
  const [confirming, setConfirming] = useState(false);
  const isCurrent = host.id === state.currentHostId;

  return (
    <div className="rw-dev" data-host-id={host.id}>
      <span className={`rw-host-dot${host.online ? '' : ' off'}`} aria-hidden="true" />
      <span className="rw-dev-body">
        <span className="rw-dev-name">
          {hostDisplayName(host, state.hosts)}
          {isCurrent && <span className="rw-dev-badge">{t('settings.host.current')}</span>}
        </span>
        <span className="rw-dev-meta">
          {host.online
            ? isCurrent && host.latencyMs != null
              ? t('settings.connectedMeta', { latency: host.latencyMs })
              : t('host.status.online')
            : t('host.status.offline')}
        </span>
      </span>
      {confirming ? (
        <span className="rw-dev-confirm" role="alertdialog" aria-label={t('settings.host.disconnect')}>
          <span className="rw-dev-confirm-text">
            {t('settings.host.disconnectConfirm', { name: host.name })}
          </span>
          <button
            type="button"
            className="btn xs danger"
            onClick={() => {
              setConfirming(false);
              actions.disconnectHost(host.id);
            }}
          >
            {t('settings.host.disconnect')}
          </button>
          <button type="button" className="btn xs ghost" onClick={() => setConfirming(false)}>
            {t('common.cancel')}
          </button>
        </span>
      ) : (
        <button
          type="button"
          className="btn xs danger-ghost"
          title={t('settings.host.disconnectHint')}
          onClick={() => setConfirming(true)}
        >
          {t('settings.host.disconnect')}
        </button>
      )}
    </div>
  );
}

export function SettingsBody() {
  const t = useT();
  const state = useRemoteState();
  const actions = useRemoteActions();
  const [logoutConfirming, setLogoutConfirming] = useState(false);

  return (
    <div className="rw-settings" data-testid="remote-settings">
      <div className="rw-set-sec">
        <span className="rw-set-label">{t('settings.appearance')}</span>
        <div className="rw-set-row">
          <div className="segm sm" role="radiogroup" aria-label={t('settings.appearance')}>
            {THEMES.map((theme) => (
              <button
                key={theme}
                type="button"
                role="radio"
                aria-checked={state.settings.theme === theme}
                className={`segm-item${state.settings.theme === theme ? ' active' : ''}`}
                onClick={() => actions.setTheme(theme)}
              >
                {theme === 'system' ? t('settings.theme.system') : theme}
              </button>
            ))}
          </div>
        </div>
        <div className="rw-set-row">
          {ACCENTS.map((accent) => (
            <button
              key={accent.id}
              type="button"
              className={`rw-acc${state.settings.accent === accent.id ? ' on' : ''}`}
              title={accent.id}
              aria-label={accent.id}
              aria-pressed={state.settings.accent === accent.id}
              style={{ background: accent.swatch }}
              onClick={() => actions.setAccent(accent.id)}
            />
          ))}
        </div>
      </div>

      <div className="rw-set-sec">
        <span className="rw-set-label">{t('settings.hosts')}</span>
        <button type="button" className="btn sm secondary" onClick={() => actions.startPairing()}>
          {t('host.add')}
        </button>
        {state.hosts.map((host) => (
          <HostRow key={host.id} host={host} />
        ))}
        <span className="rw-pair-hint">{t('settings.host.disconnectHint')}</span>
      </div>

      <div className="rw-set-sec">
        {logoutConfirming ? (
          <div className="rw-set-row" role="alertdialog" aria-label={t('settings.logout')}>
            <span className="rw-dev-confirm-text">{t('settings.logoutConfirm')}</span>
            <button
              type="button"
              className="btn sm danger"
              onClick={() => {
                setLogoutConfirming(false);
                actions.logoutBrowser();
              }}
            >
              {t('settings.logout')}
            </button>
            <button type="button" className="btn sm ghost" onClick={() => setLogoutConfirming(false)}>
              {t('common.cancel')}
            </button>
          </div>
        ) : (
          <>
            <div className="rw-set-row">
              <button
                type="button"
                className="btn sm secondary"
                title={t('settings.logoutHint')}
                onClick={() => setLogoutConfirming(true)}
              >
                {t('settings.logout')}
              </button>
            </div>
            <span className="rw-pair-hint">{t('settings.logoutHint')}</span>
          </>
        )}
      </div>
      <div className="rw-set-sec"><a href="/enrollment">{t('enrollment.title')}</a></div>
    </div>
  );
}

/** Wide/mid: settings render inside the main panel (mockup F7). */
export function SettingsMainPanel() {
  const t = useT();
  const actions = useRemoteActions();
  return (
    <main className="main">
      <div className="main-head">
        <div className="main-head-l" style={{ gap: 6 }}>
          <button
            type="button"
            className="sb-iconbtn"
            title={t('settings.back')}
            aria-label={t('settings.back')}
            onClick={() => actions.backToChat()}
          >
            <Icon name="back" size={15} />
          </button>
          <span className="manager-task-name">{t('settings.title')}</span>
        </div>
      </div>
      <div className="main-scroll">
        <div style={{ maxWidth: 560, margin: '0 auto' }}>
          <SettingsBody />
        </div>
      </div>
    </main>
  );
}

/** Narrow: settings as a full-screen page (mockup F8). */
export function SettingsPage() {
  const t = useT();
  const actions = useRemoteActions();
  return (
    <div className="rw-page" data-page="settings">
      <div className="rw-page-head">
        <button
          type="button"
          className="sb-iconbtn"
          title={t('shell.back')}
          aria-label={t('shell.back')}
          onClick={() => actions.backToChat()}
        >
          <Icon name="back" size={15} />
        </button>
        <span className="rw-page-title">{t('settings.title')}</span>
      </div>
      <div className="sb-scroll" style={{ padding: '0 0 10px' }}>
        <SettingsBody />
      </div>
    </div>
  );
}
