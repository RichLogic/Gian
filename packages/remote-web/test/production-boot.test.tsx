import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { App } from '../src/app.js';
import { createProductionController, resolveRemoteWebBoot } from '../src/controller/create.js';
import { MemoryEncryptedHostCache } from '../src/cache/encrypted-cache.js';
import { MemoryBrowserIdentityStore } from '../src/transport/identity.js';
import { ControllerProvider } from '../src/ui/controller-context.js';
import { LocaleProvider } from '../src/i18n/index.js';
import { ViewportProvider } from '../src/ui/viewport.js';

describe('production boot wiring', () => {
  it('resolves missing fixture query to production', () => {
    expect(resolveRemoteWebBoot('')).toBe('production');
    expect(resolveRemoteWebBoot('?lang=en')).toBe('production');
    expect(resolveRemoteWebBoot('?fixture=online')).toEqual({ fixture: 'online' });
  });

  it('production controller exposes pairing without GitHub and links separate Host registration', () => {
    const controller = createProductionController({
      baseUrl: 'https://remote.test',
      publicOrigin: 'https://remote.test',
      identity: new MemoryBrowserIdentityStore(),
      cache: new MemoryEncryptedHostCache(),
      autoRestore: false,
      fetchFn: async () => new Response(JSON.stringify({
        protocol: 'gian.remote.auth/1',
        error: { code: 'AUTH_REQUIRED' },
      }), { status: 401 }),
    });
    render(
      <LocaleProvider locale="zh-CN">
        <ViewportProvider>
          <ControllerProvider controller={controller}>
            <App />
          </ControllerProvider>
        </ViewportProvider>
      </LocaleProvider>,
    );
    expect(screen.queryByText('Transport not wired')).toBeNull();
    expect(controller.state.auth.kind).toBe('pairing');
    expect(screen.getByRole('textbox', { name: '配对短码' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '使用 GitHub 登录' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Host 注册' })).toHaveAttribute('href', '/enrollment');
    controller.close();
  });
});
