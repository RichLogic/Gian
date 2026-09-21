import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { parseProxyPluginId, type ManagedRuntimeGeneration } from '@gian/shared';
import { Hono } from 'hono';

import { AgentCreateError, AgentManager } from '../src/agents/manager.js';
import { AgentHomeError } from '../src/agents/home.js';
import { ManagedRuntimeGenerationStore } from '../src/runtime/generation-store.js';
import { SessionBindingPlanner } from '../src/session/binding-planner.js';
import { registerAgentRoutes } from '../src/web/routes/agents.js';

async function executable(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, '#!/bin/sh\nexit 0\n');
  await chmod(path, 0o755);
}

function generation(root: string, proxyEntry: string, cliEntry: string): ManagedRuntimeGeneration {
  return {
    schemaVersion: 1,
    generationId: 'claude-0.2.4-cli-2.1.159',
    pluginId: 'claude',
    platform: 'darwin-arm64',
    proxy: {
      pluginVersion: '0.2.4',
      manifestSha256: 'a'.repeat(64),
      artifactSha256: 'b'.repeat(64),
      entryPath: proxyEntry,
      processScope: 'session',
      protocolRange: '>=2.2 <3.0',
    },
    runtime: {
      runtimeId: 'claude',
      version: '2.1.159',
      artifactSha256: 'c'.repeat(64),
      entryPath: cliEntry,
      ownership: 'managed',
    },
    companions: [],
    certificate: { id: 'claude-release-1', sha256: 'd'.repeat(64) },
    state: 'staged',
    installedAt: '2026-09-10T00:00:00.000Z',
    activatedAt: null,
  };
}

test('managed Agents share one certified Runtime and receive separate HOMEs', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'gian-managed-agent-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const proxyEntry = join(dataDir, 'plugins', 'claude', '0.2.4', 'proxy.mjs');
  const cliEntry = join(dataDir, 'runtimes', 'claude', '2.1.159', 'c'.repeat(64), 'bin', 'claude');
  await executable(proxyEntry);
  await executable(cliEntry);
  const generations = new ManagedRuntimeGenerationStore(dataDir);
  await generations.initialize();
  const candidate = generation(dataDir, proxyEntry, cliEntry);
  await generations.stage(candidate);
  await generations.activate('claude', candidate.generationId);

  const manager = await AgentManager.create({
    allowCreateWithoutCatalog: true,
    dataDir,
    releaseVersion: '0.6.0',
    managedProxies: true,
    generationStore: generations,
    homeDir: join(dataDir, 'user-home'),
    pathEnv: '/usr/local/bin:/usr/bin',
    environmentCliPaths: { claude: '/usr/local/bin/claude' },
    pluginStore: {
      currentLaunch: async (pluginId: string) => pluginId === 'claude'
        ? {
          pluginId: parseProxyPluginId('claude'),
          pluginVersion: '0.2.4',
          manifestSha256: 'a'.repeat(64),
          protocolRange: '>=2.2 <3.0',
          entryPath: proxyEntry,
          processScope: 'session' as const,
          schemaVersion: 4 as const,
          runtime: {
            kind: 'external' as const,
            id: 'claude',
            displayName: 'Claude Code',
            verifiedVersions: ['2.1.159'],
          },
        }
        : null,
    } as never,
  });

  const first = await manager.createAgent({ name: 'Claude A', pluginId: 'claude' });
  const second = await manager.createAgent({ name: 'Claude B', pluginId: 'claude' });
  assert.equal(first.cliPath, null);
  assert.equal(manager.updateLockDataDir(), dataDir);
  assert.equal(second.cliPath, null);
  assert.equal(first.home?.kind, 'managed');
  assert.equal(second.home?.kind, 'managed');
  assert.notEqual(first.home?.path, second.home?.path);
  assert.equal(manager.agentRuntimePath(first.id).cliPath, cliEntry);
  assert.equal(manager.agentRuntimePath(second.id).cliPath, cliEntry);

  const firstStatus = await manager.agentStatus(first.id);
  const secondStatus = await manager.agentStatus(second.id);
  assert.equal(firstStatus.ready, true);
  assert.equal(secondStatus.ready, true);
  assert.equal(firstStatus.cli.path, cliEntry);
  assert.equal(secondStatus.cli.path, cliEntry);
  assert.equal(firstStatus.runtimeProfile?.configHome, first.home?.path);
  assert.equal(secondStatus.runtimeProfile?.configHome, second.home?.path);
  assert.notEqual(firstStatus.runtimeProfile?.id, secondStatus.runtimeProfile?.id);
  assert.equal(firstStatus.cli.source, 'managed');
  assert.notEqual(firstStatus.cli.path, '/usr/local/bin/claude', 'managed Runtime must ignore machine paths');
  const persisted = JSON.parse(await readFile(join(dataDir, 'agents.json'), 'utf8')) as {
    schemaVersion: number;
    agents: Array<Record<string, unknown>>;
  };
  assert.equal(persisted.schemaVersion, 6);
  assert.equal('cliPath' in persisted.agents[0]!, false);
  assert.deepEqual(persisted.agents.map(item => item.home), [first.home, second.home]);
});

