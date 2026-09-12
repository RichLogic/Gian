import { strict as assert } from 'node:assert';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Hono } from 'hono';

import {
  compileCatalogBundle,
  type CatalogEntryV1,
} from '@gian/proxy-catalog-contract';
import {
  KNOWN_PROTOCOL_VERSIONS,
  SUPPORTED_PROTOCOL_VERSIONS,
  protocolRangeIncludes,
} from '@gian/proxy-protocol';
import { parseProxyPluginId, type OfficialCatalogSourcePolicy } from '@gian/shared';

import { AgentManager } from '../src/agents/manager.js';
import { CatalogService } from '../src/catalog/service.js';
import { RuntimeReadinessCache } from '../src/runtime/readiness-cache.js';
import { RuntimeResolver } from '../src/runtime/resolver.js';
import { CatalogStore } from '../src/catalog/store.js';
import { classifyCatalogCompatibility } from '../src/catalog/compatibility.js';
import { AgentUpdateBusyError, type AgentUpdateLease } from '../src/agents/update-lock.js';
import { offeredProtocolVersionsForInstall, offeredProtocolVersionsForRange } from '../src/plugin-store/initialize.js';
import { runProtectedProxyChild } from '../src/proxy/protected-handshake.js';
import { PluginStore } from '../src/plugin-store/store.js';
import { PluginStoreError, PluginVersionConflictError } from '../src/plugin-store/errors.js';
import { MAX_PLUGIN_TOTAL_BYTES } from '../src/plugin-store/limits.js';
import { extractGzipUstar } from '../src/plugin-store/safe-extract.js';
import type { PluginArtifactNetwork, PluginInstallCoordinate } from '../src/plugin-store/types.js';
import { registerAgentRoutes } from '../src/web/routes/agents.js';
import { ProxyManager } from '../src/proxy/manager.js';
import { ProtocolV2SessionClient } from '../src/proxy/protocol-v2-session-client.js';

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
  'hex',
);

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
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

function fixtureProxySource(
  id: string,
  version: string,
  allowedProtocols: readonly string[],
): string {
  return `#!/usr/bin/env node
const id = ${JSON.stringify(id)};
const version = ${JSON.stringify(version)};
const allowed = ${JSON.stringify(allowedProtocols)};
if (process.argv.includes('--self-test')) {
  if (process.env.GIAN_RUNTIME_BIN) process.exit(2);
  process.stdout.write(JSON.stringify({
    schemaVersion: 4,
    id,
    pluginVersion: version,
    ok: true,
  }) + '\\n');
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
          jsonrpc: '2.0',
          id: req.id,
          error: { code: -32602, message: 'offered protocol is outside the Manifest range' },
        }) + '\\n');
        return;
      }
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: req.id,
        result: {
          protocol: { name: 'gian.proxy', version: chosen },
          plugin: { id, name: 'Gian Fixture', version },
          process: { scope: 'session' },
          capabilities: chosen === '2.2'
            ? { 'runtime.discover': 1, 'runtime.probe': 1 }
            : {},
        },
      }) + '\\n');
    } else if (req.method === 'catalog.list') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: req.id,
        result: {
          catalogRevision: 'rev-1',
          input: [{ type: 'text' }],
          configOptions: [],
          slashCommands: [],
          ...(chosen === '2.0' ? {} : { specialCatalogs: {} }),
        },
      }) + '\\n');
    } else if (req.method === 'session.create') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: req.id,
        result: {
          session: {
            id: req.params.sessionId,
            nativeSession: { id: 'native-1' },
            streamId: 'stream-1',
            state: 'idle',
            sessionConfig: req.params.config ?? {},
            createdAt: emittedAt,
            updatedAt: emittedAt,
          },
        },
      }) + '\\n');
    } else if (req.method === 'turn.start') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: req.id,
        result: { accepted: true, turnId: req.params.turnId },
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
          jsonrpc: '2.0',
          method,
          params: { ...base, eventId, sequence, data },
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

function packageFiles(
  version: string,
  protocolRange = '^2.2',
  pluginId = 'io.gian.fixture',
): { files: Map<string, Buffer>; manifest: Buffer } {
  const files = new Map<string, Buffer>();
  const allowedProtocols = KNOWN_PROTOCOL_VERSIONS.filter((item) => (
    protocolRangeIncludes(protocolRange, item)
  ));
  files.set('proxy.mjs', Buffer.from(fixtureProxySource(pluginId, version, allowedProtocols)));
  files.set('assets/logo-light.png', PNG);
  files.set('assets/logo-dark.png', PNG);
  const manifestObject = {
    schemaVersion: 4,
    id: pluginId,
    displayName: 'Gian Fixture',
    pluginVersion: version,
    entry: 'proxy.mjs',
    protocol: { name: 'gian.proxy', range: protocolRange },
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

function artifactUrls(version: string, releaseId = 'fixture') {
  const tag = `proxy-${releaseId}-v${version}`;
  const archive = `gian-proxy-${releaseId}-${version}-darwin-arm64.tar.gz`;
  return {
    tag,
    archive,
    manifest: `${archive}.manifest.json`,
    archiveUrl: `https://github.com/RichLogic/Gian/releases/download/${tag}/${archive}`,
    manifestUrl: `https://github.com/RichLogic/Gian/releases/download/${tag}/${archive}.manifest.json`,
  };
}

function compileCatalog(
  sequence: number,
  version: string,
  manifest: Buffer,
  archive: Buffer,
  keys: ReturnType<typeof makeSigningKeys>,
  identity: { pluginId?: string; releaseId?: string } = {},
) {
  const pluginId = identity.pluginId ?? 'io.gian.fixture';
  const urls = artifactUrls(version, identity.releaseId ?? 'fixture');
  const entry: CatalogEntryV1 = {
    schemaVersion: 1,
    pluginId,
    displayName: 'Gian Fixture',
    tagline: 'Unknown reverse-domain Catalog fixture',
    featuredOrder: 90,
    documentation: {
      overview: 'overview.md',
      setup: 'setup.md',
      usage: 'usage.md',
      troubleshooting: 'troubleshooting.md',
    },
    branding: {
      logoLight: { path: 'assets/logo-light.png', mediaType: 'image/png' },
      logoDark: { path: 'assets/logo-dark.png', mediaType: 'image/png' },
    },
    channels: {
      stable: {
        pluginVersion: version,
        manifest: { url: urls.manifestUrl, sha256: sha256(manifest), size: manifest.byteLength },
        artifacts: {
          'darwin-arm64': { url: urls.archiveUrl, sha256: sha256(archive), size: archive.byteLength },
        },
      },
    },
  };
  return compileCatalogBundle({
    sourceId: 'gian-official',
    sequence,
    issuedAt: '2026-09-02T00:00:00.000Z',
    allowedArtifactRepositories: ['RichLogic/Gian'],
    signingKey: { keyId: 'gian-official-catalog-2026', privateKey: keys.privateKey },
    plugins: [{
      entry,
      documents: {
        overview: `# Overview ${version}\n`,
        setup: '# Setup\n',
        usage: '# Usage\n',
        troubleshooting: '# Troubleshooting\n',
      },
      logos: { light: PNG, dark: PNG },
      manifestSidecar: manifest,
    }],
  });
}

function makeSigningKeys() {
  const pair = generateKeyPairSync('ed25519');
  return {
    privateKey: pair.privateKey,
    publicKeyHex: pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'),
  };
}

