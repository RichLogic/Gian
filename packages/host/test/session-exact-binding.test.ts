import { strict as assert } from 'node:assert';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';

import { KNOWN_PROTOCOL_VERSIONS, protocolRangeIncludes } from '@gian/proxy-protocol';
import {
  isResumableSessionBinding,
  parseProxyPluginId,
  parseSessionProxyBinding,
  sessionRuntimeCliPath,
  type Executor,
  type SessionProxyBinding,
  type UserAgent,
} from '@gian/shared';

import { AgentManager } from '../src/agents/manager.js';
import { ApprovalManager } from '../src/approval/index.js';
import { PluginReferencedError } from '../src/plugin-store/errors.js';
import { PluginStore } from '../src/plugin-store/store.js';
import type { PluginArtifactNetwork, PluginInstallCoordinate } from '../src/plugin-store/types.js';
import { ProxyManager } from '../src/proxy/manager.js';
import { officialRuntimeIdentity } from '../src/proxy/legacy-launch.js';
import { QueueManager } from '../src/queue/index.js';
import { RuntimeResolver } from '../src/runtime/resolver.js';
import type { RuntimeLease } from '../src/runtime/types.js';
import { SessionBindingPlanner } from '../src/session/binding-planner.js';
import { SessionManager, type SessionAgentResolver } from '../src/session/manager.js';
import { openDatabase } from '../src/storage/db.js';
import type { WsBroadcaster } from '../src/web/ws-broadcast.js';
import { EMPTY_CATALOG, stubInitialize, stubSession } from './helpers/protocol-v2-stub.js';
import type { NotificationHandler } from '../src/proxy/types.js';
import type { ProxyLaunchBinding } from '../src/proxy/launch-binding.js';

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
  'hex',
);

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function syntheticOfficialDigest(pluginId: string, entryPath: string, version: string): string {
  return createHash('sha256').update(`official:${pluginId}:${entryPath}:${version}`).digest('hex');
}

