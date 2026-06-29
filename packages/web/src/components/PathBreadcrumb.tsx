import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n/index.js';

export type PathSegmentKind = 'workspace' | 'branch' | 'session';

export interface PathSegment {
  kind: PathSegmentKind;
  label: string;
  copyHint?: string;
  editing?: boolean;
}

export interface SessionMenuActions {
  onRename: () => void;
  // All others are optional — the menu adapts to the context (full session /
  // subtask / task). When a callback is absent, its item is hidden.
  // Subtask drops fork/archive/delete; Task drops forceRecover/markUnread/fork.
  onCopyName?: () => void;
  onForceRecover?: () => void;
  onMarkUnread?: () => void;
  onFork?: (executor: 'claude' | 'codex') => void;
  onArchive?: () => void;
  onDelete?: () => void;
  /** Subtask only (spec §B): toggle the user completion flag. `completed`
   *  drives the label ("Mark complete" ↔ "Reopen"). */
  onToggleComplete?: () => void;
  completed?: boolean;
}

interface Props {
  segments: PathSegment[];
  onRenameSubmit?: (value: string) => void;
  onRenameCancel?: () => void;
  sessionMenu?: SessionMenuActions | null;
}

function BranchIcon({ size = 11 }: { size?: number }) {
  return (
    <svg
      className="branch-ico"
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="4" cy="3.5" r="1.6" />
      <circle cx="4" cy="12.5" r="1.6" />
      <circle cx="12" cy="6" r="1.6" />
      <path d="M4 5v6 M4 11c0-3 8-2 8-4.5" />
    </svg>
  );
}

