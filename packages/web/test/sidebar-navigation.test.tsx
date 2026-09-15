import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import type { Session, Task, Workspace } from '@gian/shared';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { LocaleProvider } from '../src/i18n/index.js';
import type { RailLayoutController } from '../src/components/RailLayout.js';
import type { Mode } from '../src/components/Topbar.js';
import type { SidebarListMode } from '../src/components/SidebarChrome.js';
import { PageWithSidebar } from '../src/views/PageWithSidebar.js';
import { usePanelLayout } from '../src/controllers/use-panel-layout.js';
import { __resetScheduleBadgeForTest } from '../src/controllers/use-schedules.js';
import { __resetFeedback, getSnapshot, resolveConfirm } from '../src/feedback.js';
import { mockFetch } from './setup.js';
import { renderWithOperations } from './operation-test-utils.js';
import { makeSchedule } from './schedule-fixtures.js';

const workspace = {
  id: 'ws-1',
  name: 'Gian-Dev',
  hidden: 0,
  pinned_at: null,
  sort_order: null,
} as Workspace;

const session = {
  id: 'session-1',
  name: 'Restore the sidebar',
  workspace_id: workspace.id,
  task_id: null,
  type: 'session',
  executor: 'codex',
  status: 'idle',
  unread: 0,
  archived: 0,
  pinned_at: null,
  completed_at: null,
  updated_at: '2026-09-04T08:00:00.000Z',
} as Session;

const task = {
  id: 'task-1',
  name: 'Sidebar memory',
  status: 'open',
  sort_order: null,
  created_at: '2026-09-04T08:00:00.000Z',
  updated_at: '2026-09-04T08:00:00.000Z',
} as Task;

function renderPage(options: { collapsed?: boolean; mode?: 'agents' | 'tasks'; sessions?: Session[] } = {}) {
  const onSetMode = vi.fn();
  const onSetListMode = vi.fn();
  const onNewWorkspace = vi.fn();
  const onEditWorkspace = vi.fn();
  const onNewForWorkspace = vi.fn();
  const onPinSession = vi.fn();
  const onArchiveSession = vi.fn();
  const onSelectSession = vi.fn();
  const setCollapsed = vi.fn();
  const railLayout: RailLayoutController = {
    width: 272,
    collapsed: options.collapsed ?? false,
    setCollapsed,
    onMouseDown: vi.fn(),
  };

  const rendered = renderWithOperations(
    <LocaleProvider locale="en">
      <PageWithSidebar
        mode={options.mode ?? 'agents'}
        onSetMode={onSetMode}
        listMode="sessions"
        onSetListMode={onSetListMode}
        workspaces={[workspace]}
        sessions={options.sessions ?? [session]}
        tasks={[task]}
        activeSessionId={session.id}
        activeSubtaskId={null}
        onNewWorkspace={onNewWorkspace}
        onEditWorkspace={onEditWorkspace}
        onNewForWorkspace={onNewForWorkspace}
        onPinSession={onPinSession}
        onArchiveSession={onArchiveSession}
        onSelectSession={onSelectSession}
        onSelectUnassignedSession={vi.fn()}
        onSelectSubtask={vi.fn()}
        onNewSessionForTask={vi.fn()}
        railLayout={railLayout}
      >
        <main data-testid="page-content">Page content</main>
      </PageWithSidebar>
    </LocaleProvider>,
  );

  return {
    onSetMode,
    onSetListMode,
    onNewWorkspace,
    onEditWorkspace,
    onNewForWorkspace,
    onSelectSession,
    setCollapsed,
    transport: rendered.transport,
    view: rendered,
  };
}

