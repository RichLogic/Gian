import { useEffect, useRef, useState } from 'react';
import type { RunnerInfo } from '@gian/shared';
import { blockingCount, tierOf, type InboxItem } from '../inbox.js';
import { useT } from '../i18n/index.js';
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
  // `grid` mirrors the design prototype's Dock "Workspaces" button glyph.
  grid: 'M4 4h7v7H4z M13 4h7v7h-7z M4 13h7v7H4z M13 13h7v7h-7z',
  // `chat` — the Tasks-mode "Manager" panel toggle (subtask context only).
  chat: 'M21 12c0 4.4-4 8-9 8-1.2 0-2.3-.2-3.4-.6L3 21l1.5-4.4A7.8 7.8 0 0 1 3 12c0-4.4 4-8 9-8s9 3.6 9 8z',
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

function InboxRow({ item, name, kindLabel, onClick }: {
  item: InboxItem;
  name: string;
  kindLabel: string;
  onClick: () => void;
}) {
  return (
    <button className={`row ${item.kind}${item.read ? '' : ' unread'}`} onClick={onClick}>
      <span className={`cat ${item.kind}`}>{kindLabel}</span>
      <span className="desc">
        <span className="inbox-sess">{name}</span>
        {item.subject && <span className="inbox-sub">{item.subject}</span>}
      </span>
    </button>
  );
}

interface Props {
  // Panel group (inspector toggles) — Phase 4 wiring; for now buttons can be disabled.
  inspectorTab: 'files' | 'changes' | 'workspaces' | 'manager' | null;
  onToggleInspector: (kind: 'files' | 'changes' | 'workspaces' | 'manager') => void;
  inspectorDisabled?: boolean;
  /** Workspaces is a global tool (not session-specific), so it has its own
   *  disabled flag — enabled in Tasks mode too, unlike Files / Changes. */
  workspacesDisabled?: boolean;
  /** The Tasks-mode Manager panel toggle. Only meaningful while a subtask is
   *  selected (the Manager is the parent Task's), so the button is rendered
   *  only when `managerVisible` — matching the design's subtask-only affordance. */
  managerVisible?: boolean;

  // Workbench group — Phase 3 wiring.
  hasTerminal: boolean;
  hasSettings: boolean;
  onToggleWbTab: (kind: 'term' | 'settings') => void;
  wbDisabled?: boolean;

