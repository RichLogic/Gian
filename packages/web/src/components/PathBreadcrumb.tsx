import { Fragment, useEffect, useRef, useState } from 'react';
import type { Executor } from '@gian/shared';
import { useT } from '../i18n/index.js';

export type PathSegmentKind = 'workspace' | 'branch' | 'session';

export interface PathSegment {
  kind: PathSegmentKind;
  label: string;
  copyHint?: string;
  editing?: boolean;
}

export interface SessionMenuActions {
  /** Which context this menu is for — drives the item set, order, grouping and
   *  danger styling (see buildMenuItems). Defaults to 'session'. */
  kind?: 'session' | 'subtask' | 'task';
  onRename: () => void;
  // All others are optional — the menu adapts to the context (full session /
  // subtask / task). When a callback is absent, its item is hidden.
  // Subtask drops fork/archive/delete; Task drops forceRecover/markUnread/fork.
  onCopyName?: () => void;
  onForceRecover?: () => void;
  onMarkUnread?: () => void;
  /** Task only: pin / unpin to the top of the Tasks list. `pinned` drives the
   *  label ("Pin" ↔ "Unpin") and the toggle behaviour. */
  onPin?: () => void;
  pinned?: boolean;
  /** Task only: mark the task done / reopen it (moved off the rail row onto
   *  this menu when the Tasks rail aligned with the Sessions rail, 2026-07-31).
   *  `taskDone` drives the label ("Mark done" ↔ "Reopen"). */
  onToggleDone?: () => void;
  taskDone?: boolean;
  onFork?: (executor: Executor) => void;
  onDelete?: () => void;
  /** Subtask only (spec §B): toggle the user completion flag. `completed`
   *  drives the label ("Mark complete" ↔ "Reopen"). */
  onToggleComplete?: () => void;
  completed?: boolean;
}

/** The branch segment's worktree dropdown (view-level working-tree switch).
 *  Items are the workspace's working trees; `onPick` selects one, `onCopy`
 *  (optional) appends a "Copy branch name" item after a divider. */
export interface BranchMenuActions {
  items: Array<{ id: string; label: string; detail?: string | null; active?: boolean }>;
  onPick: (id: string) => void;
  onCopy?: () => void;
}

interface Props {
  segments: PathSegment[];
  onRenameSubmit?: (value: string) => void;
  onRenameCancel?: () => void;
  sessionMenu?: SessionMenuActions | null;
  branchMenu?: BranchMenuActions | null;
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
  // pushpin — pin / unpin a task to the top of the list
  pin: 'M12 17v5 M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z',
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
  /** Right-aligned hint, e.g. the F2 shortcut. */
  hint?: string;
}

/**
 * Build the ordered menu item list for the active context. Three distinct
 * layouts (decided 2026-06-29) — they differ in order, grouping and which
 * actions are destructive, so a single fixed template can't express them:
 *
 *  session : Rename · Copy · Unread ┊ Fork×3 · Recover(red) ┊ Archive · Delete(red)
 *  subtask : Rename · Copy ┊ Unread · Complete ┊ Recover(red)
 *  task    : Rename · Copy ┊ Unread ┊ Recover(red) · Remove(red)
 */
