import type { DragEvent } from 'react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../i18n/index.js';
import type { Mode } from './Topbar.js';

type NavPage = Extract<Mode, 'agents' | 'timer' | 'custom'>;
export type SidebarListMode = Extract<Mode, 'sessions' | 'tasks'>;

/* Sidebar chrome for the 2026-08-31 redesign (design/2026-08-31-sidebar-
 * agents-timer-custom, BRIEF r8): the Agents / Custom / Timer nav rows at the
 * top of the scroll area, the Tasks/Repos list-switch dropdown row under them
 * (2026-09-08, replaces the sticky segmented switch), and the collapsed 38px
 * icon rail. Session/task list rows are unchanged. */

function SvgIcon({ d, size = 16, stroke = 1.5 }: { d: string; size?: number; stroke?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor"
         strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {d.split(' M').map((seg, i) => (
        <path key={i} d={i === 0 ? seg : `M${seg}`} />
      ))}
    </svg>
  );
}

const ICON = {
  // lucide.dev `bot` / `alarm-clock` / `sliders-horizontal` / `message-square`
  bot: 'M12 8V4H8 M2 14h2 M20 14h2 M15 13v2 M9 13v2 M8 8h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2z',
  alarm: 'M12 21a8 8 0 1 0 0-16 8 8 0 0 0 0 16z M12 9v4l2 2 M5 3 2 6 M22 6l-3-3',
  sliders: 'M21 4h-7 M10 4H3 M21 12h-9 M8 12H3 M21 20h-5 M12 20H3 M14 2v4 M8 10v4 M16 18v4',
  msg: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  caretRight: 'M9 6l6 6-6 6',
  caretDown: 'M6 9l6 6 6-6',
  plus: 'M12 5v14 M5 12h14',
};

/** Rail list display cap (2026-09-06 owner call; 2026-09-08 extended to the
 *  Tasks rail): groups show 5 rows up front, 显示更多 reveals 10 more per
 *  click. View-only — the underlying order/drag model is untouched. */
export const GROUP_INITIAL_SHOWN = 5;
export const GROUP_SHOW_MORE_STEP = 10;

const NAV_PAGES: ReadonlyArray<readonly [NavPage, string, string]> = [
  ['agents', ICON.bot, 'nav.agents'],
  ['custom', ICON.sliders, 'topbar.mode.custom'],
  ['timer', ICON.alarm, 'topbar.mode.timer'],
];

/** Agents / Custom / Timer entries — top of `.sb-scroll`; a long list scrolls
 *  them away together with the list-switch row below. */
export function SidebarNavRows({ mode, onSetMode }: { mode: Mode; onSetMode: (mode: Mode) => void }) {
  const t = useT();
  return (
    <div className="sb-nav">
      {NAV_PAGES.map(([page, icon, labelKey]) => (
        <button
          key={page}
          type="button"
          className={`sb-navrow${mode === page ? ' active' : ''}`}
          data-testid={`sb-nav-${page}`}
          onClick={() => onSetMode(page)}
        >
          <span className="sb-group-ico"><SvgIcon d={icon} size={17} stroke={1.7} /></span>
          <span>{t(labelKey)}</span>
        </button>
      ))}
    </div>
  );
}

/** Codex-style collapsible section label (2026-09-07 sidebar-section
 *  refactor): a plain grey label at rest; hover reveals the collapse caret
 *  right after the label text and an optional "+" on the right (进行中 → new
 *  task, Repos → new Repo — only those two sections carry one). Click, Enter,
 *  or Space toggles the section. Structured like `.sb-group`: a div with
 *  role="button", never a <button> wrapping the inner "+". `dropProps` lets a
 *  section double as a drop target (the Tasks 未分配 header accepts
 *  task→standalone drops). */
export function SidebarSection({
  label,
  collapsed,
  onToggle,
  onAdd,
  addTitle,
  testid,
  className = '',
  dropProps,
}: {
  label: string;
  collapsed: boolean;
  onToggle: () => void;
  onAdd?: () => void;
  addTitle?: string;
  testid: string;
  /** Extra classes appended after `sb-section` (e.g. ` dnd-assign-target`). */
  className?: string;
  dropProps?: {
    onDragOver?: (event: DragEvent<HTMLElement>) => void;
    onDrop?: (event: DragEvent<HTMLElement>) => void;
  };
}) {
  return (
    <div
      className={`sb-section${className}`}
      role="button"
      tabIndex={0}
      aria-expanded={!collapsed}
      data-testid={testid}
      onClick={onToggle}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onToggle();
        }
      }}
      {...(dropProps ?? {})}
    >
      <span className="sb-section-label">{label}</span>
      <span className="sb-caret">
        <SvgIcon d={collapsed ? ICON.caretRight : ICON.caretDown} size={13} />
      </span>
      {onAdd && (
        <span className="sb-section-acts">
          <button
            type="button"
            className="sb-act"
            data-testid={`${testid}-add`}
            aria-label={addTitle}
            title={addTitle}
            onClick={event => { event.stopPropagation(); onAdd(); }}
          >
            <SvgIcon d={ICON.plus} size={14} />
          </button>
        </span>
      )}
    </div>
  );
}

