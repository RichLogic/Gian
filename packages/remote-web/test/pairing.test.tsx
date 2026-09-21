import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderApp } from './render-app.js';
import type { PairingFailure } from '../src/controller/types.js';

describe('pairing / auth pages (B1)', () => {
  it('offers Add computer in the selector and returns to existing pairings on cancel', async () => {
    const user = userEvent.setup();
    const { controller } = renderApp({});
    const hosts = controller.state.hosts;
    await user.click(screen.getByRole('button', { name: '切换 Host' }));
    await user.click(screen.getByRole('menuitem', { name: '添加电脑' }));
    expect(screen.getByRole('textbox', { name: '配对短码' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(controller.state.hosts).toEqual(hosts);
    expect(screen.getByRole('button', { name: '切换 Host' })).toBeInTheDocument();
  });

  it('distinguishes computers with the same name and prompts for selection', async () => {
    const user = userEvent.setup();
    renderApp({ scenario: {
      currentHostId: null, snapshotReceivedAt: null,
      auth: { kind: 'challenge-login', hosts: [] },
      hosts: [
        { id: 'aaaaaaaa-1111', name: 'Gian Host', online: true, sessionCount: 0 },
        { id: 'bbbbbbbb-2222', name: 'Gian Host', online: true, sessionCount: 0 },
      ],
    } });
    expect(screen.getByText(/从上方菜单选择已配对的电脑/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '切换 Host' }));
    expect(screen.getByRole('menuitemradio', { name: /Gian Host · aaaaaaaa/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitemradio', { name: /Gian Host · bbbbbbbb/ })).toBeInTheDocument();
  });
  it('PC short-code page: 8 segmented boxes, security copy, no app shell', () => {
    renderApp({ scenario: { auth: { kind: 'pairing', pairing: { kind: 'enter-code', attemptsLeft: 5 } } } });
    expect(document.querySelector('.topbar')).toBeNull();
    expect(document.querySelectorAll('.rw-code-ch')).toHaveLength(8);
    expect(screen.getByText(/仍需在 Mac 上的 Gian 中确认/)).toBeInTheDocument();
    expect(screen.queryByText(/输入后即可访问/)).toBeNull();
  });

  it('submitting a malformed code fails with invalid; exhausting attempts locks', async () => {
    const user = userEvent.setup();
    const { controller, unmount } = renderApp({
      scenario: { auth: { kind: 'pairing', pairing: { kind: 'enter-code', attemptsLeft: 2 } } },
    });
    await user.type(screen.getByRole('textbox', { name: '配对短码' }), 'notvalid');
    await user.click(screen.getByRole('button', { name: '配对' }));
    expect(controller.state.auth).toMatchObject({ pairing: { kind: 'failed', reason: 'invalid' } });
    unmount();
    // Last remaining attempt → invalid code locks the flow.
    const second = renderApp({
      scenario: { auth: { kind: 'pairing', pairing: { kind: 'enter-code', attemptsLeft: 1 } } },
    });
    await user.type(screen.getByRole('textbox', { name: '配对短码' }), 'stillbad');
    await user.click(screen.getByRole('button', { name: '配对' }));
    expect(second.controller.state.auth).toMatchObject({ pairing: { kind: 'failed', reason: 'attempt-limit' } });
    expect(screen.getByRole('button', { name: '稍后再试' })).toBeDisabled();
  });

  it('valid code moves to waiting with cancel and a countdown', async () => {
    const user = userEvent.setup();
    const { controller } = renderApp({
      scenario: { auth: { kind: 'pairing', pairing: { kind: 'enter-code', attemptsLeft: 5 } } },
    });
    await user.type(screen.getByRole('textbox', { name: '配对短码' }), 'K7DM-F2Q9');
    await user.click(screen.getByRole('button', { name: '配对' }));
    expect(controller.state.auth).toMatchObject({ pairing: { kind: 'waiting' } });
    expect(screen.getByText(/等待 Gian 确认/)).toBeInTheDocument();
    expect(screen.getByText(/\d+:\d{2}/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(controller.state.auth).toMatchObject({ pairing: { kind: 'failed', reason: 'cancelled' } });
  });

  it('QR landing: host + editable device name, confirm then wait', async () => {
    const user = userEvent.setup();
    const { controller } = renderApp({
      scenario: {
        auth: { kind: 'pairing', pairing: { kind: 'qr-confirm', hostName: 'MacBook Pro · 家里', deviceName: 'iPhone 17 Pro' } },
      },
    });
    expect(screen.getByText('MacBook Pro · 家里')).toBeInTheDocument();
    const nameInput = screen.getByLabelText('这台设备的名称');
    await user.clear(nameInput);
    await user.type(nameInput, '我的手机');
    expect(controller.state.auth).toMatchObject({ pairing: { deviceName: '我的手机' } });
    await user.click(screen.getByRole('button', { name: '确认配对' }));
    expect(controller.state.auth).toMatchObject({ pairing: { kind: 'waiting', deviceName: '我的手机' } });
  });

  it.each([false, true])('QR invitation copies the full link without claiming; clipboard failure=%s', async fail => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText');
    if (fail) writeText.mockRejectedValueOnce(new Error('clipboard denied'));
    else writeText.mockResolvedValueOnce(undefined);
    const pairingUrl = 'https://remote.test/#nonce=unclaimed-invitation-nonce';
    const { controller } = renderApp({
      scenario: { auth: { kind: 'pairing', pairing: {
        kind: 'qr-confirm', hostName: 'Home Mac', deviceName: 'This browser', pairingUrl,
      } } },
    });
    try {
      const link = screen.getByRole('textbox', { name: '配对链接' });
      expect(link).toHaveValue(pairingUrl);
      expect(link).toHaveAttribute('readonly');
      await user.click(screen.getByRole('button', { name: '复制配对链接' }));
      expect(writeText).toHaveBeenCalledWith(pairingUrl);
      expect(await screen.findByText(fail ? '复制失败，请选中链接手动复制。' : '配对链接已复制。')).toBeInTheDocument();
      expect(controller.state.auth).toMatchObject({ pairing: { kind: 'qr-confirm' } });
      await user.click(screen.getByRole('button', { name: '确认配对' }));
      expect(screen.queryByRole('textbox', { name: '配对链接' })).toBeNull();
    } finally { writeText.mockRestore(); }
  });

  it.each<[PairingFailure, string, string]>([
    ['cancelled', '配对已取消', '重新发起'],
    ['expired', '短码已过期', '重新输入'],
    ['rejected', '配对被拒绝', '重新发起'],
    ['attempt-limit', '失败次数超限', '稍后再试'],
    ['already-claimed', '短码已被使用', '重新发起'],
    ['host-offline', 'Host 当前离线', '重试'],
  ])('failure terminal %s renders its own copy and action', async (reason, title, action) => {
    const user = userEvent.setup();
    const { controller, unmount } = renderApp({
      scenario: { auth: { kind: 'pairing', pairing: { kind: 'failed', reason } } },
    });
    expect(screen.getByText(title)).toBeInTheDocument();
    const button = screen.getByRole('button', { name: action });
    if (reason === 'attempt-limit') {
      expect(button).toBeDisabled();
    } else {
      await user.click(button);
      expect(controller.state.auth).toMatchObject({ pairing: { kind: 'enter-code' } });
    }
    unmount();
  });

  it('challenge login stays in the shell instead of showing a standalone Host chooser', async () => {
    const user = userEvent.setup();
    const { controller } = renderApp({
      scenario: { auth: { kind: 'challenge-login', hosts: [
        { id: 'host-home', name: 'MacBook Pro · 家里', online: true, sessionCount: 6 },
      ] }, connection: { kind: 'resyncing', synced: 0, total: 1 }, snapshotReceivedAt: null },
    });
    expect(screen.queryByText('重新登录此浏览器')).toBeNull();
    expect(document.querySelector('.rw-app')).not.toBeNull();
    expect(screen.getByRole('status', { name: '正在连接 Gian' }))
      .toHaveTextContent('正在恢复安全的 Remote 会话');
    expect(screen.getByRole('main')).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByText('把 verify:quick 挂到 pre-push hook 上')).toBeNull();
    await user.click(screen.getByRole('button', { name: '切换 Host' }));
    await user.click(screen.getByRole('menuitemradio', { name: /MacBook Pro · 家里/ }));
    expect(controller.state.auth.kind).toBe('authenticated');
  });
});