function createGzipUstar(files: Map<string, Buffer>): Buffer {
  const parts: Buffer[] = [];
  for (const [name, data] of files) {
    const header = Buffer.alloc(512, 0);
    Buffer.from(name).copy(header, 0);
    header.write('0000644\0', 100, 'utf8');
    header.write('0000000\0', 108, 'utf8');
    header.write('0000000\0', 116, 'utf8');
    header.write(`${data.byteLength.toString(8).padStart(11, '0')}\0`, 124, 'utf8');
    header.write('00000000000\0', 136, 'utf8');
    header[156] = 0x30;
    header.write('ustar\0', 257, 'utf8');
    header.write('00', 263, 'utf8');
    header.fill(' ', 148, 156);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'utf8');
    const pad = (512 - (data.byteLength % 512)) % 512;
    parts.push(header, data);
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

function fixtureProxySource(id: string, version: string, allowed: readonly string[]): string {
  return `#!/usr/bin/env node
const id = ${JSON.stringify(id)};
const version = ${JSON.stringify(version)};
const allowed = ${JSON.stringify(allowed)};
if (process.argv.includes('--self-test')) {
  process.stdout.write(JSON.stringify({ schemaVersion: 4, id, pluginVersion: version, ok: true }) + '\\n');
  process.exit(0);
}
import('node:readline').then(({ createInterface }) => {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const emittedAt = '2026-09-03T00:00:00.000Z';
  let chosen = allowed[0];
  rl.on('line', (line) => {
    if (!line.trim()) return;
    const req = JSON.parse(line);
    if (req.method === 'initialize') {
      const offered = req.params.protocol.versions;
      chosen = offered.find((item) => allowed.includes(item));
      if (!chosen) {
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0', id: req.id,
          error: { code: -32602, message: 'offered protocol is outside the Manifest range' },
        }) + '\\n');
        return;
      }
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0', id: req.id, result: {
          protocol: { name: 'gian.proxy', version: chosen },
          plugin: { id, name: 'Gian Fixture', version },
          process: { scope: 'session' },
          capabilities: chosen === '2.2' || chosen === '2.3'
            ? { 'runtime.discover': 1, 'runtime.probe': 1 }
            : {},
        },
      }) + '\\n');
    } else if (req.method === 'catalog.list') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0', id: req.id, result: {
          catalogRevision: 'rev-1', input: [{ type: 'text' }], configOptions: [],
          slashCommands: [], specialCatalogs: {},
        },
      }) + '\\n');
    } else if (req.method === 'session.create') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0', id: req.id, result: {
          session: {
            id: req.params.sessionId,
            nativeSession: { id: 'native-' + version },
            streamId: 'stream-1', state: 'idle',
            sessionConfig: req.params.config ?? {},
            createdAt: emittedAt, updatedAt: emittedAt,
          },
        },
      }) + '\\n');
    } else if (req.method === 'turn.start') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0', id: req.id, result: { accepted: true, turnId: req.params.turnId },
      }) + '\\n');
      const base = {
        streamId: req.params.streamId,
        sessionId: req.params.sessionId,
        turnId: req.params.turnId,
        sourceTurnId: req.params.turnId,
        emittedAt,
      };
      for (const [method, eventId, sequence, data] of [
        ['turn.started', 'event-1', 1, {}],
        ['content.delta', 'event-2', 2, { contentId: 'content-1', kind: 'text', delta: 'hello' }],
        ['content.completed', 'event-3', 3, { contentId: 'content-1', kind: 'text', content: 'hello' }],
        ['turn.completed', 'event-4', 4, { stopReason: 'completed' }],
      ]) {
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0', method, params: { ...base, eventId, sequence, data },
        }) + '\\n');
      }
    } else if (req.method === 'session.close' || req.method === 'shutdown') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { ok: true } }) + '\\n');
      if (req.method === 'shutdown') process.exit(0);
    }
  });
});
`;
}

function packageFiles(version: string) {
  const files = new Map<string, Buffer>();
  const allowed = KNOWN_PROTOCOL_VERSIONS.filter((item) => protocolRangeIncludes('^2.2', item));
  files.set('proxy.mjs', Buffer.from(fixtureProxySource('io.gian.fixture', version, allowed)));
  files.set('assets/logo-light.png', PNG);
  files.set('assets/logo-dark.png', PNG);
  const manifestObject = {
    schemaVersion: 4,
    id: 'io.gian.fixture',
    displayName: 'Gian Fixture',
    pluginVersion: version,
    entry: 'proxy.mjs',
    protocol: { name: 'gian.proxy', range: '^2.2' },
    process: { scope: 'session' },
    runtime: { kind: 'none' },
    branding: {
      logo: {
        light: { path: 'assets/logo-light.png', mediaType: 'image/png', sha256: sha256(PNG) },
        dark: { path: 'assets/logo-dark.png', mediaType: 'image/png', sha256: sha256(PNG) },
      },
    },
  };
  const manifest = Buffer.from(`${JSON.stringify(manifestObject)}\n`);
  files.set('manifest.json', manifest);
  return { files, manifest };
}

function artifactUrls(version: string) {
  const tag = `proxy-fixture-v${version}`;
  const archive = `gian-proxy-fixture-${version}-darwin-arm64.tar.gz`;
  return {
    tag,
    archive,
    manifest: `${archive}.manifest.json`,
    archiveUrl: `https://github.com/RichLogic/Gian/releases/download/${tag}/${archive}`,
    manifestUrl: `https://github.com/RichLogic/Gian/releases/download/${tag}/${archive}.manifest.json`,
  };
}

function memoryNetwork(assets: Map<string, Buffer>): PluginArtifactNetwork {
  return {
    async download(input) {
      const bytes = assets.get(`${input.repository}:${input.tag}:${input.asset}`);
      if (!bytes) throw new Error(`missing asset ${input.tag}/${input.asset}`);
      return bytes;
    },
  };
}

function coordinate(
  version: string,
  manifest: Buffer,
  archive: Buffer,
  sequence: number,
): PluginInstallCoordinate {
  const urls = artifactUrls(version);
  return {
    pluginId: 'io.gian.fixture',
    pluginVersion: version,
    platform: 'darwin-arm64',
    manifest: { url: urls.manifestUrl, sha256: sha256(manifest), size: manifest.byteLength },
    archive: { url: urls.archiveUrl, sha256: sha256(archive), size: archive.byteLength },
    sourceId: 'gian-official',
    catalogSequence: sequence,
    protocolRange: '^2.2',
    processScope: 'session',
    runtime: { kind: 'none' },
  };
}

class CapturingBroadcaster {
  messages: unknown[] = [];
  send(): void {}
  broadcast(msg: unknown): void {
    this.messages.push(msg);
  }
}

class FakeClient {
  readonly protocolV2 = true as const;
  initializeCalls = 0;
  lastCreateParams: Record<string, unknown> | null = null;
  stream = 'stream-1';
  ownSessionId: string | null = null;
  constructor(
    readonly pluginId: string,
    private readonly nativeId: string,
    private readonly failCreate = false,
    private readonly pluginVersion = '1.0.0',
    private readonly protocolVersion = '2.2',
    private readonly processScope: 'shared' | 'session' = 'session',
  ) {}
  isExited() { return false; }
  hasAttachedSession() { return this.stream !== null; }
  streamId() { return this.stream; }
  async initialize() {
    this.initializeCalls += 1;
    return {
      ...stubInitialize('claude', this.pluginVersion),
      protocol: { name: 'gian.proxy' as const, version: this.protocolVersion },
      plugin: { id: this.pluginId, name: 'Fixture', version: this.pluginVersion },
      process: { scope: this.processScope },
      capabilities: { 'session.fork': true },
    };
  }
  async catalog() { return EMPTY_CATALOG; }
  async createSession(params: Record<string, unknown>) {
    this.lastCreateParams = params;
    if (this.failCreate) throw new Error('controlled create failure');
    return {
      session: stubSession(this.nativeId, String(params.cwd ?? '/tmp')),
      nativeSessionId: this.nativeId,
    };
  }
  async forkSession(params: { sessionId: string; [key: string]: unknown }) {
    return {
      session: {
        id: params.sessionId,
        streamId: `stream-${params.sessionId}`,
        state: 'idle' as const,
        nativeSession: { id: `native-${params.sessionId}` },
        createdAt: '2026-09-03T00:00:00.000Z',
        updatedAt: '2026-09-03T00:00:00.000Z',
      },
      origin: {
        kind: 'fork' as const,
        sessionId: this.ownSessionId ?? 'parent',
        turnId: 't1',
        sourceTurnId: 'src-1',
      },
      replayEvents: [],
    };
  }
  runtimeHost() {
    return {
      createSessionClient: (sessionId: string) => {
        const child = new FakeClient(
          this.pluginId,
          `native-${sessionId}`,
          this.failCreate,
          this.pluginVersion,
          this.protocolVersion,
          this.processScope,
        );
        child.stream = `stream-${sessionId}`;
        child.ownSessionId = sessionId;
        return child;
      },
    };
  }
  async startTurn() {
    return { session: stubSession(this.nativeId, '/tmp', 'running'), turn: { id: `turn-${randomUUID()}` } };
  }
  async setName() {}
  async shutdown() {}
  forceKill() {}
  onNotification(_handler: NotificationHandler) { return () => {}; }
  onSessionFault() { return () => {}; }
  onExit() { return () => {}; }
}

class FakeProxyManager {
  clients = new Map<string, FakeClient>();
  bindings: ProxyLaunchBinding[] = [];
  getOrCreateCalls = 0;
  acquireCalls = 0;
  disposed: string[] = [];
  runtimeBins: Array<string | null> = [];
  private leases = new Map<string, RuntimeLease>();
  private seq = 0;
  constructor(
    private readonly nativeId: string,
    private readonly failCreate = false,
    private readonly sharedNative = false,
    private readonly leaseMode: 'never' | 'always' | 'first' = 'never',
  ) {}
  private nextNativeId() {
    return this.sharedNative ? this.nativeId : `${this.nativeId}-${++this.seq}`;
  }
  async acquireWithBinding(
    sessionId: string,
    binding: ProxyLaunchBinding,
    options?: { acquireLease?: () => Promise<RuntimeLease | null> },
  ) {
    this.acquireCalls += 1;
    this.bindings.push(binding);
    const existing = this.clients.get(sessionId);
    if (existing) return existing;
    const shouldConsume = this.leaseMode === 'always'
      || (this.leaseMode === 'first' && this.leases.size === 0);
    if (shouldConsume) {
      const lease = await options?.acquireLease?.() ?? null;
      this.runtimeBins.push(lease?.binaryPath ?? null);
      if (lease) this.leases.set(sessionId, lease);
    }
    const client = new FakeClient(
      binding.pluginId,
      this.nextNativeId(),
      this.failCreate,
      binding.pluginVersion,
      binding.protocolVersion,
      binding.processScope,
    );
    client.ownSessionId = sessionId;
    this.clients.set(sessionId, client);
    return client;
  }
  async getOrCreate(sessionId: string, executor: Executor) {
    this.getOrCreateCalls += 1;
    const existing = this.clients.get(sessionId);
    if (existing) return existing;
    const client = new FakeClient(String(executor), this.nextNativeId(), this.failCreate);
    client.ownSessionId = sessionId;
    this.clients.set(sessionId, client);
    return client;
  }
  get(sessionId: string) { return this.clients.get(sessionId); }
  adoptExisting(sessionId: string, client: FakeClient): void {
    client.ownSessionId = sessionId;
    this.clients.set(sessionId, client);
  }
  forgetAdopted(sessionId: string): void {
    this.clients.delete(sessionId);
  }
  async dispose(sessionId: string) {
    this.disposed.push(sessionId);
    this.clients.delete(sessionId);
    const lease = this.leases.get(sessionId);
    if (lease) {
      await lease.release();
      this.leases.delete(sessionId);
    }
  }
}

function resolverFor(agents: UserAgent[]): SessionAgentResolver {
  return {
    cliPathForKind: () => null,
    cliPathForSession: session => session.proxy_binding?.runtimeProfile
      ? ('path' in session.proxy_binding.runtimeProfile ? session.proxy_binding.runtimeProfile.path : null)
      : null,
    requireCliPathForSession: session => session.proxy_binding?.runtimeProfile
      ? ('path' in session.proxy_binding.runtimeProfile ? session.proxy_binding.runtimeProfile.path : null)
      : null,
    agentRuntime: agentId => {
      const agent = agents.find(item => item.id === agentId);
      if (!agent) throw new Error(`agent not found: ${agentId}`);
      return { agent, cliPath: agent.cliPath };
    },
    agentRuntimeProfile: async () => null,
    agentsForKind: executor => agents.filter(agent => (
      agent.proxy === executor || (!agent.proxy && agent.pluginId === executor)
    )),
  };
}

async function installFixture(
  root: string,
  versions: string[],
  listBindingReferences?: () => readonly { pluginId: string; pluginVersion: string }[],
) {
  const assets = new Map<string, Buffer>();
  const store = new PluginStore({
    dataDir: root,
    pluginsDir: join(root, 'plugins'),
    network: memoryNetwork(assets),
    allowedArtifactRepositories: ['RichLogic/Gian'],
    hostVersion: '0.1.0',
    hostVersions: ['2.3', '2.2', '2.1', '2.0'],
    ...(listBindingReferences ? { listBindingReferences } : {}),
  });
  const receipts = [];
  for (const [index, version] of versions.entries()) {
    const pkg = packageFiles(version);
    const archive = createGzipUstar(pkg.files);
    const urls = artifactUrls(version);
    assets.set(`RichLogic/Gian:${urls.tag}:${urls.archive}`, archive);
    assets.set(`RichLogic/Gian:${urls.tag}:${urls.manifest}`, pkg.manifest);
    receipts.push({
      version,
      manifest: pkg.manifest,
      receipt: await store.install(coordinate(version, pkg.manifest, archive, index + 1)),
    });
  }
  return { store, receipts, assets };
}

test('exact create persists real Manifest digest and never a synthetic official digest', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gian-exact-digest-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { store, receipts } = await installFixture(root, ['1.0.0']);
  const first = receipts[0]!;
  const agent: UserAgent = {
    id: randomUUID(),
    name: 'Fixture',
    pluginId: parseProxyPluginId('io.gian.fixture'),
    proxy: null,
    cliPath: null,
    defaults: { model: '', thinking: '', mode: '' },
  };
  const planner = new SessionBindingPlanner({
    resolveCurrent: async () => {
      const launch = await store.currentLaunch('io.gian.fixture');
      assert.ok(launch);
      return {
        pluginId: launch.pluginId,
        pluginVersion: launch.pluginVersion,
        manifestSha256: launch.manifestSha256,
        protocolRange: launch.protocolRange,
        entryPath: launch.entryPath,
        processScope: launch.processScope,
        schemaVersion: 4,
        runtime: launch.runtime,
        source: 'plugin-store',
      };
    },
    resolveExact: async (input) => {
      const exact = await store.resolveExactLaunch(input);
      return {
        pluginId: exact.pluginId,
        pluginVersion: exact.pluginVersion,
        manifestSha256: exact.manifestSha256,
        protocolRange: exact.protocolRange,
        entryPath: exact.entryPath,
        processScope: exact.processScope,
        schemaVersion: 4,
        runtime: exact.runtime,
        source: 'plugin-store',
      };
    },
  });
  const prepared = await planner.prepareCurrent({ agent, selectedPath: null });
  assert.equal(prepared.sessionBinding.manifestSha256, sha256(first.manifest));
  assert.equal(prepared.sessionBinding.manifestSha256, first.receipt.manifestSha256);
  assert.notEqual(
    prepared.sessionBinding.manifestSha256,
    syntheticOfficialDigest('io.gian.fixture', prepared.launchBinding.entryPath, '1.0.0'),
  );
  assert.notEqual(prepared.launchBinding.runtimeProfile?.identity, officialRuntimeIdentity({
    pluginId: 'io.gian.fixture',
    entryPath: prepared.launchBinding.entryPath,
    pluginVersion: '1.0.0',
  }));
  assert.equal(prepared.sessionBinding.protocolVersion, '2.3');
  assert.equal(prepared.sessionBinding.processScope, 'session');
});