describe('persistent primary sidebar', () => {
  beforeEach(() => {
    // The schedule badge store is a module-level singleton — reset it so each
    // test hydrates from its own fetch mock.
    __resetScheduleBadgeForTest();
  });

  it('marks sessions owning a live schedule with a row-end timer badge', async () => {
    const plain = { ...session, id: 'session-2', name: 'Plain chat' } as Session;
    mockFetch(async input => {
      const url = String(input);
      if (url.startsWith('/api/schedules')) {
        return new Response(JSON.stringify({
          schedules: [makeSchedule({ control_session_id: session.id })],
          next_cursor: null,
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    renderPage({ sessions: [session, plain] });

    // Only the bound session carries the lucide timer glyph (2026-09-15 owner).
    const badge = await screen.findByTestId(`session-schedule-${session.id}`);
    expect(badge.querySelector('svg')).not.toBeNull();
    // The glyph hangs in the icon gutter — no slot is reserved on plain rows.
    expect(screen.queryByTestId('session-schedule-session-2')).toBeNull();
    expect(screen.getByTestId('session-row-session-2')
      .querySelector('.ri-schedule-badge')).toBeNull();
    // Placement: inside .ri-row1, immediately before the title.
    expect(badge.parentElement?.classList.contains('ri-row1')).toBe(true);
    expect(badge.nextElementSibling?.classList.contains('ri-title')).toBe(true);
  });

  it('renders nav pages (Agents / Custom / Timer) and the list-switch dropdown row above the list', () => {
    const handlers = renderPage();
    const nav = screen.getByTestId('sb-nav-agents');
    const listSwitch = screen.getByTestId('sb-list-switch');
    const row = screen.getByTestId(`session-row-${session.id}`);

    expect(nav).toHaveClass('active');
    // Nav order (2026-09-08): Agents, Custom, Timer, then the list switch.
    const order = ['sb-nav-agents', 'sb-nav-custom', 'sb-nav-timer', 'sb-list-switch']
      .map(id => screen.getByTestId(id));
    for (let i = 0; i < order.length - 1; i++) {
      expect(order[i]!.compareDocumentPosition(order[i + 1]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    expect(listSwitch.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The row shows the CURRENT list and only opens the dropdown — it never
    // navigates (clicking it must not call onSetMode/onSetListMode).
    expect(listSwitch).toHaveTextContent('Repos');
    expect(listSwitch).toHaveAttribute('aria-haspopup', 'menu');
    expect(listSwitch).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('sb-section-projects')).toHaveTextContent('Repos');
    expect(screen.getByTestId('page-content')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('sb-nav-timer'));
    expect(handlers.onSetMode).toHaveBeenCalledWith('timer');
    fireEvent.click(listSwitch);
    expect(handlers.onSetMode).toHaveBeenCalledTimes(1);
    expect(handlers.onSetListMode).not.toHaveBeenCalled();
    // The dropdown offers both lists with a check on the active one.
    expect(listSwitch).toHaveAttribute('aria-expanded', 'true');
    const menu = screen.getByRole('menu');
    expect(within(menu).getByTestId('sb-mode-tasks')).toHaveTextContent('Tasks');
    expect(within(menu).getByTestId('sb-mode-project')).toHaveTextContent('Repos');
    expect(within(menu).getByTestId('sb-mode-project')).toHaveAttribute('aria-checked', 'true');
    expect(within(menu).getByTestId('sb-mode-tasks')).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(within(menu).getByTestId('sb-mode-tasks'));
    expect(handlers.onSetListMode).toHaveBeenCalledWith('tasks');
    expect(screen.queryByRole('menu')).toBeNull();
    // The rail search button was removed (2026-09-06); ⌘K opens the palette.
    expect(screen.queryByTestId('sb-open-search')).toBeNull();
    // The top-row New button is gone (2026-09-07): the Repos section header's
    // hover "+" opens the New Repo dialog.
    expect(screen.queryByTestId('sb-new-session')).toBeNull();
    fireEvent.click(row);
    expect(handlers.onSelectSession).toHaveBeenCalledWith(session.id);
  });

  it('closes the list-switch dropdown on Escape and on outside pointer down', () => {
    renderPage();
    const listSwitch = screen.getByTestId('sb-list-switch');
    fireEvent.click(listSwitch);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(listSwitch).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(listSwitch);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('Repos section "+" calls onNewWorkspace without collapsing the section', () => {
    const handlers = renderPage();
    const section = screen.getByTestId('sb-section-projects');
    expect(screen.getByTestId(`session-row-${session.id}`)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('sb-section-projects-add'));
    expect(handlers.onNewWorkspace).toHaveBeenCalledTimes(1);
    expect(section).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId(`session-row-${session.id}`)).toBeInTheDocument();
  });

  it('section headers collapse on click/keyboard, show no count, and persist across a rail remount', () => {
    localStorage.removeItem('gian.sidebar.sections.collapsed');
    try {
      const first = renderPage();
      const section = screen.getByTestId('sb-section-projects');
      expect(section).toHaveAttribute('aria-expanded', 'true');
      expect(section.querySelector('.count')).toBeNull();

      fireEvent.click(section);
      expect(screen.queryByTestId(`session-row-${session.id}`)).toBeNull();
      expect(JSON.parse(localStorage.getItem('gian.sidebar.sections.collapsed')!)).toEqual(['projects']);

      // Keyboard: Enter/Space toggle (Space re-expands here).
      fireEvent.keyDown(screen.getByTestId('sb-section-projects'), { key: ' ' });
      expect(screen.getByTestId(`session-row-${session.id}`)).toBeInTheDocument();
      fireEvent.keyDown(screen.getByTestId('sb-section-projects'), { key: 'Enter' });
      expect(screen.queryByTestId(`session-row-${session.id}`)).toBeNull();

      // Switching to Tasks and back unmounts this rail — the persisted
      // collapse survives the remount.
      first.view.unmount();
      renderPage();
      expect(screen.getByTestId('sb-section-projects')).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByTestId(`session-row-${session.id}`)).toBeNull();
    } finally {
      localStorage.removeItem('gian.sidebar.sections.collapsed');
    }
  });

  it('project group ⋯ menu: Edit opens the Repo dialog, Reveal posts, Remove confirms first', async () => {
    __resetFeedback();
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    mockFetch(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url, method, body });
      const payload = method === 'PATCH' && url === '/api/workspaces/ws-1'
        ? { ...workspace, name: (body as { name?: string })?.name ?? workspace.name }
        : { ok: true };
      return new Response(JSON.stringify(payload), { status: 200 });
    });
    const handlers = renderPage();

    fireEvent.click(screen.getByTestId('ws-menu-ws-1'));
    expect(screen.getByRole('menu')).toBeInTheDocument();

    // Edit → the App-owned Edit Repo dialog (2026-09-09; the group header's
    // inline rename input is gone). The dialog itself is covered by
    // workspace-dialog.test.tsx.
    fireEvent.click(screen.getByTestId('ws-edit-ws-1'));
    expect(handlers.onEditWorkspace).toHaveBeenCalledWith(workspace);
    expect(screen.queryByTestId('ws-rename-input-ws-1')).toBeNull();
    expect(calls.some(call => call.method === 'PATCH')).toBe(false);

    // Reveal in Finder → POST the working-tree reveal endpoint (ws:<id>).
    fireEvent.click(screen.getByTestId('ws-menu-ws-1'));
    fireEvent.click(screen.getByTestId('ws-reveal-ws-1'));
    await waitFor(() => expect(calls.some(call =>
      call.method === 'POST'
      && call.url === `/api/working_trees/${encodeURIComponent('ws:ws-1')}/reveal`)).toBe(true));

    // Remove waits for the danger confirm.
    fireEvent.click(screen.getByTestId('ws-menu-ws-1'));
    fireEvent.click(screen.getByTestId('ws-remove-ws-1'));
    expect(calls.some(call => call.method === 'DELETE')).toBe(false);
    act(() => resolveConfirm(getSnapshot().confirms[0]!.id, true));
    await waitFor(() => expect(calls.some(call =>
      call.method === 'DELETE' && call.url === '/api/workspaces/ws-1')).toBe(true));
  });

  it('uses the 38px icon rail when collapsed and Messages returns to chat', () => {
    const handlers = renderPage({ collapsed: true });

    expect(screen.queryByTestId('sb-list-switch')).not.toBeInTheDocument();
    expect(screen.queryByTestId('sb-mode-project')).not.toBeInTheDocument();
    expect(screen.getByTestId('rail-nav-agents')).toHaveClass('active');
    fireEvent.click(screen.getByTestId('rail-nav-custom'));
    expect(handlers.onSetMode).toHaveBeenCalledWith('custom');
    fireEvent.click(screen.getByTestId('rail-nav-chat'));
    expect(handlers.onSetMode).toHaveBeenCalledWith('sessions');
    expect(handlers.setCollapsed).toHaveBeenCalledWith(false);
  });

  it('keeps Tasks selected while Agents, Timer, and Custom change the main page', () => {
    function Harness() {
      const [mode, setMode] = useState<Mode>('tasks');
      const [listMode, setListMode] = useState<SidebarListMode>('tasks');
      return (
        <PageWithSidebar
          mode={mode}
          onSetMode={setMode}
          listMode={listMode}
          onSetListMode={next => {
            setListMode(next);
            setMode(next);
          }}
          workspaces={[workspace]}
          sessions={[session]}
          tasks={[task]}
          activeSessionId={null}
          activeSubtaskId={null}
          onNewWorkspace={() => undefined}
          onEditWorkspace={() => undefined}
          onNewForWorkspace={() => undefined}
          onPinSession={() => undefined}
          onArchiveSession={() => undefined}
          onSelectSession={() => undefined}
          onSelectUnassignedSession={() => undefined}
          onSelectSubtask={() => undefined}
          onNewSessionForTask={() => undefined}
          railLayout={{
            width: 272,
            collapsed: false,
            setCollapsed: () => undefined,
            onMouseDown: () => undefined,
          }}
        >
          <main data-testid="active-primary-page">{mode}</main>
        </PageWithSidebar>
      );
    }

    renderWithOperations(<LocaleProvider locale="en"><Harness /></LocaleProvider>);
    // The list-switch row shows the current list; the check rides the menu.
    expect(screen.getByTestId('sb-list-switch')).toHaveTextContent('Tasks');
    expect(screen.getByText(task.name)).toBeInTheDocument();

    for (const page of ['agents', 'timer', 'custom'] as const) {
      fireEvent.click(screen.getByTestId(`sb-nav-${page}`));
      expect(screen.getByTestId('active-primary-page')).toHaveTextContent(page);
      expect(screen.getByTestId('sb-list-switch')).toHaveTextContent('Tasks');
      expect(screen.getByText(task.name)).toBeInTheDocument();
    }

    fireEvent.click(screen.getByTestId('sb-list-switch'));
    fireEvent.click(screen.getByTestId('sb-mode-project'));
    expect(screen.getByTestId('active-primary-page')).toHaveTextContent('sessions');
    expect(screen.getByTestId('sb-list-switch')).toHaveTextContent('Repos');
    expect(screen.getByTestId(`session-row-${session.id}`)).toBeInTheDocument();
    // Reopening the dropdown shows the check on Repos now.
    fireEvent.click(screen.getByTestId('sb-list-switch'));
    expect(screen.getByTestId('sb-mode-project')).toHaveAttribute('aria-checked', 'true');
  });

  it('caps Workspace groups at 5 rows and reveals 10 more per 显示更多 click', () => {
    const many = Array.from({ length: 7 }, (_, index) => ({
      ...session,
      id: `session-${index + 1}`,
      name: `Row ${index + 1}`,
    }));
    renderPage({ sessions: many });
    // 5 up front, the 显示更多 row carries the remaining count.
    expect(screen.getByTestId('session-row-session-5')).toBeInTheDocument();
    expect(screen.queryByTestId('session-row-session-6')).not.toBeInTheDocument();
    const more = screen.getByTestId('sb-showmore-ws-1');
    expect(more).toHaveTextContent('Show more (2 more)');
    fireEvent.click(more);
    expect(screen.getByTestId('session-row-session-7')).toBeInTheDocument();
    expect(screen.queryByTestId('sb-showmore-ws-1')).not.toBeInTheDocument();
  });

  it('keeps group hover actions out of flow so names are not pre-truncated', () => {
    // Regression (2026-09-06): .sb-group-acts sat in flow with opacity 0, so
    // group names ellipsized ~20px early even before any button appeared.
    const css = readFileSync('src/styles/gian-v2.css', 'utf8');
    const acts = css.match(/\.sb-group-acts\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(acts).toMatch(/position:\s*absolute/);
    expect(acts).not.toMatch(/margin-left:\s*auto/);
    // …and its backdrop must not paint off-hover (an always-on background
    // rendered an empty pill over every group header).
    expect(acts).not.toMatch(/background:/);
  });

  it('drops the segmented switch; the list-switch row is a sticky nav row with a trailing caret', () => {
    // 2026-09-08 (owner): the [Tasks|Repos] segmented switch and its
    // `.sb-toprow` are gone; the list switch is a dropdown `.sb-navrow` under
    // Timer whose caret trails in the quiet text color — and the ROW sticks
    // to the scroll top while the nav rows scroll away.
    renderPage();
    expect(screen.getByTestId('sb-list-switch')).toHaveClass('sb-navrow');
    expect(document.querySelector('.sb-toprow')).toBeNull();
    expect(document.querySelector('.sb-switch')).toBeNull();
    expect(document.querySelector('.sb-toprow-spacer')).toBeNull();
    const nav = readFileSync('src/styles/sidebar-navigation.css', 'utf8');
    expect(nav).not.toMatch(/\.sb-toprow/);
    expect(nav).not.toMatch(/\.sb-switch\b/);
    expect(nav.match(/\.sb-listswitch \.sb-row-caret\s*\{([^}]*)\}/)?.[1] ?? '')
      .toMatch(/var\(--text-3\)/);
    // 2026-09-09 (owner): the caret hugs the label, never pushed to the row end.
    expect(nav.match(/\.sb-listswitch \.sb-row-caret\s*\{([^}]*)\}/)?.[1] ?? '')
      .not.toMatch(/margin-left/);
    const sticky = nav.match(/\.sb-scroll > \.sb-listswitch\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(sticky).toMatch(/position:\s*sticky/);
    expect(sticky).toMatch(/background:\s*var\(--bg\)/);
    const gianV2 = readFileSync('src/styles/gian-v2.css', 'utf8');
    expect(gianV2).not.toMatch(/\.sb-toprow/);
  });

  it('keeps the airy rail type scale (2026-09-07 owner call)', () => {
    // Owner call: the rail reads bigger and more breathable — 17px primary
    // icons (same as the collapsed icon rail), with text/spacing to match.
    const gianV2 = readFileSync('src/styles/gian-v2.css', 'utf8');
    const nav = readFileSync('src/styles/sidebar-navigation.css', 'utf8');
    const components = readFileSync('src/styles/components.css', 'utf8');
    // Section labels 13px/600, left edge aligned with the nav rows' text
    // (2026-09-08), group counts 11px, row age 11px (--fz-10).
    const section = gianV2.match(/\.sb-section\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(section).toMatch(/var\(--fz-12\)/);
    expect(section).toMatch(/padding:\s*3px 10px/);
    expect(gianV2.match(/\.sb-group \.count\s*\{([^}]*)\}/)?.[1] ?? '').toMatch(/11px/);
    expect(gianV2.match(/\.ri-age\s*\{([^}]*)\}/)?.[1] ?? '').toMatch(/var\(--fz-10\)/);
    expect(components.match(/\.ri-age\s*\{([^}]*)\}/)?.[1] ?? '').toMatch(/var\(--fz-10\)/);
    // Nav rows 14px/600 with 32px minimum height.
    const navrow = nav.match(/\.sb-navrow\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(navrow).toMatch(/var\(--fz-13\)/);
    expect(navrow).toMatch(/min-height:\s*32px/);
    // Session-row titles sit exactly in the group-name text column
    // (2px margin + 10px padding + 18px icon + 7px gap = 37px, 2026-09-09).
    expect(gianV2.match(/\.rail-item\.session-row\s*\{([^}]*)\}/)?.[1] ?? '')
      .toMatch(/padding-left:\s*37px/);
    // The 显示更多 row lands its text on the same column (2px margin + 35px
    // padding, 2026-09-10).
    expect(nav.match(/\.sb-showmore\s*\{([^}]*)\}/)?.[1] ?? '')
      .toMatch(/padding:\s*4px 8px 4px 35px/);
  });

  it('shows the delayed hover card (logo + name + time + repo) and renames inline', async () => {
    const handlers = renderPage();
    fireEvent.mouseEnter(screen.getByTestId(`session-row-${session.id}`));
    // 450ms open delay: nothing yet.
    expect(screen.queryByTestId(`session-hover-card-${session.id}`)).toBeNull();
    const card = await screen.findByTestId(`session-hover-card-${session.id}`, undefined, { timeout: 3000 });
    expect(card).toHaveTextContent('Restore the sidebar');       // full name, un-ellipsized
    expect(card).toHaveTextContent('Gian-Dev');                  // owning Repo
    expect(card.querySelector('.agent-logo')).toBeTruthy();      // agent logo
    expect(card.querySelector('.shc-time')?.textContent).toBeTruthy(); // relative time
    // Click the name → inline rename input → Enter dispatches session:rename.
    fireEvent.click(card.querySelector('.shc-name')!);
    const input = await screen.findByTestId(`session-rename-${session.id}`);
    fireEvent.change(input, { target: { value: 'Renamed sidebar' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(handlers.transport.sent.some(message =>
      (message as { type: string }).type === 'session:rename')).toBe(true));
    // The card closed after the commit.
    await waitFor(() => expect(screen.queryByTestId(`session-hover-card-${session.id}`)).toBeNull());
  });
});

describe('usePanelLayout sidebar seam on primary pages', () => {
  // Regression (2026-09-06): on Agents/Timer/Custom the `.main` card nests
  // inside `.primary-page-surface > *-view`, so the drag controller's
  // direct-child lookup measured mainWidth 0 and beginDrag dead-stopped —
  // the sidebar seam did nothing on every primary page.
  it('measures the nested .main and resizes the rail', () => {
    localStorage.removeItem('rail.w');
    const rectByClass: Record<string, { left: number; right: number; width: number }> = {
      body: { left: 0, right: 1400, width: 1400 },
      sidebar: { left: 0, right: 272, width: 272 },
      main: { left: 276, right: 1076, width: 800 },
    };
    const original = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      const entry = Object.values(rectByClass)
        .find((_, index) => this.classList.contains(Object.keys(rectByClass)[index]!));
      const rect = entry ?? { left: 0, right: 0, width: 0 };
      return {
        x: rect.left, y: 0, top: 0, bottom: 40, height: 40,
        left: rect.left, right: rect.right, width: rect.width,
        toJSON: () => ({}),
      } as DOMRect;
    };

    let latest: ReturnType<typeof usePanelLayout> | null = null;
    function Probe() {
      const [p3Collapsed, setP3Collapsed] = useState(false);
      const layout = usePanelLayout({
        enabled: false,
        panel1Visible: true,
        panel2Visible: true,
        inspectorVisible: false,
        p3Collapsed,
        setP3Collapsed,
      });
      latest = layout;
      return (
        <div className="body" ref={layout.bodyRef} style={layout.bodyStyle}>
          <div className="view">
            <aside className="sidebar" />
            <div className="primary-page-surface">
              <div className="agents-view"><main className="main" /></div>
            </div>
          </div>
        </div>
      );
    }

    try {
      render(<Probe />);
      expect(latest!.railLayout.width).toBe(272);
      const handle = document.createElement('div');
      act(() => {
        latest!.railLayout.onMouseDown({
          button: 0,
          clientX: 272,
          preventDefault: () => undefined,
          currentTarget: handle,
        } as unknown as ReactMouseEvent);
      });
      act(() => {
        window.dispatchEvent(new MouseEvent('mousemove', { clientX: 332 }));
        window.dispatchEvent(new MouseEvent('mouseup', { clientX: 332 }));
      });
      expect(latest!.railLayout.width).toBe(332);
    } finally {
      HTMLElement.prototype.getBoundingClientRect = original;
    }
  });
});