  // Popout group — fully wired in Phase 1.
  onOpenSearch: () => void;
  /** Cross-session attention center: pending approvals, errors, and completed
   *  turns of sessions you're not watching. */
  inboxItems: InboxItem[];
  /** Resolve a session id to a display label for inbox rows. */
  sessionName: (sessionId: string) => string;
  onJumpToSession: (sessionId: string) => void;
  /** Mark every inbox item read (fired when the popout opens). */
  onMarkInboxRead: () => void;
  /** Drop all FYI (completed) items. */
  onClearInboxDone: () => void;

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
  workspacesDisabled,
  managerVisible,
  hasTerminal,
  hasSettings,
  onToggleWbTab,
  wbDisabled,
  onOpenSearch,
  inboxItems,
  sessionName,
  onJumpToSession,
  onMarkInboxRead,
  onClearInboxDone,
  wsState,
  wsAttempt,
  authed,
  runner,
}: Props) {
  const t = useT();
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

  // Badge nags on actionable items only (approvals + errors); completed-turn
  // FYIs accumulate in the list but don't drive the badge.
  const badge = blockingCount(inboxItems);
  const total = inboxItems.length;
  const blocking = inboxItems.filter(i => tierOf(i.kind) === 'blocking');
  const fyi = inboxItems.filter(i => tierOf(i.kind) === 'fyi');

  function openInbox(open: boolean) {
    setInboxOpen(open);
    if (open) onMarkInboxRead();
  }

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
      <div className="dock-group" data-dock-group-label={t('dock.group.panel')}>
        {managerVisible && (
          <DockBtn
            group="panel"
            label={t('dock.manager')}
            active={inspectorTab === 'manager'}
            onClick={() => onToggleInspector('manager')}
          >
            <Icon d={ICONS.chat} />
          </DockBtn>
        )}
        <DockBtn
          group="panel"
          label={t('topbar.mode.workspaces')}
          active={inspectorTab === 'workspaces'}
          disabled={workspacesDisabled}
          onClick={() => onToggleInspector('workspaces')}
        >
          <Icon d={ICONS.grid} />
        </DockBtn>
        <DockBtn
          group="panel"
          label={t('dock.files')}
          active={inspectorTab === 'files'}
          disabled={inspectorDisabled}
          onClick={() => onToggleInspector('files')}
        >
          <Icon d={ICONS.folder} />
        </DockBtn>
        <DockBtn
          group="panel"
          label={t('dock.changes')}
          active={inspectorTab === 'changes'}
          disabled={inspectorDisabled}
          onClick={() => onToggleInspector('changes')}
        >
          <Icon d={ICONS.diff} />
        </DockBtn>
      </div>

      <div className="dock-divider" aria-hidden />

      <div className="dock-group" data-dock-group-label={t('dock.group.workbench')}>
        <DockBtn
          group="wb"
          label={t('dock.terminal')}
          active={hasTerminal}
          disabled={wbDisabled}
          onClick={() => onToggleWbTab('term')}
        >
          <Icon d={ICONS.terminal} />
        </DockBtn>
        <DockBtn
          group="wb"
          label={t('dock.settings')}
          active={hasSettings}
          disabled={wbDisabled}
          onClick={() => onToggleWbTab('settings')}
        >
          <Icon d={ICONS.gear} />
        </DockBtn>
      </div>

      <span className="dock-spacer" />
      <div className="dock-divider" aria-hidden />

      <div className="dock-group" data-dock-group-label={t('dock.group.popout')}>
        <DockBtn group="popout" label={t('dock.search')} onClick={onOpenSearch}>
          <Icon d={ICONS.search} />
        </DockBtn>
        <span
          ref={anchorRef}
          className="inbox-anchor"
          style={{ position: 'relative', width: '100%', display: 'flex', justifyContent: 'center' }}
        >
          <DockBtn
            group="popout"
            label={t('dock.inbox')}
            active={inboxOpen}
            badge={badge}
            disabled={total === 0}
            onClick={() => total > 0 && openInbox(!inboxOpen)}
          >
            <Icon d={ICONS.inbox} />
          </DockBtn>
          {inboxOpen && total > 0 && (
            <div className="inbox-pop dock-side">
              <div className="head">
                <span>{t('dock.inbox')}</span>
                <span className="head-actions">
                  {fyi.length > 0 && (
                    <button className="clear-all" onClick={onClearInboxDone}>{t('dock.inbox.clearDone')}</button>
                  )}
                  <button className="clear-all" onClick={() => setInboxOpen(false)}>{t('common.close')}</button>
                </span>
              </div>
              {blocking.length > 0 && (
                <>
                  <div className="inbox-section">{t('dock.inbox.needsYou')}</div>
                  {blocking.map(item => (
                    <InboxRow key={item.id} item={item} name={sessionName(item.sessionId)}
                      kindLabel={t(`dock.inbox.kind.${item.kind}`)}
                      onClick={() => { setInboxOpen(false); onJumpToSession(item.sessionId); }} />
                  ))}
                </>
              )}
              {fyi.length > 0 && (
                <>
                  <div className="inbox-section">{t('dock.inbox.recent')}</div>
                  {fyi.map(item => (
                    <InboxRow key={item.id} item={item} name={sessionName(item.sessionId)}
                      kindLabel={t(`dock.inbox.kind.${item.kind}`)}
                      onClick={() => { setInboxOpen(false); onJumpToSession(item.sessionId); }} />
                  ))}
                </>
              )}
            </div>
          )}
        </span>
      </div>

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
