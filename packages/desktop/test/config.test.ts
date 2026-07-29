import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEV_HOST_URL,
  DEV_WEB_URL,
  isSafeExternalUrl,
  isTrustedDesktopUrl,
  PROD_HOST_URL,
  resolveDesktopTargets,
  resolveDesktopWindowChrome,
} from '../src/config.js';

test('development targets use the isolated GianDev ports', () => {
  assert.deepEqual(
    resolveDesktopTargets({ isPackaged: false, platform: 'darwin', env: {} }),
    {
      hostUrl: DEV_HOST_URL,
      healthUrl: `${DEV_HOST_URL}/health`,
      webUrl: DEV_WEB_URL,
      manageLaunchAgent: false,
    },
  );
});

test('packaged macOS target uses the production daemon and may manage launchd', () => {
  assert.deepEqual(
    resolveDesktopTargets({ isPackaged: true, platform: 'darwin', env: {} }),
    {
      hostUrl: PROD_HOST_URL,
      healthUrl: `${PROD_HOST_URL}/health`,
      webUrl: PROD_HOST_URL,
      manageLaunchAgent: true,
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
  assert.equal(targets.manageLaunchAgent, false);
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
  });
  assert.deepEqual(resolveDesktopWindowChrome('win32'), {});
});
