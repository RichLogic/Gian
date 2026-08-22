import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Dock } from '../src/components/Dock.js';
import { GianMascot } from '../src/components/GianMascot.js';
import { Topbar } from '../src/components/Topbar.js';
import { LocaleProvider } from '../src/i18n/index.js';

function inEnglish(node: ReactNode) {
  return <LocaleProvider locale="en">{node}</LocaleProvider>;
}

describe('stable core UI visual contracts', () => {
  it('keeps the six supported Dock rails, their groups, and disabled states explicit', () => {
    const onToggleRail = vi.fn();
    const { container } = render(inEnglish(
      <Dock
        activeRail="settings"
        onToggleRail={onToggleRail}
        sessionRailsDisabled
        workbenchDisabled={false}
        wsState="open"
        wsAttempt={0}
        authed
        runner={null}
      />,
    ));

    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('.dock-btn'));
    expect(buttons.map(button => button.dataset.testid)).toEqual([
      'dock-files',
      'dock-diffs',
      'dock-history',
      'dock-terminal',
      'dock-workspaces',
      'dock-settings',
    ]);
    expect(buttons.map(button => button.dataset.dockGroup)).toEqual([
      'panel', 'panel', 'panel', 'wb', 'panel', 'wb',
    ]);
    expect(screen.getByTestId('dock-files')).toBeDisabled();
    expect(screen.getByTestId('dock-diffs')).toBeDisabled();
    expect(screen.getByTestId('dock-history')).toBeDisabled();
    expect(screen.getByTestId('dock-terminal')).toBeEnabled();
    expect(screen.getByTestId('dock-settings')).toHaveClass('active');
    expect(container.querySelectorAll('.dock-btn svg[stroke-width="1.5"]')).toHaveLength(6);
  });

  it('renders navigation and panel controls with independent availability and visible state', () => {
    const props = {
      pathSegments: [],
      sidebarCollapsed: false,
      onToggleSidebar: vi.fn(),
      p3Available: false,
      p3Visible: false,
      onToggleP3: vi.fn(),
      canGoBack: false,
      canGoForward: false,
      onGoBack: vi.fn(),
      onGoForward: vi.fn(),
    };
    const { container, rerender } = render(inEnglish(<Topbar {...props} />));

    expect(screen.getByTestId('topbar-back')).toBeDisabled();
    expect(screen.getByTestId('topbar-forward')).toBeDisabled();
    expect(screen.getByTestId('topbar-toggle-p3')).toBeDisabled();

    rerender(inEnglish(
      <Topbar
        {...props}
        canGoBack
        canGoForward
        p3Available
        p3Visible
      />,
    ));
    expect(screen.getByTestId('topbar-back')).toBeEnabled();
    expect(screen.getByTestId('topbar-forward')).toBeEnabled();
    expect(screen.getByTestId('topbar-toggle-p3')).toBeEnabled();
    // lucide panel-right-close glyph while p3 is open (left-pointing arrow);
    // panel-right-open (right-pointing) when collapsed.
    expect(screen.getByTestId('topbar-toggle-p3').querySelector('path[d*="M8 9l3 3-3 3"]')).not.toBeNull();
    rerender(inEnglish(<Topbar {...props} canGoBack canGoForward p3Available p3Visible={false} />));
    expect(screen.getByTestId('topbar-toggle-p3').querySelector('path[d*="M10 15l-3-3 3-3"]')).not.toBeNull();
    expect(container.querySelectorAll('.tb-toggle svg[stroke-width="1.5"]')).toHaveLength(4);
  });

  it('keeps the eye-free Dragon-G geometry stable between idle and working states', () => {
    const { container, rerender } = render(<GianMascot size={36} state="idle" title="Idle Gian" />);
    const idle = screen.getByRole('img', { name: 'Idle Gian' });
    expect(idle).toHaveAttribute('viewBox', '0 0 1254 1254');
    expect(idle).toHaveAttribute('width', '36');
    expect(idle.querySelectorAll('path')).toHaveLength(3);
    expect(idle.querySelector('circle, ellipse')).toBeNull();

    rerender(<GianMascot size={36} state="working" title="Working Gian" />);
    const working = screen.getByRole('img', { name: 'Working Gian' });
    expect(working).toHaveClass('working');
    expect(working.querySelectorAll('.g-body')).toHaveLength(1);
    expect(working.querySelectorAll('.g-whisker')).toHaveLength(2);
    expect(container.querySelector('circle, ellipse')).toBeNull();
  });
});
