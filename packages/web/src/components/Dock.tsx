import { useEffect, useRef, useState } from 'react';
import type { RunnerInfo } from '@gian/shared';
import { useT } from '../i18n/index.js';
import type { WsState } from '../ws.js';
import type { RailId } from './sheet-model.js';

type Group = 'panel' | 'wb';

interface DockBtnProps {
  group: Group;
  testId: string;
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
}

function DockBtn({ group, testId, label, active, disabled, onClick, children }: DockBtnProps) {
  return (
    <button
      type="button"
      className={`dock-btn ${group} ${active ? 'active' : ''}`}
      data-dock-group={group}
      data-testid={`dock-${testId}`}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      title={label}
    >
      {children}
      <span className="lbl">{label}</span>
    </button>
  );
}

const ICONS = {
  // Redrawn on a shared 24-grid (phase 6): 1.5px stroke, round caps/joins,
  // Codex-style minimal geometry, optically centered.
  grid: 'M4 5.5A1.5 1.5 0 0 1 5.5 4h4A1.5 1.5 0 0 1 11 5.5v4A1.5 1.5 0 0 1 9.5 11h-4A1.5 1.5 0 0 1 4 9.5z M13 5.5A1.5 1.5 0 0 1 14.5 4h4A1.5 1.5 0 0 1 20 5.5v4a1.5 1.5 0 0 1-1.5 1.5h-4A1.5 1.5 0 0 1 13 9.5z M4 14.5A1.5 1.5 0 0 1 5.5 13h4a1.5 1.5 0 0 1 1.5 1.5v4a1.5 1.5 0 0 1-1.5 1.5h-4A1.5 1.5 0 0 1 4 18.5z M13 14.5a1.5 1.5 0 0 1 1.5-1.5h4a1.5 1.5 0 0 1 1.5 1.5v4a1.5 1.5 0 0 1-1.5 1.5h-4a1.5 1.5 0 0 1-1.5-1.5z',
  sidechat: 'M9.2 15.8 6 18.4v-2.6H4.8A1.8 1.8 0 0 1 3 14V6.8A1.8 1.8 0 0 1 4.8 5h8.4A1.8 1.8 0 0 1 15 6.8v.7 M15.6 9.5h3.6A1.8 1.8 0 0 1 21 11.3v4.2a1.8 1.8 0 0 1-1.8 1.8h-.6v2.6l-3.2-2.6h-4.6a1.8 1.8 0 0 1-1.8-1.8v-.7',
  folder: 'M3.5 7A2.5 2.5 0 0 1 6 4.5h3.4a2 2 0 0 1 1.6.8l1.2 1.7H18A2.5 2.5 0 0 1 20.5 9.5v8A2.5 2.5 0 0 1 18 20H6a2.5 2.5 0 0 1-2.5-2.5z',
  diff: 'M8.5 4v13 M8.5 4l-3 3 M8.5 4l3 3 M15.5 20V7 M15.5 20l3-3 M15.5 20l-3-3',
  terminal: 'M5.5 7.5l4.5 4.5-4.5 4.5 M12.5 18.5h6',
  browser: 'M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z M3.5 12h17 M12 3.5c2.3 2.4 3.6 5.3 3.6 8.5s-1.3 6.1-3.6 8.5c-2.3-2.4-3.6-5.3-3.6-8.5S9.7 5.9 12 3.5z',
  gear: 'M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z M18.7 12a6 6 0 0 0-.1-1.2l1.8-1.4-1.8-3.1-2.1.8a6.2 6.2 0 0 0-2.1-1.2L14 3.5h-4l-.4 2.4a6.2 6.2 0 0 0-2.1 1.2l-2.1-.8-1.8 3.1 1.8 1.4a6 6 0 0 0 0 2.4l-1.8 1.4 1.8 3.1 2.1-.8a6.2 6.2 0 0 0 2.1 1.2l.4 2.4h4l.4-2.4a6.2 6.2 0 0 0 2.1-1.2l2.1.8 1.8-3.1-1.8-1.4c.07-.4.1-.8.1-1.2z',
};