test('ZCode readiness is projected from its active certified generation without a managed HOME', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'gian-managed-zcode-agent-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const proxyEntry = join(dataDir, 'plugins', 'com.zhipu.zcode', '0.1.1', 'proxy.mjs');
  const runtimeEntry = join(dataDir, 'Applications', 'ZCode.app', 'Contents', 'Resources', 'glm', 'zcode.cjs');
  await executable(proxyEntry);
  await executable(runtimeEntry);
  const generations = new ManagedRuntimeGenerationStore(dataDir);
  await generations.initialize();
  const candidate: ManagedRuntimeGeneration = {
    schemaVersion: 1,
    generationId: 'zcode-0.1.1-runtime-0.16.5',
    pluginId: 'com.zhipu.zcode',
    platform: 'darwin-arm64',
    proxy: {
      pluginVersion: '0.1.1',
      manifestSha256: 'a'.repeat(64),
      artifactSha256: 'b'.repeat(64),
      entryPath: proxyEntry,
      processScope: 'shared',
      protocolRange: '>=2.2 <3.0',
    },
    runtime: {
      runtimeId: 'zcode',
      version: '0.16.5',
      artifactSha256: 'c'.repeat(64),
      entryPath: runtimeEntry,
      ownership: 'external-app',
    },
    companions: [],
    certificate: { id: 'zcode-release-1', sha256: 'd'.repeat(64) },
    state: 'staged',
    installedAt: '2026-09-12T00:00:00.000Z',
    activatedAt: null,
  };
  const manager = await AgentManager.create({
    allowCreateWithoutCatalog: true,
    dataDir,
    releaseVersion: '0.6.0',
    managedProxies: true,
    generationStore: generations,
    homeDir: join(dataDir, 'user-home'),
    pathEnv: '/usr/local/bin:/usr/bin',
    pluginStore: {
      currentLaunch: async () => ({
        pluginId: parseProxyPluginId('com.zhipu.zcode'),
        pluginVersion: '0.1.1',
        manifestSha256: 'a'.repeat(64),
        protocolRange: '>=2.2 <3.0',
        entryPath: proxyEntry,
        processScope: 'shared' as const,
        schemaVersion: 4 as const,
        runtime: {
          kind: 'external' as const,
          id: 'zcode',
          displayName: 'ZCode Runtime',
          verifiedVersions: ['0.16.5'],
        },
      }),
    } as never,
  });
  const agent = await manager.createAgent({ name: 'ZCode', pluginId: 'com.zhipu.zcode' });
  const missing = await manager.agentStatus(agent.id);
  assert.equal(missing.ready, false);
  assert.equal(missing.cli.path, null, 'a local ZCode.app is not active without its certified Proxy combination');

  await generations.stage(candidate);
  await generations.activate('com.zhipu.zcode', candidate.generationId);
  manager.managedRuntimeActivated('com.zhipu.zcode');
  const status = await manager.agentStatus(agent.id);
  assert.equal(status.home, null);
  assert.equal(status.ready, true);
  assert.equal(status.cli.path, runtimeEntry);
  assert.equal(status.cli.source, 'managed');
  assert.equal(status.runtimeProfile?.configHome, null);
});

