import { strict as assert } from 'node:assert';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, symlink, unlink, writeFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  compileCatalogBundle,
  type CatalogEntryV1,
  type CompiledCatalogBundle,
} from '@gian/proxy-catalog-contract';
import type { OfficialCatalogSourcePolicy } from '@gian/shared';

import {
  createCatalogAnonymousNetwork,
  encodeGitHubCatalogAssetName,
} from '../src/catalog/anonymous-client.js';
import {
  CatalogBrokerUnavailableError,
  createCatalogBrokerNetwork,
} from '../src/catalog/broker-client.js';
import { MAX_ANONYMOUS_METADATA_BYTES } from '../src/catalog/bounded-body.js';
import { createCatalogNetwork } from '../src/catalog/network.js';
import { CatalogRefreshController } from '../src/catalog/refresh.js';
import { parseCatalogLatestRelease } from '../src/catalog/release-metadata.js';
import { CatalogSourceClient } from '../src/catalog/source-client.js';
import { CatalogStore, probeProcess } from '../src/catalog/store.js';
import {
  DEFAULT_CATALOG_BROKER_TIMEOUT_MS,
  DEFAULT_CATALOG_PER_REQUEST_MS,
} from '../src/catalog/timeouts.js';
import type { CatalogNetwork } from '../src/catalog/types.js';

function chunkedOversizedResponse(
  state: { count: number; cancelled: boolean },
  chunkSize: number,
  maxChunks: number,
  headers?: HeadersInit,
): Response {
  return new Response(new ReadableStream({
    pull(controller) {
      state.count += 1;
      if (state.count > maxChunks) {
        controller.close();
        return;
      }
      controller.enqueue(new Uint8Array(chunkSize).fill(0x61));
    },
    cancel() {
      state.cancelled = true;
    },
  }, new CountQueuingStrategy({ highWaterMark: 1 })), { status: 200, headers });
}

function signedAnonymousFetch(
  compiled: { bundle: CompiledCatalogBundle },
  tag: string,
  fetched: string[],
): typeof fetch {
  return async (input) => {
    const url = String(input);
    fetched.push(url);
    if (url.includes('/releases?')) {
      return new Response(JSON.stringify([{
        tag_name: tag,
        assets: [...compiled.bundle.files.keys()].map((name) => ({
          name: encodeGitHubCatalogAssetName(name),
          size: compiled.bundle.files.get(name)!.byteLength,
        })),
      }]), {
        status: 200,
        headers: { etag: '"anon-ingest"', 'content-type': 'application/json' },
      });
    }
    for (const [name, bytes] of compiled.bundle.files) {
      const encoded = encodeURIComponent(encodeGitHubCatalogAssetName(name));
      if (url.includes(`/${encoded}`)) {
        return new Response(Buffer.from(bytes), { status: 200 });
      }
    }
    throw new Error(`unexpected anonymous fetch: ${url}`);
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function waitWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error
        ? signal.reason
        : new DOMException('This operation was aborted', 'AbortError'));
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
  'hex',
);

function sidecar(entry: CatalogEntryV1): Buffer {
  return Buffer.from(`${JSON.stringify({
    schemaVersion: 3,
    id: entry.pluginId,
    displayName: entry.displayName,
    pluginVersion: entry.channels.stable.pluginVersion,
    entry: 'proxy.mjs',
    protocol: { name: 'gian.proxy', range: '^2.1' },
    process: { scope: 'session' },
    branding: {
      logo: {
        light: { path: 'logo-light.png', mediaType: 'image/png', sha256: 'e'.repeat(64) },
      },
    },
  })}\n`);
}

function makeSigningKeys() {
  const pair = generateKeyPairSync('ed25519');
  return {
    privateKey: pair.privateKey,
    publicKeyHex: pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'),
  };
}

function compileSequence(
  sequence: number,
  tagline = 'Unknown reverse-domain Catalog fixture',
  keys = makeSigningKeys(),
) {
  const entry: CatalogEntryV1 = {
    schemaVersion: 1,
    pluginId: 'io.gian.fixture',
    displayName: 'Gian Fixture',
    tagline,
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
        pluginVersion: '0.1.0',
        manifest: {
          url: 'https://github.com/RichLogic/Gian/releases/download/proxy-fixture-v0.1.0/gian-proxy-fixture-0.1.0-darwin-arm64.tar.gz.manifest.json',
          sha256: 'a'.repeat(64),
          size: 1,
        },
        artifacts: {
          'darwin-arm64': {
            url: 'https://github.com/RichLogic/Gian/releases/download/proxy-fixture-v0.1.0/gian-proxy-fixture-0.1.0-darwin-arm64.tar.gz',
            sha256: 'b'.repeat(64),
            size: 1234,
          },
        },
      },
    },
  };
  const bytes = sidecar(entry);
  entry.channels.stable.manifest.sha256 = createHash('sha256').update(bytes).digest('hex');
  entry.channels.stable.manifest.size = bytes.byteLength;
  const bundle = compileCatalogBundle({
    sourceId: 'gian-official',
    sequence,
    issuedAt: '2026-09-02T00:00:00.000Z',
    allowedArtifactRepositories: ['RichLogic/Gian'],
    signingKey: { keyId: 'gian-official-catalog-2026', privateKey: keys.privateKey },
    plugins: [{
      entry,
      documents: {
        overview: `# Overview ${sequence}\n`,
        setup: '# Setup\n',
        usage: '# Usage\n',
        troubleshooting: '# Troubleshooting\n',
      },
      logos: { light: PNG, dark: PNG },
      manifestSidecar: bytes,
    }],
  });
  const policy: OfficialCatalogSourcePolicy = {
    sourceId: 'gian-official',
    repository: 'RichLogic/Gian',
    artifactRepositories: ['RichLogic/Gian'],
    pinnedPublicKeys: { 'gian-official-catalog-2026': keys.publicKeyHex },
  };
  return { bundle, policy, keys };
}

function memoryNetwork(
  releases: Map<number, CompiledCatalogBundle>,
  options: { fail?: string } = {},
): CatalogNetwork {
  return {
    async latest({ ifNoneMatch }) {
      const sequence = Math.max(...releases.keys());
      const etag = `"seq-${sequence}"`;
      if (ifNoneMatch === etag) return { status: 304, etag };
      return {
        status: 200,
        release: {
          tag: `catalog-v1.${sequence}.0`,
          sequence,
          etag,
          assets: [...releases.get(sequence)!.files.keys()].map((name) => ({
            name,
            size: releases.get(sequence)!.files.get(name)!.byteLength,
          })),
        },
      };
    },
    async download({ tag, asset }) {
      if (options.fail === asset) throw new Error(`missing payload ${asset}`);
      const match = /^catalog-v1\.([1-9]\d*)\.0$/.exec(tag);
      const bundle = match ? releases.get(Number(match[1])) : undefined;
      const bytes = bundle?.files.get(asset);
      if (!bytes) throw new Error(`asset not found: ${asset}`);
      return Buffer.from(bytes);
    },
  };
}

