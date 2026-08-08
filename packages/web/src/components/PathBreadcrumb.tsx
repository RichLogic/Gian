import { Fragment, useEffect, useRef, useState } from 'react';
import type { Executor } from '@gian/shared';
import { useT } from '../i18n/index.js';

export type PathSegmentKind = 'workspace' | 'branch' | 'session';

export interface PathSegment {
  kind: PathSegmentKind;
  label: string;
  copyHint?: string;
  editing?: boolean;
  /** Marks the one segment that owns the session menu (click opens it, the
   *  caret shows). */
  menuAnchor?: boolean;
}

export interface SessionMenuActions {
  /** Which context this menu is for — drives the item set, order, grouping and
   *  danger styling (see buildMenuItems). Defaults to 'session'. */
  kind?: 'session' | 'subtask';
  onRename: () => void;
  // All others are optional — the menu adapts to the context (full session /
  // subtask). When a callback is absent, its item is hidden.
  // Subtask drops fork/delete.
  onCopyName?: () => void;
  onForceRecover?: () => void;
  /** True while a session.recover run is in flight — the Force-recover item
   *  renders disabled with a "recovering" label (Phase 2a pending policy). */
  recovering?: boolean;
  onMarkUnread?: () => void;
  onFork?: (executor: Executor) => void;
  onDelete?: () => void;
}

/** The branch segment's worktree dropdown (view-level working-tree switch).
 *  Items are the workspace's working trees; `onPick` selects one. Every item
 *  shows the branch/worktree name as the label ("Primary" marks the workspace
 *  checkout in the detail slot) and the owning session's name as detail when
 *  it adds information. */
export interface BranchMenuActions {
  items: Array<{ id: string; label: string; detail?: string | null; active?: boolean }>;
  /** Refresh the available working trees immediately before opening. */
  onOpen?: () => void;
  onPick: (id: string) => void;
}

interface Props {
  segments: PathSegment[];
  onRenameSubmit?: (value: string) => void;
  onRenameCancel?: () => void;
  sessionMenu?: SessionMenuActions | null;
  branchMenu?: BranchMenuActions | null;
}