test('unknown fixture Session create/reattach uses stored binding after Agent delete and current change', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gian-exact-unknown-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let db: ReturnType<typeof openDatabase> | undefined;
  const { store, receipts, assets } = await installFixture(root, ['1.0.0'], () => {
    if (!db) return [];
    return db.prepare(
      'SELECT proxy_binding_json FROM sessions WHERE proxy_binding_json IS NOT NULL',
    ).all().flatMap((row: { proxy_binding_json: string | null }) => {
      const parsed = parseSessionProxyBinding(row.proxy_binding_json);
      return parsed.ok && isResumableSessionBinding({ proxy_binding: parsed.binding })
        ? [{ pluginId: parsed.binding.pluginId, pluginVersion: parsed.binding.pluginVersion }]
        : [];
    });
  });
  const v1 = receipts[0]!;

  const dataDir = join(root, 'host');
  const resolver = new RuntimeResolver({
    dataDir: join(root, 'resolver'),
    updateLockDataDir: join(root, 'locks'),
    hostVersion: '0.1.0',
  });
  const agents = await AgentManager.create({
    dataDir,
    releaseVersion: '0.1.0',
    managedProxies: false,
    allowCreateWithoutCatalog: true,
    pluginStore: store,
    runtimeResolver: resolver,
    homeDir: join(root, 'home'),
    pathEnv: '',
  });
  const agent = await agents.createAgent({ name: 'Unknown Fixture', pluginId: 'io.gian.fixture' });
  assert.equal(agent.proxy, null);
  assert.equal(agent.pluginId, 'io.gian.fixture');

  db = openDatabase(dataDir);
  const wsId = randomUUID();
  db.prepare('INSERT OR IGNORE INTO workspaces (id, name, path) VALUES (?, ?, ?)')
    .run(wsId, 'ws', root);
  const planner = new SessionBindingPlanner({
    resolveCurrent: pluginId => agents.trustedLaunch(pluginId).then(launch => {
      if (!launch) throw new Error('missing current launch');
      return launch;
    }),
    resolveExact: input => agents.resolveExactTrustedLaunch(input),
    runtimeResolver: resolver,
  });
  const makeSessions = (proxy: ProxyManager) => new SessionManager(
    db!,
    proxy,
    new CapturingBroadcaster() as unknown as WsBroadcaster,
    new ApprovalManager(new CapturingBroadcaster() as unknown as WsBroadcaster),
    new QueueManager(db!),
    dataDir,
    null,
    undefined,
    undefined,
    {
      cliPathForKind: () => null,
      cliPathForSession: () => null,
      requireCliPathForSession: () => null,
      agentRuntime: agentId => ({ agent: agents.getAgent(agentId), cliPath: null }),
      agentRuntimeProfile: async agentId => {
        const status = await agents.agentStatus(agentId, true);
        if (!status.ready) throw new Error(`agent is not ready: ${status.name}`);
        return status.runtimeProfile;
      },
      agentsForKind: () => agents.listAgents(),
    },
    undefined,
    planner,
  );
  const proxy = new ProxyManager({ dataDir: join(root, 'proxy-a') });
  t.after(() => proxy.closeAll());
  const sessions = makeSessions(proxy);

  const created = await sessions.createSession({ workspace_id: wsId, agent_id: agent.id });
  assert.ok(created.proxy_binding);
  assert.equal(created.executor, 'io.gian.fixture');
  assert.equal(created.proxy_plugin_id, 'io.gian.fixture');
  const binding = created.proxy_binding as SessionProxyBinding;
  assert.equal(binding.pluginId, 'io.gian.fixture');
  assert.equal(binding.pluginVersion, '1.0.0');
  assert.equal(binding.manifestSha256, v1.receipt.manifestSha256);
  assert.equal(binding.protocolVersion, '2.3');
  assert.ok(isResumableSessionBinding(created));

  const v2 = packageFiles('2.0.0');
  const archive2 = createGzipUstar(v2.files);
  const urls2 = artifactUrls('2.0.0');
  assets.set(`RichLogic/Gian:${urls2.tag}:${urls2.archive}`, archive2);
  assets.set(`RichLogic/Gian:${urls2.tag}:${urls2.manifest}`, v2.manifest);
  await store.install(coordinate('2.0.0', v2.manifest, archive2, 2));
  assert.equal((await store.inspect('io.gian.fixture')).currentVersion, '2.0.0');

  const newer = await sessions.createSession({ workspace_id: wsId, agent_id: agent.id });
  assert.equal(newer.proxy_binding?.pluginVersion, '2.0.0');
  assert.equal(sessions.getSession(created.id).proxy_binding?.pluginVersion, '1.0.0');

  await agents.deleteAgent(agent.id);
  const afterDelete = sessions.getSession(created.id);
  assert.equal(afterDelete.agent_id, agent.id);
  assert.equal(afterDelete.proxy_binding?.pluginVersion, '1.0.0');

  const proxyB = new ProxyManager({ dataDir: join(root, 'proxy-b') });
  t.after(() => proxyB.closeAll());
  const resumed = new SessionManager(
    db,
    proxyB,
    new CapturingBroadcaster() as unknown as WsBroadcaster,
    new ApprovalManager(new CapturingBroadcaster() as unknown as WsBroadcaster),
    new QueueManager(db),
    dataDir,
    null,
    undefined,
    undefined,
    {
      cliPathForKind: () => null,
      cliPathForSession: () => null,
      requireCliPathForSession: () => null,
      agentRuntime: () => { throw Object.assign(new Error('Agent was deleted'), { code: 'AGENT_DELETED' }); },
      agentRuntimeProfile: async () => { throw new Error('Agent was deleted'); },
      agentsForKind: () => [],
    },
    undefined,
    planner,
  );
  await resumed.sendMessage(created.id, 'resume after delete');
  const client = proxyB.get(created.id);
  assert.ok(client);
  assert.equal(client.pluginId, 'io.gian.fixture');
  db.prepare(`UPDATE turns SET status = 'completed' WHERE session_id = ? AND status = 'running'`)
    .run(created.id);

  await assert.rejects(
    () => store.removeVersion('io.gian.fixture', '1.0.0'),
    (error: unknown) => error instanceof PluginReferencedError,
  );
  await assert.rejects(
    () => store.removeVersion('io.gian.fixture', '2.0.0'),
    (error: unknown) => error instanceof PluginReferencedError,
  );

  const current = await store.currentLaunch('io.gian.fixture');
  assert.equal(current?.pluginVersion, '2.0.0');

  await writeFile(join(root, 'plugins', 'io.gian.fixture', '1.0.0', 'manifest.json'), '{"tampered":true}\n');
  const proxyC = new ProxyManager({ dataDir: join(root, 'proxy-c') });
  t.after(() => proxyC.closeAll());
  const damaged = new SessionManager(
    db,
    proxyC,
    new CapturingBroadcaster() as unknown as WsBroadcaster,
    new ApprovalManager(new CapturingBroadcaster() as unknown as WsBroadcaster),
    new QueueManager(db),
    dataDir,
    null,
    undefined,
    undefined,
    {
      cliPathForKind: () => null,
      cliPathForSession: () => null,
      requireCliPathForSession: () => null,
      agentRuntime: () => { throw new Error('unused'); },
      agentRuntimeProfile: async () => null,
      agentsForKind: () => [],
    },
    undefined,
    planner,
  );
  await assert.rejects(
    () => damaged.sendMessage(created.id, 'must fail closed'),
    /digest|revalidation|quarantine|binding|TRUSTED_LAUNCH|PLUGIN_/i,
  );
  assert.equal(proxyC.get(created.id), undefined);
});

