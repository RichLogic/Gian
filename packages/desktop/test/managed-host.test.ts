import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import {
  buildManagedHostEnv,
  resolveManagedHostPaths,
  resolveUnpackedAppPath,
} from '../src/managed-host.js';

test('managed host paths keep mutable data outside the application bundle', () => {
  assert.deepEqual(
    resolveManagedHostPaths({
      hostEntry: '/Applications/Gian.app/Contents/Resources/app.asar/node_modules/@gian/host/dist/index.js',
      resourcesPath: '/Applications/Gian.app/Contents/Resources',
      dataDir: '/Users/test/.config/gian',
    }),
    {
      hostEntry: '/Applications/Gian.app/Contents/Resources/app.asar/node_modules/@gian/host/dist/index.js',
      webDist: '/Applications/Gian.app/Contents/Resources/web',
      dataDir: '/Users/test/.config/gian',
      logFile: join('/Users/test/.config/gian', 'logs', 'desktop-host.log'),
    },
  );
});

test('managed host environment configures the bundled Node runtime boundary', () => {
  const paths = {
    hostEntry: '/app/host.js',
    webDist: '/app/web',
    dataDir: '/data/gian',
    logFile: '/data/gian/logs/desktop-host.log',
  };
  const env = buildManagedHostEnv({
    paths,
    host: '127.0.0.1',
    port: 8990,
    desktopToken: 'secret',
    instanceId: 'instance-1',
    env: { PATH: '/usr/bin' },
  });

  assert.deepEqual(env, {
    PATH: '/usr/bin',
    GIAN_DATA_DIR: '/data/gian',
    GIAN_HOST: '127.0.0.1',
    GIAN_PORT: '8990',
    GIAN_WEB_DIST: '/app/web',
    GIAN_DESKTOP_TOKEN: 'secret',
    GIAN_DESKTOP_INSTANCE_ID: 'instance-1',
    GIAN_PARENT_MANAGED: '1',
    GIAN_MANAGED_PLUGINS: '1',
  });
});

test('bundled host entry resolves to the unpacked dependency tree for Node', () => {
  assert.equal(
    resolveUnpackedAppPath('/Applications/Gian.app/Contents/Resources/app.asar/node_modules/@gian/host/dist/index.js'),
    '/Applications/Gian.app/Contents/Resources/app.asar.unpacked/node_modules/@gian/host/dist/index.js',
  );
  assert.equal(resolveUnpackedAppPath('/workspace/packages/host/dist/index.js'), '/workspace/packages/host/dist/index.js');
});
