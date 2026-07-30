import { useT } from '../i18n/index.js';
import { PathBreadcrumb } from './PathBreadcrumb.js';
import type { PathSegment, SessionMenuActions } from './PathBreadcrumb.js';

export type Mode = 'sessions' | 'tasks' | 'spaces' | 'bots';
export type ViewState = 'main' | 'both' | 'workbench';

const I = {
  sidebar: 'M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z M9 3v18',
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

function ViewIcon({ variant }: { variant: 'main' | 'both' | 'wb' }) {
  if (variant === 'main') {
    return (
      <svg viewBox="0 0 20 14" width="20" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
        <rect x="2.2" y="2" width="15.6" height="10" rx="1.6" fill="currentColor" fillOpacity="0.25" />
      </svg>
    );
  }
  if (variant === 'both') {
    return (
      <svg viewBox="0 0 20 14" width="20" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
        <rect x="2.2" y="2" width="9" height="10" rx="1.6" fill="currentColor" fillOpacity="0.25" />
        <rect x="12.6" y="2" width="5.2" height="10" rx="1.6" fill="currentColor" fillOpacity="0.55" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 20 14" width="20" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
      <rect x="2.2" y="2" width="2.4" height="10" rx="1.2" fill="currentColor" fillOpacity="0.18" strokeOpacity="0.6" />
      <rect x="6.2" y="2" width="11.6" height="10" rx="1.6" fill="currentColor" fillOpacity="0.55" />
    </svg>
  );
}

interface Props {
  pathSegments: PathSegment[];
  sessionMenu?: SessionMenuActions | null;
  onRenameSubmit?: (value: string) => void;
  onRenameCancel?: () => void;

  // View-seg (Phase 2+): only visible when sessions mode + workbench has tabs.
  viewState?: ViewState;
  onSetViewState?: (v: ViewState) => void;
  showViewSeg?: boolean;

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
  viewState = 'main',
  onSetViewState,
  showViewSeg = false,
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
        title={t('topbar.toggleSidebar')}
        aria-label={t('topbar.toggleSidebar')}
        onClick={() => window.dispatchEvent(new CustomEvent('gian.toggle-rail'))}
      >
        <Icon d={I.sidebar} />
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

      <PathBreadcrumb
        segments={pathSegments}
        onRenameSubmit={onRenameSubmit}
        onRenameCancel={onRenameCancel}
        sessionMenu={sessionMenu ?? null}
      />

      <span className="topbar-spacer" />

      {showViewSeg && onSetViewState && (
        <div className="view-seg" title={t('topbar.view.title')}>
          <button
            type="button"
            className={`view-seg-item ${viewState === 'main' ? 'active' : ''}`}
            onClick={() => onSetViewState('main')}
            title={t('topbar.view.chatOnly')}
          >
            <ViewIcon variant="main" />
          </button>
          <button
            type="button"
            className={`view-seg-item ${viewState === 'both' ? 'active' : ''}`}
            onClick={() => onSetViewState('both')}
            title={t('topbar.view.split')}
          >
            <ViewIcon variant="both" />
          </button>
          <button
            type="button"
            className={`view-seg-item ${viewState === 'workbench' ? 'active' : ''}`}
            onClick={() => onSetViewState('workbench')}
            title={t('topbar.view.workbenchOnly')}
          >
            <ViewIcon variant="wb" />
          </button>
        </div>
      )}
    </header>
  );
}