function fakeLaunch(pluginId: string, version: string, digest: string, entryPath: string) {
  return {
    pluginId,
    pluginVersion: version,
    manifestSha256: digest,
    protocolRange: '^2.2',
    entryPath,
    processScope: 'session' as const,
    schemaVersion: 4 as const,
    runtime: { kind: 'none' as const },
    source: 'plugin-store' as const,
  };
}

function fakeExternalLaunch(
  pluginId: string,
  version: string,
  digest: string,
  entryPath: string,
  processScope: 'shared' | 'session' = 'session',
) {
  return {
    ...fakeLaunch(pluginId, version, digest, entryPath),
    processScope,
    runtime: {
      kind: 'external' as const,
      id: 'fixture-runtime',
      displayName: 'Fixture Runtime',
      verifiedVersions: ['1.0.0'],
    },
  };
}

function fakeLegacyLaunch(
  pluginId: string,
  version: string,
  digest: string,
  entryPath: string,
  processScope: 'shared' | 'session' = 'session',
) {
  return {
    ...fakeExternalLaunch(pluginId, version, digest, entryPath, processScope),
    schemaVersion: 3 as const,
    protocolRange: '>=2.0 <2.2',
  };
}

function openProfile(agentId: string, path = '/tmp/fixture-runtime'): import('@gian/shared').OpenRuntimeProfile {
  return {
    id: 'runtime-profile-1',
    agentId,
    pluginId: parseProxyPluginId('io.gian.fixture'),
    runtimeId: 'fixture-runtime',
    path,
    version: '1.0.0',
    configHome: '/tmp/fixture-config',
    contentFingerprint: 'fingerprint-1',
    verifiedVersions: ['1.0.0'],
    verification: 'verified',
  };
}

test('exact v3 reattach preserves stored protocol 2.0 and passes the saved Runtime path', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gian-v3-exact-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entry = join(root, 'proxy.mjs');
  const runtimeBin = join(root, 'claude');
  await writeFile(entry, 'export {}\n');
  await writeFile(runtimeBin, '#!/bin/sh\nexit 0\n');
  const digest = '9'.repeat(64);
  const profile: import('@gian/shared').AgentRuntimeProfile = {
    id: 'legacy-v3-runtime',
    agentId: 'agent-v3',
    pluginId: parseProxyPluginId('claude'),
    proxy: 'claude',
    cliPath: runtimeBin,
    cliVersion: '1.0.0',
    configHome: null,
    cliFingerprint: 'fingerprint-v3',
    proxyVersion: '1.0.0',
    verifiedCliVersions: ['1.0.0'],
    verification: 'verified',
    skill: { name: 'gian-session', version: '1.0.0', state: 'ready' },
  };
  const binding: SessionProxyBinding = {
    schemaVersion: 1,
    pluginId: parseProxyPluginId('claude'),
    pluginVersion: '1.0.0',
    manifestSha256: digest,
    protocolVersion: '2.0',
    processScope: 'session',
    runtimeProfile: profile,
  };
  const planner = new SessionBindingPlanner({
    resolveCurrent: async () => { throw new Error('current package must not be consulted'); },
    resolveExact: async () => fakeLegacyLaunch('claude', '1.0.0', digest, entry),
  });

  const prepared = await planner.prepareExact(binding);
  assert.equal(prepared.launchBinding.protocolVersion, '2.0');
  const lease = await prepared.acquireLease();
  assert.equal(lease?.binaryPath, runtimeBin);
  assert.ok((lease?.env.PATH ?? '').includes(root));
  await lease?.release();
  await prepared.releaseUnusedLease();
});