function policyFor(keys: ReturnType<typeof makeSigningKeys>): OfficialCatalogSourcePolicy {
  return {
    sourceId: 'gian-official',
    repository: 'RichLogic/Gian-Proxy-Catalog',
    artifactRepositories: ['RichLogic/Gian'],
    pinnedPublicKeys: { 'gian-official-catalog-2026': keys.publicKeyHex },
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
  protocolRange = '^2.2',
  identity: { pluginId?: string; releaseId?: string } = {},
): PluginInstallCoordinate {
  const urls = artifactUrls(version, identity.releaseId ?? 'fixture');
  return {
    pluginId: identity.pluginId ?? 'io.gian.fixture',
    pluginVersion: version,
    platform: 'darwin-arm64',
    manifest: { url: urls.manifestUrl, sha256: sha256(manifest), size: manifest.byteLength },
    archive: { url: urls.archiveUrl, sha256: sha256(archive), size: archive.byteLength },
    sourceId: 'gian-official',
    catalogSequence: sequence,
    protocolRange,
    processScope: 'session',
    runtime: { kind: 'none' },
  };
}

async function tempRoot(t: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'gian-plugin-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('safe extract rejects traversal, symlink, and special members', async (t) => {
  const root = await tempRoot(t);
  const dest = join(root, 'out');
  const good = packageFiles('0.1.0');
  const archive = createGzipUstar(good.files);
  const extracted = await extractGzipUstar(archive, dest);
  assert.equal(extracted.has('manifest.json'), true);

  const traversal = createGzipUstar(new Map([['../escape', Buffer.from('nope')]]));
  await assert.rejects(() => extractGzipUstar(traversal, join(root, 'trav')), /Unsafe|PLUGIN_PATH/);

  const header = Buffer.alloc(512, 0);
  Buffer.from('link').copy(header, 0);
  header[156] = 0x32;
  header.fill(' ', 148, 156);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'utf8');
  const symlinkArchive = gzipSync(Buffer.concat([header, Buffer.alloc(1024)]));
  await assert.rejects(() => extractGzipUstar(symlinkArchive, join(root, 'link')), /symlink|special/i);
});

test('unknown signed fixture installs, updates, rolls back, and reports references', async (t) => {
  const root = await tempRoot(t);
  const keys = makeSigningKeys();
  const v1 = packageFiles('0.1.0');
  const v2 = packageFiles('0.2.0');
  const archive1 = createGzipUstar(v1.files);
  const archive2 = createGzipUstar(v2.files);
  const urls1 = artifactUrls('0.1.0');
  const urls2 = artifactUrls('0.2.0');
  const assets = new Map<string, Buffer>([
    [`RichLogic/Gian:${urls1.tag}:${urls1.archive}`, archive1],
    [`RichLogic/Gian:${urls1.tag}:${urls1.manifest}`, v1.manifest],
    [`RichLogic/Gian:${urls2.tag}:${urls2.archive}`, archive2],
    [`RichLogic/Gian:${urls2.tag}:${urls2.manifest}`, v2.manifest],
  ]);
  const store = new PluginStore({
    dataDir: root,
    pluginsDir: join(root, 'plugins'),
    network: memoryNetwork(assets),
    allowedArtifactRepositories: ['RichLogic/Gian'],
    hostVersion: '0.1.0',
    hostVersions: ['2.2', '2.1', '2.0'],
    listBindingReferences: () => [
      { pluginId: 'io.gian.fixture', pluginVersion: '0.1.0' },
    ],
  });

  const first = await store.install(coordinate('0.1.0', v1.manifest, archive1, 1));
  assert.equal(first.pluginId, 'io.gian.fixture');
  assert.equal(first.pluginVersion, '0.1.0');
  assert.equal(first.negotiatedProtocol, '2.2');
  assert.equal(first.processScope, 'session');
  assert.equal(first.archiveSha256, sha256(archive1));
  const reused = await store.install(coordinate('0.1.0', v1.manifest, archive1, 1));
  assert.equal(reused.archiveSha256, first.archiveSha256);

  const second = await store.install(coordinate('0.2.0', v2.manifest, archive2, 2));
  assert.equal(second.pluginVersion, '0.2.0');
  assert.equal((await store.inspect('io.gian.fixture')).currentVersion, '0.2.0');

  const rolled = await store.rollback('io.gian.fixture');
  assert.equal(rolled.pluginVersion, '0.1.0');
  assert.equal((await store.inspect('io.gian.fixture')).currentVersion, '0.1.0');

  const refs = await store.reportReferences('io.gian.fixture', '0.1.0');
  assert.equal(refs.current, true);
  assert.equal(refs.sessionBindings, 1);
  assert.equal(refs.inFlight, false);

  const other = createGzipUstar(new Map([...v1.files, ['extra.txt', Buffer.from('different')]]));
  assets.set(`RichLogic/Gian:${urls1.tag}:${urls1.archive}`, other);
  await assert.rejects(
    () => store.install(coordinate('0.1.0', v1.manifest, other, 1)),
    (error: unknown) => error instanceof PluginVersionConflictError,
  );
  assert.equal((await store.inspect('io.gian.fixture')).currentVersion, '0.1.0');
});

test('reserved official pluginId installs from Catalog in production but not over a GianDev bundle', async (t) => {
  const root = await tempRoot(t);
  const keys = makeSigningKeys();
  const pkg = packageFiles('1.0.0', '^2.2', 'claude');
  const archive = createGzipUstar(pkg.files);
  const urls = artifactUrls('1.0.0', 'claude');
  const bundle = compileCatalog(1, '1.0.0', pkg.manifest, archive, keys, {
    pluginId: 'claude',
    releaseId: 'claude',
  });
  const policy = policyFor(keys);
  const catalogStore = new CatalogStore({
    rootDir: join(root, 'catalogs', 'gian-official'),
    policy,
  });
  await catalogStore.open();
  await catalogStore.ingest(bundle.files);
  const assets = new Map<string, Buffer>([
    [`RichLogic/Gian:${urls.tag}:${urls.archive}`, archive],
    [`RichLogic/Gian:${urls.tag}:${urls.manifest}`, pkg.manifest],
  ]);
  const plugins = new PluginStore({
    dataDir: root,
    pluginsDir: join(root, 'plugins'),
    network: memoryNetwork(assets),
    allowedArtifactRepositories: policy.artifactRepositories,
    hostVersion: '0.1.0',
    hostVersions: ['2.2', '2.1', '2.0'],
  });
  const production = new CatalogService({
    store: catalogStore,
    plugins,
    policy,
    hostVersions: ['2.2', '2.1', '2.0'],
    platform: 'darwin-arm64',
    officialPresence: async () => null,
  });
  assert.deepEqual((await production.get('claude'))?.availableActions, ['install_proxy']);
  await production.install('claude');
  const installed = await production.get('claude');
  assert.equal(installed?.installation.state, 'installed');
  assert.equal(installed?.availableActions.includes('create_agent'), true);

  const devRoot = join(root, 'dev');
  const devPlugins = new PluginStore({
    dataDir: devRoot,
    pluginsDir: join(devRoot, 'plugins'),
    network: memoryNetwork(new Map()),
    allowedArtifactRepositories: policy.artifactRepositories,
    hostVersion: '0.1.0',
    hostVersions: ['2.2', '2.1', '2.0'],
  });
  const development = new CatalogService({
    store: catalogStore,
    plugins: devPlugins,
    policy,
    hostVersions: ['2.2', '2.1', '2.0'],
    platform: 'darwin-arm64',
    officialPresence: async () => ({
      pluginId: 'claude',
      pluginVersion: '1.0.0',
      entryPath: join(root, 'dev-proxy.mjs'),
      processScope: 'session',
      schemaVersion: 4,
      runtime: { kind: 'none' },
    }),
  });
  const bundled = await development.get('claude');
  assert.equal(bundled?.installation.state, 'installed');
  assert.equal(bundled?.availableActions.includes('install_proxy'), false);
  assert.equal(bundled?.availableActions.includes('update_proxy'), false);
});

