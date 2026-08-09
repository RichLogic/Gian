import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliRuntimeManager } from '../src/runtime/manager.js';
import { KimiRuntimeProvider } from '../src/runtime/kimi-provider.js';
import type { CliRuntimeProvider } from '../src/runtime/types.js';
import { acquireAgentUpdateLock } from '../src/agents/update-lock.js';

function fakeKimi(dir: string, version = '0.29.2'): string {
  const path = join(dir, 'kimi');
  writeFileSync(path, `#!/bin/sh\nprintf '${version}\\n'\n`);
  chmodSync(path, 0o755);
  return path;
}

test('Kimi provider resolves and probes an explicit absolute binary', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gian-kimi-runtime-'));
  try {
    const binary = fakeKimi(dir);
    const manager = new CliRuntimeManager([
      new KimiRuntimeProvider({
        dataDir: dir,
        overridePath: binary,
        pathEnv: '',
      }),
    ], dir);
    const lease = await manager.acquire('kimi');
    assert.equal(lease.binaryPath, realpathSync(binary));
    assert.equal(lease.version, '0.29.2');
    assert.equal(lease.env.KIMI_CODE_NO_AUTO_UPDATE, '1');
    await lease.release();
    assert.equal(manager.invalidate('kimi'), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Kimi provider registers and clears its real --version process group', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gian-kimi-protected-probe-'));
  try {
    const binary = fakeKimi(dir);
    const provider = new KimiRuntimeProvider({
      dataDir: dir,
      overridePath: binary,
      pathEnv: '',
    });
    const [runtime] = await provider.inspectInstalled();
    const events: string[] = [];
    const protector = {
      async reserveProcessGroup() {
        events.push('reserve');
        return {
          async register(groupId: number) {
            assert.ok(groupId > 0);
            events.push('register');
            return 'registered' as const;
          },
          async cancelBeforeSpawn() { events.push('cancel'); },
          async releaseUnregistered() { events.push('release-unregistered'); },
          async release() { events.push('release'); },
        };
      },
    };
    const probe = await provider.probe(runtime!, protector);
    assert.equal(probe.version, '0.29.2');
    assert.deepEqual(events, ['reserve', 'register', 'release']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an invalid explicit override never falls through to another kimi', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gian-kimi-runtime-'));
  try {
    fakeKimi(dir);
    const manager = new CliRuntimeManager([
      new KimiRuntimeProvider({
        dataDir: dir,
        overridePath: join(dir, 'missing-kimi'),
        pathEnv: dir,
      }),
    ], dir);
    await assert.rejects(
      manager.acquire('kimi'),
      /missing-kimi/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('concurrent runtime acquires share one resolution and probe', async t => {
  const lockDir = mkdtempSync(join(tmpdir(), 'gian-kimi-runtime-lock-'));
  t.after(() => rmSync(lockDir, { recursive: true, force: true }));
  let inspectCalls = 0;
  let probeCalls = 0;
  let allowProbe!: () => void;
  const probeGate = new Promise<void>(resolve => {
    allowProbe = resolve;
  });
  let markProbeStarted!: () => void;
  const probeStarted = new Promise<void>(resolve => {
    markProbeStarted = resolve;
  });
  const provider: CliRuntimeProvider = {
    id: 'kimi',
    async inspectInstalled() {
      inspectCalls += 1;
      return [{
        cli: 'kimi',
        binaryPath: '/managed/kimi',
        source: 'managed',
      }];
    },
    async probe(runtime) {
      probeCalls += 1;
      markProbeStarted();
      await probeGate;
      return { ...runtime, version: '0.29.2' };
    },
    managedEnv() {
      return { KIMI_CODE_NO_AUTO_UPDATE: '1' };
    },
  };
  const manager = new CliRuntimeManager([provider], lockDir);

  const firstPending = manager.acquire('kimi');
  const secondPending = manager.acquire('kimi');
  await probeStarted;
  assert.equal(inspectCalls, 1);
  assert.equal(probeCalls, 1);

  allowProbe();
  const [first, second] = await Promise.all([firstPending, secondPending]);
  assert.equal(first.binaryPath, second.binaryPath);
  await first.release();
  assert.equal(manager.invalidate('kimi'), false, 'second lease is still active');
  await second.release();
  assert.equal(manager.invalidate('kimi'), true);
});

test('invalidation sends new acquires to a fresh generation while old leases drain', async t => {
  const lockDir = mkdtempSync(join(tmpdir(), 'gian-kimi-runtime-lock-'));
  t.after(() => rmSync(lockDir, { recursive: true, force: true }));
  let inspectCalls = 0;
  const provider: CliRuntimeProvider = {
    id: 'kimi',
    async inspectInstalled() {
      inspectCalls += 1;
      return [{
        cli: 'kimi',
        binaryPath: `/managed/kimi-${inspectCalls}`,
        source: 'managed',
      }];
    },
    async probe(runtime) {
      return { ...runtime, version: `0.29.${inspectCalls}` };
    },
    managedEnv() {
      return { KIMI_CODE_NO_AUTO_UPDATE: '1' };
    },
  };
  const manager = new CliRuntimeManager([provider], lockDir);

  const oldRuntime = await manager.acquire('kimi');
  assert.equal(oldRuntime.binaryPath, '/managed/kimi-1');
  assert.equal(manager.invalidate('kimi'), false, 'the active lease defers invalidation');

  const refreshedRuntime = await manager.acquire('kimi');
  assert.equal(refreshedRuntime.binaryPath, '/managed/kimi-2');
  assert.equal(inspectCalls, 2, 'later acquires do not prolong the retired runtime generation');
  await oldRuntime.release();
  await refreshedRuntime.release();
});

test('an idle runtime is discarded and the next acquire probes the path again', async t => {
  const lockDir = mkdtempSync(join(tmpdir(), 'gian-kimi-runtime-lock-'));
  t.after(() => rmSync(lockDir, { recursive: true, force: true }));
  let version = 1;
  let inspectCalls = 0;
  let probeCalls = 0;
  const provider: CliRuntimeProvider = {
    id: 'kimi',
    async inspectInstalled() {
      inspectCalls += 1;
      return [{ cli: 'kimi', binaryPath: '/managed/kimi', source: 'managed' }];
    },
    async probe(runtime) {
      probeCalls += 1;
      return { ...runtime, version: `0.29.${version}` };
    },
    managedEnv() {
      return { KIMI_CODE_NO_AUTO_UPDATE: '1' };
    },
  };
  const manager = new CliRuntimeManager([provider], lockDir);

  const first = await manager.acquire('kimi');
  assert.equal(first.version, '0.29.1');
  await first.release();
  assert.equal(manager.invalidate('kimi'), true, 'a fully released runtime activates immediately');
  version = 2;
  const second = await manager.acquire('kimi');
  assert.equal(second.version, '0.29.2');
  assert.equal(inspectCalls, 2);
  assert.equal(probeCalls, 2);
  await second.release();
});

test('invalidate during resolution never leases the stale generation', async t => {
  const lockDir = mkdtempSync(join(tmpdir(), 'gian-kimi-runtime-lock-'));
  t.after(() => rmSync(lockDir, { recursive: true, force: true }));
  let inspectCalls = 0;
  let firstProbeStarted!: () => void;
  const probeStarted = new Promise<void>(resolve => { firstProbeStarted = resolve; });
  let finishFirstProbe!: () => void;
  const firstProbeGate = new Promise<void>(resolve => { finishFirstProbe = resolve; });
  const provider: CliRuntimeProvider = {
    id: 'kimi',
    async inspectInstalled() {
      inspectCalls += 1;
      return [{
        cli: 'kimi',
        binaryPath: `/managed/kimi-${inspectCalls}`,
        source: 'managed',
      }];
    },
    async probe(runtime) {
      if (runtime.binaryPath.endsWith('-1')) {
        firstProbeStarted();
        await firstProbeGate;
      }
      return { ...runtime, version: runtime.binaryPath.endsWith('-1') ? '0.29.1' : '0.29.2' };
    },
    managedEnv() {
      return { KIMI_CODE_NO_AUTO_UPDATE: '1' };
    },
  };
  const manager = new CliRuntimeManager([provider], lockDir);

  const pending = manager.acquire('kimi');
  await probeStarted;
  assert.equal(manager.invalidate('kimi'), false, 'the old generation is still resolving');
  finishFirstProbe();
  const lease = await pending;
  assert.equal(lease.binaryPath, '/managed/kimi-2');
  assert.equal(lease.version, '0.29.2');
  assert.equal(inspectCalls, 2);
  await lease.release();
});

test('runtime resolution failure retires its shared updater claim', async t => {
  const lockDir = mkdtempSync(join(tmpdir(), 'gian-kimi-runtime-lock-'));
  t.after(() => rmSync(lockDir, { recursive: true, force: true }));
  const provider: CliRuntimeProvider = {
    id: 'kimi',
    async inspectInstalled() {
      return [{ cli: 'kimi', binaryPath: '/broken/kimi', source: 'managed' }];
    },
    async probe() {
      throw new Error('controlled probe failure');
    },
    managedEnv() {
      return {};
    },
  };
  const manager = new CliRuntimeManager([provider], lockDir);
  await assert.rejects(manager.acquire('kimi'), /controlled probe failure/);

  const updater = await acquireAgentUpdateLock(lockDir, 'kimi', 'post-failure updater');
  await updater.release();
});

test('runtime resolution rejects content that changes across its version probe', async t => {
  const lockDir = mkdtempSync(join(tmpdir(), 'gian-kimi-runtime-snapshot-race-'));
  t.after(() => rmSync(lockDir, { recursive: true, force: true }));
  let snapshotCalls = 0;
  const provider: CliRuntimeProvider = {
    id: 'kimi',
    async inspectInstalled() {
      return [{ cli: 'kimi', binaryPath: '/managed/kimi', source: 'managed' }];
    },
    async probe(runtime) {
      return { ...runtime, version: '0.29.2' };
    },
    async snapshot() {
      snapshotCalls += 1;
      return snapshotCalls === 1 ? 'before' : 'after';
    },
    managedEnv() { return {}; },
  };
  const manager = new CliRuntimeManager([provider], lockDir);

  await assert.rejects(manager.acquire('kimi'), /content changed while its version was being probed/);
  assert.equal(snapshotCalls, 2);
});