test('exact Runtime accepts launchable drift, rejects identity drift, and releases rejects', async () => {
  const entry = '/tmp/proxy.mjs';
  const digest = '8'.repeat(64);
  const stored = openProfile('agent-exact');
  const binding: SessionProxyBinding = {
    schemaVersion: 1,
    pluginId: parseProxyPluginId('io.gian.fixture'),
    pluginVersion: '1.0.0',
    manifestSha256: digest,
    protocolVersion: '2.2',
    processScope: 'session',
    runtimeProfile: stored,
  };
  const plannerFor = (resolvedProfile: import('@gian/shared').OpenRuntimeProfile) => {
    let released = 0;
    const planner = new SessionBindingPlanner({
      resolveCurrent: async () => null,
      resolveExact: async () => fakeExternalLaunch('io.gian.fixture', '1.0.0', digest, entry),
      runtimeResolver: {
        resolve: async () => ({
          profile: resolvedProfile,
          lease: {
            binaryPath: resolvedProfile.path ?? '/tmp/fixture-runtime',
            version: resolvedProfile.version ?? '1.0.0',
            source: 'override' as const,
            env: Object.freeze({}),
            release: async () => { released += 1; },
          },
        }),
      } as unknown as RuntimeResolver,
    });
    return { planner, released: () => released };
  };

  const identityMutations: Array<[string, import('@gian/shared').OpenRuntimeProfile]> = [
    ['runtimeId', { ...stored, runtimeId: 'runtime-other' }],
    ['path', { ...stored, path: '/tmp/runtime-other' }],
    ['pluginId', { ...stored, pluginId: parseProxyPluginId('io.gian.other') }],
  ];
  for (const [field, resolvedProfile] of identityMutations) {
    const { planner, released } = plannerFor(resolvedProfile);
    await assert.rejects(
      () => planner.prepareExact(binding),
      /Runtime|path|profile/i,
      field,
    );
    assert.equal(released(), 1, `${field} mismatch must release the prepared lease`);
  }

  const driftMutations: Array<[string, import('@gian/shared').OpenRuntimeProfile]> = [
    ['id', { ...stored, id: 'runtime-profile-2' }],
    ['version', { ...stored, version: '1.0.1' }],
    ['contentFingerprint', { ...stored, contentFingerprint: 'fingerprint-other' }],
    ['verifiedVersions', { ...stored, verifiedVersions: ['1.0.1'] }],
    ['verification', { ...stored, verification: 'unverified' }],
  ];
  for (const [field, resolvedProfile] of driftMutations) {
    const { planner } = plannerFor(resolvedProfile);
    const prepared = await planner.prepareExact(binding);
    assert.ok(prepared.remintedBinding, `${field} drift must re-mint the stored binding`);
    assert.deepEqual(prepared.sessionBinding, { ...binding, runtimeProfile: resolvedProfile }, field);
    assert.deepEqual(prepared.remintedBinding, prepared.sessionBinding, field);
    assert.deepEqual(
      prepared.launchBinding.runtimeProfile,
      { identity: resolvedProfile.id },
      `${field} drift must launch against the fresh profile identity`,
    );
    const lease = await prepared.acquireLease();
    assert.equal(lease?.binaryPath, resolvedProfile.path ?? '/tmp/fixture-runtime');
    await lease?.release();
    await prepared.releaseUnusedLease();
  }

  const { planner } = plannerFor(openProfile('agent-exact'));
  const prepared = await planner.prepareExact(binding);
  assert.equal(prepared.remintedBinding, undefined);
  assert.strictEqual(prepared.sessionBinding, binding);
  assert.deepEqual(prepared.launchBinding.runtimeProfile, { identity: stored.id });
  const lease = await prepared.acquireLease();
  await lease?.release();
  await prepared.releaseUnusedLease();
});

test('Runtime upgrade on resume re-mints and persists the exact binding', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gian-remint-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entry = join(root, 'proxy.mjs');
  await writeFile(entry, 'export {}\n');
  const digest = '5'.repeat(64);
  const agent: UserAgent = {
    id: randomUUID(),
    name: 'Remint',
    pluginId: parseProxyPluginId('io.gian.fixture'),
    proxy: null,
    cliPath: '/tmp/fixture-runtime',
    defaults: { model: '', thinking: '', mode: '' },
  };
  const baseProfile = (agentId: string): import('@gian/shared').OpenRuntimeProfile => ({
    ...openProfile(agentId),
    configHome: null,
  });
  const upgradedProfile = (agentId: string): import('@gian/shared').OpenRuntimeProfile => ({
    ...baseProfile(agentId),
    id: 'runtime-profile-2',
    version: '1.0.1',
    contentFingerprint: 'fingerprint-2',
    verifiedVersions: ['1.0.1'],
  });
  const plannerFor = (profileFor: (agentId: string) => import('@gian/shared').OpenRuntimeProfile) => (
    new SessionBindingPlanner({
      resolveCurrent: async () => fakeExternalLaunch('io.gian.fixture', '1.0.0', digest, entry),
      resolveExact: async () => fakeExternalLaunch('io.gian.fixture', '1.0.0', digest, entry),
      runtimeResolver: {
        resolve: async (input: { agentId: string; selectedPath: string | null }) => ({
          profile: profileFor(input.agentId),
          lease: {
            binaryPath: input.selectedPath ?? '/tmp/fixture-runtime',
            version: '1.0.0',
            source: 'override' as const,
            env: Object.freeze({}),
            release: async () => {},
          },
        }),
      } as unknown as RuntimeResolver,
    })
  );
  const db = openDatabase(root);
  const wsId = randomUUID();
  db.prepare('INSERT OR IGNORE INTO workspaces (id, name, path) VALUES (?, ?, ?)')
    .run(wsId, 'ws', root);
  const makeSessions = (proxy: FakeProxyManager, planner: SessionBindingPlanner) => new SessionManager(
    db,
    proxy as unknown as ProxyManager,
    new CapturingBroadcaster() as unknown as WsBroadcaster,
    new ApprovalManager(new CapturingBroadcaster() as unknown as WsBroadcaster),
    new QueueManager(db),
    root,
    null,
    undefined,
    undefined,
    resolverFor([agent]),
    undefined,
    planner,
  );
  const bindingRow = (sessionId: string) => db.prepare(
    'SELECT proxy_binding_json, runtime_profile_json FROM sessions WHERE id = ?',
  ).get(sessionId) as { proxy_binding_json: string | null; runtime_profile_json: string | null };

  const first = makeSessions(
    new FakeProxyManager('native-remint', false, false, 'always'),
    plannerFor(baseProfile),
  );
  const created = await first.createSession({ workspace_id: wsId, agent_id: agent.id });
  const createdProfile = created.proxy_binding?.runtimeProfile as
    import('@gian/shared').OpenRuntimeProfile | null;
  assert.equal(createdProfile?.version, '1.0.0');

  const second = makeSessions(
    new FakeProxyManager('native-remint', false, false, 'always'),
    plannerFor(upgradedProfile),
  );
  await second.sendMessage(created.id, 'resume after the CLI self-update');
  const reminted = second.getSession(created.id);
  const remintedProfile = reminted.proxy_binding?.runtimeProfile as
    import('@gian/shared').OpenRuntimeProfile | null;
  assert.equal(remintedProfile?.id, 'runtime-profile-2');
  assert.equal(remintedProfile?.version, '1.0.1');
  assert.equal(remintedProfile?.contentFingerprint, 'fingerprint-2');
  assert.deepEqual(remintedProfile?.verifiedVersions, ['1.0.1']);
  assert.equal(remintedProfile?.path, '/tmp/fixture-runtime');
  assert.equal(remintedProfile?.runtimeId, 'fixture-runtime');
  assert.equal(reminted.proxy_binding?.pluginVersion, '1.0.0');
  assert.equal(reminted.proxy_binding?.manifestSha256, digest);
  const remintedRow = bindingRow(created.id);
  assert.ok(remintedRow.proxy_binding_json?.includes('"id":"runtime-profile-2"'));
  assert.ok(remintedRow.proxy_binding_json?.includes('"version":"1.0.1"'));
  assert.ok(remintedRow.runtime_profile_json?.includes('"id":"runtime-profile-2"'));
  assert.ok(remintedRow.runtime_profile_json?.includes('"version":"1.0.1"'));
  db.prepare(`UPDATE turns SET status = 'completed' WHERE session_id = ? AND status = 'running'`)
    .run(created.id);

  const before = bindingRow(created.id).proxy_binding_json;
  const third = makeSessions(
    new FakeProxyManager('native-remint', false, false, 'always'),
    plannerFor(upgradedProfile),
  );
  await third.sendMessage(created.id, 'resume without further drift');
  assert.equal(
    bindingRow(created.id).proxy_binding_json,
    before,
    'an unchanged generation must not rewrite the stored binding',
  );
  db.close();
});

