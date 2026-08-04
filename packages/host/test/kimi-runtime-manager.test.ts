import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliRuntimeManager } from '../src/runtime/manager.js';
import { KimiRuntimeProvider } from '../src/runtime/kimi-provider.js';
import type { CliRuntimeProvider } from '../src/runtime/types.js';

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
    ]);
    const lease = await manager.acquire('kimi');
    assert.equal(lease.binaryPath, realpathSync(binary));
    assert.equal(lease.version, '0.29.2');
    assert.equal(lease.env.KIMI_CODE_NO_AUTO_UPDATE, '1');
    lease.release();
    assert.equal(manager.invalidate('kimi'), true);
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
    ]);
    await assert.rejects(
      manager.acquire('kimi'),
      /missing-kimi/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('concurrent runtime acquires share one resolution and probe', async () => {
  let inspectCalls = 0;
  let probeCalls = 0;
  let allowProbe!: () => void;
  const probeGate = new Promise<void>(resolve => {
    allowProbe = resolve;
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
      await probeGate;
      return { ...runtime, version: '0.29.2' };
    },
    managedEnv() {
      return { KIMI_CODE_NO_AUTO_UPDATE: '1' };
    },
  };
  const manager = new CliRuntimeManager([provider]);

  const firstPending = manager.acquire('kimi');
  const secondPending = manager.acquire('kimi');
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(inspectCalls, 1);
  assert.equal(probeCalls, 1);

  allowProbe();
  const [first, second] = await Promise.all([firstPending, secondPending]);
  assert.equal(first.binaryPath, second.binaryPath);
  first.release();
  assert.equal(manager.invalidate('kimi'), false, 'second lease is still active');
  second.release();
  assert.equal(manager.invalidate('kimi'), true);
});