test('managed Agent creation rejects CLI paths and validates Custom HOME ownership', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'gian-managed-agent-home-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const custom = join(dataDir, 'custom-home');
  await mkdir(custom, { mode: 0o700 });
  const manager = await AgentManager.create({
    allowCreateWithoutCatalog: true,
    dataDir,
    releaseVersion: '0.6.0',
    managedProxies: true,
    homeDir: join(dataDir, 'user-home'),
    pathEnv: '',
    pluginStore: {
      currentLaunch: async (pluginId: string) => pluginId === 'claude'
        ? {
          pluginId: parseProxyPluginId('claude'),
          pluginVersion: '0.2.4',
          manifestSha256: 'a'.repeat(64),
          protocolRange: '>=2.2 <3.0',
          entryPath: join(dataDir, 'plugins', 'claude', '0.2.4', 'proxy.mjs'),
          processScope: 'session' as const,
          schemaVersion: 4 as const,
          runtime: { kind: 'external' as const, id: 'claude', displayName: 'Claude Code', verifiedVersions: ['2.1.159'] },
        }
        : null,
    } as never,
  });

  await assert.rejects(
    manager.createAgent({ name: 'Path override', pluginId: 'claude', cliPath: '/usr/local/bin/claude' }),
    (error: unknown) => error instanceof AgentCreateError && error.code === 'CLI_PATH_MANAGED',
  );
  const first = await manager.createAgent({
    name: 'Custom A',
    pluginId: 'claude',
    home: { kind: 'custom', path: custom },
  });
  assert.deepEqual(first.home, { kind: 'custom', path: await realpath(custom) });
  await assert.rejects(
    manager.createAgent({
      name: 'Custom B',
      pluginId: 'claude',
      home: { kind: 'custom', path: custom },
    }),
    (error: unknown) => error instanceof AgentHomeError && error.code === 'AGENT_HOME_IN_USE',
  );
});

test('Session binding launches the shared CLI with the selected Agent HOME', async () => {
  const launch = {
    pluginId: parseProxyPluginId('claude'),
    pluginVersion: '0.2.4',
    manifestSha256: 'a'.repeat(64),
    protocolRange: '>=2.2 <3.0',
    entryPath: '/gian/plugins/claude/0.2.4/proxy.mjs',
    processScope: 'session' as const,
    schemaVersion: 4 as const,
    runtime: {
      kind: 'external' as const,
      id: 'claude',
      displayName: 'Claude Code',
      verifiedVersions: ['2.1.159'],
    },
    source: 'plugin-store' as const,
  };
  const planner = new SessionBindingPlanner({
    resolveCurrent: async () => launch,
    resolveExact: async () => launch,
    runtimeResolver: {
      resolve: async (input: { agentId: string }) => ({
        profile: {
          id: 'runtime-generation-identity',
          agentId: input.agentId,
          pluginId: parseProxyPluginId('claude'),
          runtimeId: 'claude',
          path: '/gian/runtimes/claude/2.1.159/bin/claude',
          version: '2.1.159',
          configHome: '/machine/default/.claude',
          contentFingerprint: 'f'.repeat(64),
          verifiedVersions: ['2.1.159'],
          verification: 'verified' as const,
        },
        lease: {
          binaryPath: '/gian/runtimes/claude/2.1.159/bin/claude',
          version: '2.1.159',
          source: 'managed' as const,
          env: { PATH: '/gian/runtimes/claude/2.1.159/bin' },
          release: async () => undefined,
        },
      }),
    } as never,
  });
  const baseAgent = {
    id: 'agent-a',
    name: 'Claude A',
    pluginId: parseProxyPluginId('claude'),
    proxy: 'claude' as const,
    cliPath: null,
    defaults: { model: '', thinking: '', mode: '' },
  };
  const first = await planner.prepareCurrent({
    agent: { ...baseAgent, home: { kind: 'managed', path: '/gian/homes/claude/agent-a' } },
    selectedPath: '/gian/runtimes/claude/2.1.159/bin/claude',
  });
  const second = await planner.prepareCurrent({
    agent: {
      ...baseAgent,
      id: 'agent-b',
      name: 'Claude B',
      home: { kind: 'managed', path: '/gian/homes/claude/agent-b' },
    },
    selectedPath: '/gian/runtimes/claude/2.1.159/bin/claude',
  });
  const lease = await first.acquireLease();
  assert.equal(lease?.env.CLAUDE_CONFIG_DIR, '/gian/homes/claude/agent-a');
  assert.equal(lease?.env.HOME, undefined);
  assert.equal(first.sessionBinding.runtimeProfile?.configHome, '/gian/homes/claude/agent-a');
  assert.notEqual(
    first.launchBinding.runtimeProfile?.identity,
    second.launchBinding.runtimeProfile?.identity,
    'different HOMEs must never share one Proxy process identity',
  );
  await lease?.release();
  await second.releaseUnusedLease();
});

