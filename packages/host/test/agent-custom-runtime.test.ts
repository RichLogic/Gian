import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { parseProxyPluginId, type ManagedRuntimeGeneration, type SessionProxyBinding } from '@gian/shared';

import { AgentCreateError, AgentManager } from '../src/agents/manager.js';
import type { RuntimeResolver } from '../src/runtime/resolver.js';
import { SessionBindingPlanner } from '../src/session/binding-planner.js';
import { fakeOfficialProxy, testResolver } from './runtime-test-harness.js';

async function executable(path: string, version: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`);
  await chmod(path, 0o755);
}

/** Managed-mode AgentManager whose trusted claude launch is the probing fake
 *  Proxy from the runtime test harness, so a custom Runtime path is really
 *  probed (`path --version`) through the RuntimeResolver. */
async function customHarness(t: test.TestContext, runtimeKind: 'external' | 'none' = 'external') {
  const root = await mkdtemp(join(tmpdir(), 'gian-custom-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const proxyEntry = await fakeOfficialProxy(root, 'claude', 'Claude Code', '0.2.4');
  const pluginStore = {
    currentLaunch: async (pluginId: string) => pluginId === 'claude'
      ? {
        pluginId: parseProxyPluginId('claude'),
        pluginVersion: '0.2.4',
        manifestSha256: 'a'.repeat(64),
        protocolRange: '>=2.2 <3.0',
        entryPath: proxyEntry,
        processScope: 'session' as const,
        schemaVersion: 4 as const,
        runtime: runtimeKind === 'external'
          ? {
            kind: 'external' as const,
            id: 'claude',
            displayName: 'Claude Code',
            verifiedVersions: ['2.1.159'],
          }
          : { kind: 'none' as const },
      }
      : null,
  };
  const options = {
    allowCreateWithoutCatalog: true,
    dataDir: join(root, 'data'),
    releaseVersion: '0.6.5',
    managedProxies: true,
    runtimeResolver: testResolver(root),
    pluginStore,
    homeDir: join(root, 'home'),
    pathEnv: '',
  };
  const manager = await AgentManager.create(options as never);
  return { root, manager, options };
}

test('create persists a custom Runtime binding, probes the path, and prefers it over the managed generation', async t => {
  const { root, manager, options } = await customHarness(t);
  const runtimePath = join(root, 'bin', 'claude-company');
  await executable(runtimePath, 'claude 2.1.159');
  const home = join(root, 'custom-home');
  await mkdir(home, { recursive: true });

  const agent = await manager.createAgent({
    name: 'Company Claude',
    pluginId: 'claude',
    home: { kind: 'custom', path: home },
    runtime: { kind: 'custom', path: runtimePath },
  });
  assert.deepEqual(agent.runtime, { kind: 'custom', path: runtimePath });
  assert.equal(manager.agentRuntimePath(agent.id).cliPath, runtimePath);

  const persisted = JSON.parse(await readFile(join(root, 'data', 'agents.json'), 'utf8')) as {
    schemaVersion: number;
    agents: Array<Record<string, unknown>>;
  };
  assert.equal(persisted.schemaVersion, 6);
  assert.deepEqual(persisted.agents[0]!['runtime'], { kind: 'custom', path: runtimePath });

  const status = await manager.agentStatus(agent.id, true);
  assert.equal(status.ready, true);
  assert.equal(status.cli.source, 'override');
  assert.equal(status.cli.path, runtimePath);
  assert.equal(status.cli.version, '2.1.159');

  // A fresh Manager (no probe cache, e.g. after a Host restart) re-probes the
  // stored path instead of falling back to a managed generation.
  const reloaded = await AgentManager.create(options as never);
  assert.deepEqual(reloaded.listAgents()[0]!.runtime, { kind: 'custom', path: runtimePath });
  const reloadedStatus = await reloaded.agentStatus(agent.id, true);
  assert.equal(reloadedStatus.ready, true);
  assert.equal(reloadedStatus.cli.path, runtimePath);
});

test('create with a custom Runtime rejects a path that fails the probe', async t => {
  const { root, manager } = await customHarness(t);
  const missing = join(root, 'bin', 'missing-runtime');
  await assert.rejects(
    manager.createAgent({
      name: 'Broken Claude',
      pluginId: 'claude',
      runtime: { kind: 'custom', path: missing },
    }),
    (error: unknown) => error instanceof AgentCreateError
      && error.code === 'RUNTIME_INVALID'
      && error.status === 400,
  );
  assert.equal(manager.listAgents().length, 0);
});

test('custom creation needs a trusted compatible Proxy but not a ready managed Runtime', async t => {
  const { root, options } = await customHarness(t);
  const path = join(root, 'bin', 'company-claude');
  await executable(path, 'claude 2.1.159');
  let compatible = true;
  const manager = await AgentManager.create({ ...options, catalogService: {
    get: async () => ({
      compatibility: { state: compatible ? 'compatible' : 'requires_app_update' },
      installation: { state: 'installed' },
      runtime: { state: 'setup_required' },
      availableActions: [],
    }),
  } } as never);
  const agent = await manager.createAgent({ name: 'Company', pluginId: 'claude', runtime: { kind: 'custom', path } });
  assert.equal(manager.agentRuntimePath(agent.id).cliPath, path);
  compatible = false;
  await assert.rejects(manager.createAgent({ name: 'Incompatible', pluginId: 'claude', runtime: { kind: 'custom', path } }),
    (error: unknown) => error instanceof AgentCreateError && error.code === 'CATALOG_CREATE_FORBIDDEN');
});

test('create with a custom Runtime rejects a non-absolute path', async t => {
  const { manager } = await customHarness(t);
  await assert.rejects(
    manager.createAgent({
      name: 'Relative Claude',
      pluginId: 'claude',
      runtime: { kind: 'custom', path: 'bin/claude' },
    }),
    (error: unknown) => error instanceof AgentCreateError && error.code === 'RUNTIME_INVALID',
  );
});

test('a none-Runtime Proxy cannot bind a custom Runtime path', async t => {
  const { root, manager } = await customHarness(t, 'none');
  const runtimePath = join(root, 'bin', 'claude-company');
  await executable(runtimePath, 'claude 2.1.159');
  await assert.rejects(
    manager.createAgent({
      name: 'None Claude',
      pluginId: 'claude',
      runtime: { kind: 'custom', path: runtimePath },
    }),
    (error: unknown) => error instanceof AgentCreateError && error.code === 'RUNTIME_NONE_HAS_PATH',
  );
});

test('update rejects Runtime edits (create-only binding, ADR-0102 phase 1)', async t => {
  const { root, manager } = await customHarness(t);
  const runtimePath = join(root, 'bin', 'claude-company');
  await executable(runtimePath, 'claude 2.1.159');
  const agent = await manager.createAgent({
    name: 'Company Claude',
    pluginId: 'claude',
    runtime: { kind: 'custom', path: runtimePath },
  });
  await assert.rejects(
    manager.updateAgent(agent.id, { runtime: { kind: 'managed' } }),
    (error: unknown) => error instanceof AgentCreateError
      && error.code === 'RUNTIME_EDIT_UNSUPPORTED',
  );
});

test('a custom Runtime Agent reports an explicit error when its path disappears', async t => {
  const { root, manager } = await customHarness(t);
  const runtimePath = join(root, 'bin', 'claude-company');
  await executable(runtimePath, 'claude 2.1.159');
  const agent = await manager.createAgent({
    name: 'Company Claude',
    pluginId: 'claude',
    runtime: { kind: 'custom', path: runtimePath },
  });
  assert.equal((await manager.agentStatus(agent.id, true)).ready, true);

  await rm(runtimePath);
  const status = await manager.agentStatus(agent.id, true);
  assert.equal(status.ready, false);
  assert.equal(status.cli.state, 'invalid');
  assert.equal(status.cli.readinessIssue?.code, 'RUNTIME_PATH_MISSING');
});

test('resume of a custom-Runtime Session re-probes the stored path and never adopts the active generation', async () => {
  const pluginId = parseProxyPluginId('io.gian.fixture');
  const storedPath = '/tmp/custom-runtime';
  const generationPath = '/tmp/managed-generation-runtime';
  const digest = '2'.repeat(64);
  const binding: SessionProxyBinding = {
    schemaVersion: 1,
    pluginId,
    pluginVersion: '2.0.0',
    manifestSha256: digest,
    protocolVersion: '2.2',
    processScope: 'session',
    runtimeProfile: {
      id: 'runtime-profile-custom',
      agentId: 'agent-custom',
      pluginId,
      runtimeId: 'fixture-runtime',
      path: storedPath,
      version: '9.9.9',
      configHome: '/tmp/custom-home',
      contentFingerprint: 'fingerprint-custom',
      verifiedVersions: ['9.9.9'],
      verification: 'verified',
    },
  };
  const active: ManagedRuntimeGeneration = {
    schemaVersion: 1,
    generationId: 'current-generation',
    pluginId,
    platform: 'darwin-arm64',
    proxy: {
      pluginVersion: '2.0.0', manifestSha256: digest,
      artifactSha256: '3'.repeat(64), entryPath: '/tmp/current-proxy.mjs',
      processScope: 'session', protocolRange: '>=2.2 <3.0',
    },
    runtime: {
      runtimeId: 'fixture-runtime', version: '2.0.0', artifactSha256: '4'.repeat(64),
      entryPath: generationPath, ownership: 'managed',
    },
    companions: [], certificate: { id: 'certificate', sha256: '5'.repeat(64) },
    state: 'active', installedAt: '2026-09-01T00:00:00.000Z', activatedAt: '2026-09-02T00:00:00.000Z',
  };
  const launch = {
    pluginId,
    pluginVersion: '3.0.0',
    manifestSha256: digest,
    protocolRange: '>=2.2 <3.0',
    entryPath: '/tmp/current-proxy.mjs',
    processScope: 'session' as const,
    schemaVersion: 4 as const,
    source: 'github-release' as const,
    runtime: {
      kind: 'external' as const,
      id: 'fixture-runtime',
      displayName: 'Fixture Runtime',
      verifiedVersions: ['1.0.0'],
    },
  };
  const runtimePaths: Array<string | null> = [];
  const planner = new SessionBindingPlanner({
    resolveCurrent: async () => launch,
    resolveActiveGeneration: async () => active,
    resolveExact: async () => { throw new Error('Must not load the managed generation Proxy for a custom Runtime'); },
    agentHasCustomRuntime: agentId => agentId === 'agent-custom',
    runtimeResolver: {
      resolve: async (input: { agentId: string; selectedPath: string | null }) => {
        runtimePaths.push(input.selectedPath);
        return {
          profile: { ...binding.runtimeProfile!, agentId: input.agentId },
          lease: {
            binaryPath: storedPath, version: '9.9.9', source: 'override' as const,
            env: Object.freeze({}), release: async () => {},
          },
        };
      },
    } as unknown as RuntimeResolver,
  });

  const prepared = await planner.prepareResume(binding);
  assert.deepEqual(runtimePaths, [storedPath]);
  assert.equal(prepared.sessionBinding.pluginVersion, '3.0.0');
  const lease = await prepared.acquireLease();
  assert.equal(lease?.binaryPath, storedPath);
  await prepared.releaseUnusedLease();

  // A historical identity repair leaves the saved Runtime owner id intact.
  // The missing owner must keep the same path and current trusted Proxy too.
  const deletedOwner = new SessionBindingPlanner({
    resolveCurrent: async () => launch,
    resolveActiveGeneration: async () => active,
    resolveExact: async () => { throw new Error('Deleted owner must not select a managed generation'); },
    agentHasCustomRuntime: () => undefined,
    runtimeResolver: {
      resolve: async (input: { agentId: string; selectedPath: string | null }) => {
        assert.equal(input.selectedPath, storedPath);
        return { profile: binding.runtimeProfile!, lease: {
          binaryPath: storedPath, version: '9.9.9', source: 'override',
          env: Object.freeze({}), release: async () => {},
        } };
      },
    } as unknown as RuntimeResolver,
  });
  const restored = await deletedOwner.prepareResume(binding);
  assert.equal(restored.sessionBinding.pluginVersion, '3.0.0');
  await restored.releaseUnusedLease();

  const managed = new SessionBindingPlanner({
    resolveCurrent: async () => { throw new Error('Managed sessions must use the certified generation'); },
    resolveActiveGeneration: async () => active,
    resolveExact: async () => ({ ...launch, pluginVersion: active.proxy.pluginVersion }),
    agentHasCustomRuntime: () => false,
    runtimeResolver: {
      resolve: async (input: { selectedPath: string | null }) => {
        assert.equal(input.selectedPath, generationPath);
        return { profile: { ...binding.runtimeProfile!, path: generationPath }, lease: {
          binaryPath: generationPath, version: '2.0.0', source: 'managed',
          env: Object.freeze({}), release: async () => {},
        } };
      },
    } as unknown as RuntimeResolver,
  });
  const managedResume = await managed.prepareResume(binding);
  assert.equal(managedResume.sessionBinding.pluginVersion, active.proxy.pluginVersion);
  await managedResume.releaseUnusedLease();

  const failing = new SessionBindingPlanner({
    resolveCurrent: async () => launch,
    resolveActiveGeneration: async () => active,
    resolveExact: async () => launch,
    agentHasCustomRuntime: () => true,
    runtimeResolver: {
      resolve: async () => ({
        profile: binding.runtimeProfile!,
        lease: null,
        readinessIssue: {
          code: 'RUNTIME_PATH_MISSING',
          message: 'The custom Runtime path no longer exists.',
          repairable: false,
        },
      }),
    } as unknown as RuntimeResolver,
  });
  await assert.rejects(
    () => failing.prepareResume(binding),
    (error: unknown) => error instanceof Error && 'code' in error
      && error.code === 'RUNTIME_PATH_MISSING',
  );
});