test('prepared Runtime leases transfer only to new processes and release on reuse', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gian-prepared-lease-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entry = join(root, 'proxy.mjs');
  await writeFile(entry, 'export {}\n');
  const digest = '7'.repeat(64);
  const agent: UserAgent = {
    id: randomUUID(),
    name: 'Lease fixture',
    pluginId: parseProxyPluginId('io.gian.fixture'),
    proxy: null,
    cliPath: '/tmp/fixture-runtime',
    defaults: { model: '', thinking: '', mode: '' },
  };
  const releases: number[] = [];
  const runtimeResolver = {
    resolve: async (input: { agentId: string; selectedPath: string | null }) => {
      const index = releases.push(0) - 1;
      return {
        profile: openProfile(input.agentId, input.selectedPath ?? '/tmp/fixture-runtime'),
        lease: {
          binaryPath: input.selectedPath ?? '/tmp/fixture-runtime',
          version: '1.0.0',
          source: 'override' as const,
          env: Object.freeze({}),
          release: async () => { releases[index] = (releases[index] ?? 0) + 1; },
        },
      };
    },
  } as unknown as RuntimeResolver;
  const planner = new SessionBindingPlanner({
    resolveCurrent: async () => fakeExternalLaunch(
      'io.gian.fixture', '1.0.0', digest, entry, 'shared',
    ),
    resolveExact: async () => fakeExternalLaunch(
      'io.gian.fixture', '1.0.0', digest, entry, 'shared',
    ),
    runtimeResolver,
  });
  const db = openDatabase(root);
  const wsId = randomUUID();
  db.prepare('INSERT OR IGNORE INTO workspaces (id, name, path) VALUES (?, ?, ?)')
    .run(wsId, 'ws', root);
  const proxy = new FakeProxyManager('native-lease', false, false, 'first');
  const makeSessions = () => new SessionManager(
    db,
    proxy as unknown as ProxyManager,
    new CapturingBroadcaster() as unknown as WsBroadcaster,
    new ApprovalManager(new CapturingBroadcaster() as unknown as WsBroadcaster),
    new QueueManager(db),
    root,
    null,
    undefined,
    undefined,
    resolverFor([agent]),
    undefined,
    planner,
  );
  const firstManager = makeSessions();
  const first = await firstManager.createSession({
    workspace_id: wsId,
    agent_id: agent.id,
    name: 'first lease',
  });
  assert.deepEqual(releases, [0], 'the first process owns its transferred lease');

  const second = await firstManager.createSession({
    workspace_id: wsId,
    agent_id: agent.id,
    name: 'second lease',
  });
  assert.deepEqual(releases, [0, 1], 'shared-process reuse releases its unused prepared lease');

  const rehydrated = makeSessions();
  await rehydrated.sendMessage(first.id, 'reuse the existing exact facade');
  assert.deepEqual(releases, [0, 1, 1], 'same-session reuse also releases the unused lease');
  db.prepare(`UPDATE turns SET status = 'completed' WHERE session_id = ? AND status = 'running'`)
    .run(first.id);

  await proxy.dispose(first.id);
  await proxy.dispose(second.id);
  assert.deepEqual(releases, [1, 1, 1]);
  db.close();
});

test('legacy first attach captures exact facts once; failed capture writes nothing', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gian-legacy-capture-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtimeBin = join(root, 'claude');
  await writeFile(runtimeBin, '#!/bin/sh\nexit 0\n');
  const agent: UserAgent = {
    id: randomUUID(),
    name: 'Legacy',
    pluginId: parseProxyPluginId('claude'),
    proxy: 'claude',
    cliPath: runtimeBin,
    defaults: { model: '', thinking: '', mode: '' },
  };
  const db = openDatabase(root);
  const wsId = randomUUID();
  db.prepare('INSERT OR IGNORE INTO workspaces (id, name, path) VALUES (?, ?, ?)')
    .run(wsId, 'ws', root);
  const digest = 'c'.repeat(64);
  const entry = join(root, 'proxy.mjs');
  await writeFile(entry, 'export {}\n');
  const runtimeProfile: import('@gian/shared').AgentRuntimeProfile = {
    id: 'legacy-runtime-profile',
    agentId: agent.id,
    pluginId: parseProxyPluginId('claude'),
    proxy: 'claude',
    cliPath: runtimeBin,
    cliVersion: '1.0.0',
    configHome: null,
    cliFingerprint: 'legacy-fingerprint',
    proxyVersion: '1.0.0',
    verifiedCliVersions: ['1.0.0'],
    verification: 'verified',
    skill: { name: 'gian-session', version: '1.0.0', state: 'ready' },
  };
  const planner = new SessionBindingPlanner({
    resolveCurrent: async () => fakeLegacyLaunch('claude', '1.0.0', digest, entry),
    resolveExact: async () => fakeLegacyLaunch('claude', '1.0.0', digest, entry),
  });
  const agentResolver = {
    ...resolverFor([agent]),
    cliPathForSession: (session: import('@gian/shared').Session) =>
      sessionRuntimeCliPath(session.runtime_profile),
    requireCliPathForSession: (session: import('@gian/shared').Session) => {
      const path = sessionRuntimeCliPath(session.runtime_profile);
      if (!path) throw new Error('missing stored legacy Runtime path');
      return path;
    },
    agentRuntimeProfile: async () => runtimeProfile,
  };
  const firstProxy = new FakeProxyManager('native-legacy');
  const first = new SessionManager(
    db,
    firstProxy as unknown as ProxyManager,
    new CapturingBroadcaster() as unknown as WsBroadcaster,
    new ApprovalManager(new CapturingBroadcaster() as unknown as WsBroadcaster),
    new QueueManager(db),
    root,
    null,
    undefined,
    undefined,
    agentResolver,
  );
  const created = await first.createSession({
    workspace_id: wsId,
    agent_id: agent.id,
  });
  assert.equal(created.proxy_binding, null);
  assert.equal(firstProxy.getOrCreateCalls, 1);

  const secondProxy = new FakeProxyManager('native-legacy', false, false, 'always');
  const second = new SessionManager(
    db,
    secondProxy as unknown as ProxyManager,
    new CapturingBroadcaster() as unknown as WsBroadcaster,
    new ApprovalManager(new CapturingBroadcaster() as unknown as WsBroadcaster),
    new QueueManager(db),
    root,
    null,
    undefined,
    undefined,
    agentResolver,
    undefined,
    planner,
  );
  await second.sendMessage(created.id, 'capture');
  const captured = second.getSession(created.id);
  assert.equal(captured.proxy_binding?.manifestSha256, digest);
  assert.equal(captured.proxy_binding?.pluginVersion, '1.0.0');
  assert.equal(secondProxy.getOrCreateCalls, 0);
  assert.equal(secondProxy.acquireCalls, 1);
  assert.deepEqual(secondProxy.runtimeBins, [runtimeBin]);
  db.prepare(`UPDATE turns SET status = 'completed' WHERE session_id = ? AND status = 'running'`)
    .run(created.id);

  const thirdProxy = new FakeProxyManager('native-legacy', false, false, 'always');
  const third = new SessionManager(
    db,
    thirdProxy as unknown as ProxyManager,
    new CapturingBroadcaster() as unknown as WsBroadcaster,
    new ApprovalManager(new CapturingBroadcaster() as unknown as WsBroadcaster),
    new QueueManager(db),
    root,
    null,
    undefined,
    undefined,
    agentResolver,
    undefined,
    planner,
  );
  await third.sendMessage(created.id, 'exact-only');
  assert.equal(thirdProxy.acquireCalls, 1);
  assert.equal(thirdProxy.getOrCreateCalls, 0);
  assert.deepEqual(thirdProxy.runtimeBins, [runtimeBin]);
  assert.equal(third.getSession(created.id).proxy_binding?.manifestSha256, digest);
});