test('managed Agent API rejects CLI input and creates a recoverable Agent before install', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'gian-managed-agent-api-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const custom = join(dataDir, 'custom-home');
  await mkdir(custom, { mode: 0o700 });
  const manager = await AgentManager.create({
    dataDir,
    releaseVersion: '0.6.0',
    managedProxies: true,
    homeDir: join(dataDir, 'user-home'),
    pathEnv: '',
    catalogService: {
      get: async () => ({
        compatibility: { state: 'compatible' },
        availableActions: ['install_runtime'],
      }),
    } as never,
  });
  const app = new Hono();
  let deliveredAgentId: string | undefined;
  registerAgentRoutes(app, {
    agents: manager,
    runtimeDelivery: {
      install: async (
        _pluginId: string,
        agentId?: string,
        onProgress?: (progress: { stage: 'catalog'; status: 'started' | 'completed' }) => void,
      ) => {
        deliveredAgentId = agentId;
        onProgress?.({ stage: 'catalog', status: 'started' });
        onProgress?.({ stage: 'catalog', status: 'completed' });
        return generation(
          dataDir,
          join(dataDir, 'plugins', 'claude', '0.2.4', 'proxy.mjs'),
          join(dataDir, 'runtimes', 'claude', '2.1.159', 'c'.repeat(64), 'bin', 'claude'),
        );
      },
    } as never,
    closeProxy: async () => undefined,
    capabilities: async () => ({
      catalogRevision: 'test',
      input: [{ type: 'text' }],
      configOptions: [],
      slashCommands: [],
    }),
  });

  const rejected = await app.request('/api/agents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Unsafe', pluginId: 'claude', cliPath: '/usr/local/bin/claude' }),
  });
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.json() as { code?: string }).code, 'CLI_PATH_MANAGED');

  const created = await app.request('/api/agents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Claude Fresh', pluginId: 'claude' }),
  });
  assert.equal(created.status, 201);
  const createdBody = await created.json() as {
    agent: { id: string; home: { kind: string; path: string }; cliPath?: unknown; cli: { path: string | null } };
  };
  assert.equal(createdBody.agent.home.kind, 'managed');
  assert.equal('cliPath' in createdBody.agent, false);
  assert.equal(createdBody.agent.cli.path, null);

  const patched = await app.request(`/api/agents/${createdBody.agent.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ home: { kind: 'custom', path: custom } }),
  });
  assert.equal(patched.status, 200);
  const patchedBody = await patched.json() as { agent: { home: { kind: string; path: string } } };
  assert.deepEqual(patchedBody.agent.home, { kind: 'custom', path: await realpath(custom) });

  const runtime = await app.request('/api/proxies/claude/runtime');
  assert.equal(runtime.status, 200);
  assert.deepEqual(await runtime.json(), { pluginId: 'claude', active: null, staged: [] });

  const installed = await app.request('/api/proxies/claude/runtime/install', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agentId: createdBody.agent.id }),
  });
  assert.equal(installed.status, 200);
  assert.equal(deliveredAgentId, createdBody.agent.id);

  const streamed = await app.request('/api/proxies/claude/runtime/install', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/x-ndjson',
    },
    body: JSON.stringify({ agentId: createdBody.agent.id }),
  });
  assert.equal(streamed.status, 200);
  assert.match(streamed.headers.get('content-type') ?? '', /application\/x-ndjson/);
  const frames = (await streamed.text()).trim().split('\n').map(line => JSON.parse(line) as {
    type: string;
    progress?: { stage: string; status: string };
  });
  assert.deepEqual(frames.slice(0, 2), [
    { type: 'progress', progress: { stage: 'catalog', status: 'started' } },
    { type: 'progress', progress: { stage: 'catalog', status: 'completed' } },
  ]);
  assert.equal(frames.at(-1)?.type, 'result');
});
