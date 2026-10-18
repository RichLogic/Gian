/**
 * Bottom global entries (0.6.7, Air-style): Search, Inbox (pending badge),
 * Settings — pinned at the bottom of the right dock, Settings last, never
 * scrolling with content, available on every page. The Topbar no longer
 * carries duplicate global entries.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Dock } from '../src/components/Dock.js';
import { Topbar } from '../src/components/Topbar.js';

function renderDock(overrides: Partial<Parameters<typeof Dock>[0]> = {}) {
  const props: Parameters<typeof Dock>[0] = {
    activeRail: null,
    onToggleRail: vi.fn(),
    wsState: 'open',
    wsAttempt: 0,
    authed: true,
    runner: null,
    onOpenSearch: vi.fn(),
    inbox: { pendingCount: 0, open: false, onToggle: vi.fn() },
    ...overrides,
  };
  render(<Dock {...props} />);
  return props;
}

function renderTopbar() {
  render(
    <Topbar
      pathSegments={[]}
      sidebarCollapsed={false}
      onToggleSidebar={vi.fn()}
      p3Available
      p3Visible={false}
      onToggleP3={vi.fn()}
      canGoBack={false}
      canGoForward={false}
      onGoBack={vi.fn()}
      onGoForward={vi.fn()}
    />,
  );
}

describe('dock bottom global entries', () => {
  it('pins Search, Inbox, Settings after the spacer — Settings last', () => {
    renderDock();
    const dock = document.querySelector('.dock')!;
    const spacer = dock.querySelector('.dock-spacer')!;
    const search = screen.getByTestId('dock-search');
    const inbox = screen.getByTestId('dock-inbox');
    const settings = screen.getByTestId('dock-settings');
    // Everything is below the flex spacer (never scrolls with the groups).
    expect(spacer.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(search.compareDocumentPosition(inbox) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(inbox.compareDocumentPosition(settings) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Settings is the last dock button.
    const buttons = dock.querySelectorAll('.dock-btn');
    expect(buttons[buttons.length - 1]).toBe(settings);
  });

  it('keeps the Inbox pending badge and fires the callbacks', async () => {
    const onToggle = vi.fn();
    const onOpenSearch = vi.fn();
    renderDock({ inbox: { pendingCount: 3, open: false, onToggle }, onOpenSearch });
    const inboxBtn = screen.getByTestId('dock-inbox');
    expect(inboxBtn.querySelector('.dock-badge')?.textContent).toBe('3');
    const user = userEvent.setup();
    await user.click(inboxBtn);
    expect(onToggle).toHaveBeenCalledTimes(1);
    await user.click(screen.getByTestId('dock-search'));
    expect(onOpenSearch).toHaveBeenCalledTimes(1);
  });

  it('hides the badge at zero and mirrors the open state', () => {
    renderDock({ inbox: { pendingCount: 0, open: true, onToggle: vi.fn() } });
    const inboxBtn = screen.getByTestId('dock-inbox');
    expect(inboxBtn.querySelector('.dock-badge')).toBeNull();
    expect(inboxBtn.className).toContain('active');
  });

  it('keeps the Inbox pending badge contract: hidden at 0, raw to 99, capped at 99+', () => {
    const { rerender } = render(
      <Dock
        activeRail={null}
        onToggleRail={vi.fn()}
        wsState="open"
        wsAttempt={0}
        authed
        runner={null}
        onOpenSearch={vi.fn()}
        inbox={{ pendingCount: 0, open: false, onToggle: vi.fn() }}
      />,
    );
    expect(screen.getByTestId('dock-inbox').querySelector('.dock-badge')).toBeNull();
    for (const count of [1, 99, 100, 140]) {
      rerender(
        <Dock
          activeRail={null}
          onToggleRail={vi.fn()}
          wsState="open"
          wsAttempt={0}
          authed
          runner={null}
          onOpenSearch={vi.fn()}
          inbox={{ pendingCount: count, open: false, onToggle: vi.fn() }}
        />,
      );
      const badge = screen.getByTestId('dock-inbox').querySelector('.dock-badge');
      expect(badge?.textContent).toBe(count > 99 ? '99+' : String(count));
    }
  });

  it('the global entries stay clickable when session/workbench rails are disabled', async () => {
    const onOpenSearch = vi.fn();
    const onToggle = vi.fn();
    const user = userEvent.setup();
    renderDock({ sessionRailsDisabled: true, workbenchDisabled: true, onOpenSearch, inbox: { pendingCount: 1, open: false, onToggle } });
    await user.click(screen.getByTestId('dock-search'));
    await user.click(screen.getByTestId('dock-inbox'));
    await user.click(screen.getByTestId('dock-settings'));
    expect(onOpenSearch).toHaveBeenCalledTimes(1);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('routes Settings through the rail toggle like before', async () => {
    const onToggleRail = vi.fn();
    renderDock({ onToggleRail });
    await userEvent.setup().click(screen.getByTestId('dock-settings'));
    expect(onToggleRail).toHaveBeenCalledWith('settings');
  });

  it('the Topbar no longer carries the global entries', () => {
    renderTopbar();
    expect(screen.queryByTestId('topbar-search')).toBeNull();
    expect(screen.queryByTestId('topbar-inbox')).toBeNull();
    expect(screen.getByTestId('topbar-toggle-p3')).toBeTruthy();
  });
});
