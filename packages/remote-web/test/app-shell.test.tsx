import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from './render-app.js';

describe('app shell (B2)', () => {
  it('breadcrumb shows Task › Session only; the Host never repeats in it', () => {
    renderApp({ scenario: {}, viewport: 'wide' });
    const topbar = document.querySelector('.topbar')!;
    const path = within(topbar as HTMLElement).getByText('pre-push hook 接入 verify:quick');
    expect(path).toBeInTheDocument();
    expect(within(topbar as HTMLElement).getByText('Gian 0.5.4 发布')).toBeInTheDocument();
    // Host name appears only in the Host selector button, not the breadcrumb.
    const pathEl = topbar.querySelector('.path')!;
    expect(within(pathEl as HTMLElement).queryByText(/MacBook Pro/)).toBeNull();
    expect(within(topbar as HTMLElement).getByRole('button', { name: '切换 Host' })).toBeInTheDocument();
  });

  it('has no right-side icon dock', () => {
    renderApp({ scenario: {}, viewport: 'wide' });
    expect(document.querySelector('.dock, .icon-dock, .nav-dock')).toBeNull();
  });

  it('host selector carries a textual state, not just a colored dot', () => {
    renderApp({ scenario: {}, viewport: 'wide' });
    const selector = screen.getByRole('button', { name: '切换 Host' });
    expect(selector.textContent).toContain('已连接');
  });

  it('switching Host swaps sessions/tasks (state partitioned per Host)', async () => {
    const user = userEvent.setup();
    const { controller } = renderApp({ scenario: {}, viewport: 'wide' });
    await user.click(screen.getByRole('button', { name: '切换 Host' }));
    await user.click(screen.getByRole('menuitemradio', { name: /iMac · 公司/ }));
    expect(controller.state.currentHostId).toBe('host-work');
    // host-work fixtures have no sessions — home sessions must not leak over.
    expect(screen.queryAllByText('pre-push hook 接入 verify:quick')).toHaveLength(0);
    // switching back restores them
    await user.click(screen.getByRole('button', { name: '切换 Host' }));
    await user.click(screen.getByRole('menuitemradio', { name: /MacBook Pro/ }));
    expect(controller.state.currentHostId).toBe('host-home');
    expect(screen.getAllByText('pre-push hook 接入 verify:quick').length).toBeGreaterThan(0);
  });

  it('offline Host rows are marked with text in the selector', async () => {
    const user = userEvent.setup();
    renderApp({ scenario: {}, viewport: 'wide' });
    await user.click(screen.getByRole('button', { name: '切换 Host' }));
    const row = screen.getByRole('menuitemradio', { name: /旧 ThinkPad/ });
    expect(row.textContent).toContain('离线');
  });
});