test('compiler, source client, and cache produce an offline trusted Catalog snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gian-catalog-store-'));
  try {
    const first = compileSequence(2);
    const store = new CatalogStore({ rootDir: root, policy: first.policy });
    const client = new CatalogSourceClient({
      store,
      policy: first.policy,
      network: memoryNetwork(new Map([[2, first.bundle]])),
    });
    const synced = await client.sync();
    assert.equal(synced.state, 'ready');
    assert.equal(synced.sequence, 2);
    assert.equal(synced.index?.plugins[0]?.pluginId, 'io.gian.fixture');
    assert.equal(synced.files?.has('catalog-v1.json'), true);

    const reopened = await store.open();
    assert.equal(reopened.sequence, 2);
    assert.equal(reopened.index?.plugins[0]?.displayName, 'Gian Fixture');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('signature, rollback, same-sequence conflict, and network failure keep last-known-good', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gian-catalog-fail-'));
  try {
    const first = compileSequence(2);
    const store = new CatalogStore({ rootDir: root, policy: first.policy });
    const ok = new CatalogSourceClient({
      store,
      policy: first.policy,
      network: memoryNetwork(new Map([[2, first.bundle]])),
    });
    assert.equal((await ok.sync()).sequence, 2);

    const other = compileSequence(3);
    const badKey = new CatalogSourceClient({
      store,
      policy: first.policy,
      network: memoryNetwork(new Map([[3, other.bundle]])),
    });
    const rejected = await badKey.sync();
    assert.equal(rejected.sequence, 2);
    assert.equal(rejected.state, 'stale');
    assert.equal(rejected.error?.code, 'CATALOG_SIGNATURE_INVALID');

    const rollback = compileSequence(1, 'Unknown reverse-domain Catalog fixture', first.keys);
    await assert.rejects(
      store.ingest(rollback.bundle.files),
      /rollback/,
    );
    assert.equal((await store.open()).sequence, 2);

    const conflict = compileSequence(2, 'Different content at the same sequence', first.keys);
    await assert.rejects(
      store.ingest(conflict.bundle.files),
      /different content/,
    );
    assert.equal((await store.open()).sequence, 2);

    const failedNet = new CatalogSourceClient({
      store,
      policy: first.policy,
      network: {
        async latest() { throw new Error('network down'); },
        async download() { throw new Error('network down'); },
      },
    });
    const stale = await failedNet.sync();
    assert.equal(stale.sequence, 2);
    assert.equal(stale.state, 'stale');
    assert.equal(stale.index?.plugins[0]?.pluginId, 'io.gian.fixture');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('concurrent ingest, partial generation, stale lock, and malicious current pointer recover', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gian-catalog-recover-'));
  try {
    const keys = makeSigningKeys();
    const first = compileSequence(2, 'Unknown reverse-domain Catalog fixture', keys);
    let releaseWait: () => void = () => undefined;
    const waiting = new Promise<void>((resolve) => { releaseWait = resolve; });
    const store = new CatalogStore({
      rootDir: root,
      policy: first.policy,
      afterLock: async () => {
        releaseWait();
        await new Promise((resolve) => setTimeout(resolve, 40));
      },
    });
    const firstIngest = store.ingest(first.bundle.files, '"seq-2"');
    await waiting;
    await assert.rejects(store.ingest(first.bundle.files), /already in progress/);
    assert.equal((await firstIngest).sequence, 2);

    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(root, 'generations', '3'), { recursive: true });
    await writeFile(join(root, 'generations', '3', 'catalog-v1.json'), 'torn');
    assert.equal((await store.open()).sequence, 2);

    await writeClaim(root, '00000000-0000-4000-8000-0000000000aa', {
      schemaVersion: 1,
      token: '00000000-0000-4000-8000-0000000000aa',
      pid: 2_147_483_647,
      processIdentity: 'not-this-process',
      createdAt: '2020-01-01T00:00:00.000Z',
    });
    const fourth = compileSequence(4, 'Unknown reverse-domain Catalog fixture', keys);
    const advanced = await store.ingest(fourth.bundle.files);
    assert.equal(advanced.sequence, 4);

    await rm(join(root, 'current'), { force: true });
    await symlink('/tmp/evil-catalog', join(root, 'current'));
    const afterSymlink = await store.open();
    assert.equal(afterSymlink.sequence, 4);
    assert.equal(afterSymlink.state, 'ready');

    const fifth = compileSequence(5, 'Unknown reverse-domain Catalog fixture', keys);
    const missing = new CatalogSourceClient({
      store,
      policy: first.policy,
      network: memoryNetwork(new Map([[5, fifth.bundle]]), {
        fail: 'docs/io.gian.fixture/overview.md',
      }),
    });
    const missingResult = await missing.sync();
    assert.equal(missingResult.sequence, 4);
    assert.equal(missingResult.state, 'stale');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('conditional 304 keeps the current generation without downloading', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gian-catalog-304-'));
  try {
    const first = compileSequence(2);
    const store = new CatalogStore({ rootDir: root, policy: first.policy });
    const network = memoryNetwork(new Map([[2, first.bundle]]));
    const client = new CatalogSourceClient({ store, policy: first.policy, network });
    assert.equal((await client.sync()).etag, '"seq-2"');
    const again = await client.sync();
    assert.equal(again.sequence, 2);
    assert.equal(again.state, 'ready');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('generation ETags, watermark, 304 cache miss, same-sequence repair, and lock ownership stay fail-closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gian-catalog-etag-'));
  try {
    const keys = makeSigningKeys();
    const first = compileSequence(2, 'Unknown reverse-domain Catalog fixture', keys);
    const store = new CatalogStore({ rootDir: root, policy: first.policy });
    await store.ingest(first.bundle.files, '"gen-2"');
    assert.equal((await store.open()).etag, '"gen-2"');

    const third = compileSequence(3, 'Unknown reverse-domain Catalog fixture', keys);
    await store.ingest(third.bundle.files, '"gen-3"');
    assert.equal((await store.open()).etag, '"gen-3"');
    await assert.rejects(store.ingest(first.bundle.files, '"replay-2"'), /rollback/);
    assert.equal((await store.open()).sequence, 3);

    await writeFile(join(root, 'current'), '2\n');
    const fallback = await store.open();
    assert.equal(fallback.sequence, 2);
    assert.equal(fallback.etag, '"gen-2"');

    await writeFile(join(root, 'generations', '2', 'etag'), '\n');
    assert.equal((await store.open()).etag, null);

    await mkdir(join(root, 'generations', '3'), { recursive: true });
    await writeFile(join(root, 'generations', '3', 'catalog-v1.json'), 'torn');
    const repaired = await store.ingest(third.bundle.files, '"gen-3-repaired"');
    assert.equal(repaired.sequence, 3);
    assert.equal(repaired.etag, '"gen-3-repaired"');

    const fourth = compileSequence(4, 'Unknown reverse-domain Catalog fixture', keys);
    await store.ingest(fourth.bundle.files, '"gen-4"');
    await writeFile(join(root, 'generations', '4', 'catalog-v1.json'), 'torn');
    await writeFile(join(root, 'current'), '3\n');
    assert.equal((await store.open()).sequence, 3);
    const rollback = compileSequence(1, 'Unknown reverse-domain Catalog fixture', keys);
    await assert.rejects(store.ingest(rollback.bundle.files), /rollback/);

    const emptyRoot = await mkdtemp(join(tmpdir(), 'gian-catalog-304-miss-'));
    try {
      const emptyStore = new CatalogStore({ rootDir: emptyRoot, policy: first.policy });
      const miss = new CatalogSourceClient({
        store: emptyStore,
        policy: first.policy,
        network: {
          async latest() {
            return { status: 304, etag: '"missing"' };
          },
          async download() {
            throw new Error('download must not run on a cache miss');
          },
        },
      });
      const result = await miss.sync();
      assert.equal(result.state, 'error');
      assert.equal(result.error?.code, 'CATALOG_CACHE_MISS');
      assert.equal(result.sequence, null);
    } finally {
      await rm(emptyRoot, { recursive: true, force: true });
    }

    const overflowToken = '00000000-0000-4000-8000-0000000000bb';
    await writeClaim(root, overflowToken, 'x'.repeat(2048));
    await assert.rejects(store.ingest(fourth.bundle.files), /MAX_LOCK_BYTES|CATALOG_LOCK_OVERFLOW/);
    assert.equal((await readFile(claimPath(root, overflowToken), 'utf8')).length, 2048);
    await unlink(claimPath(root, overflowToken));

    const reusedToken = '00000000-0000-4000-8000-0000000000cc';
    await writeClaim(root, reusedToken, {
      schemaVersion: 1,
      token: reusedToken,
      pid: process.pid,
      processIdentity: 'pid:not-this-process',
      createdAt: new Date().toISOString(),
    });
    const reclaimed = await store.ingest(fourth.bundle.files, '"gen-4-reclaimed"');
    assert.equal(reclaimed.sequence, 4);
    assert.equal(reclaimed.etag, '"gen-4-reclaimed"');

    const successorToken = '00000000-0000-4000-8000-0000000000dd';
    const self = await probeProcess(process.pid);
    assert.equal(self.state, 'live');
    const successorStore = new CatalogStore({
      rootDir: root,
      policy: first.policy,
      afterLock: async () => {
        await writeClaim(root, successorToken, {
          schemaVersion: 1,
          token: successorToken,
          pid: process.pid,
          processIdentity: self.identity,
          createdAt: new Date().toISOString(),
        });
      },
    });
    const fifth = compileSequence(5, 'Unknown reverse-domain Catalog fixture', keys);
    await successorStore.ingest(fifth.bundle.files, '"gen-5"');
    assert.match(await readFile(claimPath(root, successorToken), 'utf8'), /00000000-0000-4000-8000-0000000000dd/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Catalog refresh starts a bounded sync and stops cleanly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gian-catalog-refresh-'));
  try {
    const first = compileSequence(2);
    const store = new CatalogStore({ rootDir: root, policy: first.policy });
    let syncs = 0;
    const client = new CatalogSourceClient({
      store,
      policy: first.policy,
      network: {
        async latest() {
          syncs += 1;
          return {
            status: 200,
            release: {
              tag: 'catalog-v1.2.0',
              sequence: 2,
              etag: '"seq-2"',
              assets: [...first.bundle.files.keys()].map((name) => ({
                name,
                size: first.bundle.files.get(name)!.byteLength,
              })),
            },
          };
        },
        async download({ asset }) {
          const bytes = first.bundle.files.get(asset);
          if (!bytes) throw new Error(`asset not found: ${asset}`);
          return Buffer.from(bytes);
        },
      },
    });
    const refresh = new CatalogRefreshController({
      sourceClient: client,
      intervalMs: 60_000,
    });
    refresh.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await refresh.stop();
    assert.ok(syncs >= 1);
    assert.equal((await store.open()).sequence, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Catalog sync total budget, concurrency, abort, broker ETag, and anonymous GitHub stay bounded', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gian-catalog-sync-bound-'));
  try {
    const first = compileSequence(2);
    const store = new CatalogStore({ rootDir: root, policy: first.policy });
    const slow = new CatalogSourceClient({
      store,
      policy: first.policy,
      totalBudgetMs: 50,
      perRequestMs: 1_000,
      downloadConcurrency: 4,
      network: {
        async latest() {
          return {
            status: 200,
            release: {
              tag: 'catalog-v1.2.0',
              sequence: 2,
              etag: '"seq-2"',
              assets: [...first.bundle.files.keys()].map((name) => ({
                name,
                size: first.bundle.files.get(name)!.byteLength,
              })),
            },
          };
        },
        async download({ asset, signal }) {
          await waitWithSignal(80, signal);
          const bytes = first.bundle.files.get(asset);
          if (!bytes) throw new Error(`asset not found: ${asset}`);
          return Buffer.from(bytes);
        },
      },
    });
    const timedOut = await slow.sync();
    assert.equal(timedOut.state, 'error');
    assert.match(timedOut.error?.message ?? '', /aborted|timeout|This operation was aborted/i);

    const readyStore = new CatalogStore({ rootDir: join(root, 'ready'), policy: first.policy });
    let inflight = 0;
    let maxInflight = 0;
    const concurrent = new CatalogSourceClient({
      store: readyStore,
      policy: first.policy,
      totalBudgetMs: 5_000,
      perRequestMs: 1_000,
      downloadConcurrency: 2,
      network: {
        async latest() {
          return {
            status: 200,
            release: {
              tag: 'catalog-v1.2.0',
              sequence: 2,
              etag: '"seq-2"',
              assets: [...first.bundle.files.keys()].map((name) => ({
                name,
                size: first.bundle.files.get(name)!.byteLength,
              })),
            },
          };
        },
        async download({ asset }) {
          inflight += 1;
          maxInflight = Math.max(maxInflight, inflight);
          await new Promise((resolve) => setTimeout(resolve, 15));
          inflight -= 1;
          const bytes = first.bundle.files.get(asset);
          if (!bytes) throw new Error(`asset not found: ${asset}`);
          return Buffer.from(bytes);
        },
      },
    });
    const ready = await concurrent.sync();
    assert.equal(ready.state, 'ready');
    assert.ok(maxInflight <= 2);

    const abortStore = new CatalogStore({ rootDir: join(root, 'abort'), policy: first.policy });
    await abortStore.ingest(first.bundle.files, '"seq-2"');
    const abortClient = new CatalogSourceClient({
      store: abortStore,
      policy: first.policy,
      network: {
        async latest() {
          await new Promise((resolve) => setTimeout(resolve, 50));
          throw new Error('latest should have been aborted');
        },
        async download() {
          throw new Error('download should have been aborted');
        },
      },
    });
    const controller = new AbortController();
    controller.abort();
    const aborted = await abortClient.sync(controller.signal);
    assert.equal(aborted.sequence, 2);
    assert.equal(aborted.state, 'stale');

    const socket = join(root, 'broker.sock');
    const server = createServer((request, response) => {
      assert.equal(request.url, '/v1/release-metadata');
      response.writeHead(200, {
        etag: '"from-header"',
        'content-type': 'application/json',
      });
      response.end(JSON.stringify({
        tag: 'catalog-v1.2.0',
        sequence: 2,
        assets: [{ name: 'catalog-v1.json', size: 12 }],
      }));
    });
    await new Promise<void>((resolve, reject) => {
      server.listen(socket, () => resolve());
      server.once('error', reject);
    });
    try {
      const broker = createCatalogBrokerNetwork({
        socketPath: socket,
        policy: first.policy,
      });
      const latest = await broker.latest({});
      assert.equal(latest.status, 200);
      if (latest.status === 200) {
        assert.equal(latest.release.etag, '"from-header"');
        assert.equal(latest.release.tag, 'catalog-v1.2.0');
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    const fetched: string[] = [];
    const anonymous = createCatalogAnonymousNetwork({
      policy: first.policy,
      fetchImpl: async (input, init) => {
        const url = String(input);
        fetched.push(url);
        const headers = new Headers(init?.headers);
        assert.equal(headers.get('authorization'), null);
        if (url.includes('/releases?')) {
          return new Response(JSON.stringify([
            {
              tag_name: 'catalog-v1.3.0',
              assets: [{ name: 'catalog-v1.json', size: 4 }],
            },
          ]), {
            status: 200,
            headers: { etag: '"anon-etag"', 'content-type': 'application/json' },
          });
        }
        return new Response(Buffer.from('body'), { status: 200 });
      },
    });
    const anonLatest = await anonymous.latest({});
    assert.equal(anonLatest.status, 200);
    if (anonLatest.status === 200) {
      assert.equal(anonLatest.release.etag, '"anon-etag"');
      assert.equal(anonLatest.release.sequence, 3);
    }
    const asset = await anonymous.download({
      tag: 'catalog-v1.3.0',
      asset: 'catalog-v1.json',
      maxBytes: 16,
    });
    assert.equal(asset.toString(), 'body');
    assert.ok(fetched.every((url) => url.startsWith('https://')));
    assert.ok(fetched.some((url) => url.includes('api.github.com/repos/RichLogic/Gian/releases')));
    assert.ok(!fetched.some((url) => url.includes('authorization')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('old valid generation, crash-order watermark, and malformed watermark stay fail-closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gian-catalog-watermark-'));
  try {
    const keys = makeSigningKeys();
    const third = compileSequence(3, 'Unknown reverse-domain Catalog fixture', keys);
    const fifth = compileSequence(5, 'Unknown reverse-domain Catalog fixture', keys);
    const store = new CatalogStore({ rootDir: root, policy: third.policy });
    await store.ingest(third.bundle.files, '"gen-3"');
    await store.ingest(fifth.bundle.files, '"gen-5"');
    await assert.rejects(store.ingest(third.bundle.files, '"replay-3"'), /rollback/);
    assert.equal((await store.open()).sequence, 5);
    assert.equal(await readFile(join(root, 'current'), 'utf8'), '5\n');
    assert.equal(await readFile(join(root, 'watermark'), 'utf8'), '5\n');

    const crashRoot = await mkdtemp(join(tmpdir(), 'gian-catalog-watermark-crash-'));
    try {
      const fourth = compileSequence(4, 'Unknown reverse-domain Catalog fixture', keys);
      const advancing = compileSequence(6, 'Unknown reverse-domain Catalog fixture', keys);
      const crashStore = new CatalogStore({
        rootDir: crashRoot,
        policy: third.policy,
        afterWatermarkWrite: async () => {
          if ((await readFile(join(crashRoot, 'watermark'), 'utf8')) === '6\n') {
            throw new Error('crash after watermark');
          }
        },
      });
      await crashStore.ingest(fourth.bundle.files, '"gen-4"');
      await assert.rejects(crashStore.ingest(advancing.bundle.files, '"gen-6"'), /crash after watermark/);
      assert.equal(await readFile(join(crashRoot, 'watermark'), 'utf8'), '6\n');
      assert.equal(await readFile(join(crashRoot, 'current'), 'utf8'), '4\n');
      await assert.rejects(crashStore.ingest(fourth.bundle.files, '"replay-4"'), /rollback/);
    } finally {
      await rm(crashRoot, { recursive: true, force: true });
    }

    const badRoot = await mkdtemp(join(tmpdir(), 'gian-catalog-watermark-bad-'));
    try {
      const first = compileSequence(2, 'Unknown reverse-domain Catalog fixture', keys);
      const badStore = new CatalogStore({ rootDir: badRoot, policy: first.policy });
      await writeFile(join(badRoot, 'watermark'), 'nope\n');
      await assert.rejects(badStore.ingest(first.bundle.files), /watermark|CATALOG_WATERMARK_INVALID/);
      await unlink(join(badRoot, 'watermark'));
      await symlink('/tmp/evil-watermark', join(badRoot, 'watermark'));
      await assert.rejects(badStore.ingest(first.bundle.files), /watermark|CATALOG_WATERMARK_INVALID/);
      await unlink(join(badRoot, 'watermark'));
      await writeFile(join(badRoot, 'watermark'), `${'9'.repeat(64)}\n`);
      await assert.rejects(badStore.ingest(first.bundle.files), /watermark|CATALOG_WATERMARK_INVALID/);
    } finally {
      await rm(badRoot, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('unique-claim stale reclaim, invalid lock, probe failure, and release ownership stay race-free', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gian-catalog-claim-'));
  try {
    const keys = makeSigningKeys();
    const first = compileSequence(2, 'Unknown reverse-domain Catalog fixture', keys);
    const self = await probeProcess(process.pid);
    assert.equal(self.state, 'live');

    const staleToken = '00000000-0000-4000-8000-0000000000ee';
    const successorToken = '00000000-0000-4000-8000-0000000000ff';
    await writeClaim(root, staleToken, {
      schemaVersion: 1,
      token: staleToken,
      pid: 2_147_483_647,
      processIdentity: 'dead-owner',
      createdAt: '2020-01-01T00:00:00.000Z',
    });
    const staleStore = new CatalogStore({
      rootDir: root,
      policy: first.policy,
      beforeUnlinkClaim: async () => {
        await writeClaim(root, successorToken, {
          schemaVersion: 1,
          token: successorToken,
          pid: process.pid,
          processIdentity: self.identity,
          createdAt: new Date().toISOString(),
        });
      },
    });
    await assert.rejects(staleStore.ingest(first.bundle.files), /already in progress/);
    assert.match(await readFile(claimPath(root, successorToken), 'utf8'), /00000000-0000-4000-8000-0000000000ff/);

    const invalidRoot = await mkdtemp(join(tmpdir(), 'gian-catalog-claim-invalid-'));
    try {
      const invalidToken = '00000000-0000-4000-8000-000000000111';
      const replacementToken = '00000000-0000-4000-8000-000000000112';
      await writeClaim(invalidRoot, invalidToken, '{not-json');
      await writeClaim(invalidRoot, replacementToken, {
        schemaVersion: 1,
        token: replacementToken,
        pid: process.pid,
        processIdentity: self.identity,
        createdAt: new Date().toISOString(),
      });
      const invalidStore = new CatalogStore({ rootDir: invalidRoot, policy: first.policy });
      await assert.rejects(invalidStore.ingest(first.bundle.files), /already in progress/);
      assert.equal(await readFile(claimPath(invalidRoot, invalidToken), 'utf8'), '{not-json');
      assert.match(await readFile(claimPath(invalidRoot, replacementToken), 'utf8'), /00000000-0000-4000-8000-000000000112/);
    } finally {
      await rm(invalidRoot, { recursive: true, force: true });
    }

    const probeRoot = await mkdtemp(join(tmpdir(), 'gian-catalog-claim-probe-'));
    try {
      await writeClaim(probeRoot, '00000000-0000-4000-8000-000000000113', {
        schemaVersion: 1,
        token: '00000000-0000-4000-8000-000000000113',
        pid: 12_345,
        processIdentity: 'unknown-owner',
        createdAt: new Date().toISOString(),
      });
      const probeStore = new CatalogStore({
        rootDir: probeRoot,
        policy: first.policy,
        probeProcess: async (pid) => {
          if (pid === 12_345) return { state: 'unknown' };
          return probeProcess(pid);
        },
      });
      await assert.rejects(probeStore.ingest(first.bundle.files), /already in progress/);
      assert.match(
        await readFile(claimPath(probeRoot, '00000000-0000-4000-8000-000000000113'), 'utf8'),
        /unknown-owner/,
      );

      const identityStore = new CatalogStore({
        rootDir: join(probeRoot, 'identity'),
        policy: first.policy,
        probeProcess: async () => ({ state: 'unknown' }),
      });
      await assert.rejects(identityStore.ingest(first.bundle.files), /process identity|CATALOG_PROCESS_IDENTITY/);
    } finally {
      await rm(probeRoot, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('anonymous Catalog metadata and assets cancel oversized chunked bodies before allocation', { timeout: 5_000 }, async () => {
  const policy: OfficialCatalogSourcePolicy = {
    sourceId: 'gian-official',
    repository: 'RichLogic/Gian',
    artifactRepositories: ['RichLogic/Gian'],
    pinnedPublicKeys: { 'gian-official-catalog-2026': 'a'.repeat(64) },
  };
  const metadataChunks = { count: 0, cancelled: false };
  const metadata = createCatalogAnonymousNetwork({
    policy,
    fetchImpl: async (input) => {
      assert.match(String(input), /releases\?/);
      return chunkedOversizedResponse(metadataChunks, 64 * 1024, 24, {
        'content-type': 'application/json',
      });
    },
  });
  await assert.rejects(metadata.latest({}), /too large/);
  assert.equal(metadataChunks.cancelled, true);
  assert.ok(metadataChunks.count < 24);
  assert.ok(metadataChunks.count * 64 * 1024 <= MAX_ANONYMOUS_METADATA_BYTES + 3 * 64 * 1024);

  const assetChunks = { count: 0, cancelled: false };
  const assets = createCatalogAnonymousNetwork({
    policy,
    fetchImpl: async () => chunkedOversizedResponse(assetChunks, 256, 16),
  });
  await assert.rejects(assets.download({
    tag: 'catalog-v1.1.0',
    asset: 'catalog-v1.json',
    maxBytes: 1_024,
  }), /too large/);
  assert.equal(assetChunks.cancelled, true);
  assert.ok(assetChunks.count < 16);
  assert.ok(assetChunks.count * 256 <= 1_024 + 3 * 256);

  const lyingMeta = { count: 0, cancelled: false };
  const lyingAsset = { count: 0, cancelled: false };
  const lyingLength = createCatalogAnonymousNetwork({
    policy,
    fetchImpl: async (input) => {
      if (String(input).includes('/releases?')) {
        return chunkedOversizedResponse(lyingMeta, 64 * 1024, 24, {
          'content-type': 'application/json',
          'content-length': '12',
        });
      }
      return chunkedOversizedResponse(lyingAsset, 256, 16, {
        'content-length': '8',
      });
    },
  });
  await assert.rejects(lyingLength.latest({}), /too large/);
  await assert.rejects(lyingLength.download({
    tag: 'catalog-v1.1.0',
    asset: 'catalog-v1.json',
    maxBytes: 1_024,
  }), /too large/);
  assert.equal(lyingMeta.cancelled, true);
  assert.equal(lyingAsset.cancelled, true);
  assert.ok(lyingMeta.count < 24);
  assert.ok(lyingAsset.count < 16);
});

test('Catalog network falls back to anonymous only for pre-response broker unavailability', async () => {
  const first = compileSequence(3);
  const root = await mkdtemp(join(tmpdir(), 'gian-catalog-broker-fallback-'));
  const fetched: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    fetched.push(String(input));
    if (String(input).includes('/releases?')) {
      return new Response(JSON.stringify([
        {
          tag_name: 'catalog-v1.3.0',
          assets: [{ name: 'catalog-v1.json', size: 4 }],
        },
      ]), {
        status: 200,
        headers: { etag: '"anon-fallback"', 'content-type': 'application/json' },
      });
    }
    return new Response(Buffer.from('body'), { status: 200 });
  };
  try {
    const missing = createCatalogNetwork({
      policy: first.policy,
      socketPath: join(root, 'missing.sock'),
      fetchImpl,
    });
    const fromMissing = await missing.latest({});
    assert.equal(fromMissing.status, 200);
    if (fromMissing.status === 200) {
      assert.equal(fromMissing.release.etag, '"anon-fallback"');
    }

    const stalePath = join(root, 'stale.sock');
    await writeFile(stalePath, 'not-a-socket');
    const stale = createCatalogNetwork({
      policy: first.policy,
      socketPath: stalePath,
      fetchImpl,
    });
    const fromStale = await stale.latest({});
    assert.equal(fromStale.status, 200);

    const refusedPath = join(root, 'refused.sock');
    const refusedServer = createServer();
    await new Promise<void>((resolve, reject) => {
      refusedServer.listen(refusedPath, () => resolve());
      refusedServer.once('error', reject);
    });
    await new Promise<void>((resolve) => refusedServer.close(() => resolve()));
    const refused = createCatalogNetwork({
      policy: first.policy,
      socketPath: refusedPath,
      fetchImpl,
    });
    const fromRefused = await refused.latest({});
    assert.equal(fromRefused.status, 200);
    assert.ok(fetched.length >= 3);

    const midPath = join(root, 'mid.sock');
    const midServer = createServer((_request, response) => {
      response.writeHead(200, {
        'content-type': 'application/json',
        'content-length': '64',
      });
      response.write('{');
      setTimeout(() => response.destroy(), 25);
    });
    await new Promise<void>((resolve, reject) => {
      midServer.listen(midPath, () => resolve());
      midServer.once('error', reject);
    });
    try {
      const beforeMid = fetched.length;
      const mid = createCatalogNetwork({
        policy: first.policy,
        socketPath: midPath,
        fetchImpl,
      });
      await assert.rejects(mid.latest({}), (error: unknown) => !(error instanceof CatalogBrokerUnavailableError));
      assert.equal(fetched.length, beforeMid);
    } finally {
      await new Promise<void>((resolve) => midServer.close(() => resolve()));
    }

    const hungPath = join(root, 'hung.sock');
    const hungServer = createServer((_request, _response) => {
      /* accept the request but never write response headers */
    });
    await new Promise<void>((resolve, reject) => {
      hungServer.listen(hungPath, () => resolve());
      hungServer.once('error', reject);
    });
    try {
      const beforeHung = fetched.length;
      const hung = createCatalogNetwork({
        policy: first.policy,
        socketPath: hungPath,
        fetchImpl,
        timeoutMs: 80,
      });
      const fromHung = await hung.latest({});
      assert.equal(fromHung.status, 200);
      if (fromHung.status === 200) {
        assert.equal(fromHung.release.etag, '"anon-fallback"');
      }
      assert.ok(fetched.length > beforeHung);
    } finally {
      await new Promise<void>((resolve) => hungServer.close(() => resolve()));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CatalogSourceClient falls back through the production network composition on a hung broker', { timeout: 15_000 }, async () => {
  assert.ok(DEFAULT_CATALOG_BROKER_TIMEOUT_MS < DEFAULT_CATALOG_PER_REQUEST_MS);
  const compiled = compileSequence(3);
  const tag = 'catalog-v1.3.0';
  const root = await mkdtemp(join(tmpdir(), 'gian-catalog-source-fallback-'));
  const fetched: string[] = [];
  const fetchImpl = signedAnonymousFetch(compiled, tag, fetched);
  try {
    const hungPath = join(root, 'hung.sock');
    let accepted = 0;
    const hungServer = createServer((_request, _response) => {
      accepted += 1;
    });
    await new Promise<void>((resolve, reject) => {
      hungServer.listen(hungPath, () => resolve());
      hungServer.once('error', reject);
    });
    try {
      const readyStore = new CatalogStore({ rootDir: join(root, 'ready'), policy: compiled.policy });
      const readyClient = new CatalogSourceClient({
        store: readyStore,
        policy: compiled.policy,
        perRequestMs: 250,
        totalBudgetMs: 8_000,
        network: createCatalogNetwork({
          policy: compiled.policy,
          socketPath: hungPath,
          fetchImpl,
          timeoutMs: 80,
        }),
      });
      const synced = await readyClient.sync();
      assert.equal(synced.state, 'ready');
      assert.equal(synced.sequence, 3);
      assert.ok(fetched.some((url) => url.includes('/releases?')));
      assert.ok(fetched.some((url) => url.includes('/releases/download/')));

      const abortStore = new CatalogStore({ rootDir: join(root, 'abort'), policy: compiled.policy });
      const abortClient = new CatalogSourceClient({
        store: abortStore,
        policy: compiled.policy,
        perRequestMs: 250,
        totalBudgetMs: 8_000,
        network: createCatalogNetwork({
          policy: compiled.policy,
          socketPath: hungPath,
          fetchImpl,
          timeoutMs: 80,
        }),
      });
      const beforeAbort = fetched.length;
      accepted = 0;
      const controller = new AbortController();
      const aborting = abortClient.sync(controller.signal);
      await waitUntil(() => accepted > 0);
      controller.abort();
      const aborted = await aborting;
      assert.notEqual(aborted.state, 'ready');
      assert.equal(fetched.length, beforeAbort);

      const midPath = join(root, 'mid.sock');
      const midServer = createServer((_request, response) => {
        response.writeHead(200, {
          'content-type': 'application/json',
          'content-length': '64',
        });
        response.write('{');
        setTimeout(() => response.destroy(), 25);
      });
      await new Promise<void>((resolve, reject) => {
        midServer.listen(midPath, () => resolve());
        midServer.once('error', reject);
      });
      try {
        const beforeMid = fetched.length;
        const midStore = new CatalogStore({ rootDir: join(root, 'mid'), policy: compiled.policy });
        const midClient = new CatalogSourceClient({
          store: midStore,
          policy: compiled.policy,
          perRequestMs: 400,
          totalBudgetMs: 2_000,
          network: createCatalogNetwork({
            policy: compiled.policy,
            socketPath: midPath,
            fetchImpl,
            timeoutMs: 80,
          }),
        });
        const mid = await midClient.sync();
        assert.notEqual(mid.state, 'ready');
        assert.equal(fetched.length, beforeMid);
      } finally {
        await new Promise<void>((resolve) => midServer.close(() => resolve()));
      }
    } finally {
      await new Promise<void>((resolve) => hungServer.close(() => resolve()));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('broker latest assets must be exact name/size pairs with unique paths', async () => {
  assert.throws(() => parseCatalogLatestRelease({
    tag: 'catalog-v1.1.0',
    sequence: 1,
    assets: [{
      name: 'catalog-v1.json',
      size: 4,
      url: 'https://evil.example/catalog-v1.json',
    }],
  }), /invalid asset/);
  assert.throws(() => parseCatalogLatestRelease({
    tag: 'catalog-v1.1.0',
    sequence: 1,
    assets: [
      { name: 'catalog-v1.json', size: 4 },
      { name: 'catalog-v1.json', size: 8 },
    ],
  }), /invalid asset/);
  assert.deepEqual(parseCatalogLatestRelease({
    tag: 'catalog-v1.1.0',
    sequence: 1,
    assets: [{ name: 'catalog-v1.json', size: 4 }],
    etag: '"ok"',
  }).assets, [{ name: 'catalog-v1.json', size: 4 }]);

  const root = await mkdtemp(join(tmpdir(), 'gian-catalog-broker-assets-'));
  const extraPath = join(root, 'extra.sock');
  const extraServer = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      tag: 'catalog-v1.1.0',
      sequence: 1,
      assets: [{
        name: 'catalog-v1.json',
        size: 4,
        digest: 'sha256:abcd',
      }],
    }));
  });
  await new Promise<void>((resolve, reject) => {
    extraServer.listen(extraPath, () => resolve());
    extraServer.once('error', reject);
  });
  try {
    const extra = createCatalogBrokerNetwork({
      socketPath: extraPath,
      policy: compileSequence(1).policy,
    });
    await assert.rejects(extra.latest({}), /invalid asset/);
  } finally {
    await new Promise<void>((resolve) => extraServer.close(() => resolve()));
  }

  const duplicatePath = join(root, 'duplicate.sock');
  const duplicateServer = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      tag: 'catalog-v1.1.0',
      sequence: 1,
      assets: [
        { name: 'catalog-v1.json', size: 4 },
        { name: 'catalog-v1.json', size: 4 },
      ],
    }));
  });
  await new Promise<void>((resolve, reject) => {
    duplicateServer.listen(duplicatePath, () => resolve());
    duplicateServer.once('error', reject);
  });
  try {
    const duplicate = createCatalogBrokerNetwork({
      socketPath: duplicatePath,
      policy: compileSequence(1).policy,
    });
    await assert.rejects(duplicate.latest({}), /invalid asset/);
  } finally {
    await new Promise<void>((resolve) => duplicateServer.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('Catalog sync aborts sibling downloads on first failure and settles before returning', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gian-catalog-sync-abort-'));
  try {
    const first = compileSequence(4);
    const store = new CatalogStore({ rootDir: root, policy: first.policy });
    const inflight = new Set<string>();
    const observedAbort = new Map<string, boolean>();
    const client = new CatalogSourceClient({
      store,
      policy: first.policy,
      downloadConcurrency: 3,
      network: {
        async latest() {
          return {
            status: 200,
            release: {
              tag: 'catalog-v1.4.0',
              sequence: 4,
              etag: '"seq-4"',
              assets: [...first.bundle.files.keys()].map((name) => ({
                name,
                size: first.bundle.files.get(name)!.byteLength,
              })),
            },
          };
        },
        async download({ asset, signal }) {
          inflight.add(asset);
          try {
            if (asset === 'catalog-v1.json') {
              await waitWithSignal(20, signal);
              throw new Error('first payload failed');
            }
            await waitWithSignal(200, signal);
            return Buffer.from(first.bundle.files.get(asset) ?? Buffer.alloc(1));
          } catch (error) {
            observedAbort.set(asset, Boolean(signal?.aborted) || /aborted/i.test(
              error instanceof Error ? error.message : String(error),
            ));
            throw error;
          } finally {
            inflight.delete(asset);
          }
        },
      },
    });
    const snapshot = await client.sync();
    assert.equal(snapshot.state, 'error');
    assert.match(snapshot.error?.message ?? '', /first payload failed/);
    assert.equal(inflight.size, 0);
    const siblings = [...observedAbort.entries()].filter(([asset]) => asset !== 'catalog-v1.json');
    assert.ok(siblings.length >= 1);
    assert.ok(siblings.every(([, aborted]) => aborted));
    assert.throws(() => new CatalogSourceClient({
      store,
      policy: first.policy,
      downloadConcurrency: 0,
      network: { async latest() { throw new Error('unused'); }, async download() { throw new Error('unused'); } },
    }), /bounded positive safe integer/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('anonymous latest rejects an invalid ETag before buffering the response body', { timeout: 5_000 }, async () => {
  const policy: OfficialCatalogSourcePolicy = {
    sourceId: 'gian-official',
    repository: 'RichLogic/Gian',
    artifactRepositories: ['RichLogic/Gian'],
    pinnedPublicKeys: { 'gian-official-catalog-2026': 'a'.repeat(64) },
  };
  const chunks = { count: 0, cancelled: false };
  const anonymous = createCatalogAnonymousNetwork({
    policy,
    fetchImpl: async () => chunkedOversizedResponse(chunks, 64 * 1024, 24, {
      etag: `W/"${'a'.repeat(300)}"`,
      'content-type': 'application/json',
    }),
  });
  await assert.rejects(anonymous.latest({}), /ETag is invalid/);
  assert.equal(chunks.cancelled, true);
  assert.ok(chunks.count < 24);
});

test('Catalog sync binds the signed index sequence to the Release coordinate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gian-catalog-sequence-bind-'));
  try {
    const keys = makeSigningKeys();
    const signedTwo = compileSequence(2, 'Unknown reverse-domain Catalog fixture', keys);
    const emptyStore = new CatalogStore({ rootDir: join(root, 'empty'), policy: signedTwo.policy });
    const mismatchedTag = new CatalogSourceClient({
      store: emptyStore,
      policy: signedTwo.policy,
      network: {
        async latest() {
          return {
            status: 200,
            release: {
              tag: 'catalog-v1.9.0',
              sequence: 9,
              etag: '"seq-9"',
              assets: [...signedTwo.bundle.files.keys()].map((name) => ({
                name,
                size: signedTwo.bundle.files.get(name)!.byteLength,
              })),
            },
          };
        },
        async download({ asset }) {
          const bytes = signedTwo.bundle.files.get(asset);
          if (!bytes) throw new Error(`asset not found: ${asset}`);
          return Buffer.from(bytes);
        },
      },
    });
    const empty = await mismatchedTag.sync();
    assert.equal(empty.state, 'error');
    assert.equal(empty.sequence, null);
    assert.match(empty.error?.message ?? '', /sequence|Release coordinate/);

    const keptStore = new CatalogStore({ rootDir: join(root, 'kept'), policy: signedTwo.policy });
    await keptStore.ingest(signedTwo.bundle.files, '"seq-2"');
    const keptClient = new CatalogSourceClient({
      store: keptStore,
      policy: signedTwo.policy,
      network: {
        async latest() {
          return {
            status: 200,
            release: {
              tag: 'catalog-v1.9.0',
              sequence: 9,
              etag: '"seq-9"',
              assets: [...signedTwo.bundle.files.keys()].map((name) => ({
                name,
                size: signedTwo.bundle.files.get(name)!.byteLength,
              })),
            },
          };
        },
        async download({ asset }) {
          const bytes = signedTwo.bundle.files.get(asset);
          if (!bytes) throw new Error(`asset not found: ${asset}`);
          return Buffer.from(bytes);
        },
      },
    });
    const kept = await keptClient.sync();
    assert.equal(kept.sequence, 2);
    assert.notEqual(kept.state, 'ready');

    const metadataStore = new CatalogStore({ rootDir: join(root, 'metadata'), policy: signedTwo.policy });
    await metadataStore.ingest(signedTwo.bundle.files, '"seq-2"');
    const metadataClient = new CatalogSourceClient({
      store: metadataStore,
      policy: signedTwo.policy,
      network: {
        async latest() {
          return {
            status: 200,
            release: {
              tag: 'catalog-v1.9.0',
              sequence: 2,
              etag: '"lie-2"',
              assets: [...signedTwo.bundle.files.keys()].map((name) => ({
                name,
                size: signedTwo.bundle.files.get(name)!.byteLength,
              })),
            },
          };
        },
        async download() {
          throw new Error('metadata sequence mismatch must not download');
        },
      },
    });
    const metadata = await metadataClient.sync();
    assert.equal(metadata.sequence, 2);
    assert.match(metadata.error?.message ?? '', /sequence/);

    const socket = join(root, 'broker-mismatch.sock');
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        tag: 'catalog-v1.9.0',
        sequence: 2,
        assets: [{ name: 'catalog-v1.json', size: 12 }],
      }));
    });
    await new Promise<void>((resolve, reject) => {
      server.listen(socket, () => resolve());
      server.once('error', reject);
    });
    try {
      const broker = createCatalogBrokerNetwork({
        socketPath: socket,
        policy: signedTwo.policy,
      });
      await assert.rejects(broker.latest({}), /sequence|invalid release/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    const anonymous = createCatalogAnonymousNetwork({
      policy: signedTwo.policy,
      fetchImpl: async (input) => {
        if (String(input).includes('/releases?')) {
          return new Response(JSON.stringify([
            {
              tag_name: 'catalog-v1.5.0',
              assets: [{ name: 'catalog-v1.json', size: 4 }],
            },
            {
              tag_name: 'catalog-v1.9.0',
              assets: [{ name: '', size: 4 }],
            },
          ]), {
            status: 200,
            headers: { etag: '"broken-high"', 'content-type': 'application/json' },
          });
        }
        throw new Error('anonymous highest-release failure must not download');
      },
    });
    await assert.rejects(anonymous.latest({}), /highest release metadata is invalid/);

    const highestStore = new CatalogStore({ rootDir: join(root, 'highest'), policy: signedTwo.policy });
    await highestStore.ingest(signedTwo.bundle.files, '"seq-2"');
    const highestClient = new CatalogSourceClient({
      store: highestStore,
      policy: signedTwo.policy,
      network: createCatalogAnonymousNetwork({
        policy: signedTwo.policy,
        fetchImpl: async (input) => {
          if (String(input).includes('/releases?')) {
            return new Response(JSON.stringify([
              {
                tag_name: 'catalog-v1.5.0',
                assets: [{ name: 'catalog-v1.json', size: 4 }],
              },
              {
                tag_name: 'catalog-v1.9.0',
                assets: 'broken',
              },
            ]), {
              status: 200,
              headers: { etag: '"broken-high-sync"', 'content-type': 'application/json' },
            });
          }
          throw new Error('anonymous highest-release failure must not download');
        },
      }),
    });
    const highest = await highestClient.sync();
    assert.equal(highest.sequence, 2);
    assert.notEqual(highest.state, 'ready');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('unique-claim release failure is not reported as a healthy ingest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gian-catalog-claim-release-'));
  try {
    const first = compileSequence(5);
    const store = new CatalogStore({
      rootDir: root,
      policy: first.policy,
      beforeReleaseClaim: async () => {
        throw new Error('unlink blocked');
      },
    });
    await assert.rejects(store.ingest(first.bundle.files, '"gen-5"'), /unlink blocked|CATALOG_CLAIM_RELEASE/);
    assert.notEqual(store.snapshot().state, 'ready');
    assert.equal(store.snapshot().error?.code, 'CATALOG_CLAIM_RELEASE');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function claimPath(root: string, token: string): string {
  return join(root, 'ingest-claims', `claim-${token}`);
}

async function writeClaim(root: string, token: string, body: unknown): Promise<void> {
  await mkdir(join(root, 'ingest-claims'), { recursive: true, mode: 0o700 });
  await writeFile(
    claimPath(root, token),
    typeof body === 'string' ? body : JSON.stringify(body),
  );
}
