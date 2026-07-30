import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n/index.js';
import type { Mode } from './Topbar.js';

// Per the design: only Sessions + Tasks are top-level modes. Workspaces moved
// into the dock rail + Workbench detail; Bots are hidden. The 'spaces'/'bots'
// modes still exist as routes (e.g. the workspace-create flow opens 'spaces'),
// just not as dropdown entries.
const MODE_OPTIONS: ReadonlyArray<readonly [Mode, string]> = [
  ['tasks', 'topbar.mode.tasks'],
  ['sessions', 'topbar.mode.sessions'],
];

/** Codex-style mode switcher living at the top of the left sidebar: a large
 *  bold label + chevron that opens the Sessions/Tasks menu. Moved here from
 *  the Topbar in the dock-rail rework (phases 1+2). */
export function ModeDropdown({ mode, onSetMode }: { mode: Mode; onSetMode: (mode: Mode) => void }) {
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
    <span className="mode-anchor" ref={modeRef}>
      <button
        type="button"
        className="sb-mode"
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
  );
}
