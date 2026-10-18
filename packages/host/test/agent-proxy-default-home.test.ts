import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, chmod, lstat, mkdir, mkdtemp, open, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { Hono } from 'hono';

import {
  parseProxyPluginId,
  type ManagedRuntimeGeneration,
  type OpenRuntimeProfile,
  type UserAgentStatus,
} from '@gian/shared';
import { AgentCreateError, AgentManager } from '../src/agents/manager.js';
import { AgentHomeError } from '../src/agents/home.js';
import { recordRuntimeArtifact, runtimeFileInventory } from '../src/runtime/artifact-reuse.js';
import { isAuthorizedConfigHome } from '../src/runtime/config-home.js';
import { provisionDevRuntimes } from '../src/runtime/dev-runtime-provision.js';
import { MAX_RUNTIME_FINGERPRINT_BYTES } from '../src/runtime/fingerprint.js';
import { ManagedRuntimeGenerationStore } from '../src/runtime/generation-store.js';
import { RuntimeResolver } from '../src/runtime/resolver.js';
import { registerAgentRoutes } from '../src/web/routes/agents.js';

function routesFor(manager: AgentManager): Hono {
  const app = new Hono();
  registerAgentRoutes(app, {
    agents: manager,
    closeProxy: async () => undefined,
    capabilities: async () => ({
      catalogRevision: 'test',
      input: [{ type: 'text' }],
      configOptions: [],
      slashCommands: [],
    }),
  });
  return app;
}

