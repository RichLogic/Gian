/**
 * App shell (B2, §12.1/§12.2). Desktop header: back/forward, `Task › Session`
 * breadcrumb (Host never repeated here), and the single Host selector on the
 * right — no icon dock. Narrow layout: screen-level header with menu, the
 * session title, and the Host selector; rail/file/settings are full pages.
 */

import { useEffect } from 'react';
import { useT } from './i18n/index.js';
import { resolveTheme, useSystemDark } from './theme.js';
import { useRemoteActions, useRemoteState } from './ui/controller-context.js';
import { ConnectionBanner, DeviceRevokedPage } from './ui/banners.js';
import { ChatPage } from './ui/chat.js';
import { FileMainPanel, FilePage, FileSheetPanel } from './ui/file-viewer.js';
import { HostSelector } from './ui/host-selector.js';
import { Icon } from './ui/icons.js';
import { NewChatPage } from './ui/new-chat.js';
import { PairingApp } from './ui/pairing.js';
import { Rail, RailPage } from './ui/rail.js';
import { SettingsMainPanel, SettingsPage } from './ui/settings.js';
import { useViewportMode } from './ui/viewport.js';

function Breadcrumb() {
  const state = useRemoteState();
  const view = state.view;
  if (view.kind !== 'chat') {
    const label = view.kind === 'new-chat' ? 'new-chat' : view.kind === 'settings' ? 'settings' : null;
    return (
      <div className="path">
        {label && (
          <span className="path-seg-anchor">
            <button type="button" className="path-seg session">
              <span className="path-seg-label">{label === 'new-chat' ? 'New chat' : 'Settings'}</span>
            </button>
          </span>
        )}
      </div>
    );
  }
  const session = state.sessions.find((s) => s.id === view.sessionId);
  const task = session?.task_id ? state.tasks.find((taskItem) => taskItem.id === session.task_id) : null;
  return (
    <div className="path">
      {task && (
        <span className="path-seg-anchor">
          <button type="button" className="path-seg branch">
            <span className="path-seg-label">{task.name}</span>
          </button>
        </span>
      )}
      {task && (
        <span className="path-sep" aria-hidden="true">›</span>
      )}
      <span className="path-seg-anchor">
        <button type="button" className="path-seg session">
          <span className="path-seg-label">{session?.name ?? session?.id ?? ''}</span>
        </button>
      </span>
    </div>
  );
}

function InitialConnectionPanel() {
  const t = useT();
  const state = useRemoteState();
  if (!state.currentHostId) return <div className="rw-initial-loading" role="status">
    <strong>{t('host.select')}</strong><span>{t('host.selectHint')}</span>
  </div>;
  return (
    <>
      <ConnectionBanner connection={state.connection} />
      <div
        className="rw-initial-loading"
        role="status"
        aria-label={t('conn.initial.title')}
        aria-live="polite"
      >
        <span className="spinner" aria-hidden="true" />
        <strong>{t('conn.initial.title')}</strong>
        <span>{t('conn.initial.desc')}</span>
        {state.connectionPhase && <span>{t(`conn.phase.${state.connectionPhase}`)}</span>}
        {state.connectionFailed && <span>{t('conn.failedHint')}</span>}
      </div>
    </>
  );
}

function DesktopShell() {
  const t = useT();
  const state = useRemoteState();
  const actions = useRemoteActions();
  const mode = useViewportMode();
  const view = state.view;
  const awaitingInitialSnapshot = state.auth.kind === 'challenge-login'
    && state.snapshotReceivedAt === null;

  const session = view.kind === 'chat' ? state.sessions.find((s) => s.id === view.sessionId) : undefined;
  const fileOpen = state.fileViewer !== null;
  // File layout tiers (§12.1.6): wide = right panel; mid = replaces chat.
  const fileAsPanel = fileOpen && mode === 'wide';
  const fileAsMain = fileOpen && mode === 'mid';

  return (
    <div className="rw-app" data-mode={mode}>
      <header className="topbar">
        <button type="button" className="tb-toggle" title={t('shell.back')} aria-label={t('shell.back')} disabled>
          <Icon name="back" size={15} />
        </button>
        <button type="button" className="tb-toggle" title={t('shell.forward')} aria-label={t('shell.forward')} disabled>
          <Icon name="forward" size={15} />
        </button>
        <span className="tb-divider" aria-hidden="true" />
        <Breadcrumb />
        <span className="topbar-spacer" />
        <HostSelector />
      </header>
      <div className="view">
        <Rail />
        {awaitingInitialSnapshot ? (
          <main className="main rw-initial-main" aria-busy="true">
            <InitialConnectionPanel />
          </main>
        ) : fileAsMain ? (
          <FileMainPanel />
        ) : view.kind === 'settings' ? (
          <SettingsMainPanel />
        ) : view.kind === 'new-chat' ? (
          <main className="main">
            <div className="main-head">
              <div className="main-head-l" style={{ gap: 6 }}>
                <button
                  type="button"
                  className="sb-iconbtn"
                  title={t('shell.back')}
                  aria-label={t('shell.back')}
                  onClick={() => actions.backToChat()}
                >
                  <Icon name="back" size={15} />
                </button>
                <span className="manager-task-name">New chat</span>
              </div>
            </div>
            <NewChatPage />
          </main>
        ) : session ? (
          <main className="main">
            <ChatPage session={session} />
          </main>
        ) : (
          <main className="main">
            <div className="rw-empty">{t('rail.newChat.title')}</div>
          </main>
        )}
        {fileAsPanel && <FileSheetPanel />}
      </div>
    </div>
  );
}

