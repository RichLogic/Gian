import assert from 'node:assert/strict';
import test from 'node:test';
import {
  desktopRequestBoundaryUrls,
  DEV_HOST_URL,
  DEV_WEB_URL,
  isSafeExternalUrl,
  isTrustedDesktopUrl,
  PROD_HOST_URL,
  resolveDesktopApplicationIdentity,
  resolveDesktopDisplayName,
  resolveDesktopTargets,
  resolveDesktopWindowChrome,
} from '../src/config.js';

test('desktop request boundary covers HTTP and WebSocket traffic', () => {
  assert.deepEqual(desktopRequestBoundaryUrls('http://127.0.0.1:8990'), [
    'http://127.0.0.1:8990/*',
    'ws://127.0.0.1:8990/*',
  ]);
  assert.deepEqual(desktopRequestBoundaryUrls('https://gian.example'), [
    'https://gian.example/*',
    'wss://gian.example/*',
  ]);
});

test('development shell uses a distinct application identity and profile', () => {
  assert.deepEqual(resolveDesktopApplicationIdentity(false, '/tmp/app-data'), {
    name: 'GianDev',
    userDataPath: '/tmp/app-data/GianDev',
    variant: 'development',
  });
  assert.deepEqual(resolveDesktopApplicationIdentity(true, '/tmp/app-data'), {
    name: 'Gian',
    userDataPath: null,
    variant: 'production',
  });
});

test('desktop smoke can override the profile for either application variant', () => {
  const env = { GIAN_DESKTOP_USER_DATA_DIR: '/tmp/gian-smoke-profile' };
  assert.equal(
    resolveDesktopApplicationIdentity(false, '/tmp/app-data', env).userDataPath,
    '/tmp/gian-smoke-profile',
  );
  assert.equal(
    resolveDesktopApplicationIdentity(true, '/tmp/app-data', env).userDataPath,
    '/tmp/gian-smoke-profile',
  );
});

test('development launcher can label the window with its current worktree', () => {
  const identity = resolveDesktopApplicationIdentity(false, '/tmp/app-data');
  assert.equal(resolveDesktopDisplayName(identity), 'GianDev');
  assert.equal(
    resolveDesktopDisplayName(identity, { GIAN_DESKTOP_LABEL: ' GianDev · gian-0.3.0 ' }),
    'GianDev · gian-0.3.0',
  );
});

test('development targets use the isolated GianDev ports', () => {
  assert.deepEqual(
    resolveDesktopTargets({ isPackaged: false, platform: 'darwin', env: {} }),
    {
      hostUrl: DEV_HOST_URL,
      healthUrl: `${DEV_HOST_URL}/health`,
      webUrl: DEV_WEB_URL,
      manageHost: false,
    },
  );
});

test('packaged macOS target uses the production core and may manage its host', () => {
  assert.deepEqual(
    resolveDesktopTargets({ isPackaged: true, platform: 'darwin', env: {} }),
    {
      hostUrl: PROD_HOST_URL,
      healthUrl: `${PROD_HOST_URL}/health`,
      webUrl: PROD_HOST_URL,
      manageHost: true,
    },
  );
});

test('custom targets disable production launchd management', () => {
  const targets = resolveDesktopTargets({
    isPackaged: true,
    platform: 'darwin',
    env: {
      GIAN_DESKTOP_HOST_URL: 'http://localhost:9100',
      GIAN_DESKTOP_WEB_URL: 'http://localhost:5100',
    },
  });
  assert.equal(targets.hostUrl, 'http://localhost:9100');
  assert.equal(targets.webUrl, 'http://localhost:5100');
  assert.equal(targets.manageHost, false);
});

test('packaged smoke may manage a custom loopback Host without using 8990', () => {
  const targets = resolveDesktopTargets({
    isPackaged: true,
    platform: 'darwin',
    env: {
      GIAN_DESKTOP_HOST_URL: 'http://127.0.0.1:49123',
      GIAN_DESKTOP_SMOKE_MANAGE_HOST: '1',
    },
  });
  assert.equal(targets.hostUrl, 'http://127.0.0.1:49123');
  assert.equal(targets.webUrl, 'http://127.0.0.1:49123');
  assert.equal(targets.manageHost, true);

  assert.equal(resolveDesktopTargets({
    isPackaged: true,
    platform: 'darwin',
    env: {
      GIAN_DESKTOP_HOST_URL: 'https://example.com',
      GIAN_DESKTOP_SMOKE_MANAGE_HOST: '1',
    },
  }).manageHost, false);
});

test('desktop targets must be plain HTTP origins', () => {
  assert.throws(
    () =>
      resolveDesktopTargets({
        isPackaged: false,
        platform: 'darwin',
        env: { GIAN_DESKTOP_WEB_URL: 'file:///tmp/gian.html' },
      }),
    /must use http or https/,
  );
  assert.throws(
    () =>
      resolveDesktopTargets({
        isPackaged: false,
        platform: 'darwin',
        env: { GIAN_DESKTOP_WEB_URL: 'http://127.0.0.1:5191/path' },
      }),
    /must be an origin/,
  );
});

test('navigation allowlist is limited to the configured Gian origins', () => {
  const targets = { hostUrl: DEV_HOST_URL, webUrl: DEV_WEB_URL };
  assert.equal(isTrustedDesktopUrl(`${DEV_WEB_URL}/tasks`, targets), true);
  assert.equal(isTrustedDesktopUrl(`${DEV_HOST_URL}/api/sessions`, targets), true);
  assert.equal(isTrustedDesktopUrl('https://example.com', targets), false);
  assert.equal(isTrustedDesktopUrl('file:///tmp/unsafe.html', targets), false);
});

test('only browser-safe external protocols can leave the desktop shell', () => {
  assert.equal(isSafeExternalUrl('https://example.com'), true);
  assert.equal(isSafeExternalUrl('mailto:hello@example.com'), true);
  assert.equal(isSafeExternalUrl('file:///etc/passwd'), false);
  assert.equal(isSafeExternalUrl('javascript:alert(1)'), false);
});

test('macOS uses full-height content with inset native traffic lights', () => {
  assert.deepEqual(resolveDesktopWindowChrome('darwin'), {
    titleBarStyle: 'hiddenInset',
    titleBarOverlay: true,
    trafficLightPosition: { x: 15, y: 15 },
  });
  assert.deepEqual(resolveDesktopWindowChrome('win32'), {});
});
