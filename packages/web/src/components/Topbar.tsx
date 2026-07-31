import { useT } from '../i18n/index.js';
import { PathBreadcrumb } from './PathBreadcrumb.js';
import type { PathSegment, SessionMenuActions } from './PathBreadcrumb.js';

export type Mode = 'sessions' | 'tasks' | 'spaces' | 'bots';
export type ViewState = 'main' | 'both' | 'workbench';

const I = {
  back: 'M15 18l-6-6 6-6',
  forward: 'M9 18l6-6-6-6',
};

function Icon({ d, size = 16 }: { d: string; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}

/** Panel toggle glyph: outer frame + side divider; the side section is tinted
 *  while the panel is open, empty when collapsed (same visual language for
 *  the left sidebar and the right panel-3 buttons, mirrored). */
function PanelIcon({ side, active }: { side: 'left' | 'right'; active: boolean }) {
  const dividerX = side === 'left' ? 9 : 15;
  const fill = side === 'left'
    ? 'M6 3.5h3v17H6a2.5 2.5 0 0 1-2.5-2.5V6A2.5 2.5 0 0 1 6 3.5z'
    : 'M18 3.5h-3v17h3a2.5 2.5 0 0 0 2.5-2.5V6A2.5 2.5 0 0 0 18 3.5z';
  return (
    <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      {active && <path d={fill} fill="currentColor" fillOpacity={0.28} stroke="none" />}
      <path d="M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
      <path d={`M${dividerX} 3v18`} />
    </svg>
  );
}

interface Props {
  pathSegments: PathSegment[];
  sessionMenu?: SessionMenuActions | null;
  onRenameSubmit?: (value: string) => void;
  onRenameCancel?: () => void;

  /** Left sidebar collapse toggle — icon mirrors the current state. */
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;

  /** Panel-3 (inspector) toggle. `p3Available` gates the button for rails
   *  that have no panel 3; `p3Visible` drives the icon state. */
  p3Available: boolean;
  p3Visible: boolean;
  onToggleP3: () => void;

  // Panel-2 navigation history (rail + tab), driven by App's navStack.
  canGoBack: boolean;
  canGoForward: boolean;
  onGoBack: () => void;
  onGoForward: () => void;
}

export function Topbar({
  pathSegments,
  sessionMenu,
  onRenameSubmit,
  onRenameCancel,
  sidebarCollapsed,
  onToggleSidebar,
  p3Available,
  p3Visible,
  onToggleP3,
  canGoBack,
  canGoForward,
  onGoBack,
  onGoForward,
}: Props) {
  const t = useT();

  return (
    <header className="topbar">
      <button
        type="button"
        className="tb-toggle"
        data-testid="topbar-toggle-sidebar"
        title={t('topbar.toggleSidebar')}
        aria-label={t('topbar.toggleSidebar')}
        onClick={onToggleSidebar}
      >
        <PanelIcon side="left" active={!sidebarCollapsed} />
      </button>
      <button
        type="button"
        className="tb-toggle"
        data-testid="topbar-back"
        title={t('topbar.back')}
        aria-label={t('topbar.back')}
        disabled={!canGoBack}
        onClick={onGoBack}
      >
        <Icon d={I.back} />
      </button>
      <button
        type="button"
        className="tb-toggle"
        data-testid="topbar-forward"
        title={t('topbar.forward')}
        aria-label={t('topbar.forward')}
        disabled={!canGoForward}
        onClick={onGoForward}
      >
        <Icon d={I.forward} />
      </button>

      <span className="tb-divider" aria-hidden="true" />

      <PathBreadcrumb
        segments={pathSegments}
        onRenameSubmit={onRenameSubmit}
        onRenameCancel={onRenameCancel}
        sessionMenu={sessionMenu ?? null}
      />

      <span className="topbar-spacer" />

      <button
        type="button"
        className="tb-toggle"
        data-testid="topbar-toggle-p3"
        title={t('topbar.toggleInspector')}
        aria-label={t('topbar.toggleInspector')}
        disabled={!p3Available}
        onClick={onToggleP3}
      >
        <PanelIcon side="right" active={p3Visible} />
      </button>
    </header>
  );
}