function buildMenuItems(m: SessionMenuActions, t: (k: string) => string): MenuItemDesc[] {
  const items: MenuItemDesc[] = [
    { key: 'rename', icon: ICON.edit, label: t('path.menu.rename'), onClick: m.onRename, hint: 'F2' },
  ];
  const copy = () => {
    if (m.onCopyName) items.push({ key: 'copy', icon: ICON.copy, label: t('path.menu.copyName'), onClick: m.onCopyName });
  };

  if (m.kind === 'task') {
    copy();
    if (m.onMarkUnread) items.push({ key: 'unread', icon: ICON.mail, label: t('path.menu.markUnread'), onClick: m.onMarkUnread, ruleBefore: true });
    if (m.onPin) items.push({ key: 'pin', icon: ICON.pin, label: t(m.pinned ? 'path.menu.unpin' : 'path.menu.pin'), onClick: m.onPin });
    if (m.onToggleDone) items.push({
      key: 'done',
      icon: m.taskDone ? ICON.refresh : ICON.check,
      label: m.taskDone ? t('tasks.reopen') : t('tasks.markDone'),
      onClick: m.onToggleDone,
    });
    if (m.onForceRecover) items.push({ key: 'recover', icon: ICON.refresh, label: t('path.menu.forceRecover'), onClick: m.onForceRecover, danger: true, ruleBefore: true });
    if (m.onDelete) items.push({ key: 'remove', icon: ICON.trash, label: t('path.menu.removeTask'), onClick: m.onDelete, danger: true });
    return items;
  }

  if (m.kind === 'subtask') {
    copy();
    if (m.onMarkUnread) items.push({ key: 'unread', icon: ICON.mail, label: t('path.menu.markUnread'), onClick: m.onMarkUnread, ruleBefore: true });
    if (m.onToggleComplete) items.push({
      key: 'complete',
      icon: m.completed ? ICON.refresh : ICON.check,
      label: m.completed ? t('tasks.subtask.reopen') : t('tasks.subtask.complete'),
      onClick: m.onToggleComplete,
    });
    if (m.onForceRecover) items.push({ key: 'recover', icon: ICON.refresh, label: t('path.menu.forceRecover'), onClick: m.onForceRecover, danger: true, ruleBefore: true });
    if (m.onDelete) items.push({ key: 'delete', icon: ICON.trash, label: t('path.menu.deleteSession'), onClick: m.onDelete, danger: true });
    return items;
  }

  // session (default)
  copy();
  if (m.onMarkUnread) items.push({ key: 'unread', icon: ICON.mail, label: t('path.menu.markUnread'), onClick: m.onMarkUnread });
  if (m.onFork) {
    items.push({ key: 'fork-claude', icon: ICON.fork, label: t('path.menu.forkClaude'), onClick: () => m.onFork!('claude'), ruleBefore: true });
    items.push({ key: 'fork-codex', icon: ICON.fork, label: t('path.menu.forkCodex'), onClick: () => m.onFork!('codex') });
    items.push({ key: 'fork-kimi', icon: ICON.fork, label: t('path.menu.forkKimi'), onClick: () => m.onFork!('kimi') });
  }
  if (m.onForceRecover) items.push({ key: 'recover', icon: ICON.refresh, label: t('path.menu.forceRecover'), onClick: m.onForceRecover, danger: true });
  if (m.onDelete) items.push({ key: 'delete', icon: ICON.trash, label: t('path.menu.deleteSession'), onClick: m.onDelete, danger: true });
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
    if (seg.kind === 'session' && sessionMenu) {
      setMenuOpen(o => !o);
    } else if (seg.kind === 'branch' && branchMenu) {
      // With a branch menu wired up, clicking the branch switches worktree
      // instead of copying (copying stays available as a menu item).
      setBranchMenuOpen(o => !o);
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
        const showBranchMenu = seg.kind === 'branch' && branchMenuOpen && branchMenu;
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
              <span
                className="path-seg-anchor"
                ref={seg.kind === 'session' ? anchorRef : seg.kind === 'branch' ? branchAnchorRef : undefined}
              >
                <button
                  className={`path-seg ${seg.kind} ${isCopied ? 'copied' : ''}`}
                  title={seg.kind === 'branch' && branchMenu ? t('path.branch.switch') : seg.copyHint}
                  onClick={e => { e.stopPropagation(); handleSegClick(i, seg); }}
                >
                  {seg.kind === 'branch' && <BranchIcon />}
                  <span className="path-seg-label">{seg.label}</span>
                  {(seg.kind === 'session' || (seg.kind === 'branch' && branchMenu)) && (
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
                  <div className="session-menu" ref={branchMenuRef} onClick={e => e.stopPropagation()}>
                    {branchMenu.items.map(it => (
                      <button
                        key={it.id}
                        className={`item${it.active ? ' active' : ''}`}
                        onClick={() => { setBranchMenuOpen(false); branchMenu.onPick(it.id); }}
                      >
                        {it.active && <CheckIcon size={11} />}
                        <span className="item-label">{it.label}</span>
                        {it.detail && <span className="item-detail">{it.detail}</span>}
                      </button>
                    ))}
                    {branchMenu.onCopy && (
                      <>
                        <div className="rule" />
                        <button
                          className="item"
                          onClick={() => { setBranchMenuOpen(false); branchMenu.onCopy!(); }}
                        >
                          <MenuIcon d={ICON.copy} /> {t('path.menu.copyBranch')}
                        </button>
                      </>
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
      {showSep && <span className="path-sep">/</span>}
      {children}
    </>
  );
}
