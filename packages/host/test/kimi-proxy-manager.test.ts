import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RuntimeLease } from '../src/runtime/types.js';
import { ProxyManager } from '../src/proxy/manager.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, 'fixtures', 'fake-kimi-proxy.mjs');

test('failed Kimi attach recycles an unused ACP host for login retry', async () => {
  let acquireCalls = 0;
  let releaseCalls = 0;
  const runtimeManager = {
    async acquire(): Promise<RuntimeLease> {
      acquireCalls += 1;
      return {
        cli: 'kimi',
        binaryPath: '/managed/kimi',
        version: '0.29.2',
        source: 'managed',
        env: {},
        release() {
          releaseCalls += 1;
        },
      };
    },
  };
  const manager = new ProxyManager({
    dataDir: '/tmp/gian-kimi-proxy-manager-test',
    ccProxyEntry: '/unused/cc-proxy.js',
    kimiProxyEntry: fixture,
    runtimeManager: runtimeManager as never,
  });

  try {
    const originalDiscovery = await manager.getOrCreate('__native_sessions_kimi__', 'kimi');
    await originalDiscovery.initialize();
    await originalDiscovery.listNativeSessions?.({ cwd: '/tmp' });

    const failed = await manager.getOrCreate('failed-session', 'kimi');
    await failed.initialize();
    await assert.rejects(
      failed.createSession({ cwd: '/auth-required' }),
      /login in a terminal/,
    );
    await manager.dispose('failed-session');
    assert.equal(releaseCalls, 1);

    const refreshedDiscovery = await manager.getOrCreate('__native_sessions_kimi__', 'kimi');
    assert.notEqual(refreshedDiscovery, originalDiscovery);
    await refreshedDiscovery.listNativeSessions?.({ cwd: '/tmp' });

    const retry = await manager.getOrCreate('retry-session', 'kimi');
    const created = await retry.createSession({ cwd: '/tmp' });
    assert.match(created.nativeSessionId, /^kimi_native_/);
    assert.equal(acquireCalls, 2, 'retry must acquire a fresh runtime/ACP process');
  } finally {
    await manager.closeAll();
  }
});

test('concurrent Kimi sessions initialize through one shared ACP host', async () => {
  let acquireCalls = 0;
  let releaseCalls = 0;
  const runtimeManager = {
    async acquire(): Promise<RuntimeLease> {
      acquireCalls += 1;
      await new Promise<void>(resolve => setImmediate(resolve));
      return {
        cli: 'kimi',
        binaryPath: '/managed/kimi',
        version: '0.29.2',
        source: 'managed',
        env: {},
        release() {
          releaseCalls += 1;
        },
      };
    },
  };
  const manager = new ProxyManager({
    dataDir: '/tmp/gian-kimi-proxy-manager-concurrency-test',
    ccProxyEntry: '/unused/cc-proxy.js',
    kimiProxyEntry: fixture,
    runtimeManager: runtimeManager as never,
  });

  try {
    const [first, second] = await Promise.all([
      manager.getOrCreate('first-session', 'kimi'),
      manager.getOrCreate('second-session', 'kimi'),
    ]);
    assert.equal(acquireCalls, 1);

    await Promise.all([first.initialize(), second.initialize()]);
    const [firstCreated, secondCreated] = await Promise.all([
      first.createSession({ cwd: '/tmp/first' }),
      second.createSession({ cwd: '/tmp/second' }),
    ]);
    assert.notEqual(firstCreated.nativeSessionId, secondCreated.nativeSessionId);
  } finally {
    await manager.closeAll();
  }
  assert.equal(releaseCalls, 1);
});
