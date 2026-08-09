import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { AgentManager } from '../src/agents/manager.js';
import {
  compareKimiVersions,
  KimiDataVersionError,
  KimiSessionStoreGuard,
} from '../src/runtime/kimi-session-store.js';
import { CliRuntimeManager } from '../src/runtime/manager.js';
import type { CliRuntimeProvider } from '../src/runtime/types.js';

async function executable(path: string, version: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`);
  await chmod(path, 0o755);
}

async function populatedKimiHome(root: string): Promise<string> {
  const home = join(root, 'kimi-home');
  await mkdir(join(home, 'sessions', 'wd_fixture', 'session_fixture'), { recursive: true });
  await writeFile(
    join(home, 'session_index.jsonl'),
    '{"sessionId":"session_fixture","sessionDir":"fixture","workDir":"fixture"}\n',
  );
  return home;
}

function hasCode(code: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof Error);
    assert.equal((error as Error & { code?: string }).code, code);
    return true;
  };
}

test('Kimi version ordering follows SemVer precedence', () => {
  assert.equal(compareKimiVersions('0.31.1', '0.31.0'), 1);
  assert.equal(compareKimiVersions('0.31.1-beta.2', '0.31.1-beta.10'), -1);
  assert.equal(compareKimiVersions('0.31.1', '0.31.1-rc.1'), 1);
  assert.equal(compareKimiVersions('0.31.1+build.2', '0.31.1+build.1'), 0);
});

test('activation records a monotonic Kimi session-store floor and blocks downgrade', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-kimi-store-floor-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const guard = new KimiSessionStoreGuard(join(root, 'kimi-home'));

  await guard.assertCompatible('0.31.1');
  await guard.recordActivation('0.31.1');
  await assert.rejects(
    guard.assertCompatible('0.30.0'),
    hasCode('DATA_VERSION_INCOMPATIBLE'),
  );
  await guard.assertCompatible('0.32.0');
  await Promise.all([
    guard.recordActivation('0.31.1'),
    guard.recordActivation('0.32.0'),
  ]);

  assert.deepEqual(
    (await readdir(join(root, 'kimi-home', '.gian-session-store-compat', 'v1'))).sort(),
    ['0.31.1', '0.32.0'],
  );
});

test('existing Kimi sessions require a known owner version before first Gian activation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-kimi-store-bootstrap-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = await populatedKimiHome(root);
  const guard = new KimiSessionStoreGuard(home);

  await assert.rejects(
    guard.assertCompatible('0.31.1'),
    hasCode('DATA_VERSION_INCOMPATIBLE'),
  );
  await guard.assertCompatible('0.31.1', '0.31.1');
  await assert.rejects(
    guard.assertCompatible('0.30.0', '0.31.1'),
    hasCode('DATA_VERSION_INCOMPATIBLE'),
  );
});

test('unknown Kimi compatibility schemas and versions fail closed', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-kimi-store-schema-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'kimi-home');
  await mkdir(join(home, '.gian-session-store-compat', 'v2'), { recursive: true });
  const guard = new KimiSessionStoreGuard(home);
  await assert.rejects(
    guard.assertCompatible('0.31.1'),
    hasCode('DATA_VERSION_INCOMPATIBLE'),
  );

  await rm(join(home, '.gian-session-store-compat'), { recursive: true, force: true });
  await mkdir(join(home, '.gian-session-store-compat', 'v1'), { recursive: true });
  await writeFile(join(home, '.gian-session-store-compat', 'v1', 'future-format'), '');
  await assert.rejects(
    guard.assertCompatible('0.31.1'),
    hasCode('DATA_VERSION_INCOMPATIBLE'),
  );

  await rm(join(home, '.gian-session-store-compat', 'v1', 'future-format'));
  await mkdir(join(home, '.gian-session-store-compat', 'v1', '0.31.1'));
  await assert.rejects(
    guard.assertCompatible('0.31.1'),
    hasCode('DATA_VERSION_INCOMPATIBLE'),
  );
});

test('production AgentManager bootstraps from the same-home Kimi and persists the floor only on acquire', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-kimi-store-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = await populatedKimiHome(root);
  const binary = join(home, 'bin', 'kimi');
  await executable(binary, 'kimi 0.31.1');
  const options = {
    dataDir: join(root, 'data'),
    releaseVersion: '0.3.0',
    managedProxies: false,
    homeDir: join(root, 'user-home'),
    kimiCodeHome: home,
    pathEnv: '',
  } as const;
  const agents = await AgentManager.create(options);
  const kimiProvider = agents.runtimeProviders().find(provider => provider.id === 'kimi');
  assert.ok(kimiProvider);

  const [candidate] = await kimiProvider.inspectInstalled();
  assert.ok(candidate);
  const probe = await kimiProvider.probe(candidate);
  assert.equal(probe.version, '0.31.1');
  await assert.rejects(
    readdir(join(home, '.gian-session-store-compat')),
    (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT',
  );

  const runtimes = new CliRuntimeManager(agents.runtimeProviders(), join(root, 'locks'));
  const lease = await runtimes.acquire('kimi');
  assert.equal(lease.version, '0.31.1');
  assert.equal(lease.env.KIMI_CODE_HOME, home);
  await lease.release();
  assert.deepEqual(
    await readdir(join(home, '.gian-session-store-compat', 'v1')),
    ['0.31.1'],
  );

  await executable(binary, 'kimi 0.30.0');
  const downgradedAgents = await AgentManager.create(options);
  const downgradedRuntimes = new CliRuntimeManager(
    downgradedAgents.runtimeProviders(),
    join(root, 'downgrade-locks'),
  );
  await assert.rejects(
    downgradedRuntimes.acquire('kimi'),
    hasCode('DATA_VERSION_INCOMPATIBLE'),
  );
});

test('runtime manager preserves DATA_VERSION_INCOMPATIBLE from activation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-kimi-store-error-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const provider: CliRuntimeProvider = {
    id: 'kimi',
    async inspectInstalled() {
      return [{ cli: 'kimi', binaryPath: '/managed/kimi', source: 'managed' }];
    },
    async probe(runtime) {
      return { ...runtime, version: '0.30.0' };
    },
    async activate() {
      throw new KimiDataVersionError('controlled incompatible store');
    },
    managedEnv() { return {}; },
  };
  const runtimes = new CliRuntimeManager([provider], join(root, 'locks'));
  await assert.rejects(
    runtimes.acquire('kimi'),
    hasCode('DATA_VERSION_INCOMPATIBLE'),
  );
});
