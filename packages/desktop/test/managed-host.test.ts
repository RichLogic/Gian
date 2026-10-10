import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import {
  buildManagedHostEnv,
  resolveManagedHostPaths,
  resolveUnpackedAppPath,
  shouldProvisionPackagedDevRuntimes,
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
      dshBridgePackageDir: '/Applications/Gian.app/Contents/Resources/dsh-bridge',
      dataDir: '/Users/test/.config/gian',
      logFile: join('/Users/test/.config/gian', 'logs', 'desktop-host.log'),
    },
  );
});

test('managed host environment configures the bundled Node runtime boundary', () => {
  const paths = {
    hostEntry: '/app/host.js',
    webDist: '/app/web',
    dshBridgePackageDir: '/app/dsh-bridge',
    dataDir: '/data/gian',
    logFile: '/data/gian/logs/desktop-host.log',
  };
  const env = buildManagedHostEnv({
    paths,
    host: '127.0.0.1',
    port: 8990,
    desktopToken: 'secret',
    instanceId: 'instance-1',
    githubBrokerSocket: '/tmp/gian-github.sock',
    remoteBrokerSocket: '/tmp/gian-remote.sock',
    browserBrokerSocket: '/tmp/gian-browser.sock',
    env: { PATH: '/usr/bin' },
  });

  assert.deepEqual(env, {
    PATH: '/usr/bin',
    GIAN_DATA_DIR: '/data/gian',
    GIAN_HOST: '127.0.0.1',
    GIAN_PORT: '8990',
    GIAN_WEB_DIST: '/app/web',
    GIAN_DSH_BRIDGE_PACKAGE_DIR: '/app/dsh-bridge',
    GIAN_DESKTOP_TOKEN: 'secret',
    GIAN_DESKTOP_INSTANCE_ID: 'instance-1',
    GIAN_DESKTOP_GITHUB_BROKER_SOCKET: '/tmp/gian-github.sock',
    GIAN_DESKTOP_REMOTE_BROKER_SOCKET: '/tmp/gian-remote.sock',
    GIAN_DESKTOP_BROWSER_BROKER_SOCKET: '/tmp/gian-browser.sock',
    GIAN_PARENT_MANAGED: '1',
    GIAN_MANAGED_PLUGINS: '1',
  });
});

test('packaged Dev selects its bundled source Proxies while production strips inherited Dev controls', () => {
  const paths = resolveManagedHostPaths({ hostEntry: '/app/host.js', resourcesPath: '/app/resources',
    dataDir: '/home/user/.gian-dev', sourceFirstDev: true });
  const input = { paths, host: '127.0.0.1', port: 8991, desktopToken: 'test-only', instanceId: 'dev',
    githubBrokerSocket: '/tmp/github.sock', remoteBrokerSocket: '/tmp/remote.sock',
    browserBrokerSocket: '/tmp/browser.sock',
    env: { PATH: '/usr/bin', GIAN_PROVISION_DEV_RUNTIMES: '1', GIAN_DEV_PROXY_PACKAGES_DIR: '/wrong' } };
  const dev = buildManagedHostEnv({ ...input, sourceFirstDev: true });
  assert.equal(dev.GIAN_MANAGED_PLUGINS, '0');
  assert.equal(dev.GIAN_DEV_PROXY_PACKAGES_DIR, '/app/resources/giandev/proxies');
  assert.equal(dev.GIAN_DEV_RUNTIME_ASSETS_DIR, '/app/resources/giandev/runtime-assets');
  assert.equal(dev.GIAN_PROVISION_DEV_RUNTIMES, '1');
  const prod = buildManagedHostEnv(input);
  assert.equal(prod.GIAN_MANAGED_PLUGINS, '1');
  assert.equal(prod.GIAN_DEV_PROXY_PACKAGES_DIR, undefined);
  assert.equal(prod.GIAN_PROVISION_DEV_RUNTIMES, undefined);
});

test('packaged GianDev provisions runtimes only for the Dev data directory', () => {
  const devDataDir = '/Users/richlogic/.gian-dev';
  assert.equal(shouldProvisionPackagedDevRuntimes({
    devArtifact: true,
    productionDataSelected: false,
    smoke: false,
    dataDir: devDataDir,
    devDataDir,
  }), true);
  assert.equal(shouldProvisionPackagedDevRuntimes({
    devArtifact: true,
    productionDataSelected: true,
    smoke: false,
    dataDir: '/Users/richlogic/.gian',
    devDataDir,
  }), false);
  assert.equal(shouldProvisionPackagedDevRuntimes({
    devArtifact: true,
    productionDataSelected: false,
    smoke: true,
    dataDir: devDataDir,
    devDataDir,
  }), false);
  assert.equal(shouldProvisionPackagedDevRuntimes({ devArtifact: true, productionDataSelected: false,
    smoke: true, dataDir: '/tmp/dev-smoke/data', devDataDir }), true);
});

test('bundled host entry resolves to the unpacked dependency tree for Node', () => {
  assert.equal(
    resolveUnpackedAppPath('/Applications/Gian.app/Contents/Resources/app.asar/node_modules/@gian/host/dist/index.js'),
    '/Applications/Gian.app/Contents/Resources/app.asar.unpacked/node_modules/@gian/host/dist/index.js',
  );
  assert.equal(resolveUnpackedAppPath('/workspace/packages/host/dist/index.js'), '/workspace/packages/host/dist/index.js');
});