test('failed legacy capture writes nothing', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gian-legacy-fail-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agent: UserAgent = {
    id: randomUUID(),
    name: 'Legacy',
    pluginId: parseProxyPluginId('claude'),
    proxy: 'claude',
    cliPath: '/tmp/claude',
    defaults: { model: '', thinking: '', mode: '' },
  };
  const db = openDatabase(root);
  const wsId = randomUUID();
  db.prepare('INSERT OR IGNORE INTO workspaces (id, name, path) VALUES (?, ?, ?)')
    .run(wsId, 'ws', root);
  const first = new SessionManager(
    db,
    new FakeProxyManager('native-fail') as unknown as ProxyManager,
    new CapturingBroadcaster() as unknown as WsBroadcaster,
    new ApprovalManager(new CapturingBroadcaster() as unknown as WsBroadcaster),
    new QueueManager(db),
    root,
    null,
    undefined,
    undefined,
    resolverFor([agent]),
  );
  const created = await first.createSession({ workspace_id: wsId, agent_id: agent.id });
  assert.equal(created.proxy_binding, null);
  const exploding = new SessionBindingPlanner({
    resolveCurrent: async () => { throw new Error('capture exploded'); },
    resolveExact: async () => { throw new Error('unused'); },
  });
  const second = new SessionManager(
    db,
    new FakeProxyManager('native-fail') as unknown as ProxyManager,
    new CapturingBroadcaster() as unknown as WsBroadcaster,
    new ApprovalManager(new CapturingBroadcaster() as unknown as WsBroadcaster),
    new QueueManager(db),
    root,
    null,
    undefined,
    undefined,
    resolverFor([agent]),
    undefined,
    exploding,
  );
  await assert.rejects(() => second.sendMessage(created.id, 'must not persist'), /capture exploded/);
  assert.equal(second.getSession(created.id).proxy_binding, null);
});

test('fork inherits the parent exact binding and not the Agent current package', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gian-fork-binding-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const digest = 'f'.repeat(64);
  const entry = join(root, 'proxy.mjs');
  await writeFile(entry, 'export {}\n');
  const agent: UserAgent = {
    id: randomUUID(),
    name: 'Fixture',
    pluginId: parseProxyPluginId('io.gian.fixture'),
    proxy: null,
    cliPath: null,
    defaults: { model: '', thinking: '', mode: '' },
  };
  let currentVersion = '1.0.0';
  const planner = new SessionBindingPlanner({
    resolveCurrent: async () => fakeLaunch('io.gian.fixture', currentVersion, digest, entry),
    resolveExact: async (input) => fakeLaunch(input.pluginId, input.pluginVersion, digest, entry),
  });
  const db = openDatabase(root);
  const wsId = randomUUID();
  db.prepare('INSERT OR IGNORE INTO workspaces (id, name, path) VALUES (?, ?, ?)')
    .run(wsId, 'ws', root);
  const proxy = new FakeProxyManager('native-fork');
  const sessions = new SessionManager(
    db,
    proxy as unknown as ProxyManager,
    new CapturingBroadcaster() as unknown as WsBroadcaster,
    new ApprovalManager(new CapturingBroadcaster() as unknown as WsBroadcaster),
    new QueueManager(db),
    root,
    null,
    undefined,
    undefined,
    resolverFor([agent]),
    undefined,
    planner,
  );
  const parent = await sessions.createSession({ workspace_id: wsId, agent_id: agent.id });
  assert.equal(parent.proxy_binding?.pluginVersion, '1.0.0');
  db.prepare(
    `INSERT INTO turns (id, session_id, turn_number, status, created_at, completed_at)
     VALUES ('t1', ?, 1, 'completed', '2026-09-03T00:00:00.000Z', '2026-09-03T00:00:00.000Z')`,
  ).run(parent.id);
  db.prepare(
    `INSERT INTO proxy_replay_turns (session_id, provider_turn_id, turn_id) VALUES (?, 'src-1', 't1')`,
  ).run(parent.id);
  currentVersion = '2.0.0';
  const result = await sessions.forkSession({
    sourceSessionId: parent.id,
    anchor: { type: 'head' },
  });
  const child = sessions.getSession(result.sessionId);
  assert.deepEqual(child.proxy_binding, parent.proxy_binding);
  assert.equal(child.proxy_binding?.pluginVersion, '1.0.0');
  const newer = await sessions.createSession({ workspace_id: wsId, agent_id: agent.id });
  assert.equal(newer.proxy_binding?.pluginVersion, '2.0.0');
});

