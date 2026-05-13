import { useEffect, useRef, useState } from 'react';
import type { Bot, Workspace } from '@gian/shared';
import type { WsState } from '../ws.js';
import type { PendingApproval } from '../App.js';
import type { ReconnectComponent } from '../api.js';
import { useT } from '../i18n/index.js';

interface ComponentStatus {
  label: string;
  key: ReconnectComponent;
  state: 'ok' | 'error' | 'unconfigured';
  detail?: string;
}

function inferComponents(bots: Bot[], wsState: WsState): ComponentStatus[] {
  // Codex and Claude Code status comes from the runner stub in state_sync.
  // For M5 we treat WS connectivity as a proxy — if we're connected, proxies
  // are assumed alive; when disconnected we can't know, so show unknown.
  const proxyState: ComponentStatus['state'] = wsState === 'open' ? 'ok' : 'error';

  const discord = bots.filter(b => b.platform === 'discord');
  const slack = bots.filter(b => b.platform === 'slack');

  function imState(list: Bot[]): ComponentStatus['state'] {
    if (list.length === 0) return 'unconfigured';
    const enabled = list.filter(b => b.enabled === 1);
    if (enabled.length === 0) return 'unconfigured';
    return enabled.some(b => b.status === 'connected') ? 'ok' : 'error';
  }

  function imDetail(list: Bot[]): string | undefined {
    const enabled = list.filter(b => b.enabled === 1);
    if (enabled.length === 0) return undefined;
    const errored = enabled.filter(b => b.status === 'error' && b.last_error);
    return errored[0]?.last_error ?? undefined;
  }

  return [
    { label: 'Codex', key: 'codex' as const, state: proxyState },
    { label: 'Claude Code', key: 'claude' as const, state: proxyState },
    { label: 'Discord', key: 'discord' as const, state: imState(discord), detail: imDetail(discord) },
    { label: 'Slack', key: 'slack' as const, state: imState(slack), detail: imDetail(slack) },
  ];
}

function aggregateState(components: ComponentStatus[], wsState: WsState): 'ok' | 'warn' | 'error' {
  if (wsState === 'closed') return 'error';
  if (wsState === 'connecting') return 'warn';
  if (components.some(c => c.state === 'error')) return 'warn';
  return 'ok';
}

