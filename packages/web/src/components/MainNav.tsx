import type { ReactNode } from 'react';
import type { View } from '../types.js';
import { useT } from '../i18n/index.js';

export function pendingCount(pending: Record<string, boolean>): number {
  return Object.values(pending).filter(Boolean).length;
}

export function MainNav({
  view,
  onSwitch,
  runningCount,
}: {
  view: View;
  onSwitch: (v: View) => void;
  runningCount: number;
}) {
  const t = useT();
  return (
    <nav className="nav">
      <NavBtn label={t('nav.coding')} active={view === 'coding'} onClick={() => onSwitch('coding')} badge={runningCount > 0 ? runningCount : undefined}>
        <svg viewBox="0 0 16 16" fill="none">
          <path d="M5 5L2 8l3 3M11 5l3 3-3 3M9 3l-2 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </NavBtn>
      <NavBtn label={t('nav.files')} active={view === 'files'} onClick={() => onSwitch('files')}>
        <svg viewBox="0 0 16 16" fill="none">
          <path d="M2 4a1 1 0 011-1h3l2 2h5a1 1 0 011 1v6a1 1 0 01-1 1H3a1 1 0 01-1-1z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        </svg>
      </NavBtn>
      <div className="nav-rule" />
      <NavBtn label={t('nav.spaces')} active={view === 'workspaces'} onClick={() => onSwitch('workspaces')}>
        <svg viewBox="0 0 16 16" fill="none">
          <rect x="2" y="2" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.5" />
          <rect x="9" y="2" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.5" />
          <rect x="2" y="9" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.5" />
          <rect x="9" y="9" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </NavBtn>
      <NavBtn label={t('nav.bots')} active={view === 'bots'} onClick={() => onSwitch('bots')}>
        <svg viewBox="0 0 16 16" fill="none">
          <rect x="3" y="5.5" width="10" height="7.5" rx="2" stroke="currentColor" strokeWidth="1.5" />
          <circle cx="6.2" cy="9.2" r="0.9" stroke="currentColor" strokeWidth="1.2" />
          <circle cx="9.8" cy="9.2" r="0.9" stroke="currentColor" strokeWidth="1.2" />
          <path d="M8 3v2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          <circle cx="8" cy="2.5" r="0.6" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      </NavBtn>
    </nav>
  );
}

function NavBtn({
  label,
  active,
  onClick,
  badge,
  children,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  badge?: number;
  children: ReactNode;
}) {
  return (
    <button className={`nav-btn ${active ? 'active' : ''}`} onClick={onClick} title={label}>
      {children}
      <span>{label}</span>
      {badge !== undefined && <span className="nav-badge">{badge}</span>}
    </button>
  );
}