const LIST_SWITCH_ITEMS: ReadonlyArray<readonly [SidebarListMode, string, string]> = [
  ['tasks', 'topbar.mode.tasks', 'sb-mode-tasks'],
  ['sessions', 'topbar.mode.project', 'sb-mode-project'],
];

/** Tasks/Repos list switch (2026-09-08 owner call): a nav row under the nav
 *  pages — replaces the sticky [Tasks|Repos] segmented switch. The row shows
 *  the CURRENT list with a trailing caret and only opens/closes the dropdown
 *  (it is not a page navigation); picking an item switches the list. Menu
 *  semantics match the HistoryInspector filter chips (backdrop click / Escape
 *  close, check on the active item); the popover portals to <body> with fixed
 *  coordinates because the rail clips absolute overflow (same reason as the
 *  row ⋯ menus). The row is sticky at the top of the scroll area — the nav
 *  rows scroll away, the switch stays (2026-09-08 owner call). */
export function SidebarListSwitch({
  listMode,
  onSetListMode,
}: {
  listMode: SidebarListMode;
  onSetListMode: (mode: SidebarListMode) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLSpanElement>(null);

  // Left-align to the row and clamp into the viewport; measure on the first
  // hidden pass so no misplaced frame is ever painted.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const btn = btnRef.current;
    const pop = popRef.current;
    if (!btn || !pop) return;
    const rect = btn.getBoundingClientRect();
    const width = pop.offsetWidth;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    setPos({ left, top: rect.bottom + 4 });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (btnRef.current?.contains(target)) return;
      if (popRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    // position: fixed cannot track the anchor — close on scroll/resize.
    const onScrollOrResize = () => setOpen(false);
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
    };
  }, [open]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="sb-navrow sb-listswitch"
        data-testid="sb-list-switch"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(o => !o)}
      >
        <span className="sb-group-ico"><SvgIcon d={ICON.msg} size={17} stroke={1.7} /></span>
        <span>{t(listMode === 'tasks' ? 'topbar.mode.tasks' : 'topbar.mode.project')}</span>
        <span className="sb-row-caret"><SvgIcon d={ICON.caretDown} size={13} /></span>
      </button>
      {open && createPortal(
        <span
          ref={popRef}
          className="ws-kebab-pop ws-kebab-pop--fixed sb-listswitch-pop"
          role="menu"
          onClick={event => event.stopPropagation()}
          style={pos
            ? { left: pos.left, top: pos.top }
            : { visibility: 'hidden', left: 0, top: 0 }}
        >
          {LIST_SWITCH_ITEMS.map(([value, labelKey, testid]) => (
            <button
              key={value}
              type="button"
              className={`ws-kebab-item${listMode === value ? ' active' : ''}`}
              role="menuitemradio"
              aria-checked={listMode === value}
              data-testid={testid}
              onClick={() => { setOpen(false); onSetListMode(value); }}
            >
              <span className="ck">{listMode === value ? '✓' : ''}</span>
              {t(labelKey)}
            </button>
          ))}
        </span>,
        document.body,
      )}
    </>
  );
}

/** Collapsed sidebar: a 38px icon rail identical to the right Dock. The three
 *  nav pages open directly; 消息 re-expands the sidebar onto the current
 *  conversation (the collapsed rail cannot switch sessions). */
export function LeftRail({
  mode,
  listMode,
  onSetMode,
  onExpand,
}: {
  mode: Mode;
  listMode: SidebarListMode;
  onSetMode: (mode: Mode) => void;
  onExpand: () => void;
}) {
  const t = useT();
  const chatActive = mode === listMode;
  return (
    <aside className="dock left-rail">
      {NAV_PAGES.map(([page, icon, labelKey]) => (
        <button
          key={page}
          type="button"
          className={`dock-btn wb${mode === page ? ' active' : ''}`}
          data-testid={`rail-nav-${page}`}
          aria-label={t(labelKey)}
          title={t(labelKey)}
          onClick={() => onSetMode(page)}
        >
          <SvgIcon d={icon} size={17} />
          <span className="lbl">{t(labelKey)}</span>
        </button>
      ))}
      <div className="dock-divider" aria-hidden />
      <button
        type="button"
        className={`dock-btn wb${chatActive ? ' active' : ''}`}
        data-testid="rail-nav-chat"
        aria-label={t('nav.messages')}
        title={t('nav.messages.hint')}
        onClick={() => {
          if (!chatActive) onSetMode(listMode);
          onExpand();
        }}
      >
        <SvgIcon d={ICON.msg} size={17} />
        <span className="lbl">{t('nav.messages')}</span>
      </button>
    </aside>
  );
}