function CaretDown({ size = 11 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function CheckIcon({ size = 10 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12l5 5L20 7" />
    </svg>
  );
}

function MenuIcon({ d, size = 13 }: { d: string; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}

const ICON = {
  edit: 'M4 20h4l10-10-4-4L4 16z M14 6l4 4',
  copy: 'M9 9h10v10H9z M5 15V5h10',
  refresh: 'M3 12a9 9 0 0 1 15.5-6.3L21 8 M21 3v5h-5 M21 12a9 9 0 0 1-15.5 6.3L3 16 M3 21v-5h5',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  trash: 'M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13',
  fork: 'M6 3v6 M6 21v-3a4 4 0 0 1 4-4h4a4 4 0 0 0 4-4V3 M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z M6 21a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z',
  // envelope — "mark as unread", same idiom as an unread email
  mail: 'M3 5h18v14H3z M3 7l9 6 9-6',
  // check — "mark complete" (subtask)
  check: 'M5 12l5 5L20 7',
};

export function PathBreadcrumb({ segments, onRenameSubmit, onRenameCancel, sessionMenu }: Props) {
  const t = useT();
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    function onDown(e: PointerEvent) {
      const t = e.target as Node;
      if (menuRef.current?.contains(t)) return;
      if (anchorRef.current?.contains(t)) return;
      setMenuOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setMenuOpen(false);
    }
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  function copy(idx: number, text: string) {
    try { void navigator.clipboard?.writeText(text); } catch (_) { /* ignore */ }
    setCopiedIdx(idx);
    window.setTimeout(() => {
      setCopiedIdx(curr => (curr === idx ? null : curr));
    }, 1400);
  }

  function handleSegClick(idx: number, seg: PathSegment) {
    if (seg.kind === 'session' && sessionMenu) {
      setMenuOpen(o => !o);
    } else {
      copy(idx, seg.label);
    }
  }

  if (!segments.length) {
    return <span className="path" style={{ flex: 1 }} />;
  }

  return (
    <div className="path">
      {segments.map((seg, i) => {
        const showMenu = seg.kind === 'session' && menuOpen && sessionMenu;
        const isCopied = copiedIdx === i;
        return (
          <SegmentFragment key={i} idx={i} seg={seg} showSep={i > 0}>
            {seg.editing ? (
              <input
                className="path-rename-input"
                autoFocus
                defaultValue={seg.label}
                onBlur={e => onRenameSubmit?.(e.currentTarget.value)}
                onKeyDown={e => {
                  // Skip while an IME composition is in flight — Chinese/
                  // Japanese/Korean input methods use Enter to commit the
                  // candidate, not to submit the rename.
                  if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                  if (e.key === 'Escape') onRenameCancel?.();
                }}
              />
            ) : (
              <span className="path-seg-anchor" ref={seg.kind === 'session' ? anchorRef : undefined}>
                <button
                  className={`path-seg ${seg.kind} ${isCopied ? 'copied' : ''}`}
                  title={seg.copyHint}
                  onClick={e => { e.stopPropagation(); handleSegClick(i, seg); }}
                >
                  {seg.kind === 'branch' && <BranchIcon />}
                  <span className="path-seg-label">{seg.label}</span>
                  {seg.kind === 'session' && (
                    <span className="path-seg-affordance caret" aria-hidden>
                      <CaretDown size={11} />
                    </span>
                  )}
                </button>
                {isCopied && (
                  <span className="path-copied" role="status">
                    <CheckIcon size={10} />
                    {t('common.copied')}
                  </span>
                )}
                {showMenu && sessionMenu && (
                  <div className="session-menu" ref={menuRef} onClick={e => e.stopPropagation()}>
                    <button className="item" onClick={() => { setMenuOpen(false); sessionMenu.onRename(); }}>
                      <MenuIcon d={ICON.edit} /> {t('path.menu.rename')}
                      <span className="sub">F2</span>
                    </button>
                    {sessionMenu.onToggleComplete && (
                      <button className="item" onClick={() => { setMenuOpen(false); sessionMenu.onToggleComplete!(); }}>
                        <MenuIcon d={sessionMenu.completed ? ICON.refresh : ICON.check} />{' '}
                        {sessionMenu.completed ? t('tasks.subtask.reopen') : t('tasks.subtask.complete')}
                      </button>
                    )}
                    {sessionMenu.onCopyName && (
                      <button className="item" onClick={() => { setMenuOpen(false); sessionMenu.onCopyName!(); }}>
                        <MenuIcon d={ICON.copy} /> {t('path.menu.copyName')}
                      </button>
                    )}
                    {sessionMenu.onForceRecover && (
                      <button className="item" onClick={() => { setMenuOpen(false); sessionMenu.onForceRecover!(); }}>
                        <MenuIcon d={ICON.refresh} /> {t('path.menu.forceRecover')}
                      </button>
                    )}
                    {sessionMenu.onFork && (
                      <>
                        <div className="rule" />
                        <button className="item" onClick={() => { setMenuOpen(false); sessionMenu.onFork!('claude'); }}>
                          <MenuIcon d={ICON.fork} /> {t('path.menu.forkClaude')}
                        </button>
                        <button className="item" onClick={() => { setMenuOpen(false); sessionMenu.onFork!('codex'); }}>
                          <MenuIcon d={ICON.fork} /> {t('path.menu.forkCodex')}
                        </button>
                      </>
                    )}
                    {(sessionMenu.onMarkUnread || sessionMenu.onArchive || sessionMenu.onDelete) && (
                      <div className="rule" />
                    )}
                    {sessionMenu.onMarkUnread && (
                      <button className="item" onClick={() => { setMenuOpen(false); sessionMenu.onMarkUnread!(); }}>
                        <MenuIcon d={ICON.mail} /> {t('path.menu.markUnread')}
                      </button>
                    )}
                    {sessionMenu.onArchive && (
                      <button className="item" onClick={() => { setMenuOpen(false); sessionMenu.onArchive!(); }}>
                        <MenuIcon d={ICON.folder} /> {t('common.archive')}
                      </button>
                    )}
                    {sessionMenu.onDelete && (
                      <button className="item danger" onClick={() => { setMenuOpen(false); sessionMenu.onDelete!(); }}>
                        <MenuIcon d={ICON.trash} /> {t('path.menu.deleteSession')}
                      </button>
                    )}
                  </div>
                )}
              </span>
            )}
          </SegmentFragment>
        );
      })}
      <span style={{ flex: 1 }} />
    </div>
  );
}

function SegmentFragment({
  showSep,
  children,
}: {
  idx: number;
  seg: PathSegment;
  showSep: boolean;
  children: React.ReactNode;
}) {
  return (
    <>
      {showSep && <span className="path-sep">›</span>}
      {children}
    </>
  );
}
