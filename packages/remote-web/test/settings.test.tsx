import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from './render-app.js';

describe('remote settings (B9)', () => {
  it('theme + accent controls apply to the document', async () => {
    const user = userEvent.setup();
    renderApp({ scenario: { view: { kind: 'settings' } }, viewport: 'wide' });
    expect(document.body.dataset.theme).toBe('light');
    await user.click(screen.getByRole('radio', { name: 'dark' }));
    expect(document.body.dataset.theme).toBe('dark');
    await user.click(screen.getByRole('button', { name: 'rose' }));
    expect(document.body.dataset.accent).toBe('rose');
  });

  it('lists host pairings; current host is badged', () => {
    renderApp({ scenario: { view: { kind: 'settings' } }, viewport: 'wide' });
    expect(screen.getAllByText('MacBook Pro · 家里').length).toBeGreaterThan(0);
    expect(screen.getByText('当前')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: '断开此 Host' })).toHaveLength(3);
  });

  it('disconnect requires a second confirmation and removes the host', async () => {
    const user = userEvent.setup();
    const { controller } = renderApp({ scenario: { view: { kind: 'settings' } }, viewport: 'wide' });
    const row = document.querySelector('[data-host-id="host-lab"]')! as HTMLElement;
    await user.click(within(row).getByRole('button', { name: '断开此 Host' }));
    // first click only asks
    expect(controller.state.hosts.find((h) => h.id === 'host-lab')).toBeTruthy();
    expect(screen.getByText(/断开 旧 ThinkPad · 实验室？/)).toBeInTheDocument();
    await user.click(within(row).getByRole('button', { name: '断开此 Host' }));
    expect(controller.state.hosts.find((h) => h.id === 'host-lab')).toBeUndefined();
  });

  it('disconnecting the current host switches to another online host', async () => {
    const user = userEvent.setup();
    const { controller } = renderApp({ scenario: { view: { kind: 'settings' } }, viewport: 'wide' });
    const row = document.querySelector('[data-host-id="host-home"]')! as HTMLElement;
    await user.click(within(row).getByRole('button', { name: '断开此 Host' }));
    await user.click(within(row).getByRole('button', { name: '断开此 Host' }));
    expect(controller.state.currentHostId).toBe('host-work');
  });

  it('logout stays in the shell and re-authenticates from the Host selector', async () => {
    const user = userEvent.setup();
    const { controller } = renderApp({
      scenario: { view: { kind: 'settings' }, snapshotReceivedAt: Date.now() },
      viewport: 'wide',
    });
    await user.click(screen.getByRole('button', { name: '退出此浏览器' }));
    expect(controller.state.auth.kind).toBe('authenticated');
    await user.click(screen.getAllByRole('button', { name: '退出此浏览器' })[0]!);
    expect(controller.state.auth.kind).toBe('challenge-login');
    expect(screen.queryByText('重新登录此浏览器')).toBeNull();
    expect(screen.queryByRole('status', { name: '正在连接 Gian' })).toBeNull();
    expect(document.querySelector('.rw-app')).not.toBeNull();
    // Pairings remain intact; re-entry lives in the existing Host selector.
    expect(controller.state.auth.kind === 'challenge-login' && controller.state.auth.hosts.length).toBe(3);
    await user.click(screen.getByRole('button', { name: '切换 Host' }));
    await user.click(screen.getByRole('menuitemradio', { name: /MacBook Pro · 家里/ }));
    expect(controller.state.auth.kind).toBe('authenticated');
  });

  it('no account section, no other-device management', () => {
    renderApp({ scenario: { view: { kind: 'settings' } }, viewport: 'wide' });
    expect(screen.queryByText(/GitHub|账户|Account/i)).toBeNull();
    expect(screen.queryByText(/其他设备|Devices/i)).toBeNull();
  });

  it('narrow layout renders settings as a full-screen page', () => {
    renderApp({ scenario: { view: { kind: 'settings' }, mobilePage: 'settings' }, viewport: 'narrow' });
    expect(document.querySelector('.rw-page[data-page="settings"]')).not.toBeNull();
  });
});