test('reverse-domain official Agent status resolves the PluginStore package by canonical pluginId', async (t) => {
  const root = await tempRoot(t);
  const pluginId = 'ai.deepseek.harness';
  const pkg = packageFiles('1.0.0', '^2.2', pluginId);
  const archive = createGzipUstar(pkg.files);
  const urls = artifactUrls('1.0.0', 'dsh');
  const plugins = new PluginStore({
    dataDir: root,
    pluginsDir: join(root, 'plugins'),
    network: memoryNetwork(new Map([
      [`RichLogic/Gian:${urls.tag}:${urls.archive}`, archive],
      [`RichLogic/Gian:${urls.tag}:${urls.manifest}`, pkg.manifest],
    ])),
    allowedArtifactRepositories: ['RichLogic/Gian'],
    hostVersion: '0.1.0',
    hostVersions: ['2.2', '2.1', '2.0'],
  });
  await plugins.install(coordinate('1.0.0', pkg.manifest, archive, 1, '^2.2', {
    pluginId,
    releaseId: 'dsh',
  }));
  const runtimeResolver = new RuntimeResolver({
    dataDir: join(root, 'runtime'),
    updateLockDataDir: join(root, 'locks'),
    hostVersion: '0.1.0',
  });
  const agents = await AgentManager.create({
    dataDir: join(root, 'agents'),
    releaseVersion: '0.1.0',
    managedProxies: true,
    pluginStore: plugins,
    runtimeResolver,
    allowCreateWithoutCatalog: true,
    homeDir: join(root, 'home'),
    pathEnv: '',
  });
  const agent = await agents.createAgent({ name: 'Canonical DSH', pluginId });
  assert.equal(agent.proxy, 'dsh');
  const status = await agents.agentStatus(agent.id, true);
  assert.equal(status.ready, false, 'a Proxy package alone is not a certified Runtime generation');
  assert.equal(status.cli.state, 'missing');
  assert.equal(status.plugin.version, '1.0.0');
  assert.match(status.plugin.path ?? '', /plugins\/ai\.deepseek\.harness\/1\.0\.0\/proxy\.mjs$/);
  assert.doesNotMatch(status.plugin.path ?? '', /plugins\/dsh\//);
});

test('exact launch resolves retained versions and never falls back to current', async (t) => {
  const root = await tempRoot(t);
  const v1 = packageFiles('0.1.0');
  const v2 = packageFiles('0.2.0');
  const archive1 = createGzipUstar(v1.files);
  const archive2 = createGzipUstar(v2.files);
  const urls1 = artifactUrls('0.1.0');
  const urls2 = artifactUrls('0.2.0');
  const assets = new Map<string, Buffer>([
    [`RichLogic/Gian:${urls1.tag}:${urls1.archive}`, archive1],
    [`RichLogic/Gian:${urls1.tag}:${urls1.manifest}`, v1.manifest],
    [`RichLogic/Gian:${urls2.tag}:${urls2.archive}`, archive2],
    [`RichLogic/Gian:${urls2.tag}:${urls2.manifest}`, v2.manifest],
  ]);
  const store = new PluginStore({
    dataDir: root,
    pluginsDir: join(root, 'plugins'),
    network: memoryNetwork(assets),
    allowedArtifactRepositories: ['RichLogic/Gian'],
    hostVersion: '0.1.0',
    hostVersions: ['2.2', '2.1', '2.0'],
  });

  const first = await store.install(coordinate('0.1.0', v1.manifest, archive1, 1));
  await store.install(coordinate('0.2.0', v2.manifest, archive2, 2));
  assert.equal((await store.inspect('io.gian.fixture')).currentVersion, '0.2.0');

  const retained = await store.resolveExactLaunch({
    pluginId: 'io.gian.fixture',
    pluginVersion: '0.1.0',
    expectedManifestSha256: first.manifestSha256,
  });
  assert.equal(retained.pluginVersion, '0.1.0');
  assert.equal(retained.manifestSha256, first.manifestSha256);
  assert.equal(retained.processScope, 'session');
  assert.match(retained.entryPath, /proxy\.mjs$/);

  await assert.rejects(
    () => store.resolveExactLaunch({
      pluginId: 'io.gian.fixture',
      pluginVersion: '0.1.0',
      expectedManifestSha256: '',
    }),
    (error: unknown) => error instanceof PluginStoreError && error.code === 'PLUGIN_DIGEST_MISMATCH',
  );
  await assert.rejects(
    () => store.resolveExactLaunch({
      pluginId: 'io.gian.fixture',
      pluginVersion: '0.3.0',
      expectedManifestSha256: first.manifestSha256,
    }),
    (error: unknown) => error instanceof PluginStoreError && error.code === 'PLUGIN_NOT_FOUND',
  );
  await assert.rejects(
    () => store.resolveExactLaunch({
      pluginId: 'io.gian.fixture',
      pluginVersion: '0.1.0',
      expectedManifestSha256: '0'.repeat(64),
    }),
    (error: unknown) => error instanceof PluginStoreError && error.code === 'PLUGIN_DIGEST_MISMATCH',
  );

  await writeFile(join(root, 'plugins', 'io.gian.fixture', '0.1.0', 'proxy.mjs'), 'tampered\n');
  await assert.rejects(
    () => store.resolveExactLaunch({
      pluginId: 'io.gian.fixture',
      pluginVersion: '0.1.0',
      expectedManifestSha256: first.manifestSha256,
    }),
    (error: unknown) => error instanceof PluginStoreError && error.code === 'PLUGIN_QUARANTINED',
  );
  assert.equal((await store.inspect('io.gian.fixture')).currentVersion, '0.2.0');
});

test('bad digest, self-test, handshake, and mutated receipt fail closed', async (t) => {
  const root = await tempRoot(t);
  const v1 = packageFiles('0.1.0');
  const archive = createGzipUstar(v1.files);
  const urls = artifactUrls('0.1.0');
  const assets = new Map<string, Buffer>([
    [`RichLogic/Gian:${urls.tag}:${urls.archive}`, archive],
    [`RichLogic/Gian:${urls.tag}:${urls.manifest}`, v1.manifest],
  ]);
  const store = new PluginStore({
    dataDir: root,
    pluginsDir: join(root, 'plugins'),
    network: memoryNetwork(assets),
    allowedArtifactRepositories: ['RichLogic/Gian'],
    hostVersion: '0.1.0',
    hostVersions: ['2.2', '2.1', '2.0'],
  });
  const good = coordinate('0.1.0', v1.manifest, archive, 1);
  await assert.rejects(
    () => store.install({
      ...good,
      archive: { ...good.archive, sha256: 'a'.repeat(64) },
    }),
    (error: unknown) => error instanceof PluginStoreError && error.code === 'PLUGIN_DIGEST',
  );
  await assert.rejects(
    () => store.install({
      ...good,
      archive: {
        url: 'https://evil.example/x.tar.gz',
        sha256: sha256(archive),
        size: archive.byteLength,
      },
    }),
    (error: unknown) => error instanceof PluginStoreError && error.code === 'PLUGIN_URL_REJECTED',
  );

  const brokenSelfTest = packageFiles('0.1.0');
  brokenSelfTest.files.set('proxy.mjs', Buffer.from('process.exit(2)\n'));
  const brokenArchive = createGzipUstar(brokenSelfTest.files);
  assets.set(`RichLogic/Gian:${urls.tag}:${urls.archive}`, brokenArchive);
  await assert.rejects(
    () => store.install({
      ...good,
      archive: { ...good.archive, sha256: sha256(brokenArchive), size: brokenArchive.byteLength },
    }),
    (error: unknown) => error instanceof PluginStoreError && error.code === 'PLUGIN_SELF_TEST',
  );
  assets.set(`RichLogic/Gian:${urls.tag}:${urls.archive}`, archive);

  const receipt = await store.install(good);
  const versionDir = join(root, 'plugins', 'io.gian.fixture', '0.1.0');
  await writeFile(join(versionDir, 'proxy.mjs'), 'throw new Error("mutated")\n');
  const inspected = await store.inspect('io.gian.fixture');
  assert.equal(inspected.currentVersion, '0.1.0');
  assert.equal(inspected.versions[0]?.state, 'quarantined');
  assert.equal(receipt.pluginVersion, '0.1.0');
});

test('CatalogService lists, installs, and serves docs/logo without spawning on list', async (t) => {
  const root = await tempRoot(t);
  const keys = makeSigningKeys();
  const v1 = packageFiles('0.1.0');
  const v2 = packageFiles('0.2.0');
  const archive1 = createGzipUstar(v1.files);
  const archive2 = createGzipUstar(v2.files);
  const bundle1 = compileCatalog(1, '0.1.0', v1.manifest, archive1, keys);
  const bundle2 = compileCatalog(2, '0.2.0', v2.manifest, archive2, keys);
  const policy = policyFor(keys);
  const catalogStore = new CatalogStore({
    rootDir: join(root, 'catalogs', 'gian-official'),
    policy,
  });
  await catalogStore.open();
  await catalogStore.ingest(bundle1.files);

  const urls1 = artifactUrls('0.1.0');
  const urls2 = artifactUrls('0.2.0');
  const plugins = new PluginStore({
    dataDir: root,
    pluginsDir: join(root, 'plugins'),
    network: memoryNetwork(new Map([
      [`RichLogic/Gian:${urls1.tag}:${urls1.archive}`, archive1],
      [`RichLogic/Gian:${urls1.tag}:${urls1.manifest}`, v1.manifest],
      [`RichLogic/Gian:${urls2.tag}:${urls2.archive}`, archive2],
      [`RichLogic/Gian:${urls2.tag}:${urls2.manifest}`, v2.manifest],
    ])),
    allowedArtifactRepositories: policy.artifactRepositories,
    hostVersion: '0.1.0',
    hostVersions: ['2.2', '2.1', '2.0'],
  });
  const readinessCache = new RuntimeReadinessCache();
  const service = new CatalogService({
    store: catalogStore,
    plugins,
    policy,
    hostVersions: ['2.2', '2.1', '2.0'],
    platform: 'darwin-arm64',
    readinessCache,
  });

  const listed = await service.list();
  assert.equal(listed.source.state, 'ready');
  assert.equal(listed.items.length, 1);
  assert.equal(listed.items[0]?.pluginId, 'io.gian.fixture');
  assert.equal(listed.items[0]?.compatibility.state, 'compatible');
  assert.equal(listed.items[0]?.installation.state, 'not_installed');
  assert.deepEqual(listed.items[0]?.availableActions, ['install_proxy']);

  const production = classifyCatalogCompatibility('^2.2');
  assert.equal(production.state, 'compatible');
  assert.equal(classifyCatalogCompatibility('^2.2', ['2.1', '2.0']).state, 'requires_app_update');

  const installed = await service.install('io.gian.fixture');
  assert.equal(installed.negotiatedProtocol, '2.2');
  const afterInstall = await service.get('io.gian.fixture');
  assert.equal(afterInstall?.installation.state, 'installed');
  assert.equal(afterInstall?.runtime.state, 'not_required');
  assert.ok(afterInstall?.availableActions.includes('create_agent'));
  readinessCache.publish({
    pluginId: 'io.gian.fixture',
    pluginVersion: '0.1.0',
    selectedPath: null,
    profileIdentity: 'ready-before-update',
    state: 'not_required',
    displayName: 'Fixture',
  });
  assert.equal(readinessCache.isInvalidated('io.gian.fixture', '0.1.0'), false);

  await catalogStore.ingest(bundle2.files);
  const updated = await service.update('io.gian.fixture');
  assert.equal(updated.pluginVersion, '0.2.0');
  assert.equal(readinessCache.isInvalidated('io.gian.fixture', '0.1.0'), true);
  readinessCache.publish({
    pluginId: 'io.gian.fixture',
    pluginVersion: '0.2.0',
    selectedPath: null,
    profileIdentity: 'ready-before-rollback',
    state: 'not_required',
    displayName: 'Fixture',
  });
  const rolled = await service.rollback('io.gian.fixture');
  assert.equal(rolled.pluginVersion, '0.1.0');
  assert.equal(readinessCache.isInvalidated('io.gian.fixture', '0.2.0'), true);

  const logo = await service.logo('io.gian.fixture', 'light');
  assert.ok(logo);
  assert.equal(logo.mediaType, 'image/png');
  const docs = await service.documentation('io.gian.fixture', 'overview');
  assert.ok(docs);
  assert.equal(docs.mediaType, 'text/markdown; charset=utf-8');
  assert.match(docs.bytes.toString('utf8'), /Overview/);

  const agents = await AgentManager.create({
    dataDir: join(root, 'agents-data'),
    releaseVersion: '0.1.0',
    managedProxies: false,
    developmentProxyEntries: {
      claude: join(root, 'proxy.mjs'),
      codex: join(root, 'proxy.mjs'),
      kimi: join(root, 'proxy.mjs'),
      dsh: join(root, 'proxy.mjs'),
    },
    homeDir: join(root, 'home'),
    pathEnv: '',
  });
  await writeFile(join(root, 'proxy.mjs'), 'export {};\n');
  const app = new Hono();
  registerAgentRoutes(app, {
    agents,
    closeProxy: async () => undefined,
    catalogService: service,
    capabilities: async () => ({
      catalogRevision: 'test',
      input: [{ type: 'text' }],
      configOptions: [],
      slashCommands: [],
    }),
  });
  const list = await app.request('/api/proxies');
  assert.equal(list.status, 200);
  const body = await list.json() as {
    proxies: Array<{ id: string }>;
    catalog: { items: Array<{ pluginId: string; installation: { state: string } }> };
  };
  assert.ok(body.proxies.some((item) => item.id === 'claude'));
  assert.equal(body.catalog.items[0]?.pluginId, 'io.gian.fixture');
  assert.equal(body.catalog.items[0]?.installation.state, 'installed');

  const doc = await app.request('/api/proxies/io.gian.fixture/docs/overview');
  assert.equal(doc.status, 200);
  assert.equal(doc.headers.get('content-type'), 'text/markdown; charset=utf-8');
  const image = await app.request('/api/proxies/io.gian.fixture/logo/light');
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
});

test('legacy current, unmanaged current, handshake, and lock stay fail-closed', async (t) => {
  const root = await tempRoot(t);
  const v1 = packageFiles('0.1.0');
  const v2 = packageFiles('0.2.0');
  const archive1 = createGzipUstar(v1.files);
  const archive2 = createGzipUstar(v2.files);
  const urls1 = artifactUrls('0.1.0');
  const urls2 = artifactUrls('0.2.0');
  const assets = new Map<string, Buffer>([
    [`RichLogic/Gian:${urls1.tag}:${urls1.archive}`, archive1],
    [`RichLogic/Gian:${urls1.tag}:${urls1.manifest}`, v1.manifest],
    [`RichLogic/Gian:${urls2.tag}:${urls2.archive}`, archive2],
    [`RichLogic/Gian:${urls2.tag}:${urls2.manifest}`, v2.manifest],
  ]);
  const store = new PluginStore({
    dataDir: root,
    pluginsDir: join(root, 'plugins'),
    network: memoryNetwork(assets),
    allowedArtifactRepositories: ['RichLogic/Gian'],
    hostVersion: '0.1.0',
    hostVersions: ['2.2', '2.1', '2.0'],
  });

  await mkdir(join(root, 'plugins', 'claude', '1.0.0'), { recursive: true });
  await writeFile(join(root, 'plugins', 'claude', '1.0.0', 'proxy.mjs'), 'export {}\n');
  await symlink('1.0.0', join(root, 'plugins', 'claude', 'current'));
  await assert.rejects(
    () => store.install({
      ...coordinate('0.1.0', v1.manifest, archive1, 1),
      pluginId: 'claude',
    }),
    (error: unknown) => error instanceof PluginStoreError
      && error.code === 'PLUGIN_CURRENT_UNMANAGED',
  );
  assert.equal(await readlink(join(root, 'plugins', 'claude', 'current')), '1.0.0');
  assert.equal(
    (await store.listInstalled()).find((item) => item.pluginId === 'claude')?.currentPointer,
    'valid',
  );
  assert.equal(
    (await store.inspect('claude')).versions.find(item => item.version === '1.0.0')?.state,
    'legacy',
  );

  await mkdir(join(root, 'plugins', 'io.gian.fixture', '0.0.1'), { recursive: true });
  await writeFile(join(root, 'plugins', 'io.gian.fixture', '0.0.1', 'proxy.mjs'), 'export {}\n');
  await symlink('0.0.1', join(root, 'plugins', 'io.gian.fixture', 'current'));
  await assert.rejects(
    () => store.install(coordinate('0.1.0', v1.manifest, archive1, 1)),
    (error: unknown) => error instanceof PluginStoreError && error.code === 'PLUGIN_CURRENT_UNMANAGED',
  );
  assert.equal(await readlink(join(root, 'plugins', 'io.gian.fixture', 'current')), '0.0.1');

  await rm(join(root, 'plugins', 'io.gian.fixture'), { recursive: true, force: true });

  const handshakeFiles = packageFiles('0.1.0');
  handshakeFiles.files.set('proxy.mjs', Buffer.from(`#!/usr/bin/env node
if (process.argv.includes('--self-test')) {
  process.stdout.write(JSON.stringify({
    schemaVersion: 4,
    id: 'io.gian.fixture',
    pluginVersion: '0.1.0',
    ok: true,
  }) + '\\n');
  process.exit(0);
}
import('node:readline').then(({ createInterface }) => {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    const req = JSON.parse(line);
    if (req.method === 'initialize') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: req.id,
        result: {
          protocol: { name: 'gian.proxy', version: '2.1' },
          plugin: { id: 'io.gian.fixture', name: 'Gian Fixture', version: '0.1.0' },
          process: { scope: 'session' },
          capabilities: {},
        },
      }) + '\\n');
    }
  });
});
`));
  const handshakeArchive = createGzipUstar(handshakeFiles.files);
  assets.set(`RichLogic/Gian:${urls1.tag}:${urls1.archive}`, handshakeArchive);
  await assert.rejects(
    () => store.install({
      ...coordinate('0.1.0', handshakeFiles.manifest, handshakeArchive, 1),
      archive: {
        ...coordinate('0.1.0', handshakeFiles.manifest, handshakeArchive, 1).archive,
        sha256: sha256(handshakeArchive),
        size: handshakeArchive.byteLength,
      },
    }),
    (error: unknown) => error instanceof PluginStoreError && error.code === 'PLUGIN_INITIALIZE',
  );
  assets.set(`RichLogic/Gian:${urls1.tag}:${urls1.archive}`, archive1);

  const first = store.install(coordinate('0.1.0', v1.manifest, archive1, 1));
  const second = store.install(coordinate('0.2.0', v2.manifest, archive2, 2));
  const settled = await Promise.allSettled([first, second]);
  assert.ok(settled.some((item) => (
    item.status === 'rejected'
    && item.reason instanceof AgentUpdateBusyError
  )));
  const current = (await store.inspect('io.gian.fixture')).currentVersion;
  assert.ok(current === '0.1.0' || current === '0.2.0');
  assert.ok(await store.revalidateVersion('io.gian.fixture', current!));
});

test('install offers integrated 2.3/2.2 ranges and still rejects unknown ranges', async (t) => {
  assert.deepEqual(offeredProtocolVersionsForInstall('^2.2'), ['2.3', '2.2']);
  assert.deepEqual(offeredProtocolVersionsForInstall('>=2.2 <3.0'), ['2.3', '2.2']);
  assert.deepEqual(offeredProtocolVersionsForInstall('>=2.1 <3.0'), ['2.3', '2.2', '2.1']);
  assert.throws(
    () => offeredProtocolVersionsForInstall('>=3.0 <4.0'),
    (error: unknown) => error instanceof PluginStoreError && error.code === 'PLUGIN_PROTOCOL_INCOMPATIBLE',
  );
  const root = await tempRoot(t);
  let downloaded = false;
  const v1 = packageFiles('0.1.0');
  const archive = createGzipUstar(v1.files);
  const store = new PluginStore({
    dataDir: root,
    pluginsDir: join(root, 'plugins'),
    network: {
      async download() {
        downloaded = true;
        throw new Error('network must not run');
      },
    },
    allowedArtifactRepositories: ['RichLogic/Gian'],
    hostVersion: '0.1.0',
  });
  await assert.rejects(
    () => store.install(coordinate('0.1.0', v1.manifest, archive, 1, '>=3.0 <4.0')),
    (error: unknown) => error instanceof PluginStoreError && error.code === 'PLUGIN_PROTOCOL_INCOMPATIBLE',
  );
  assert.equal(downloaded, false);
  assert.equal((await store.inspect('io.gian.fixture')).currentPointer, 'absent');
});

test('integrated ranges offer 2.3 then the 2.2 Runtime baseline before legacy versions', () => {
  assert.deepEqual([...SUPPORTED_PROTOCOL_VERSIONS], ['2.3', '2.2', '2.1', '2.0']);
  assert.deepEqual([...KNOWN_PROTOCOL_VERSIONS], ['2.3', '2.2', '2.1', '2.0']);
  assert.deepEqual(offeredProtocolVersionsForRange('>=2.1 <3.0'), ['2.3', '2.2', '2.1']);
  assert.deepEqual(offeredProtocolVersionsForRange('^2.2'), ['2.3', '2.2']);
  assert.deepEqual(
    offeredProtocolVersionsForRange('>=2.1 <3.0', ['2.2', '2.1', '2.0']),
    ['2.2', '2.1'],
  );
});

test('incompatible Catalog actions stay disabled and update never downgrades', async (t) => {
  const root = await tempRoot(t);
  const keys = makeSigningKeys();
  const v1 = packageFiles('0.1.0');
  const v2 = packageFiles('0.2.0');
  const archive1 = createGzipUstar(v1.files);
  const archive2 = createGzipUstar(v2.files);
  const bundle1 = compileCatalog(1, '0.1.0', v1.manifest, archive1, keys);
  const bundle2 = compileCatalog(2, '0.2.0', v2.manifest, archive2, keys);
  const policy = policyFor(keys);
  const catalogStore = new CatalogStore({
    rootDir: join(root, 'catalogs', 'gian-official'),
    policy,
  });
  await catalogStore.open();
  await catalogStore.ingest(bundle2.files);
  const urls2 = artifactUrls('0.2.0');
  const plugins = new PluginStore({
    dataDir: root,
    pluginsDir: join(root, 'plugins'),
    network: memoryNetwork(new Map([
      [`RichLogic/Gian:${urls2.tag}:${urls2.archive}`, archive2],
      [`RichLogic/Gian:${urls2.tag}:${urls2.manifest}`, v2.manifest],
    ])),
    allowedArtifactRepositories: policy.artifactRepositories,
    hostVersion: '0.1.0',
    hostVersions: ['2.2', '2.1', '2.0'],
  });
  const production = new CatalogService({
    store: catalogStore,
    plugins,
    policy,
    hostVersions: ['2.1', '2.0'],
    platform: 'darwin-arm64',
  });
  const listed = await production.list();
  assert.equal(listed.items[0]?.compatibility.state, 'requires_app_update');
  assert.deepEqual(listed.items[0]?.availableActions, []);
  await assert.rejects(
    () => production.install('io.gian.fixture'),
    (error: unknown) => error instanceof PluginStoreError && error.code === 'CATALOG_INSTALL_FORBIDDEN',
  );

  const compatible = new CatalogService({
    store: catalogStore,
    plugins,
    policy,
    hostVersions: ['2.2', '2.1', '2.0'],
    platform: 'darwin-arm64',
  });
  await compatible.install('io.gian.fixture');
  const olderLatest = compileCatalog(3, '0.1.0', v1.manifest, archive1, keys);
  await catalogStore.ingest(olderLatest.files);
  await assert.rejects(
    () => compatible.update('io.gian.fixture'),
    (error: unknown) => error instanceof PluginStoreError && error.code === 'CATALOG_UPDATE_FORBIDDEN',
  );
  assert.equal((await plugins.inspect('io.gian.fixture')).currentVersion, '0.2.0');
});

test('gzip bombs fail before extract and invalid pluginId is a 400', async (t) => {
  const root = await tempRoot(t);
  const bomb = gzipSync(Buffer.alloc(MAX_PLUGIN_TOTAL_BYTES + 1024 * 1024, 0));
  await assert.rejects(
    () => extractGzipUstar(bomb, join(root, 'bomb')),
    (error: unknown) => error instanceof PluginStoreError && error.code === 'PLUGIN_PACKAGE_SIZE',
  );

  const keys = makeSigningKeys();
  const v1 = packageFiles('0.1.0');
  const archive = createGzipUstar(v1.files);
  const bundle = compileCatalog(1, '0.1.0', v1.manifest, archive, keys);
  const policy = policyFor(keys);
  const catalogStore = new CatalogStore({
    rootDir: join(root, 'catalogs', 'gian-official'),
    policy,
  });
  await catalogStore.open();
  await catalogStore.ingest(bundle.files);
  const service = new CatalogService({
    store: catalogStore,
    plugins: new PluginStore({
      dataDir: root,
      pluginsDir: join(root, 'plugins'),
      network: { async download() { throw new Error('unused'); } },
      allowedArtifactRepositories: policy.artifactRepositories,
      hostVersion: '0.1.0',
    }),
    policy,
    platform: 'darwin-arm64',
  });
  const app = new Hono();
  registerAgentRoutes(app, {
    agents: { list: async () => [] } as never,
    closeProxy: async () => undefined,
    catalogService: service,
    capabilities: async () => ({
      catalogRevision: 'test',
      input: [{ type: 'text' }],
      configOptions: [],
      slashCommands: [],
    }),
  });
  const response = await app.request('/api/proxies/not%20an%20id/install', { method: 'POST' });
  assert.equal(response.status, 400);
});

test('current last-known-good survives post-publish failure and rejects unmanaged pointers', async (t) => {
  const root = await tempRoot(t);
  const v1 = packageFiles('0.1.0');
  const v2 = packageFiles('0.2.0');
  const archive1 = createGzipUstar(v1.files);
  const archive2 = createGzipUstar(v2.files);
  const urls1 = artifactUrls('0.1.0');
  const urls2 = artifactUrls('0.2.0');
  const assets = new Map<string, Buffer>([
    [`RichLogic/Gian:${urls1.tag}:${urls1.archive}`, archive1],
    [`RichLogic/Gian:${urls1.tag}:${urls1.manifest}`, v1.manifest],
    [`RichLogic/Gian:${urls2.tag}:${urls2.archive}`, archive2],
    [`RichLogic/Gian:${urls2.tag}:${urls2.manifest}`, v2.manifest],
  ]);
  const store = new PluginStore({
    dataDir: root,
    pluginsDir: join(root, 'plugins'),
    network: memoryNetwork(assets),
    allowedArtifactRepositories: ['RichLogic/Gian'],
    hostVersion: '0.1.0',
    hostVersions: ['2.2', '2.1', '2.0'],
    hooks: {
      afterPublish: async () => {
        const current = join(root, 'plugins', 'io.gian.fixture', 'current');
        try {
          if ((await readlink(current)) !== '0.2.0') return;
        } catch {
          return;
        }
        await unlink(current);
        await writeFile(current, 'not-a-symlink');
      },
    },
  });
  await store.install(coordinate('0.1.0', v1.manifest, archive1, 1));
  await assert.rejects(
    () => store.install(coordinate('0.2.0', v2.manifest, archive2, 2)),
    /failed post-publish|PLUGIN_QUARANTINED|not a PluginStore-owned symlink/,
  );
  const inspected = await store.inspect('io.gian.fixture');
  assert.equal(inspected.currentVersion, '0.1.0');
  assert.equal(inspected.currentPointer, 'valid');
  assert.equal(await readlink(join(root, 'plugins', 'io.gian.fixture', 'current')), '0.1.0');

  await unlink(join(root, 'plugins', 'io.gian.fixture', 'current'));
  await writeFile(join(root, 'plugins', 'io.gian.fixture', 'current'), 'regular-file');
  const unmanaged = new PluginStore({
    dataDir: root,
    pluginsDir: join(root, 'plugins'),
    network: memoryNetwork(assets),
    allowedArtifactRepositories: ['RichLogic/Gian'],
    hostVersion: '0.1.0',
    hostVersions: ['2.2', '2.1', '2.0'],
  });
  await assert.rejects(
    () => unmanaged.install(coordinate('0.2.0', v2.manifest, archive2, 2)),
    (error: unknown) => error instanceof PluginStoreError && error.code === 'PLUGIN_CURRENT_UNMANAGED',
  );
  assert.equal((await lstat(join(root, 'plugins', 'io.gian.fixture', 'current'))).isSymbolicLink(), false);
  assert.equal((await unmanaged.inspect('io.gian.fixture')).currentPointer, 'unmanaged');
});

test('restore failure is explicit and does not report a healthy store', async (t) => {
  const root = await tempRoot(t);
  const v1 = packageFiles('0.1.0');
  const v2 = packageFiles('0.2.0');
  const archive1 = createGzipUstar(v1.files);
  const archive2 = createGzipUstar(v2.files);
  const urls1 = artifactUrls('0.1.0');
  const urls2 = artifactUrls('0.2.0');
  const store = new PluginStore({
    dataDir: root,
    pluginsDir: join(root, 'plugins'),
    network: memoryNetwork(new Map([
      [`RichLogic/Gian:${urls1.tag}:${urls1.archive}`, archive1],
      [`RichLogic/Gian:${urls1.tag}:${urls1.manifest}`, v1.manifest],
      [`RichLogic/Gian:${urls2.tag}:${urls2.archive}`, archive2],
      [`RichLogic/Gian:${urls2.tag}:${urls2.manifest}`, v2.manifest],
    ])),
    allowedArtifactRepositories: ['RichLogic/Gian'],
    hostVersion: '0.1.0',
    hostVersions: ['2.2', '2.1', '2.0'],
    hooks: {
      afterPublish: async () => {
        throw new Error('post-publish boom');
      },
      beforeRestore: async () => {
        const current = join(root, 'plugins', 'io.gian.fixture', 'current');
        await unlink(current).catch(() => undefined);
        await mkdir(current);
      },
    },
  });
  await assert.rejects(
    () => store.install(coordinate('0.1.0', v1.manifest, archive1, 1)),
    (error: unknown) => (
      error instanceof AggregateError
      && error.errors.some((item) => item instanceof Error && /post-publish boom/.test(item.message))
      && error.errors.some((item) => item instanceof PluginStoreError && item.code === 'PLUGIN_CURRENT_RESTORE')
    ),
  );
  const inspected = await store.inspect('io.gian.fixture');
  assert.notEqual(inspected.currentPointer, 'valid');
  assert.notEqual(inspected.currentVersion, '0.1.0');
});

test('mutated previous generation cannot be published or restored as last-known-good', async (t) => {
  const root = await tempRoot(t);
  const v1 = packageFiles('0.1.0');
  const v2 = packageFiles('0.2.0');
  const archive1 = createGzipUstar(v1.files);
  const archive2 = createGzipUstar(v2.files);
  const urls1 = artifactUrls('0.1.0');
  const urls2 = artifactUrls('0.2.0');
  const assets = new Map<string, Buffer>([
    [`RichLogic/Gian:${urls1.tag}:${urls1.archive}`, archive1],
    [`RichLogic/Gian:${urls1.tag}:${urls1.manifest}`, v1.manifest],
    [`RichLogic/Gian:${urls2.tag}:${urls2.archive}`, archive2],
    [`RichLogic/Gian:${urls2.tag}:${urls2.manifest}`, v2.manifest],
  ]);
  const beforePublish = new PluginStore({
    dataDir: root,
    pluginsDir: join(root, 'plugins'),
    network: memoryNetwork(assets),
    allowedArtifactRepositories: ['RichLogic/Gian'],
    hostVersion: '0.1.0',
    hostVersions: ['2.2', '2.1', '2.0'],
    hooks: {
      beforePublish: async () => {
        const current = join(root, 'plugins', 'io.gian.fixture', 'current');
        try {
          if ((await readlink(current)) !== '0.1.0') return;
        } catch {
          return;
        }
        await writeFile(join(root, 'plugins', 'io.gian.fixture', '0.1.0', 'proxy.mjs'), 'export const mutated = true;\n');
      },
    },
  });
  await beforePublish.install(coordinate('0.1.0', v1.manifest, archive1, 1));
  await assert.rejects(
    () => beforePublish.install(coordinate('0.2.0', v2.manifest, archive2, 2)),
    (error: unknown) => error instanceof PluginStoreError && error.code === 'PLUGIN_CURRENT_UNMANAGED',
  );
  const afterMutation = await beforePublish.inspect('io.gian.fixture');
  assert.equal(afterMutation.currentVersion, '0.1.0');
  assert.equal(await readlink(join(root, 'plugins', 'io.gian.fixture', 'current')), '0.1.0');

  const restoreRoot = await tempRoot(t);
  const restoreStore = new PluginStore({
    dataDir: restoreRoot,
    pluginsDir: join(restoreRoot, 'plugins'),
    network: memoryNetwork(new Map([
      [`RichLogic/Gian:${urls1.tag}:${urls1.archive}`, archive1],
      [`RichLogic/Gian:${urls1.tag}:${urls1.manifest}`, v1.manifest],
      [`RichLogic/Gian:${urls2.tag}:${urls2.archive}`, archive2],
      [`RichLogic/Gian:${urls2.tag}:${urls2.manifest}`, v2.manifest],
    ])),
    allowedArtifactRepositories: ['RichLogic/Gian'],
    hostVersion: '0.1.0',
    hostVersions: ['2.2', '2.1', '2.0'],
    hooks: {
      afterPublish: async () => {
        const current = join(restoreRoot, 'plugins', 'io.gian.fixture', 'current');
        try {
          if ((await readlink(current)) !== '0.2.0') return;
        } catch {
          return;
        }
        throw new Error('post-publish boom');
      },
      beforeRestore: async () => {
        await writeFile(
          join(restoreRoot, 'plugins', 'io.gian.fixture', '0.1.0', 'proxy.mjs'),
          'export const mutated = true;\n',
        );
      },
    },
  });
  await restoreStore.install(coordinate('0.1.0', v1.manifest, archive1, 1));
  await assert.rejects(
    () => restoreStore.install(coordinate('0.2.0', v2.manifest, archive2, 2)),
    (error: unknown) => {
      const errors = error instanceof AggregateError ? error.errors : [error];
      return errors.some((item) => item instanceof PluginStoreError && item.code === 'PLUGIN_CURRENT_RESTORE')
        || (error instanceof PluginStoreError && error.code === 'PLUGIN_CURRENT_RESTORE')
        || (error instanceof Error && /post-publish boom/.test(error.message));
    },
  );
  const restored = await restoreStore.inspect('io.gian.fixture');
  assert.notEqual(restored.versions.find((item) => item.version === '0.1.0')?.state, 'valid');
});

test('Catalog install keeps the authorized snapshot when a newer generation arrives mid-download', async (t) => {
  const root = await tempRoot(t);
  const keys = makeSigningKeys();
  const v1 = packageFiles('0.1.0');
  const v2 = packageFiles('0.2.0');
  const archive1 = createGzipUstar(v1.files);
  const archive2 = createGzipUstar(v2.files);
  const bundle1 = compileCatalog(1, '0.1.0', v1.manifest, archive1, keys);
  const bundle2 = compileCatalog(2, '0.2.0', v2.manifest, archive2, keys);
  const policy = policyFor(keys);
  const catalogStore = new CatalogStore({
    rootDir: join(root, 'catalogs', 'gian-official'),
    policy,
  });
  await catalogStore.open();
  await catalogStore.ingest(bundle1.files);
  const urls1 = artifactUrls('0.1.0');
  const urls2 = artifactUrls('0.2.0');
  let ingestedNewer = false;
  const plugins = new PluginStore({
    dataDir: root,
    pluginsDir: join(root, 'plugins'),
    network: {
      async download(input) {
        if (!ingestedNewer && input.asset.includes('.tar.gz')) {
          ingestedNewer = true;
          await catalogStore.ingest(bundle2.files);
        }
        const bytes = new Map([
          [`RichLogic/Gian:${urls1.tag}:${urls1.archive}`, archive1],
          [`RichLogic/Gian:${urls1.tag}:${urls1.manifest}`, v1.manifest],
          [`RichLogic/Gian:${urls2.tag}:${urls2.archive}`, archive2],
          [`RichLogic/Gian:${urls2.tag}:${urls2.manifest}`, v2.manifest],
        ]).get(`${input.repository}:${input.tag}:${input.asset}`);
        if (!bytes) throw new Error(`missing asset ${input.tag}/${input.asset}`);
        return bytes;
      },
    },
    allowedArtifactRepositories: policy.artifactRepositories,
    hostVersion: '0.1.0',
    hostVersions: ['2.2', '2.1', '2.0'],
  });
  const service = new CatalogService({
    store: catalogStore,
    plugins,
    policy,
    hostVersions: ['2.2', '2.1', '2.0'],
    platform: 'darwin-arm64',
  });
  const listed = await service.list();
  assert.equal(listed.items[0]?.installation.latestVersion, '0.1.0');
  const installed = await service.install('io.gian.fixture');
  assert.equal(installed.pluginVersion, '0.1.0');
  assert.equal(installed.catalogSequence, 1);
  const inspected = await plugins.inspect('io.gian.fixture');
  assert.equal(inspected.currentVersion, '0.1.0');
  assert.equal(inspected.versions.some((item) => item.version === '0.2.0'), false);
  assert.equal(catalogStore.snapshot().sequence, 2);
});

test('shutdown failure keeps current unchanged and does not activate', async (t) => {
  const root = await tempRoot(t);
  const v1 = packageFiles('0.1.0');
  const archive = createGzipUstar(v1.files);
  const urls = artifactUrls('0.1.0');
  const store = new PluginStore({
    dataDir: root,
    pluginsDir: join(root, 'plugins'),
    network: memoryNetwork(new Map([
      [`RichLogic/Gian:${urls.tag}:${urls.archive}`, archive],
      [`RichLogic/Gian:${urls.tag}:${urls.manifest}`, v1.manifest],
    ])),
    allowedArtifactRepositories: ['RichLogic/Gian'],
    hostVersion: '0.1.0',
    hostVersions: ['2.2', '2.1', '2.0'],
    shutdownProcess: async () => {
      throw new Error('stubborn descendant still alive');
    },
  });
  await assert.rejects(
    () => store.install(coordinate('0.1.0', v1.manifest, archive, 1)),
    /stubborn descendant|cleanup failed|protected process groups remain|update claim could not be released/,
  );
  const inspected = await store.inspect('io.gian.fixture');
  assert.equal(inspected.currentVersion, null);
  assert.equal(inspected.currentPointer, 'absent');
});

function trackingLease(): { events: string[]; protector: AgentUpdateLease } {
  const events: string[] = [];
  return {
    events,
    protector: {
      async reserveProcessGroup() {
        return {
          async register(groupId: number) {
            events.push(`register:${groupId}`);
            return 'registered';
          },
          async cancelBeforeSpawn() {
            events.push('cancel');
          },
          async releaseUnregistered(groupId: number) {
            events.push(`unreg:${groupId}`);
          },
          async release() {
            events.push('release');
          },
        };
      },
      async release() {
        events.push('lease-release');
      },
    },
  };
}

test('protected handshake timeout, fast-exit, and spawn failure stay fail-closed', async (t) => {
  const root = await tempRoot(t);
  const hanging = join(root, 'hang.mjs');
  await writeFile(hanging, 'setInterval(() => {}, 60_000);\n');
  const timeoutLease = trackingLease();
  await assert.rejects(
    () => runProtectedProxyChild({
      label: 'catalog timeout',
      args: [hanging],
      env: { ...process.env },
      protector: timeoutLease.protector,
      timeoutMs: 80,
      async work({ deadline }) {
        await deadline;
      },
    }),
    /timed out|cleanup failed/,
  );
  assert.ok(timeoutLease.events.some((item) => item.startsWith('register:')));

  const fastExit = join(root, 'fast-exit.mjs');
  await writeFile(fastExit, 'process.exit(0);\n');
  let shutdownCalls = 0;
  const fastLease: AgentUpdateLease = {
    async reserveProcessGroup() {
      return {
        async register() {
          await new Promise((resolve) => setTimeout(resolve, 40));
          return 'already-empty';
        },
        async cancelBeforeSpawn() {
          assert.fail('spawn already occurred');
        },
        async releaseUnregistered(groupId: number) {
          assert.ok(groupId > 0);
        },
        async release() {
          assert.fail('the group was never registered');
        },
      };
    },
    async release() {},
  };
  await assert.rejects(
    () => runProtectedProxyChild({
      label: 'catalog fast-exit',
      args: [fastExit],
      env: { ...process.env },
      protector: fastLease,
      timeoutMs: 2_000,
      shutdownProcess: async () => {
        shutdownCalls += 1;
      },
      async work() {
        return undefined;
      },
    }),
    /exited before registration/,
  );
  assert.equal(shutdownCalls, 0);

  const missingLease = trackingLease();
  await assert.rejects(
    () => runProtectedProxyChild({
      label: 'catalog spawn-failure',
      args: [join(root, 'missing-entry.mjs')],
      env: { ...process.env },
      protector: missingLease.protector,
      timeoutMs: 1_000,
      async work(context) {
        const next = await Promise.race([context.iterator.next(), context.deadline]);
        if (next.done) {
          throw new Error(`catalog spawn-failure process stopped: ${context.processFailureDetail()}`);
        }
      },
    }),
    /Cannot find module|MODULE_NOT_FOUND|exited|cleanup failed|process stopped/,
  );

  const v1 = packageFiles('0.1.0');
  v1.files.set('proxy.mjs', Buffer.from('process.exit(0);\n'));
  const archive = createGzipUstar(v1.files);
  const urls = artifactUrls('0.1.0');
  const store = new PluginStore({
    dataDir: root,
    pluginsDir: join(root, 'plugins'),
    network: memoryNetwork(new Map([
      [`RichLogic/Gian:${urls.tag}:${urls.archive}`, archive],
      [`RichLogic/Gian:${urls.tag}:${urls.manifest}`, v1.manifest],
    ])),
    allowedArtifactRepositories: ['RichLogic/Gian'],
    hostVersion: '0.1.0',
    hostVersions: ['2.2', '2.1', '2.0'],
  });
  await assert.rejects(
    () => store.install(coordinate('0.1.0', v1.manifest, archive, 1)),
    /exited before registration|initialize process stopped|PLUGIN_INITIALIZE|PLUGIN_SELF_TEST|invalid JSON|cleanup failed/,
  );
  assert.equal((await store.inspect('io.gian.fixture')).currentPointer, 'absent');
});

test('exact launch rejects escaped or symlinked entry and does not fall back to current', async (t) => {
  const root = await tempRoot(t);
  const v1 = packageFiles('0.1.0');
  const v2 = packageFiles('0.2.0');
  const archive1 = createGzipUstar(v1.files);
  const archive2 = createGzipUstar(v2.files);
  const urls1 = artifactUrls('0.1.0');
  const urls2 = artifactUrls('0.2.0');
  const store = new PluginStore({
    dataDir: root,
    pluginsDir: join(root, 'plugins'),
    network: memoryNetwork(new Map([
      [`RichLogic/Gian:${urls1.tag}:${urls1.archive}`, archive1],
      [`RichLogic/Gian:${urls1.tag}:${urls1.manifest}`, v1.manifest],
      [`RichLogic/Gian:${urls2.tag}:${urls2.archive}`, archive2],
      [`RichLogic/Gian:${urls2.tag}:${urls2.manifest}`, v2.manifest],
    ])),
    allowedArtifactRepositories: ['RichLogic/Gian'],
    hostVersion: '0.1.0',
    hostVersions: ['2.2', '2.1', '2.0'],
  });
  const first = await store.install(coordinate('0.1.0', v1.manifest, archive1, 1));
  const second = await store.install(coordinate('0.2.0', v2.manifest, archive2, 2));
  assert.equal((await store.inspect('io.gian.fixture')).currentVersion, '0.2.0');

  const versionDir = join(root, 'plugins', 'io.gian.fixture', '0.1.0');
  await writeFile(join(root, 'plugins', 'io.gian.fixture', 'escape.mjs'), 'stolen\n');
  const manifest = JSON.parse(await readFile(join(versionDir, 'manifest.json'), 'utf8')) as {
    entry: string;
  };
  manifest.entry = '../escape.mjs';
  await writeFile(join(versionDir, 'manifest.json'), `${JSON.stringify(manifest)}\n`);
  await assert.rejects(
    () => store.resolveExactLaunch({
      pluginId: 'io.gian.fixture',
      pluginVersion: '0.1.0',
      expectedManifestSha256: first.manifestSha256,
    }),
    (error: unknown) => error instanceof PluginStoreError && error.code === 'PLUGIN_QUARANTINED',
  );
  assert.equal((await store.inspect('io.gian.fixture')).currentVersion, '0.2.0');

  const currentEntry = join(root, 'plugins', 'io.gian.fixture', '0.2.0', 'proxy.mjs');
  await unlink(currentEntry);
  await symlink('/etc/passwd', currentEntry);
  await assert.rejects(
    () => store.resolveExactLaunch({
      pluginId: 'io.gian.fixture',
      pluginVersion: '0.2.0',
      expectedManifestSha256: second.manifestSha256,
    }),
    (error: unknown) => error instanceof PluginStoreError && (
      error.code === 'PLUGIN_QUARANTINED' || error.code === 'PLUGIN_DIGEST_MISMATCH'
    ),
  );
  assert.equal((await store.inspect('io.gian.fixture')).currentVersion, '0.2.0');
});

test('PluginStore exact launch create/turn/closes through the generic supervisor', async (t) => {
  const root = await tempRoot(t);
  const pkg = packageFiles('1.0.0');
  const archive = createGzipUstar(pkg.files);
  const urls = artifactUrls('1.0.0');
  const store = new PluginStore({
    dataDir: root,
    pluginsDir: join(root, 'plugins'),
    network: memoryNetwork(new Map([
      [`RichLogic/Gian:${urls.tag}:${urls.archive}`, archive],
      [`RichLogic/Gian:${urls.tag}:${urls.manifest}`, pkg.manifest],
    ])),
    allowedArtifactRepositories: ['RichLogic/Gian'],
    hostVersion: '0.1.0',
    hostVersions: ['2.2', '2.1', '2.0'],
  });
  const installed = await store.install(coordinate('1.0.0', pkg.manifest, archive, 1));
  const launch = await store.resolveExactLaunch({
    pluginId: 'io.gian.fixture',
    pluginVersion: '1.0.0',
    expectedManifestSha256: installed.manifestSha256,
  });
  assert.equal(installed.negotiatedProtocol, '2.2');
  assert.equal(launch.protocolVersion, installed.negotiatedProtocol);
  const manager = new ProxyManager({
    dataDir: join(root, 'proxy-data'),
  });
  t.after(() => manager.closeAll());
  await assert.rejects(
    () => manager.acquireWithBinding('from-store-wrong-pin', {
      pluginId: parseProxyPluginId(launch.pluginId),
      pluginVersion: launch.pluginVersion,
      manifestSha256: launch.manifestSha256,
      entryPath: launch.entryPath,
      processScope: launch.processScope,
      protocolVersion: '2.1',
      runtimeProfile: null,
    }),
    /outside the Manifest range|did not offer|PROTOCOL_VIOLATION|initialize/,
  );
  const client = await manager.acquireWithBinding('from-store', {
    pluginId: parseProxyPluginId(launch.pluginId),
    pluginVersion: launch.pluginVersion,
    manifestSha256: launch.manifestSha256,
    entryPath: launch.entryPath,
    processScope: launch.processScope,
    protocolVersion: launch.protocolVersion,
    runtimeProfile: null,
  });
  assert.ok(client instanceof ProtocolV2SessionClient);
  assert.equal(client.pluginId, 'io.gian.fixture');
  assert.equal(client.executor, undefined);
  const created = await client.createSession({ cwd: root });
  assert.equal(created.nativeSessionId, 'native-1');
  await client.startTurn({
    sessionId: 'from-store',
    turnId: 'turn-1',
    input: [{ type: 'text', text: 'hi' }],
    config: {},
  });
  await client.closeSession();
  await manager.dispose('from-store');
});