function Icon({ d, size = 17 }: { d: string; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}

interface Props {
  /** Currently open rail; null = all dock panels collapsed. */
  activeRail: RailId | null;
  /** Toggle a rail open/closed (re-clicking the active rail collapses it). */
  onToggleRail: (rail: RailId) => void;
  /** Session-scoped rails (Files / Diffs) need an active session. */
  sessionRailsDisabled?: boolean;
  /** Global workbench rails (Terminal / Workspaces / Settings) need
   *  Sessions or Tasks mode. */
  workbenchDisabled?: boolean;

  // Runner chip (V1-style clickable status pill anchored bottom-right).
  wsState: WsState;
  wsAttempt: number;
  authed: boolean;
  runner: RunnerInfo | null;
}

export function Dock({
  activeRail,
  onToggleRail,
  sessionRailsDisabled,
  workbenchDisabled,
  wsState,
  wsAttempt,
  authed,
  runner,
}: Props) {
  const t = useT();
  const [runnerOpen, setRunnerOpen] = useState(false);
  const runnerRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!runnerOpen) return;
    function onDown(e: PointerEvent) {
      if (runnerRef.current?.contains(e.target as Node)) return;
      setRunnerOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setRunnerOpen(false);
    }
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [runnerOpen]);

  const runnerState: 'ok' | 'reconnecting' | 'offline' =
    wsState === 'open' && authed ? 'ok'
    : wsState === 'connecting' ? 'reconnecting'
    : 'offline';
  const runnerTitle =
    runnerState === 'ok' ? `${t('dock.runner.connected')}${runner ? ` · ${runner.latency}ms` : ''}`
    : runnerState === 'reconnecting' ? `${t('dock.runner.reconnecting')} (${wsAttempt})…`
    : t('dock.runner.reconnecting.title');

  return (
    <aside className="dock">
      <div className="dock-group" data-dock-group-label={t('dock.group.files')}>
        <DockBtn
          group="panel"
          testId="files"
          label={t('dock.files')}
          active={activeRail === 'files'}
          disabled={sessionRailsDisabled}
          onClick={() => onToggleRail('files')}
        >
          <Icon d={ICONS.folder} />
        </DockBtn>
        <DockBtn
          group="panel"
          testId="diffs"
          label={t('dock.diffs')}
          active={activeRail === 'diffs'}
          disabled={sessionRailsDisabled}
          onClick={() => onToggleRail('diffs')}
        >
          <Icon d={ICONS.diff} />
        </DockBtn>
      </div>

      <div className="dock-divider" aria-hidden />

      <div className="dock-group" data-dock-group-label={t('dock.group.chat')}>
        {/* Sidechat rail — chat tabs onto other sessions, added via the
            tab strip's "+" session picker. */}
        <DockBtn
          group="panel"
          testId="sidechat"
          label={t('dock.sidechat')}
          active={activeRail === 'sidechat'}
          disabled={workbenchDisabled}
          onClick={() => onToggleRail('sidechat')}
        >
          <Icon d={ICONS.sidechat} />
        </DockBtn>
      </div>

      <div className="dock-divider" aria-hidden />

      <div className="dock-group" data-dock-group-label={t('dock.group.workbench')}>
        <DockBtn
          group="wb"
          testId="terminal"
          label={t('dock.terminal')}
          active={activeRail === 'terminal'}
          disabled={workbenchDisabled}
          onClick={() => onToggleRail('terminal')}
        >
          <Icon d={ICONS.terminal} />
        </DockBtn>
        {/* Browser rail — iframe preview tabs, added via the tab strip's "+". */}
        <DockBtn
          group="wb"
          testId="browser"
          label={t('dock.browser')}
          active={activeRail === 'browser'}
          disabled={workbenchDisabled}
          onClick={() => onToggleRail('browser')}
        >
          <Icon d={ICONS.browser} />
        </DockBtn>
      </div>

      <div className="dock-divider" aria-hidden />

      <div className="dock-group" data-dock-group-label={t('dock.group.system')}>
        <DockBtn
          group="panel"
          testId="workspaces"
          label={t('topbar.mode.workspaces')}
          active={activeRail === 'workspaces'}
          disabled={workbenchDisabled}
          onClick={() => onToggleRail('workspaces')}
        >
          <Icon d={ICONS.grid} />
        </DockBtn>
        <DockBtn
          group="wb"
          testId="settings"
          label={t('dock.settings')}
          active={activeRail === 'settings'}
          disabled={workbenchDisabled}
          onClick={() => onToggleRail('settings')}
        >
          <Icon d={ICONS.gear} />
        </DockBtn>
      </div>

      <span className="dock-spacer" />

      {/* Connection chip: hidden while healthy (a static green dot is noise);
          only surfaces when reconnecting/offline so it actually means something. */}
      {runnerState !== 'ok' && (
        <>
      <div className="dock-divider" aria-hidden />

      <span ref={runnerRef} className="runner-anchor">
        <button
          type="button"
          className="runner-chip"
          data-state={runnerState}
          data-testid="runner-chip"
          aria-label={runnerTitle}
          aria-expanded={runnerOpen}
          title={runnerTitle}
          onClick={() => setRunnerOpen(o => !o)}
        >
          <span className="runner-dot" />
        </button>
        {runnerOpen && (
          <div className="runner-pop dock-side">
            <div className="runner-pop-head">
              <span className="runner-dot" data-state={runnerState} />
              <div className="runner-pop-host">
                <div className="runner-pop-name">{runner?.host ?? 'host'}</div>
                <div className="runner-pop-meta">
                  {runnerState === 'reconnecting'
                    ? `${t('dock.runner.reconnecting')} (${wsAttempt})…`
                    : t('dock.runner.disconnected')}
                </div>
              </div>
            </div>
            <div className="runner-pop-divider" />
            {runner && (
              <dl className="runner-pop-list">
                <dt>{t('dock.runner.agents')}</dt><dd>{runner.agents} {t('dock.runner.running')}</dd>
                <dt>{t('dock.runner.disk')}</dt><dd>{runner.disk}</dd>
                <dt>Codex CLI</dt><dd>{runner.codex_version}</dd>
                <dt>Claude Code</dt><dd>{runner.cc_version}</dd>
                <dt>{t('dock.runner.workspaceRoot')}</dt><dd>{runner.ws_root}</dd>
              </dl>
            )}
          </div>
        )}
      </span>
        </>
      )}
    </aside>
  );
}
