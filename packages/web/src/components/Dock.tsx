import { useEffect, useRef, useState } from 'react';
import type { RunnerInfo } from '@gian/shared';
import type { PendingApproval } from '../App.js';
import type { WsState } from '../ws.js';

type Group = 'panel' | 'wb' | 'popout';

interface DockBtnProps {
  group: Group;
  label: string;
  active?: boolean;
  disabled?: boolean;
  badge?: number;
  onClick?: () => void;
  children: React.ReactNode;
}

function DockBtn({ group, label, active, disabled, badge, onClick, children }: DockBtnProps) {
  const testId = `dock-${label.toLowerCase().replace(/\s+/g, '-')}`;
  return (
    <button
      type="button"
      className={`dock-btn ${group} ${active ? 'active' : ''}`}
      data-dock-group={group}
      data-testid={testId}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      title={label}
    >
      {children}
      {badge != null && badge > 0 && (
        <span className="dock-badge">{badge > 9 ? '9+' : badge}</span>
      )}
      <span className="lbl">{label}</span>
    </button>
  );
}

const ICONS = {
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  diff: 'M9 4v12 M9 4l-3 3 M9 4l3 3 M15 20V8 M15 20l3-3 M15 20l-3-3',
  terminal: 'M5 7l5 5-5 5 M12 19h8',
  gear: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z M19 12a7 7 0 0 0-.2-1.6l2-1.6-2-3.4-2.4.9a7 7 0 0 0-2.8-1.6L13.2 2H10.8l-.4 2.7a7 7 0 0 0-2.8 1.6L5.2 5.4l-2 3.4 2 1.6A7 7 0 0 0 5 12c0 .6.1 1.1.2 1.6l-2 1.6 2 3.4 2.4-.9a7 7 0 0 0 2.8 1.6l.4 2.7h2.4l.4-2.7a7 7 0 0 0 2.8-1.6l2.4.9 2-3.4-2-1.6c.1-.5.2-1 .2-1.6z',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-4.3-4.3',
  inbox: 'M3 13l3-8h12l3 8 M3 13v6h18v-6 M3 13h5l1 3h6l1-3h5',
};

