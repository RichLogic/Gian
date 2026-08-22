import { useT } from '../i18n/index.js';
import { PathBreadcrumb } from './PathBreadcrumb.js';
import type { BranchMenuActions, PathSegment, SessionMenuActions } from './PathBreadcrumb.js';

export type Mode = 'sessions' | 'tasks' | 'spaces';
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

/** Panel toggle glyph — lucide.dev `panel-left-close/open` and
 *  `panel-right-close/open` (24-grid, project 1.5px stroke). The icon mirrors
 *  the current state: panel OPEN → the `-close` glyph, panel COLLAPSED →
 *  the `-open` glyph (same rule for the left sidebar and panel-3). */
const PANEL_ICON_PATHS = {
  'left-close': 'M9 3v18 M16 15l-3-3 3-3',
  'left-open': 'M9 3v18 M14 9l3 3-3 3',
  'right-close': 'M15 3v18 M8 9l3 3-3 3',
  'right-open': 'M15 3v18 M10 15l-3-3 3-3',
} as const;

function PanelIcon({ side, active }: { side: 'left' | 'right'; active: boolean }) {
  const d = PANEL_ICON_PATHS[`${side}-${active ? 'close' : 'open'}`];
  return (
    <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d={d} />
    </svg>
  );
}

interface Props {
  pathSegments: PathSegment[];
  sessionMenu?: SessionMenuActions | null;
  branchMenu?: BranchMenuActions | null;
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

  // View navigation history (sidebar mode + conversation selection), driven
  // by App's useViewNav stack.
  canGoBack: boolean;
  canGoForward: boolean;
  onGoBack: () => void;
  onGoForward: () => void;
}

export function Topbar({
  pathSegments,
  sessionMenu,
  branchMenu,
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
        branchMenu={branchMenu ?? null}
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