async function fixture(t: test.TestContext, configHome?: string) {
  const root = await mkdtemp(join(tmpdir(), 'gian-proxy-default-home-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'user');
  await mkdir(home);
  const runtimePath = join(root, 'runtime');
  await writeFile(runtimePath, 'fixture binary; never executed', { mode: 0o700 });
  const pluginId = parseProxyPluginId('io.gian.home-fixture');
  let probes = 0;
  const profile: OpenRuntimeProfile = {
    id: 'a'.repeat(64), agentId: pluginId, pluginId, runtimeId: 'home-fixture',
    path: runtimePath, version: '1.0.0', configHome: configHome ?? join(home, '.gemini'),
    contentFingerprint: 'b'.repeat(64), verifiedVersions: ['1.0.0'], verification: 'verified',
  };
  const manager = await AgentManager.create({
    allowCreateWithoutCatalog: true, managedProxies: true,
    dataDir: join(root, 'data'), homeDir: home, releaseVersion: '0.6.7', pathEnv: '',
    runtimeResolver: {
      resolve: async () => {
        probes += 1;
        return { profile, lease: { release: async () => {} } };
      },
    } as never,
    pluginStore: {
      currentLaunch: async (id: string) => id === pluginId ? {
        pluginId, pluginVersion: '1.0.0', manifestSha256: 'c'.repeat(64),
        protocolRange: '>=2.2 <3.0', entryPath: join(root, 'proxy.mjs'),
        processScope: 'shared', schemaVersion: 4,
        runtime: { kind: 'external', id: 'home-fixture', displayName: 'Fixture', verifiedVersions: ['1.0.0'] },
      } : null,
    } as never,
  });
  return { manager, root, home, runtimePath, pluginId, probes: () => probes };
}

test('external Proxy default HOME comes from the trusted probe without a built-in Provider branch', async t => {
  const f = await fixture(t);
  const agent = await f.manager.createAgent({
    name: 'External native home', pluginId: f.pluginId,
    runtime: { kind: 'custom', path: f.runtimePath },
  });
  assert.deepEqual(agent.home, { kind: 'custom', path: await realpath(join(f.home, '.gemini')) });
  assert.equal(f.probes(), 1);
});

test('explicit managed HOME is not replaced by a Proxy default', async t => {
  const f = await fixture(t);
  const agent = await f.manager.createAgent({
    name: 'Explicit managed home', pluginId: f.pluginId,
    runtime: { kind: 'custom', path: f.runtimePath }, home: { kind: 'managed' },
  });
  assert.equal(agent.home?.kind, 'managed');
  assert.notEqual(agent.home?.path, join(f.home, '.gemini'));
  assert.equal(f.probes(), 1);
});

test('unauthorized default configuration locations are rejected before saving an Agent', async t => {
  const f = await fixture(t, '/etc');
  await assert.rejects(f.manager.createAgent({
    name: 'Unsafe suggested home', pluginId: f.pluginId,
    runtime: { kind: 'custom', path: f.runtimePath },
  }), /authorized configuration locations/);
  assert.equal(f.manager.listAgents().length, 0);
});

test('managed creation still rejects a per-Agent CLI path', async t => {
  const f = await fixture(t);
  await assert.rejects(
    f.manager.createAgent({
      name: 'Managed path', pluginId: f.pluginId, cliPath: f.runtimePath,
      runtime: { kind: 'custom', path: f.runtimePath },
    }),
    (error: unknown) => error instanceof AgentCreateError && error.code === 'CLI_PATH_MANAGED',
  );
  assert.equal(f.manager.listAgents().length, 0);
});

const PLUGIN_ID = 'io.gian.home-fixture';

function shownDefault(path: string): { kind: 'default'; expectedPath: string } {
  return { kind: 'default', expectedPath: path };
}

async function savedAgents(dataDir: string): Promise<unknown[]> {
  try {
    const parsed = JSON.parse(await readFile(join(dataDir, 'agents.json'), 'utf8')) as { agents?: unknown[] };
    return parsed.agents ?? [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

async function sourceFirstFixture(t: test.TestContext, options?: {
  configHome?: string | null;
  configHomeSequence?: (homeDir: string) => Array<string | null>;
  provision?: boolean;
  tamper?: boolean;
  failProbe?: boolean;
  generation?: boolean;
  /** Real Resolver and a provisioned multi-file tree. The Proxy entry is a fake probe. */
  realFiles?: { harnessBytes: number; probeError?: string };
}) {
  const root = await mkdtemp(join(tmpdir(), 'gian-source-first-home-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'user');
  const dataDir = join(root, 'data');
  await mkdir(home, { recursive: true });
  const pluginId = parseProxyPluginId(PLUGIN_ID);
  const packageDir = join(root, 'home-fixture-proxy');
  const entry = join(packageDir, 'dist', 'src', 'cli', 'spawn.js');
  await mkdir(dirname(entry), { recursive: true });
  await writeFile(join(packageDir, 'package.json'), JSON.stringify({
    name: '@gian/home-fixture-proxy', version: '1.0.0',
  }));
  await writeFile(join(packageDir, 'manifest.json'), JSON.stringify({
    schemaVersion: 4,
    id: PLUGIN_ID,
    displayName: 'Home Fixture',
    pluginVersion: '1.0.0',
    entry: 'proxy.mjs',
    protocol: { name: 'gian.proxy', range: '>=2.2 <3.0' },
    process: { scope: 'shared' },
    runtime: {
      kind: 'external', id: 'home-fixture', displayName: 'Home Fixture',
      verifiedVersions: ['1.0.0'],
    },
    branding: {
      logo: { light: { path: 'assets/logo-light.png', mediaType: 'image/png', sha256: 'a'.repeat(64) } },
    },
  }));
  await writeFile(entry, 'export {};\n');
  const configHome = options?.configHome === undefined ? join(home, '.provider-default') : options.configHome;
  const configHomeSequence = options?.configHomeSequence?.(home);
  let configHomeIndex = 0;
  const selected: string[] = [];
  let probes = 0;
  let generationStore: ManagedRuntimeGenerationStore | undefined;
  if (options?.generation) {
    generationStore = new ManagedRuntimeGenerationStore(dataDir);
    await generationStore.initialize();
    const generationEntry = join(dataDir, 'runtimes', 'home-fixture', 'bin', 'fixture');
    const generationProxy = join(dataDir, 'plugins', PLUGIN_ID, 'proxy.mjs');
    await mkdir(dirname(generationEntry), { recursive: true });
    await mkdir(dirname(generationProxy), { recursive: true });
    await writeFile(generationEntry, '#!/bin/sh\necho 1.0.0\n', { mode: 0o700 });
    await writeFile(generationProxy, 'export {};\n');
    const candidate: ManagedRuntimeGeneration = {
      schemaVersion: 1,
      generationId: 'home-fixture-1.0.0',
      pluginId: PLUGIN_ID,
      platform: 'darwin-arm64',
      proxy: {
        pluginVersion: '1.0.0', manifestSha256: 'a'.repeat(64), artifactSha256: 'b'.repeat(64),
        entryPath: generationProxy, processScope: 'shared', protocolRange: '>=2.2 <3.0',
      },
      runtime: {
        runtimeId: 'home-fixture', version: '1.0.0', artifactSha256: 'c'.repeat(64),
        entryPath: generationEntry, ownership: 'managed',
      },
      companions: [],
      certificate: { id: 'home-fixture-1', sha256: 'd'.repeat(64) },
      state: 'staged',
      installedAt: '2026-10-14T00:00:00.000Z',
      activatedAt: null,
    };
    await generationStore.stage(candidate);
    await generationStore.activate(PLUGIN_ID, candidate.generationId);
  }
  const runtimeBytes = Buffer.from('#!/bin/sh\necho home-fixture 1.0.0\n');
  const realFiles = options?.realFiles;
  let launchEntry = entry;
  let realResolver: RuntimeResolver | undefined;
  let serverPath: string | undefined;
  let harnessPath: string | undefined;
  if (realFiles) {
    const artifactSha = createHash('sha256').update(runtimeBytes).digest('hex');
    const generation = join(dataDir, 'runtimes', 'home-fixture', '1.0.0', artifactSha);
    serverPath = join(generation, 'bin', 'fixture');
    harnessPath = join(generation, 'bin', 'harness.bin');
    launchEntry = join(packageDir, 'proxy.mjs');
    await mkdir(join(root, 'locks'), { recursive: true });
    await writeFile(launchEntry, managedProbeSource({
      configHome: configHome ?? join(home, '.provider-default'),
      roots: [
        { path: serverPath, mode: 'file' },
        { path: harnessPath, mode: 'file' },
      ],
      probeError: realFiles.probeError ?? null,
      pluginId: PLUGIN_ID,
      pluginName: 'Home Fixture',
      runtimeId: 'home-fixture',
      displayName: 'Home Fixture',
      version: '1.0.0',
    }), { mode: 0o755 });
    await chmod(launchEntry, 0o755);
    realResolver = new RuntimeResolver({
      dataDir,
      updateLockDataDir: join(root, 'locks'),
      hostVersion: '0.6.7',
      homeDir: home,
      managedStoreRoot: join(dataDir, 'runtimes'),
    });
  }
  const manager = await AgentManager.create({
    allowCreateWithoutCatalog: true,
    managedProxies: false,
    dataDir,
    homeDir: home,
    releaseVersion: '0.6.7',
    pathEnv: '',
    ...(generationStore ? { generationStore } : {}),
    developmentProxyEntries: { [PLUGIN_ID]: launchEntry },
    runtimeResolver: realResolver ?? {
      resolve: async (input: { selectedPath: string }) => {
        probes += 1;
        selected.push(input.selectedPath);
        if (options?.failProbe) throw new Error('probe unavailable');
        const resolvedHome = configHomeSequence && configHomeSequence.length > 0
          ? configHomeSequence[Math.min(configHomeIndex, configHomeSequence.length - 1)] ?? null
          : configHome;
        if (configHomeSequence && configHomeSequence.length > 0) configHomeIndex += 1;
        const profile: OpenRuntimeProfile = {
          id: 'a'.repeat(64), agentId: pluginId, pluginId, runtimeId: 'home-fixture',
          path: input.selectedPath, version: '1.0.0', configHome: resolvedHome,
          contentFingerprint: 'b'.repeat(64), verifiedVersions: ['1.0.0'], verification: 'verified',
        };
        return { profile, lease: { release: async () => {} } };
      },
    } as never,
  });
  let runtimePath: string | null = null;
  if (options?.provision !== false) {
    const installed = await provisionDevRuntimes({
      dataDir, homeDir: root, mode: 'isolated',
      declarations: [{ pluginId: PLUGIN_ID, runtimeId: 'home-fixture', versions: ['1.0.0'] }],
      coordinates: [{
        pluginId: PLUGIN_ID, runtimeId: 'home-fixture', version: '1.0.0', format: 'raw',
        entryRelativePath: 'bin/fixture',
        asset: {
          url: 'https://example.invalid/fixture', size: runtimeBytes.length,
          sha256: createHash('sha256').update(runtimeBytes).digest('hex'),
        },
      }],
      download: async () => runtimeBytes,
      probe: async () => '1.0.0',
    });
    runtimePath = installed[0]!.entryPath;
    if (realFiles && serverPath && harnessPath) {
      assert.equal(runtimePath, serverPath);
      const handle = await open(harnessPath, 'w');
      try {
        await handle.truncate(realFiles.harnessBytes);
      } finally {
        await handle.close();
      }
      const generation = dirname(dirname(runtimePath));
      await recordRuntimeArtifact(
        join(dataDir, 'runtimes'),
        generation,
        installed[0]!.artifactSha256,
        installed[0]!.entryRelativePath ?? 'bin/fixture',
        await runtimeFileInventory(generation),
      );
    }
    if (options?.tamper) await writeFile(runtimePath, 'tampered\n');
    manager.setProvisionedRuntimes(installed);
  }
  return {
    manager, root, home, dataDir, pluginId, configHome, runtimePath,
    probes: () => probes, selected,
    ...(realResolver && serverPath && harnessPath
      ? { resolver: realResolver, serverPath, harnessPath }
      : {}),
  };
}

test('source-first Dev creates an unknown plugin from its ready provisioned runtime', async t => {
  const f = await sourceFirstFixture(t);
  const draft = await f.manager.integrationDraftDefaults(f.pluginId);
  assert.equal(draft.name, 'Home Fixture');
  assert.deepEqual(draft.home, { kind: 'default', path: f.configHome });
  assert.equal(draft.cliPath, f.runtimePath);
  await assert.rejects(access(f.configHome!));
  const agent = await f.manager.createAgent({
    name: 'External', pluginId: f.pluginId, home: shownDefault(f.configHome!),
  });
  assert.equal(agent.proxy, null);
  assert.equal(agent.cliPath, f.runtimePath);
  assert.deepEqual(agent.home, { kind: 'custom', path: await realpath(f.configHome!) });
  assert.deepEqual(f.selected, [f.runtimePath, f.runtimePath]);
  const persisted = JSON.parse(await readFile(join(f.dataDir, 'agents.json'), 'utf8')) as {
    agents: Array<{ home: { kind: string } }>;
  };
  assert.equal(persisted.agents[0]?.home.kind, 'custom');
  assert.equal(f.manager.listAgents().length, 1);
});

test('source-first creation rejects a missing or untrusted runtime without using activeCached', async t => {
  const missing = await sourceFirstFixture(t, { provision: false, generation: true });
  assert.deepEqual((await missing.manager.integrationDraftDefaults(missing.pluginId)).home, {
    kind: 'unavailable',
  });
  assert.equal((await missing.manager.integrationDraftDefaults(missing.pluginId)).cliPath, null);
  await assert.rejects(
    missing.manager.createAgent({
      name: 'Generation only', pluginId: missing.pluginId,
      home: shownDefault(join(missing.home, '.provider-default')),
    }),
    (error: unknown) => error instanceof AgentCreateError && error.code === 'RUNTIME_PATH_REQUIRED',
  );
  assert.equal(missing.manager.listAgents().length, 0);
  assert.equal(missing.probes(), 0);
  const untrusted = await sourceFirstFixture(t, { tamper: true, generation: true });
  await assert.rejects(
    untrusted.manager.createAgent({ name: 'Tampered', pluginId: untrusted.pluginId }),
    (error: unknown) => error instanceof AgentCreateError && error.code === 'RUNTIME_INVALID',
  );
  assert.equal(untrusted.manager.listAgents().length, 0);
  assert.equal(untrusted.selected.includes(untrusted.runtimePath ?? ''), false);
});

test('explicit default HOME fails when it is occupied, unauthorized, or unavailable', async t => {
  const occupied = await sourceFirstFixture(t);
  await occupied.manager.createAgent({
    name: 'First', pluginId: occupied.pluginId, home: shownDefault(occupied.configHome!),
  });
  const occupiedBefore = await readFile(join(occupied.dataDir, 'agents.json'), 'utf8');
  await assert.rejects(
    occupied.manager.createAgent({
      name: 'Second', pluginId: occupied.pluginId, home: shownDefault(occupied.configHome!),
    }),
    (error: unknown) => error instanceof AgentHomeError && error.code === 'AGENT_HOME_IN_USE',
  );
  assert.equal(occupied.manager.listAgents().length, 1);
  assert.equal(await readFile(join(occupied.dataDir, 'agents.json'), 'utf8'), occupiedBefore);

  const unsafe = await sourceFirstFixture(t, { configHome: '/etc' });
  await assert.rejects(
    unsafe.manager.createAgent({ name: 'Unsafe', pluginId: unsafe.pluginId, home: shownDefault('/etc') }),
    /authorized configuration locations/,
  );
  assert.equal(unsafe.manager.listAgents().length, 0);

  const unavailable = await sourceFirstFixture(t, { configHome: null });
  assert.deepEqual((await unavailable.manager.integrationDraftDefaults(unavailable.pluginId)).home, {
    kind: 'unavailable',
  });
  await assert.rejects(
    unavailable.manager.createAgent({
      name: 'No default', pluginId: unavailable.pluginId,
      home: shownDefault(join(unavailable.home, '.provider-default')),
    }),
    (error: unknown) => error instanceof AgentCreateError && error.code === 'AGENT_HOME_UNAVAILABLE',
  );
  assert.equal(unavailable.manager.listAgents().length, 0);
  const fallback = await unavailable.manager.createAgent({
    name: 'Omitted home', pluginId: unavailable.pluginId,
  });
  assert.equal(fallback.home?.kind, 'managed');

  const failedProbe = await sourceFirstFixture(t, { failProbe: true });
  assert.deepEqual((await failedProbe.manager.integrationDraftDefaults(failedProbe.pluginId)).home, {
    kind: 'unavailable',
    reason: { code: 'RUNTIME_PROBE_FAILED', message: 'Runtime probe failed.' },
  });
  await assert.rejects(
    failedProbe.manager.createAgent({
      name: 'Probe down', pluginId: failedProbe.pluginId,
      home: shownDefault(join(failedProbe.home, '.provider-default')),
    }),
    (error: unknown) => error instanceof AgentCreateError && error.code === 'RUNTIME_INVALID',
  );
  assert.equal(failedProbe.manager.listAgents().length, 0);
});

test('custom HOME and custom Runtime keep their existing rejection rules', async t => {
  const f = await sourceFirstFixture(t);
  const missing = join(f.root, 'missing-home');
  await assert.rejects(
    f.manager.createAgent({
      name: 'Missing custom', pluginId: f.pluginId, home: { kind: 'custom', path: missing },
    }),
    (error: unknown) => error instanceof AgentHomeError && error.code === 'AGENT_HOME_MISSING',
  );
  await assert.rejects(access(missing));
  assert.equal(f.manager.listAgents().length, 0);
  const created = await f.manager.createAgent({
    name: 'External', pluginId: f.pluginId, home: shownDefault(f.configHome!),
  });
  await assert.rejects(
    f.manager.updateAgent(created.id, { home: { kind: 'default' } }),
    (error: unknown) => error instanceof AgentCreateError && error.code === 'AGENT_HOME_INVALID',
  );

  const custom = await sourceFirstFixture(t, { failProbe: true });
  const customRuntime = join(custom.root, 'custom-runtime');
  await writeFile(customRuntime, '#!/bin/sh\necho 1.0.0\n', { mode: 0o700 });
  const customHome = join(custom.root, 'custom-home');
  await mkdir(customHome);
  await assert.rejects(
    custom.manager.createAgent({
      name: 'Default with custom runtime', pluginId: custom.pluginId,
      runtime: { kind: 'custom', path: customRuntime },
      home: shownDefault(join(custom.home, '.provider-default')),
    }),
    (error: unknown) => error instanceof AgentCreateError && error.code === 'AGENT_HOME_INVALID',
  );
  assert.equal(custom.probes(), 0);
  await assert.rejects(
    custom.manager.createAgent({
      name: 'Custom runtime', pluginId: custom.pluginId,
      runtime: { kind: 'custom', path: customRuntime },
      home: { kind: 'custom', path: customHome },
    }),
    (error: unknown) => error instanceof AgentCreateError && error.code === 'RUNTIME_INVALID',
  );
  assert.deepEqual(custom.selected, [customRuntime]);
  assert.equal(custom.manager.listAgents().length, 0);
});

test('explicit default HOME rejects a candidate that changed after it was displayed', async t => {
  const f = await sourceFirstFixture(t, {
    configHomeSequence: homeDir => [join(homeDir, '.home-a'), join(homeDir, '.home-b')],
  });
  const shown = join(f.home, '.home-a');
  const replacement = join(f.home, '.home-b');
  const app = routesFor(f.manager);
  const draft = await app.request(`/api/proxies/${f.pluginId}/draft-defaults`);
  assert.equal(draft.status, 200);
  assert.deepEqual((await draft.json() as { home: unknown }).home, { kind: 'default', path: shown });
  await assert.rejects(access(shown));
  await assert.rejects(access(replacement));

  const created = await app.request('/api/agents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'External', pluginId: f.pluginId, home: shownDefault(shown) }),
  });
  assert.equal(created.status, 409);
  assert.equal((await created.json() as { code?: string }).code, 'AGENT_HOME_CHANGED');
  await assert.rejects(access(shown));
  await assert.rejects(access(replacement));
  assert.equal(f.manager.listAgents().length, 0);
  assert.deepEqual(await savedAgents(f.dataDir), []);
});

test('explicit default HOME accepts a missing leaf through its parent symlink', async t => {
  const f = await sourceFirstFixture(t, {
    configHomeSequence: homeDir => [join(homeDir, '.real-parent', '.provider-default')],
  });
  const realParent = join(f.home, '.real-parent');
  const linkParent = join(f.home, '.link-parent');
  const candidate = join(realParent, '.provider-default');
  const expected = join(linkParent, '.provider-default');
  await mkdir(realParent);
  await symlink(realParent, linkParent);
  assert.equal((await lstat(linkParent)).isSymbolicLink(), true);
  assert.notEqual(expected, candidate);
  await assert.rejects(access(candidate));
  await assert.rejects(access(expected));
  const agent = await f.manager.createAgent({
    name: 'Linked', pluginId: f.pluginId, home: shownDefault(expected),
  });
  assert.deepEqual(agent.home, { kind: 'custom', path: await realpath(candidate) });
  assert.equal(f.manager.listAgents().length, 1);
});

test('explicit default HOME rejects the same missing leaf under a different parent', async t => {
  const f = await sourceFirstFixture(t, {
    configHomeSequence: homeDir => [join(homeDir, '.parent-b', '.provider-default')],
  });
  const shown = join(f.home, '.parent-a', '.provider-default');
  const candidate = join(f.home, '.parent-b', '.provider-default');
  await mkdir(join(f.home, '.parent-a'));
  await mkdir(join(f.home, '.parent-b'));
  await assert.rejects(access(shown));
  await assert.rejects(access(candidate));
  await assert.rejects(
    f.manager.createAgent({
      name: 'Other parent', pluginId: f.pluginId, home: shownDefault(shown),
    }),
    (error: unknown) => error instanceof AgentHomeError && error.code === 'AGENT_HOME_CHANGED',
  );
  await assert.rejects(access(shown));
  await assert.rejects(access(candidate));
  assert.equal(f.manager.listAgents().length, 0);
  assert.deepEqual(await savedAgents(f.dataDir), []);
});

test('explicit default HOME does not create the other directory when only one side exists', async t => {
  const f = await sourceFirstFixture(t, {
    configHomeSequence: homeDir => [join(homeDir, '.home-b')],
  });
  const shown = join(f.home, '.home-a');
  const candidate = join(f.home, '.home-b');
  await mkdir(shown);
  await assert.rejects(access(candidate));
  await assert.rejects(
    f.manager.createAgent({
      name: 'Partial', pluginId: f.pluginId, home: shownDefault(shown),
    }),
    (error: unknown) => error instanceof AgentHomeError && error.code === 'AGENT_HOME_CHANGED',
  );
  await assert.rejects(access(candidate));
  assert.equal(f.manager.listAgents().length, 0);
  assert.deepEqual(await savedAgents(f.dataDir), []);
});

test('source-first draft and create use the agent routes for a provisioned unknown plugin', async t => {
  const f = await sourceFirstFixture(t);
  const app = routesFor(f.manager);
  const draft = await app.request(`/api/proxies/${f.pluginId}/draft-defaults`);
  assert.equal(draft.status, 200);
  assert.deepEqual(await draft.json(), {
    name: 'Home Fixture',
    home: { kind: 'default', path: f.configHome },
    cliPath: f.runtimePath,
  });
  await assert.rejects(access(f.configHome!));

  const created = await app.request('/api/agents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'External', pluginId: f.pluginId, home: shownDefault(f.configHome!) }),
  });
  assert.equal(created.status, 201);
  const { agent } = await created.json() as { agent: UserAgentStatus };
  assert.equal(agent.pluginId, f.pluginId);
  assert.equal(agent.proxy, null);
  assert.equal(agent.cli?.path, f.runtimePath);
  assert.deepEqual(agent.home, { kind: 'custom', path: await realpath(f.configHome!) });
  const persisted = JSON.parse(await readFile(join(f.dataDir, 'agents.json'), 'utf8')) as {
    agents: Array<{ cliPath: string | null; home: { kind: string; path: string } }>;
  };
  assert.equal(persisted.agents[0]?.cliPath, f.runtimePath);
  assert.equal(persisted.agents[0]?.home.kind, 'custom');

  const occupied = await app.request('/api/agents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'External 2', pluginId: f.pluginId, home: shownDefault(f.configHome!) }),
  });
  assert.equal(occupied.status, 409);
  assert.equal((await occupied.json() as { code?: string }).code, 'AGENT_HOME_IN_USE');
  assert.equal(f.manager.listAgents().length, 1);

  const before = await readFile(join(f.dataDir, 'agents.json'), 'utf8');
  const patched = await app.request(`/api/agents/${agent.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ home: { kind: 'default' } }),
  });
  assert.equal(patched.status, 400);
  assert.equal(await readFile(join(f.dataDir, 'agents.json'), 'utf8'), before);

  const unknown = await app.request('/api/proxies/io.acme.unknown/draft-defaults');
  assert.equal(unknown.status, 404);
  assert.equal(f.manager.listAgents().length, 1);
});

test('source-first routes reject a missing or tampered runtime before saving', async t => {
  const missing = await sourceFirstFixture(t, { provision: false, generation: true });
  const missingApp = routesFor(missing.manager);
  const missingDraft = await missingApp.request(`/api/proxies/${missing.pluginId}/draft-defaults`);
  assert.equal(missingDraft.status, 200);
  assert.deepEqual(await missingDraft.json(), {
    name: 'Home Fixture',
    cliPath: null,
    home: { kind: 'unavailable' },
  });
  const missingCreate = await missingApp.request('/api/agents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Generation only', pluginId: missing.pluginId,
      home: shownDefault(join(missing.home, '.provider-default')),
    }),
  });
  assert.equal(missingCreate.status, 400);
  assert.equal((await missingCreate.json() as { code?: string }).code, 'RUNTIME_PATH_REQUIRED');
  assert.equal(missing.manager.listAgents().length, 0);
  assert.equal(missing.probes(), 0);

  const untrusted = await sourceFirstFixture(t, { tamper: true, generation: true });
  const untrustedApp = routesFor(untrusted.manager);
  const untrustedCreate = await untrustedApp.request('/api/agents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Tampered', pluginId: untrusted.pluginId,
      home: shownDefault(join(untrusted.home, '.provider-default')),
    }),
  });
  assert.equal(untrustedCreate.status, 400);
  assert.equal((await untrustedCreate.json() as { code?: string }).code, 'RUNTIME_INVALID');
  assert.equal(untrusted.manager.listAgents().length, 0);
  assert.equal(untrusted.selected.includes(untrusted.runtimePath ?? ''), false);
});

async function ownedGeneration(
  dataDir: string,
  generationId: string,
  installedAt: string,
  certificateId: string,
): Promise<ManagedRuntimeGeneration> {
  const runtimePath = join(dataDir, 'runtimes', generationId, 'bin', 'fixture');
  const proxyPath = join(dataDir, 'plugins', PLUGIN_ID, `${generationId}.mjs`);
  await mkdir(dirname(runtimePath), { recursive: true });
  await mkdir(dirname(proxyPath), { recursive: true });
  await writeFile(runtimePath, `#!/bin/sh\necho ${generationId}\n`, { mode: 0o700 });
  await writeFile(proxyPath, 'export {};\n');
  return {
    schemaVersion: 1,
    generationId,
    pluginId: PLUGIN_ID,
    platform: 'darwin-arm64',
    proxy: {
      pluginVersion: '1.0.0', manifestSha256: 'a'.repeat(64), artifactSha256: 'b'.repeat(64),
      entryPath: proxyPath, processScope: 'shared', protocolRange: '>=2.2 <3.0',
    },
    runtime: {
      runtimeId: 'home-fixture', version: '1.0.0', artifactSha256: 'c'.repeat(64),
      entryPath: runtimePath, ownership: 'managed',
    },
    companions: [],
    certificate: { id: certificateId, sha256: 'd'.repeat(64) },
    state: 'staged',
    installedAt,
    activatedAt: null,
  };
}

async function managedGenerationFixture(t: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'gian-managed-default-home-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'user');
  const dataDir = join(root, 'data');
  await mkdir(home, { recursive: true });
  const pluginId = parseProxyPluginId(PLUGIN_ID);
  const configHome = join(home, '.provider-default');
  const store = new ManagedRuntimeGenerationStore(dataDir);
  await store.initialize();
  const current = await ownedGeneration(
    dataDir, 'home-fixture-1.0.0', '2026-10-14T00:00:00.000Z', 'home-fixture-1',
  );
  const replacement = await ownedGeneration(
    dataDir, 'home-fixture-1.0.1', '2026-10-14T00:01:00.000Z', 'home-fixture-2',
  );
  await store.stage(current);
  await store.stage(replacement);
  await store.activate(PLUGIN_ID, current.generationId);
  const selected: string[] = [];
  let probes = 0;
  const manager = await AgentManager.create({
    allowCreateWithoutCatalog: true,
    managedProxies: true,
    dataDir,
    homeDir: home,
    releaseVersion: '0.6.7',
    pathEnv: '',
    generationStore: store,
    pluginStore: {
      currentLaunch: async (id: string) => id === pluginId ? {
        pluginId,
        displayName: 'Home Fixture',
        pluginVersion: '1.0.0',
        manifestSha256: 'c'.repeat(64),
        protocolRange: '>=2.2 <3.0',
        entryPath: current.proxy.entryPath,
        processScope: 'shared',
        schemaVersion: 4,
        runtime: {
          kind: 'external', id: 'home-fixture', displayName: 'Home Fixture',
          verifiedVersions: ['1.0.0'],
        },
      } : null,
    } as never,
    runtimeResolver: {
      resolve: async (input: { selectedPath: string }) => {
        probes += 1;
        selected.push(input.selectedPath);
        const profile: OpenRuntimeProfile = {
          id: 'a'.repeat(64), agentId: pluginId, pluginId, runtimeId: 'home-fixture',
          path: input.selectedPath, version: '1.0.0', configHome,
          contentFingerprint: 'b'.repeat(64), verifiedVersions: ['1.0.0'], verification: 'verified',
        };
        return { profile, lease: { release: async () => {} } };
      },
    } as never,
  });
  return {
    manager, store, pluginId, configHome, home, selected,
    runtimePath: current.runtime?.entryPath ?? '',
    replacementId: replacement.generationId,
    replacementPath: replacement.runtime?.entryPath ?? '',
    probes: () => probes,
  };
}

test('managed unknown plugin default HOME comes from the active certified generation', async t => {
  const f = await managedGenerationFixture(t);
  const draft = await f.manager.integrationDraftDefaults(f.pluginId);
  assert.equal(draft.name, 'Home Fixture');
  assert.deepEqual(draft.home, { kind: 'default', path: f.configHome });
  assert.equal(draft.cliPath, f.runtimePath);
  await assert.rejects(access(f.configHome));
  const agent = await f.manager.createAgent({
    name: 'External', pluginId: f.pluginId, home: shownDefault(f.configHome),
  });
  assert.equal(agent.proxy, null);
  assert.equal(agent.cliPath, null);
  assert.deepEqual(agent.home, { kind: 'custom', path: await realpath(f.configHome) });
  assert.deepEqual(f.selected, [f.runtimePath, f.runtimePath]);
  assert.equal(f.selected.includes(f.replacementPath), false);

  const probesBefore = f.probes();
  let pending: { name: string; cliPath: string | null; home: { kind: string } } | null = null;
  await f.store.activate(f.pluginId, f.replacementId, new Date(), async () => {
    pending = await f.manager.integrationDraftDefaults(f.pluginId);
  });
  assert.deepEqual(pending, { name: 'Home Fixture', cliPath: null, home: { kind: 'unavailable' } });
  assert.equal(f.probes(), probesBefore);
  assert.equal(f.selected.includes(f.replacementPath), false);
  assert.equal(f.manager.listAgents().length, 1);
});

test('draft default HOME rejects a symlink that leaves authorized identity roots', async t => {
  const f = await sourceFirstFixture(t);
  const outside = join(f.root, 'outside');
  await mkdir(outside);
  await symlink(outside, f.configHome!);
  assert.equal(isAuthorizedConfigHome(f.configHome!, f.runtimePath!, f.home), true);
  const draft = await f.manager.integrationDraftDefaults(f.pluginId);
  assert.equal(draft.home.kind, 'unavailable');
  const reason = draft.home.kind === 'unavailable' ? draft.home.reason : undefined;
  assert.equal(reason?.code, 'RUNTIME_CONFIG_HOME_INVALID');
  assert.equal(reason?.message, 'Runtime probe failed.');
  assert.equal((reason?.message ?? '').includes(f.configHome!), false);
  assert.equal(draft.cliPath, f.runtimePath);
  assert.equal((await lstat(f.configHome!)).isSymbolicLink(), true);
  assert.deepEqual(f.selected, [f.runtimePath]);
  assert.equal(f.manager.listAgents().length, 0);
});

const MANAGED_PLUGIN_ID = 'io.gian.managed-files';
const BUDGET_COPY = 'Runtime files exceed the allowed fingerprint size.';
const PROBE_FAILURE_COPY = 'Runtime probe failed.';

function managedProbeSource(input: {
  configHome: string;
  roots: Array<{ path: string; mode: 'file' }>;
  probeError: string | null;
  pluginId?: string;
  pluginName?: string;
  runtimeId?: string;
  displayName?: string;
  version?: string;
}): string {
  const pluginId = input.pluginId ?? MANAGED_PLUGIN_ID;
  const pluginName = input.pluginName ?? 'Managed Files';
  const runtimeId = input.runtimeId ?? 'managed-files';
  const displayName = input.displayName ?? 'Managed Files';
  const version = input.version ?? '1.2.3';
  return `#!/usr/bin/env node
const { createInterface } = await import('node:readline');
const roots = ${JSON.stringify(input.roots)};
const probeError = ${JSON.stringify(input.probeError)};
const lineEnd = String.fromCharCode(10);
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const req = JSON.parse(line);
  const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + lineEnd);
  const fail = (message) => process.stdout.write(JSON.stringify({
    jsonrpc: '2.0', id: req.id, error: { code: -32602, message },
  }) + lineEnd);
  if (req.method === 'initialize') {
    const offered = req.params?.protocol?.versions ?? [];
    if (!offered.includes('2.2')) return fail('2.2 required');
    reply({
      protocol: { name: 'gian.proxy', version: '2.2' },
      plugin: { id: ${JSON.stringify(pluginId)}, name: ${JSON.stringify(pluginName)}, version: '1.0.0' },
      process: { scope: 'shared' },
      capabilities: { 'runtime.discover': 1, 'runtime.probe': 1 },
    });
    return;
  }
  if (req.method === 'runtime.discover') {
    reply({ candidates: [], setupActions: [] });
    return;
  }
  if (req.method === 'runtime.probe') {
    if (probeError) return fail(probeError);
    reply({
      runtimeId: ${JSON.stringify(runtimeId)},
      displayName: ${JSON.stringify(displayName)},
      path: req.params.path,
      version: ${JSON.stringify(version)},
      configHome: ${JSON.stringify(input.configHome)},
      contentRoots: roots,
    });
    return;
  }
  if (req.method === 'shutdown') {
    reply({ ok: true });
    process.exit(0);
  }
});
`;
}

async function postAgent(app: Hono, body: unknown): Promise<Response> {
  return app.request('/api/agents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function captureErrors(work: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map(item => typeof item === 'string' ? item : JSON.stringify(item)).join(' '));
  };
  try {
    await work();
    return lines.join('\n');
  } finally {
    console.error = original;
  }
}

function integrationRecords(log: string): Array<Record<string, unknown>> {
  return log.split('\n').flatMap(line => {
    const marker = '[integration] ';
    const at = line.indexOf(marker);
    if (at < 0) return [];
    return [JSON.parse(line.slice(at + marker.length)) as Record<string, unknown>];
  });
}

async function managedFilesFixture(t: test.TestContext, options: {
  receipt: boolean;
  harnessBytes: number;
  probeError?: string;
}) {
  const root = await mkdtemp(join(tmpdir(), 'gian-managed-files-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'user');
  const dataDir = join(root, 'data');
  await mkdir(home, { recursive: true });
  await mkdir(join(root, 'locks'), { recursive: true });
  const pluginId = parseProxyPluginId(MANAGED_PLUGIN_ID);
  const store = new ManagedRuntimeGenerationStore(dataDir);
  await store.initialize();
  const sha = 'ab'.repeat(32);
  const generation = join(dataDir, 'runtimes', 'managed-files', '1.2.3', sha);
  const serverPath = join(generation, 'server.par');
  const harnessPath = join(generation, 'harness.bin');
  await mkdir(generation, { recursive: true });
  await writeFile(serverPath, 'server\n');
  if (options.harnessBytes > 0) {
    const handle = await open(harnessPath, 'w');
    try {
      await handle.truncate(options.harnessBytes);
    } finally {
      await handle.close();
    }
  }
  if (options.receipt) {
    await recordRuntimeArtifact(join(dataDir, 'runtimes'), generation, sha, 'server.par', [
      { path: 'server.par', sha256: 'cd'.repeat(32), size: 7, executable: false },
      { path: 'harness.bin', sha256: 'ef'.repeat(32), size: options.harnessBytes, executable: false },
    ]);
  }
  const configHome = join(home, '.gemini');
  const proxyPath = join(dataDir, 'plugins', pluginId, 'proxy.mjs');
  await mkdir(dirname(proxyPath), { recursive: true });
  const roots = options.harnessBytes > 0
    ? [{ path: serverPath, mode: 'file' as const }, { path: harnessPath, mode: 'file' as const }]
    : [{ path: serverPath, mode: 'file' as const }];
  await writeFile(proxyPath, managedProbeSource({
    configHome,
    roots,
    probeError: options.probeError ?? null,
  }), { mode: 0o755 });
  await chmod(proxyPath, 0o755);
  const candidate: ManagedRuntimeGeneration = {
    schemaVersion: 1,
    generationId: 'managed-files-1.2.3',
    pluginId,
    platform: 'darwin-arm64',
    proxy: {
      pluginVersion: '1.0.0',
      manifestSha256: 'a'.repeat(64),
      artifactSha256: 'b'.repeat(64),
      entryPath: proxyPath,
      processScope: 'shared',
      protocolRange: '>=2.2 <3.0',
    },
    runtime: {
      runtimeId: 'managed-files',
      version: '1.2.3',
      artifactSha256: sha,
      entryPath: serverPath,
      ownership: 'managed',
    },
    companions: [],
    certificate: { id: 'managed-files-1', sha256: 'd'.repeat(64) },
    state: 'staged',
    installedAt: '2026-10-14T00:00:00.000Z',
    activatedAt: null,
  };
  await store.stage(candidate);
  await store.activate(pluginId, candidate.generationId);
  const resolver = new RuntimeResolver({
    dataDir,
    updateLockDataDir: join(root, 'locks'),
    hostVersion: '0.6.7',
    homeDir: home,
    managedStoreRoot: join(dataDir, 'runtimes'),
  });
  const manager = await AgentManager.create({
    allowCreateWithoutCatalog: true,
    managedProxies: true,
    dataDir,
    homeDir: home,
    releaseVersion: '0.6.7',
    pathEnv: '',
    generationStore: store,
    pluginStore: {
      currentLaunch: async (id: string) => id === pluginId ? {
        pluginId,
        displayName: 'Managed Files',
        pluginVersion: '1.0.0',
        manifestSha256: 'c'.repeat(64),
        protocolRange: '>=2.2 <3.0',
        entryPath: proxyPath,
        processScope: 'shared' as const,
        schemaVersion: 4 as const,
        runtime: {
          kind: 'external' as const,
          id: 'managed-files',
          displayName: 'Managed Files',
          verifiedVersions: ['1.2.3'],
        },
      } : null,
    } as never,
    runtimeResolver: resolver,
  });
  return {
    root, manager, resolver, pluginId, configHome, serverPath,
    app: routesFor(manager),
  };
}

test('real resolver drafts and creates a managed multi-file runtime above 64MiB', async (t) => {
  const f = await managedFilesFixture(t, {
    receipt: true,
    harnessBytes: MAX_RUNTIME_FINGERPRINT_BYTES + 1,
  });
  assert.equal(f.resolver instanceof RuntimeResolver, true);
  const draft = await f.app.request(`/api/proxies/${f.pluginId}/draft-defaults`);
  assert.equal(draft.status, 200);
  const draftBody = await draft.json() as {
    cliPath: string | null;
    home: { kind: string; path?: string };
  };
  assert.equal(draftBody.cliPath, f.serverPath);
  assert.deepEqual(draftBody.home, { kind: 'default', path: f.configHome });
  await assert.rejects(access(f.configHome));

  const created = await postAgent(f.app, {
    name: 'Managed Files',
    pluginId: f.pluginId,
    home: shownDefault(draftBody.home.path!),
  });
  assert.equal(created.status, 201);
  const createdBody = await created.json() as { agent: { home?: { kind: string; path: string } } };
  assert.equal(createdBody.agent.home?.kind, 'custom');
  assert.equal(createdBody.agent.home?.path, await realpath(f.configHome));
  assert.equal(f.manager.listAgents()[0]?.cliPath, null);

  const occupied = await postAgent(f.app, {
    name: 'Managed Files 2',
    pluginId: f.pluginId,
    home: shownDefault(f.configHome),
  });
  assert.equal(occupied.status, 409);
  assert.equal((await occupied.json() as { code?: string }).code, 'AGENT_HOME_IN_USE');

  const managed = await postAgent(f.app, {
    name: 'Managed Home',
    pluginId: f.pluginId,
    home: { kind: 'managed' },
  });
  assert.equal(managed.status, 201);
  assert.equal((await managed.json() as { agent: { home?: { kind: string } } }).agent.home?.kind, 'managed');

  const missing = join(f.root, 'missing-home');
  const existing = await postAgent(f.app, {
    name: 'Missing Home',
    pluginId: f.pluginId,
    home: { kind: 'custom', path: missing },
  });
  assert.equal(existing.status, 400);
  assert.equal((await existing.json() as { code?: string }).code, 'AGENT_HOME_MISSING');
  await assert.rejects(access(missing));
  assert.equal(f.manager.listAgents().length, 2);
});

test('an unverified oversized sibling fails draft and default create without a raw provider log', async (t) => {
  const f = await managedFilesFixture(t, {
    receipt: false,
    harnessBytes: MAX_RUNTIME_FINGERPRINT_BYTES + 1,
  });
  const log = await captureErrors(async () => {
    const draft = await f.app.request(`/api/proxies/${f.pluginId}/draft-defaults`);
    assert.equal(draft.status, 200);
    const draftBody = await draft.json() as {
      home: { kind: string; reason?: { code: string; message: string } };
    };
    assert.deepEqual(draftBody.home, {
      kind: 'unavailable',
      reason: { code: 'RUNTIME_FINGERPRINT_BUDGET', message: BUDGET_COPY },
    });
    const created = await postAgent(f.app, {
      name: 'Over budget',
      pluginId: f.pluginId,
      home: shownDefault(f.configHome),
    });
    assert.equal(created.status, 400);
    const body = await created.json() as { code?: string; error?: string };
    assert.equal(body.code, 'RUNTIME_FINGERPRINT_BUDGET');
    assert.equal(body.error, BUDGET_COPY);
  });
  assert.equal(f.manager.listAgents().length, 0);
  const records = integrationRecords(log);
  assert.deepEqual(records.map(record => record['operation']), ['draft-defaults', 'agent.create']);
  for (const record of records) {
    assert.deepEqual(Object.keys(record).sort(), ['code', 'operation', 'pluginId', 'stage']);
    assert.equal(record['code'], 'RUNTIME_FINGERPRINT_BUDGET');
    assert.equal(record['stage'], 'runtime-probe');
    assert.equal(record['pluginId'], f.pluginId);
    assert.equal('message' in record, false);
  }
});

test('provider probe failures keep a fixed message and omit secrets from the log', async (t) => {
  const secret = 'sekret-token';
  const providerError = `login failed https://accounts.example/oauth?code=${secret} GEMINI_API_KEY=do-not-log`;
  const f = await managedFilesFixture(t, {
    receipt: false,
    harnessBytes: 0,
    probeError: providerError,
  });
  const log = await captureErrors(async () => {
    const draft = await f.app.request(`/api/proxies/${f.pluginId}/draft-defaults`);
    const draftText = await draft.text();
    assert.equal(draft.status, 200);
    assert.equal(draftText.includes(secret), false);
    assert.equal(draftText.includes('accounts.example'), false);
    assert.equal(draftText.includes('GEMINI_API_KEY'), false);
    assert.equal(draftText.includes('do-not-log'), false);
    const draftBody = JSON.parse(draftText) as {
      home: { kind: string; reason?: { code: string; message: string } };
    };
    assert.deepEqual(draftBody.home.reason, {
      code: 'RUNTIME_PROBE_FAILED',
      message: PROBE_FAILURE_COPY,
    });
    const created = await postAgent(f.app, {
      name: 'Provider failed',
      pluginId: f.pluginId,
      home: shownDefault(f.configHome),
    });
    const createdText = await created.text();
    assert.equal(created.status, 400);
    assert.equal(createdText.includes(secret), false);
    assert.equal(createdText.includes('accounts.example'), false);
    assert.equal(createdText.includes('GEMINI_API_KEY'), false);
    const createdBody = JSON.parse(createdText) as { code?: string; error?: string };
    assert.equal(createdBody.code, 'RUNTIME_INVALID');
    assert.equal(createdBody.error, PROBE_FAILURE_COPY);
  });
  assert.equal(f.manager.listAgents().length, 0);
  assert.equal(log.includes(secret), false);
  assert.equal(log.includes('accounts.example'), false);
  assert.equal(log.includes('GEMINI_API_KEY'), false);
  assert.equal(log.includes('do-not-log'), false);
  const records = integrationRecords(log);
  assert.deepEqual(records.map(record => record['code']), ['RUNTIME_PROBE_FAILED', 'RUNTIME_INVALID']);
  assert.deepEqual(records.map(record => record['operation']), ['draft-defaults', 'agent.create']);
  for (const record of records) {
    assert.equal(record['stage'], 'runtime-probe');
    assert.equal(record['pluginId'], f.pluginId);
    assert.equal('message' in record, false);
  }
});

test('source-first Dev drafts and creates a receipt-backed runtime above 64MiB', async (t) => {
  const f = await sourceFirstFixture(t, {
    realFiles: { harnessBytes: MAX_RUNTIME_FINGERPRINT_BYTES + 1 },
  });
  assert.equal(f.resolver instanceof RuntimeResolver, true);
  assert.equal((await lstat(f.harnessPath!)).size, MAX_RUNTIME_FINGERPRINT_BYTES + 1);
  const ready = await f.manager.provisionedRuntimeStatus(f.pluginId);
  assert.equal(ready?.state, 'ready');
  assert.equal(ready?.path, f.serverPath);
  const app = routesFor(f.manager);
  const draft = await app.request(`/api/proxies/${f.pluginId}/draft-defaults`);
  assert.equal(draft.status, 200);
  const draftBody = await draft.json() as {
    cliPath: string | null;
    home: { kind: string; path?: string };
  };
  assert.equal(draftBody.cliPath, f.serverPath);
  assert.deepEqual(draftBody.home, { kind: 'default', path: f.configHome });
  await assert.rejects(access(f.configHome!));

  const created = await postAgent(app, {
    name: 'Home Fixture',
    pluginId: f.pluginId,
    home: shownDefault(draftBody.home.path!),
  });
  assert.equal(created.status, 201);
  const createdBody = await created.json() as {
    agent: {
      cliPath?: string | null;
      cli?: { path?: string | null };
      home?: { kind: string; path: string };
    };
  };
  assert.equal(createdBody.agent.cliPath, null);
  assert.equal(createdBody.agent.cli?.path, f.serverPath);
  assert.equal(createdBody.agent.home?.kind, 'custom');
  assert.equal(createdBody.agent.home?.path, await realpath(f.configHome!));
  assert.equal(f.manager.listAgents()[0]?.cliPath, f.serverPath);
  assert.equal(f.manager.listAgents().length, 1);
});

test('source-first default, managed, and existing HOME probe failures stay controlled', async (t) => {
  const secret = 'sekret-token';
  const providerError = `login failed https://accounts.example/oauth?code=${secret} GEMINI_API_KEY=do-not-log`;
  const f = await sourceFirstFixture(t, {
    realFiles: {
      harnessBytes: MAX_RUNTIME_FINGERPRINT_BYTES + 1,
      probeError: providerError,
    },
  });
  assert.equal(f.resolver instanceof RuntimeResolver, true);
  const ready = await f.manager.provisionedRuntimeStatus(f.pluginId);
  assert.equal(ready?.state, 'ready');
  assert.equal(ready?.path, f.serverPath);
  const existing = join(f.home, 'existing-home');
  await mkdir(existing);
  const app = routesFor(f.manager);
  const log = await captureErrors(async () => {
    const draft = await app.request(`/api/proxies/${f.pluginId}/draft-defaults`);
    const draftText = await draft.text();
    assert.equal(draft.status, 200);
    assert.equal(draftText.includes(secret), false);
    assert.equal(draftText.includes('accounts.example'), false);
    assert.equal(draftText.includes('GEMINI_API_KEY'), false);
    assert.equal(draftText.includes('do-not-log'), false);
    const draftBody = JSON.parse(draftText) as {
      cliPath: string | null;
      home: { kind: string; reason?: { code: string; message: string } };
    };
    assert.equal(draftBody.cliPath, f.serverPath);
    assert.deepEqual(draftBody.home, {
      kind: 'unavailable',
      reason: { code: 'RUNTIME_PROBE_FAILED', message: PROBE_FAILURE_COPY },
    });
    const homes = [
      { name: 'Default failed', home: shownDefault(f.configHome!) },
      { name: 'Managed failed', home: { kind: 'managed' as const } },
      { name: 'Existing failed', home: { kind: 'custom' as const, path: existing } },
    ];
    for (const input of homes) {
      const response = await postAgent(app, { ...input, pluginId: f.pluginId });
      const text = await response.text();
      assert.equal(response.status, 400);
      assert.equal(text.includes(secret), false);
      assert.equal(text.includes('accounts.example'), false);
      assert.equal(text.includes('GEMINI_API_KEY'), false);
      assert.equal(text.includes('do-not-log'), false);
      const body = JSON.parse(text) as { code?: string; error?: string };
      assert.equal(body.code, 'RUNTIME_INVALID');
      assert.equal(body.error, PROBE_FAILURE_COPY);
    }
  });
  assert.equal(f.manager.listAgents().length, 0);
  await access(existing);
  assert.equal(log.includes(secret), false);
  assert.equal(log.includes('accounts.example'), false);
  assert.equal(log.includes('GEMINI_API_KEY'), false);
  assert.equal(log.includes('do-not-log'), false);
  const records = integrationRecords(log);
  assert.deepEqual(records.map(record => record['code']), [
    'RUNTIME_PROBE_FAILED',
    'RUNTIME_INVALID',
    'RUNTIME_INVALID',
    'RUNTIME_INVALID',
  ]);
  assert.deepEqual(records.map(record => record['operation']), [
    'draft-defaults',
    'agent.create',
    'agent.create',
    'agent.create',
  ]);
  for (const record of records) {
    assert.deepEqual(Object.keys(record).sort(), ['code', 'operation', 'pluginId', 'stage']);
    assert.equal(record['stage'], 'runtime-probe');
    assert.equal(record['pluginId'], f.pluginId);
    assert.equal('message' in record, false);
  }
});