export function Topbar({
  wsState,
  wsAttempt,
  authed,
  bots,
  activeWorkspace,
  workspaces,
  pendingApprovals,
  onJumpToSession,
  onSettingsClick,
  onReconnect,
  onPaletteOpen,
  onPickWorkspace,
}: {
  wsState: WsState;
  wsAttempt: number;
  authed: boolean;
  bots: Bot[];
  activeWorkspace: Workspace | null;
  workspaces: Workspace[];
  pendingApprovals: PendingApproval[];
  onJumpToSession: (sessionId: string) => void;
  onSettingsClick: () => void;
  onReconnect?: (component: ReconnectComponent) => Promise<void>;
  onPaletteOpen?: (initialQuery?: string) => void;
  onPickWorkspace?: (id: string) => void;
}) {
  const t = useT();
  const [approvalPopoverOpen, setApprovalPopoverOpen] = useState(false);
  const [statusPopoverOpen, setStatusPopoverOpen] = useState(false);
  const [workspacePopoverOpen, setWorkspacePopoverOpen] = useState(false);
  const [reconnecting, setReconnecting] = useState<ReconnectComponent | null>(null);
  const approvalBtnRef = useRef<HTMLButtonElement>(null);
  const statusBtnRef = useRef<HTMLButtonElement>(null);
  const workspaceBtnRef = useRef<HTMLButtonElement>(null);
  const approvalPopRef = useRef<HTMLDivElement>(null);
  const statusPopRef = useRef<HTMLDivElement>(null);
  const workspacePopRef = useRef<HTMLDivElement>(null);
  const count = pendingApprovals.length;

  useEffect(() => {
    if (!statusPopoverOpen && !approvalPopoverOpen && !workspacePopoverOpen) return;
    function onPointerDown(e: PointerEvent) {
      const target = e.target as Node;
      if (
        statusPopoverOpen &&
        !statusPopRef.current?.contains(target) &&
        !statusBtnRef.current?.contains(target)
      ) {
        setStatusPopoverOpen(false);
      }
      if (
        approvalPopoverOpen &&
        !approvalPopRef.current?.contains(target) &&
        !approvalBtnRef.current?.contains(target)
      ) {
        setApprovalPopoverOpen(false);
      }
      if (
        workspacePopoverOpen &&
        !workspacePopRef.current?.contains(target) &&
        !workspaceBtnRef.current?.contains(target)
      ) {
        setWorkspacePopoverOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setStatusPopoverOpen(false);
        setApprovalPopoverOpen(false);
        setWorkspacePopoverOpen(false);
      }
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [statusPopoverOpen, approvalPopoverOpen, workspacePopoverOpen]);

  const components = inferComponents(bots, wsState);
  const agg = aggregateState(components, wsState);

  function handleJump(sessionId: string): void {
    onJumpToSession(sessionId);
    setApprovalPopoverOpen(false);
  }

  function statusLabel(): string {
    if (wsState === 'connecting') return `${t('topbar.runner.reconnecting')} (${wsAttempt})`;
    if (wsState === 'closed') return t('topbar.runner.offline');
    if (!authed) return t('topbar.runner.auth');
    return t('topbar.runner.ready');
  }

  return (
    <header className="topbar">
      <a
        className="brand"
        href="#"
        title="Toggle sidebar"
        onClick={e => {
          e.preventDefault();
          // Burger icon toggles the current view's sidebar. CodingView (and
          // any other view that wants to participate) listens for this
          // window-level event and flips its rail-collapsed state.
          window.dispatchEvent(new CustomEvent('gian.toggle-rail'));
        }}
      >
        <svg className="brand-mark" viewBox="0 0 24 24" fill="none">
          <path d="M5 4h14M5 12h14M5 20h10" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
          <circle cx="19" cy="20" r="2" fill="currentColor" />
        </svg>
        <span className="brand-word">Gian</span>
      </a>

      <div className="runner-wrap">
        <span className="runner-lbl">HOST</span>
        <button
          ref={statusBtnRef}
          className="runner-chip"
          type="button"
          data-agg={agg}
          title={t('topbar.status.title')}
          onClick={() => setStatusPopoverOpen(o => !o)}
        >
          <span className="runner-dot" data-state={agg === 'ok' ? 'ok' : agg === 'warn' ? 'warn' : 'bad'} />
          <span className="runner-host">{t('topbar.runner.local')}</span>
          <span className="runner-sep">·</span>
          <span>{statusLabel()}</span>
        </button>

        {statusPopoverOpen && (
          <div ref={statusPopRef} className="status-popover">
            <div className="status-popover-header">{t('topbar.status.header')}</div>
            <ul className="status-popover-list">
              {components.map(comp => (
                <li key={comp.label} className="status-popover-row">
                  <span
                    className="status-dot"
                    data-state={comp.state === 'ok' ? 'ok' : comp.state === 'unconfigured' ? 'none' : 'bad'}
                  />
                  <span className="status-comp-label">{comp.label}</span>
                  {comp.detail && (
                    <span className="status-comp-detail" title={comp.detail}>{comp.detail}</span>
                  )}
                  <button
                    type="button"
                    className="status-reconnect-btn btn"
                    disabled={!onReconnect || reconnecting === comp.key || comp.state === 'unconfigured'}
                    aria-label={`Reconnect ${comp.label}`}
                    onClick={() => {
                      if (!onReconnect || reconnecting) return;
                      setReconnecting(comp.key);
                      void onReconnect(comp.key).finally(() => setReconnecting(null));
                    }}
                  >
                    {reconnecting === comp.key ? '…' : t('topbar.status.reconnect')}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="crumbs">
        <span className="crumb-lbl">{t('topbar.workspace.label')}</span>
        <button
          ref={workspaceBtnRef}
          type="button"
          className="crumb-btn"
          onClick={() => setWorkspacePopoverOpen(o => !o)}
        >
          {activeWorkspace ? activeWorkspace.name : 'Pick workspace'}
          <span className="crumb-btn-car">▾</span>
        </button>
        {workspacePopoverOpen && workspaces.length > 0 && (
          <div ref={workspacePopRef} className="workspace-popover">
            {workspaces.map(ws => (
              <button
                key={ws.id}
                type="button"
                className={`workspace-popover-item${ws.id === activeWorkspace?.id ? ' active' : ''}`}
                onClick={() => {
                  onPickWorkspace?.(ws.id);
                  setWorkspacePopoverOpen(false);
                }}
              >
                <span className="workspace-popover-item-name">{ws.name}</span>
                <span className="workspace-popover-item-path">{ws.path}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <span className="topbar-spacer" />

      <button
        type="button"
        className="top-cmd"
        title="Command palette (⌘K)"
        onClick={() => onPaletteOpen?.()}
        onKeyDown={(e: React.KeyboardEvent<HTMLButtonElement>) => {
          if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
            e.preventDefault();
            onPaletteOpen?.(e.key);
          }
        }}
      >
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.5" />
          <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        <span>Jump to session, file, command…</span>
        <kbd className="kc">⌘K</kbd>
      </button>

      <div className="inbox-wrap">
        <button
          ref={approvalBtnRef}
          className="inbox-btn"
          type="button"
          title={count > 0 ? `${count} ${t('topbar.approvals.pending')}${count === 1 ? '' : 's'}` : t('topbar.approvals.none')}
          data-active={count > 0 ? 'true' : undefined}
          onClick={() => count > 0 && setApprovalPopoverOpen(o => !o)}
        >
          <svg viewBox="0 0 16 16" fill="none">
            <path d="M2 9l2-5h8l2 5M2 9v4h12V9M2 9h4l1 2h2l1-2h4" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
          </svg>
          {count > 0 && (
            <span className="inbox-badge">{count > 99 ? '99+' : count}</span>
          )}
        </button>

        {approvalPopoverOpen && count > 0 && (
          <div ref={approvalPopRef} className="inbox-popover">
            <div className="inbox-popover-header">{t('topbar.approvals.header')}</div>
            <ul className="inbox-popover-list">
              {pendingApprovals.map(a => (
                <li key={a.id} className="inbox-popover-item">
                  <button
                    type="button"
                    className="inbox-popover-jump"
                    onClick={() => handleJump(a.session_id)}
                  >
                    <span className="inbox-popover-cat" data-category={a.category}>{a.category}</span>
                    <span className="inbox-popover-desc">{a.description}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <button className="avatar" type="button" title={t('topbar.settings.title')} onClick={onSettingsClick}>R</button>
    </header>
  );
}