function CaretDown({ size = 11 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

/** `branch` is the historical model name for the selected worktree. */
function WorktreeIcon({ size = 14 }: { size?: number }) {
  return (
    <svg data-icon="git-branch" viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <line x1="6" x2="6" y1="3" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  );
}

function ChevronRight({ size = 12 }: { size?: number }) {
  return (
    <svg data-icon="chevron-right" viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

function CheckIcon({ size = 10 }: { size?: number }) {  return (
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
  // envelope — "mark as unread", same idiom as an unread email
  mail: 'M3 5h18v14H3z M3 7l9 6 9-6',
};

interface MenuItemDesc {
  key: string;
  icon: string;
  label: string;
  onClick: () => void;
  /** Render a divider above this item (group separator). */
  ruleBefore?: boolean;
  /** Danger (red) styling. */
  danger?: boolean;
  /** Inert while its operation is in flight (e.g. Force recover pending). */
  disabled?: boolean;
  /** Right-aligned hint, e.g. the F2 shortcut. */
  hint?: string;
}

/**
 * Build the ordered menu item list for the active context. Two distinct
 * layouts (decided 2026-06-29) — they differ in order, grouping and which
 * actions are destructive, so a single fixed template can't express them:
 *
 *  session : Rename · Copy · Unread ┊ Recover(red)
 *  subtask : Rename · Copy ┊ Unread ┊ Recover(red)
 *
 * 2026-08-03: the session menu's Fork×3 and Delete items were removed (fork
 * plumbing in use-topbar-model stays, unused by the menu); the subtask
 * menu's Delete item went with them. The task menu was dropped entirely when
 * the Tasks-view breadcrumb lost the task segment — task rename/done/delete
 * live on the sidebar rail row's ⋯ menu. 2026-08-05: the subtask menu's
 * Complete/Reopen item was removed too — completion is toggled from the
 * subtask row's hover check in the Tasks rail.
 */
function buildMenuItems(m: SessionMenuActions, t: (k: string) => string): MenuItemDesc[] {
  const items: MenuItemDesc[] = [
    { key: 'rename', icon: ICON.edit, label: t('path.menu.rename'), onClick: m.onRename, hint: 'F2' },
  ];
  const copy = () => {
    if (m.onCopyName) items.push({ key: 'copy', icon: ICON.copy, label: t('path.menu.copyName'), onClick: m.onCopyName });
  };

  if (m.kind === 'subtask') {
    copy();
    if (m.onMarkUnread) items.push({ key: 'unread', icon: ICON.mail, label: t('path.menu.markUnread'), onClick: m.onMarkUnread, ruleBefore: true });
    if (m.onForceRecover) items.push({ key: 'recover', icon: ICON.refresh, label: t(m.recovering ? 'path.menu.recovering' : 'path.menu.forceRecover'), onClick: m.onForceRecover, danger: true, disabled: m.recovering, ruleBefore: true });
    return items;
  }

  // session (default)
  copy();
  if (m.onMarkUnread) items.push({ key: 'unread', icon: ICON.mail, label: t('path.menu.markUnread'), onClick: m.onMarkUnread });
  if (m.onForceRecover) items.push({ key: 'recover', icon: ICON.refresh, label: t(m.recovering ? 'path.menu.recovering' : 'path.menu.forceRecover'), onClick: m.onForceRecover, danger: true, disabled: m.recovering, ruleBefore: true });
  return items;
}

export function PathBreadcrumb({ segments, onRenameSubmit, onRenameCancel, sessionMenu, branchMenu }: Props) {
  const t = useT();
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLSpanElement>(null);
  // Branch segment worktree dropdown — mirrors the session menu above (own
  // open state + anchor/menu refs so an outside click or Escape closes it).
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const branchMenuRef = useRef<HTMLDivElement>(null);
  const branchAnchorRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!menuOpen && !branchMenuOpen) return;
    function onDown(e: PointerEvent) {
      const t = e.target as Node;
      if (menuRef.current?.contains(t)) return;
      if (anchorRef.current?.contains(t)) return;
      if (branchMenuRef.current?.contains(t)) return;
      if (branchAnchorRef.current?.contains(t)) return;
      setMenuOpen(false);
      setBranchMenuOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') { setMenuOpen(false); setBranchMenuOpen(false); }
    }
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen, branchMenuOpen]);

  function copy(idx: number, text: string) {
    try { void navigator.clipboard?.writeText(text); } catch (_) { /* ignore */ }
    setCopiedIdx(idx);
    window.setTimeout(() => {
      setCopiedIdx(curr => (curr === idx ? null : curr));
    }, 1400);
  }

  function handleSegClick(idx: number, seg: PathSegment) {
    if (seg.menuAnchor && sessionMenu) {
      // Mutually exclusive: opening one dropdown closes the other (2026-08-04
      // — both could stay open at once because the outside-click handler only
      // fires outside BOTH menus/anchors).
      setBranchMenuOpen(false);
      setMenuOpen(o => !o);
    } else if (seg.kind === 'branch' && branchMenu) {
      // With a branch menu wired up, clicking the branch switches worktree
      // instead of copying (copying stays available as a menu item).
      setMenuOpen(false);
      if (!branchMenuOpen) branchMenu.onOpen?.();
      setBranchMenuOpen(open => !open);
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
        const showMenu = seg.menuAnchor === true && menuOpen && sessionMenu;
        const showBranchMenu = seg.kind === 'branch' && branchMenuOpen && branchMenu;
        const isCopied = copiedIdx === i;
        return (
          <SegmentFragment key={i} idx={i} seg={seg} showSep={i > 0}>
            {seg.editing ? (
              <span className="path-editing">
                {seg.kind === 'branch' && (
                  <span className="path-seg-icon"><WorktreeIcon /></span>
                )}
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
              </span>
            ) : (
              <span
                className="path-seg-anchor"
                ref={seg.menuAnchor ? anchorRef : seg.kind === 'branch' ? branchAnchorRef : undefined}
              >
                <button
                  className={`path-seg ${seg.kind} ${isCopied ? 'copied' : ''}`}
                  title={seg.kind === 'branch' && branchMenu ? t('path.branch.switch') : seg.copyHint}
                  onClick={e => { e.stopPropagation(); handleSegClick(i, seg); }}
                >
                  {seg.kind === 'branch' && (
                    <span className="path-seg-icon"><WorktreeIcon /></span>
                  )}
                  <span className="path-seg-label">{seg.label}</span>
                  {(seg.menuAnchor || (seg.kind === 'branch' && branchMenu)) && (
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
                    {buildMenuItems(sessionMenu, t).map(it => (
                      <Fragment key={it.key}>
                        {it.ruleBefore && <div className="rule" />}
                        <button
                          className={`item${it.danger ? ' danger' : ''}`}
                          disabled={it.disabled}
                          onClick={() => { setMenuOpen(false); it.onClick(); }}
                        >
                          <MenuIcon d={it.icon} /> {it.label}
                          {it.hint && <span className="sub">{it.hint}</span>}
                        </button>
                      </Fragment>
                    ))}
                  </div>
                )}
                {showBranchMenu && branchMenu && (
                  <div className="session-menu branch-menu" ref={branchMenuRef} onClick={e => e.stopPropagation()}>
                    {branchMenu.items.map(it => (
                      <button
                        key={it.id}
                        className={`item${it.active ? ' active' : ''}`}
                        title={it.label}
                        onClick={() => { setBranchMenuOpen(false); branchMenu.onPick(it.id); }}
                      >
                        {/* The check slot is always rendered so every label
                            starts at the same x, active row or not. Same
                            footprint as the session menu's leading icon. */}
                        <span className="item-check">{it.active && <CheckIcon size={13} />}</span>
                        <span className="item-label">{it.label}</span>
                        {/* Right-side detail uses the same `.sub` style as the
                            session menu's hint so both dropdowns read alike. */}
                        {it.detail && <span className="sub">{it.detail}</span>}
                      </button>
                    ))}
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
  if (!showSep) return <>{children}</>;
  return (
    <>
      <span className="path-sep"><ChevronRight /></span>
      {children}
    </>
  );
}