function Icon({ d, size = 17 }: { d: string; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}

interface Props {
  // Panel group (inspector toggles) — Phase 4 wiring; for now buttons can be disabled.
  inspectorTab: 'files' | 'changes' | null;
  onToggleInspector: (kind: 'files' | 'changes') => void;
  inspectorDisabled?: boolean;

  // Workbench group — Phase 3 wiring.
  hasTerminal: boolean;
  hasSettings: boolean;
  onToggleWbTab: (kind: 'term' | 'settings') => void;
  wbDisabled?: boolean;

  // Popout group — fully wired in Phase 1.
  onOpenSearch: () => void;
  pendingApprovals: PendingApproval[];
  onJumpToSession: (sessionId: string) => void;

  // Runner chip (V1-style clickable status pill anchored bottom-right).
  wsState: WsState;
  wsAttempt: number;
  authed: boolean;
  runner: RunnerInfo | null;
}

export function Dock({
  inspectorTab,
  onToggleInspector,
  inspectorDisabled,
  hasTerminal,
  hasSettings,
  onToggleWbTab,
  wbDisabled,
  onOpenSearch,
  pendingApprovals,
  onJumpToSession,
  wsState,
  wsAttempt,
  authed,
  runner,
}: Props) {
  const [inboxOpen, setInboxOpen] = useState(false);
  const [runnerOpen, setRunnerOpen] = useState(false);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const runnerRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!inboxOpen) return;
    function onDown(e: PointerEvent) {
      if (anchorRef.current?.contains(e.target as Node)) return;
      setInboxOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setInboxOpen(false);
    }
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [inboxOpen]);

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

  const count = pendingApprovals.length;

  const runnerState: 'ok' | 'reconnecting' | 'offline' =
    wsState === 'open' && authed ? 'ok'
    : wsState === 'connecting' ? 'reconnecting'
    : 'offline';
  const runnerTitle =
    runnerState === 'ok' ? `Host connected${runner ? ` · ${runner.latency}ms` : ''}`
    : runnerState === 'reconnecting' ? `Reconnecting (attempt ${wsAttempt})…`
    : 'Disconnected — reconnecting…';

  return (
    <aside className="dock">
      <div className="dock-group" data-dock-group-label="Panel">
        <DockBtn
          group="panel"
          label="Files"
          active={inspectorTab === 'files'}
          disabled={inspectorDisabled}
          onClick={() => onToggleInspector('files')}
        >
          <Icon d={ICONS.folder} />
        </DockBtn>
        <DockBtn
          group="panel"
          label="Changes"
          active={inspectorTab === 'changes'}
          disabled={inspectorDisabled}
          onClick={() => onToggleInspector('changes')}
        >
          <Icon d={ICONS.diff} />
        </DockBtn>
      </div>

      <div className="dock-divider" aria-hidden />

      <div className="dock-group" data-dock-group-label="Workbench">
        <DockBtn
          group="wb"
          label="Terminal"
          active={hasTerminal}
          disabled={wbDisabled}
          onClick={() => onToggleWbTab('term')}
        >
          <Icon d={ICONS.terminal} />
        </DockBtn>
        <DockBtn
          group="wb"
          label="Settings"
          active={hasSettings}
          disabled={wbDisabled}
          onClick={() => onToggleWbTab('settings')}
        >
          <Icon d={ICONS.gear} />
        </DockBtn>
      </div>

      <span className="dock-spacer" />
      <div className="dock-divider" aria-hidden />

      <div className="dock-group" data-dock-group-label="Popout">
        <DockBtn group="popout" label="Search" onClick={onOpenSearch}>
          <Icon d={ICONS.search} />
        </DockBtn>
        <span
          ref={anchorRef}
          className="inbox-anchor"
          style={{ position: 'relative', width: '100%', display: 'flex', justifyContent: 'center' }}
        >
          <DockBtn
            group="popout"
            label="Inbox"
            active={inboxOpen}
            badge={count}
            disabled={count === 0}
            onClick={() => count > 0 && setInboxOpen(o => !o)}
          >
            <Icon d={ICONS.inbox} />
          </DockBtn>
          {inboxOpen && count > 0 && (
            <div className="inbox-pop dock-side">
              <div className="head">
                <span>Approvals waiting</span>
                <button className="clear-all" onClick={() => setInboxOpen(false)}>Close</button>
              </div>
              {pendingApprovals.map(a => (
                <button
                  key={a.id}
                  className="row"
                  onClick={() => { setInboxOpen(false); onJumpToSession(a.session_id); }}
                >
                  <span className="cat">{a.category}</span>
                  <span className="desc">{a.description}</span>
                </button>
              ))}
            </div>
          )}
        </span>
      </div>

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
                  {runnerState === 'ok'
                    ? `connected${runner ? ` · ${runner.latency}ms · started ${runner.started_ago} ago` : ''}`
                    : runnerState === 'reconnecting'
                      ? `reconnecting (attempt ${wsAttempt})…`
                      : 'disconnected'}
                </div>
              </div>
            </div>
            <div className="runner-pop-divider" />
            {runner && (
              <dl className="runner-pop-list">
                <dt>Agents</dt><dd>{runner.agents} running</dd>
                <dt>Disk</dt><dd>{runner.disk}</dd>
                <dt>Codex CLI</dt><dd>{runner.codex_version}</dd>
                <dt>Claude Code</dt><dd>{runner.cc_version}</dd>
                <dt>Workspace root</dt><dd>{runner.ws_root}</dd>
              </dl>
            )}
          </div>
        )}
      </span>
    </aside>
  );
}