function NarrowShell() {
  const t = useT();
  const state = useRemoteState();
  const actions = useRemoteActions();
  const page = state.mobilePage;
  const awaitingInitialSnapshot = state.auth.kind === 'challenge-login'
    && state.snapshotReceivedAt === null;
  const session = state.view.kind === 'chat'
    ? state.sessions.find((s) => s.id === (state.view as { sessionId: string }).sessionId)
    : undefined;

  if (page === 'rail') {
    return (
      <div className="rw-app" data-mode="narrow">
        <RailPage />
      </div>
    );
  }
  if (page === 'settings') {
    return (
      <div className="rw-app" data-mode="narrow">
        <SettingsPage />
      </div>
    );
  }
  if (page === 'new-chat') {
    return (
      <div className="rw-app" data-mode="narrow">
        <div className="rw-page" data-page="new-chat">
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
            <span className="rw-page-title">New chat</span>
          </div>
          <NewChatPage />
        </div>
      </div>
    );
  }
  if (page === 'file' && state.fileViewer) {
    return (
      <div className="rw-app" data-mode="narrow">
        <FilePage />
      </div>
    );
  }

  return (
    <div className="rw-app" data-mode="narrow">
      <div className="rw-m-header">
        <button
          type="button"
          className="sb-iconbtn"
          title={t('shell.menu')}
          aria-label={t('shell.menu')}
          onClick={() => actions.openMobilePage('rail')}
        >
          <Icon name="menu" size={15} />
        </button>
        <span className="rw-m-title">{session?.name ?? t('rail.title')}</span>
        <HostSelector />
      </div>
      <main className={`main${awaitingInitialSnapshot ? ' rw-initial-main' : ''}`} aria-busy={awaitingInitialSnapshot || undefined}>
        {awaitingInitialSnapshot
          ? <InitialConnectionPanel />
          : session
            ? <ChatPage session={session} />
            : <div className="rw-empty">{t('rail.newChat.title')}</div>}
      </main>
    </div>
  );
}

function Shell() {
  const state = useRemoteState();
  const actions = useRemoteActions();
  const mode = useViewportMode();
  const systemDark = useSystemDark();

  // Apply theme/accent to the document root element the tokens bind to.
  // `system` tracks the OS dark-mode preference live.
  useEffect(() => {
    document.body.dataset.theme = resolveTheme(state.settings.theme, systemDark);
    document.body.dataset.accent = state.settings.accent;
  }, [state.settings.theme, state.settings.accent, systemDark]);

  useEffect(() => {
    if (state.auth.kind === 'pairing' && state.auth.pairing.kind === 'enter-code') {
      actions.restoreBrowserSession();
    }
  }, [actions, state.auth]);

  // Device revoked is terminal: caches are already cleared by the controller;
  // the only path forward is re-pairing.
  if (state.connection.kind === 'device_revoked') {
    return <DeviceRevokedPage />;
  }
  // Remembered device-key authentication stays in the product shell. If
  // legacy state contains more than one Host, the existing header selector
  // owns that choice instead of a standalone login page.
  if (state.auth.kind === 'pairing') {
    return <PairingApp />;
  }
  return mode === 'narrow' ? <NarrowShell /> : <DesktopShell />;
}

export function App() {
  return <Shell />;
}