test('native uniqueness is per pluginId and publish failure discards the facade', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gian-native-unique-live-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const digest = 'd'.repeat(64);
  const entry = join(root, 'proxy.mjs');
  await writeFile(entry, 'export {}\n');
  const fixture: UserAgent = {
    id: randomUUID(),
    name: 'A',
    pluginId: parseProxyPluginId('io.gian.fixture'),
    proxy: null,
    cliPath: null,
    defaults: { model: '', thinking: '', mode: '' },
  };
  const other: UserAgent = {
    id: randomUUID(),
    name: 'B',
    pluginId: parseProxyPluginId('io.gian.other'),
    proxy: null,
    cliPath: null,
    defaults: { model: '', thinking: '', mode: '' },
  };
  const planner = new SessionBindingPlanner({
    resolveCurrent: async (pluginId) => fakeLaunch(pluginId, '1.0.0', digest, entry),
    resolveExact: async (input) => fakeLaunch(input.pluginId, '1.0.0', digest, entry),
  });
  const db = openDatabase(root);
  const wsId = randomUUID();
  db.prepare('INSERT OR IGNORE INTO workspaces (id, name, path) VALUES (?, ?, ?)')
    .run(wsId, 'ws', root);
  const proxy = new FakeProxyManager('native-shared', false, true);
  const sessions = new SessionManager(
    db,
    proxy as unknown as ProxyManager,
    new CapturingBroadcaster() as unknown as WsBroadcaster,
    new ApprovalManager(new CapturingBroadcaster() as unknown as WsBroadcaster),
    new QueueManager(db),
    root,
    null,
    undefined,
    undefined,
    resolverFor([fixture, other]),
    undefined,
    planner,
  );
  const first = await sessions.createSession({ workspace_id: wsId, agent_id: fixture.id });
  assert.equal(first.native_session_id, 'native-shared');
  const second = await sessions.createSession({ workspace_id: wsId, agent_id: other.id });
  assert.equal(second.native_session_id, 'native-shared');
  assert.notEqual(first.id, second.id);
  await assert.rejects(
    () => sessions.createSession({ workspace_id: wsId, agent_id: fixture.id }),
    /UNIQUE|unique|already/i,
  );
  assert.ok(proxy.disposed.length >= 1);
});

test('database publication failure releases the transferred exact Runtime lease', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gian-publish-lease-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entry = join(root, 'proxy.mjs');
  await writeFile(entry, 'export {}\n');
  const digest = '6'.repeat(64);
  const agent: UserAgent = {
    id: randomUUID(),
    name: 'Publish fixture',
    pluginId: parseProxyPluginId('io.gian.fixture'),
    proxy: null,
    cliPath: '/tmp/fixture-runtime',
    defaults: { model: '', thinking: '', mode: '' },
  };
  const releases: number[] = [];
  const planner = new SessionBindingPlanner({
    resolveCurrent: async () => fakeExternalLaunch('io.gian.fixture', '1.0.0', digest, entry),
    resolveExact: async () => fakeExternalLaunch('io.gian.fixture', '1.0.0', digest, entry),
    runtimeResolver: {
      resolve: async (input: { agentId: string; selectedPath: string | null }) => {
        const index = releases.push(0) - 1;
        return {
          profile: openProfile(input.agentId, input.selectedPath ?? '/tmp/fixture-runtime'),
          lease: {
            binaryPath: input.selectedPath ?? '/tmp/fixture-runtime',
            version: '1.0.0',
            source: 'override' as const,
            env: Object.freeze({}),
            release: async () => { releases[index] = (releases[index] ?? 0) + 1; },
          },
        };
      },
    } as unknown as RuntimeResolver,
  });
  const db = openDatabase(root);
  const wsId = randomUUID();
  db.prepare('INSERT OR IGNORE INTO workspaces (id, name, path) VALUES (?, ?, ?)')
    .run(wsId, 'ws', root);
  const proxy = new FakeProxyManager('native-publish-conflict', false, true, 'always');
  const sessions = new SessionManager(
    db,
    proxy as unknown as ProxyManager,
    new CapturingBroadcaster() as unknown as WsBroadcaster,
    new ApprovalManager(new CapturingBroadcaster() as unknown as WsBroadcaster),
    new QueueManager(db),
    root,
    null,
    undefined,
    undefined,
    resolverFor([agent]),
    undefined,
    planner,
  );
  const first = await sessions.createSession({
    workspace_id: wsId,
    agent_id: agent.id,
    name: 'published',
  });
  await assert.rejects(
    () => sessions.createSession({
      workspace_id: wsId,
      agent_id: agent.id,
      name: 'conflict',
    }),
    /UNIQUE|unique|already/i,
  );
  assert.deepEqual(releases, [0, 1]);
  await proxy.dispose(first.id);
  assert.deepEqual(releases, [1, 1]);
  db.close();
});

test('create racing a current package flip binds wholly to one generation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gian-binding-race-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entry = join(root, 'proxy.mjs');
  await writeFile(entry, 'export {}\n');
  const oldDigest = 'a'.repeat(64);
  const newDigest = 'b'.repeat(64);
  const fixture: UserAgent = {
    id: randomUUID(),
    name: 'Race',
    pluginId: parseProxyPluginId('io.gian.fixture'),
    proxy: null,
    cliPath: null,
    defaults: { model: '', thinking: '', mode: '' },
  };
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  let currentCalls = 0;
  const planner = new SessionBindingPlanner({
    resolveCurrent: async (pluginId) => {
      currentCalls += 1;
      if (currentCalls === 1) {
        await firstGate;
        return fakeLaunch(pluginId, '1.0.0', oldDigest, entry);
      }
      return fakeLaunch(pluginId, '2.0.0', newDigest, entry);
    },
    resolveExact: async (input) => fakeLaunch(
      input.pluginId,
      input.pluginVersion,
      input.expectedManifestSha256,
      entry,
    ),
  });
  const db = openDatabase(root);
  const wsId = randomUUID();
  db.prepare('INSERT OR IGNORE INTO workspaces (id, name, path) VALUES (?, ?, ?)')
    .run(wsId, 'ws', root);
  const sessions = new SessionManager(
    db,
    new FakeProxyManager('native-race') as unknown as ProxyManager,
    new CapturingBroadcaster() as unknown as WsBroadcaster,
    new ApprovalManager(new CapturingBroadcaster() as unknown as WsBroadcaster),
    new QueueManager(db),
    root,
    null,
    undefined,
    undefined,
    resolverFor([fixture]),
    undefined,
    planner,
  );
  const firstPromise = sessions.createSession({ workspace_id: wsId, agent_id: fixture.id });
  while (currentCalls < 1) await new Promise(resolve => setImmediate(resolve));
  const secondPromise = sessions.createSession({ workspace_id: wsId, agent_id: fixture.id });
  releaseFirst();
  const created = await Promise.all([firstPromise, secondPromise]);
  for (const session of created) {
    const binding = session.proxy_binding;
    assert.ok(binding);
    if (binding.pluginVersion === '1.0.0') {
      assert.equal(binding.manifestSha256, oldDigest);
    } else {
      assert.equal(binding.pluginVersion, '2.0.0');
      assert.equal(binding.manifestSha256, newDigest);
    }
    assert.equal(binding.protocolVersion, '2.3');
    assert.notEqual(
      binding.manifestSha256,
      syntheticOfficialDigest(binding.pluginId, entry, binding.pluginVersion),
    );
  }
  assert.equal(
    new Set(created.map(session => session.proxy_binding?.pluginVersion)).size,
    2,
    'the race must observe both fully validated generations rather than one mixed pair',
  );
});

test('resumable bindings keep finished worktrees and archived sessions (ADR-0080)', () => {
  const binding: SessionProxyBinding = {
    schemaVersion: 1,
    pluginId: parseProxyPluginId('io.gian.fixture'),
    pluginVersion: '1.0.0',
    manifestSha256: 'e'.repeat(64),
    protocolVersion: '2.2',
    processScope: 'session',
    runtimeProfile: null,
  };
  assert.equal(isResumableSessionBinding({ proxy_binding: binding }), true);
  // A finalized worktree outcome is legacy metadata and never blocks resume.
  const legacyFinalizedRow = { proxy_binding: binding, worktree_outcome: 'merged' };
  assert.equal(isResumableSessionBinding(legacyFinalizedRow), true);
  assert.equal(isResumableSessionBinding({
    proxy_binding: binding,
    proxy_binding_error: 'PROXY_BINDING_INVALID',
  }), false);
});
