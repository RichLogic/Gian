import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n/index.js';
import { PathBreadcrumb } from './PathBreadcrumb.js';
import type { PathSegment, SessionMenuActions } from './PathBreadcrumb.js';

export type Mode = 'sessions' | 'tasks' | 'spaces' | 'bots';
export type ViewState = 'main' | 'both' | 'workbench';

// Per the design: only Sessions + Tasks are top-level modes. Workspaces moved
// into the Inspector rail (dock "Workspaces" button) + Workbench detail; Bots
// are hidden. The 'spaces'/'bots' modes still exist as routes (e.g. the
// workspace-create flow opens 'spaces'), just not as dropdown entries.
const MODE_OPTIONS: ReadonlyArray<readonly [Mode, string]> = [
  ['tasks', 'topbar.mode.tasks'],
  ['sessions', 'topbar.mode.sessions'],
];

function GianMark({ size = 18 }: { size?: number }) {
  return (
    <svg className="brand-mark" viewBox="0 0 24 24" width={size} height={size} fill="none">
      <path d="M3 6h18 M3 12h18 M3 18h12" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
      <circle cx="20" cy="18" r="1.6" fill="currentColor" />
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
  mode: Mode;
  onSetMode: (mode: Mode) => void;
  pathSegments: PathSegment[];
  sessionMenu?: SessionMenuActions | null;
  onRenameSubmit?: (value: string) => void;
  onRenameCancel?: () => void;

  // View-seg (Phase 2+): only visible when sessions mode + workbench has tabs.
  viewState?: ViewState;
  onSetViewState?: (v: ViewState) => void;
  showViewSeg?: boolean;
}

export function Topbar({
  mode,
  onSetMode,
  pathSegments,
  sessionMenu,
  onRenameSubmit,
  onRenameCancel,
  viewState = 'main',
  onSetViewState,
  showViewSeg = false,
}: Props) {
  const t = useT();
  const [modeOpen, setModeOpen] = useState(false);
  const modeRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!modeOpen) return;
    function onDown(e: PointerEvent) {
      if (modeRef.current?.contains(e.target as Node)) return;
      setModeOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setModeOpen(false);
    }
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [modeOpen]);

  const modeLabelKey = MODE_OPTIONS.find(([k]) => k === mode)?.[1] ?? 'topbar.mode.sessions';
  const modeLabel = t(modeLabelKey);

  return (
    <header className="topbar">
      <button
        type="button"
        className="brand"
        title={t('topbar.toggleSidebar')}
        onClick={() => window.dispatchEvent(new CustomEvent('gian.toggle-rail'))}
      >
        <GianMark size={18} />
        <span className="brand-word">Gian</span>
      </button>

      <span className="mode-anchor" ref={modeRef}>
        <button
          type="button"
          className="mode-btn"
          data-testid="mode-button"
          aria-label={`${t('topbar.currentView')}: ${modeLabel}`}
          aria-expanded={modeOpen}
          onClick={() => setModeOpen(o => !o)}
        >
          {modeLabel}
          <span className="caret">▾</span>
        </button>
        {modeOpen && (
          <div className="mode-pop" role="menu" aria-label={t('topbar.switchView')}>
            {MODE_OPTIONS.map(([key, labelKey]) => (
              <button
                key={key}
                type="button"
                className={`mode-pop-item ${mode === key ? 'active' : ''}`}
                data-testid={`mode-option-${key}`}
                role="menuitemradio"
                aria-checked={mode === key}
                onClick={() => { onSetMode(key); setModeOpen(false); }}
              >
                <span className="check">{mode === key ? '✓' : ''}</span>
                {t(labelKey)}
              </button>
            ))}
          </div>
        )}
      </span>

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
