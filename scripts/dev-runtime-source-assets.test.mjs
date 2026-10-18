import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { antigravityRuntimeSource } from './build-antigravity-runtime.mjs';
import { prepareDevSourceRuntimeAssets } from './dev-runtime-source-assets.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');

test('source Runtime preparation pins its lock, builds the declared version and never downgrades', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-source-assets-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'runtimes/deepseek-harness');
  await mkdir(source, { recursive: true });
  const pkg = JSON.stringify({ dependencies: { '@deepseek-ai/dsh': '0.2.0-rc.2' } });
  const lock = JSON.stringify({ packages: { 'node_modules/@deepseek-ai/dsh': { version: '0.2.0-rc.2' } } });
  await writeFile(join(source, 'package.json'), pkg);
  await writeFile(join(source, 'package-lock.json'), lock);
  const bytes = Buffer.from('pinned source archive');
  const coordinate = { version: '0.2.0-rc.2', format: 'tar.gz', entryRelativePath: 'bin/example',
    build: { kind: 'dsh-lock', packageSha256: digest(pkg), lockSha256: digest(lock) },
    asset: { sha256: digest(bytes), size: bytes.length } };
  let version = coordinate.version;
  let builds = 0;
  const options = { root, coordinates: [coordinate], directory: join(root, 'cache'),
    prepareAssets: async ({ coordinates, download }) => {
      assert.deepEqual(coordinates, [coordinate]);
      assert.deepEqual(await download(coordinate.asset), bytes);
    },
    build: async output => {
      builds += 1;
      const path = join(output, 'runtime.tar.gz');
      await writeFile(path, bytes);
      return { version, format: coordinate.format, entryRelativePath: coordinate.entryRelativePath, asset: { path } };
    } };
  await prepareDevSourceRuntimeAssets(options);
  assert.equal(builds, 1);
  version = '0.1.5-rc.3';
  await assert.rejects(prepareDevSourceRuntimeAssets(options), /pinned declaration/);
  await writeFile(join(source, 'package-lock.json'), lock + ' ');
  await assert.rejects(prepareDevSourceRuntimeAssets({ ...options,
    prepareAssets: async () => { throw new Error('stale source must fail even with a reusable asset'); },
  }), /pinned package\/lock digests/);
  assert.equal(builds, 2);
});

test('the Dev DSH coordinate follows the current Manifest and exact source lock', async () => {
  const root = new URL('../', import.meta.url);
  const coordinates = JSON.parse(await readFile(new URL('packages/host/src/runtime/dev-runtime-coordinates.json', root)));
  const manifest = JSON.parse(await readFile(new URL('packages/proxies/dsh-proxy/manifest.json', root)));
  const pkg = JSON.parse(await readFile(new URL('packages/proxies/dsh-proxy/package.json', root)));
  const coordinate = coordinates.find(item => item.pluginId === manifest.id);
  assert.equal(coordinate.version, manifest.runtime.verifiedVersions[0]);
  assert.equal(coordinate.asset.url, undefined);
  assert.equal(pkg.version, manifest.pluginVersion);
  // ADR-0095: development carries the next patch with the -Dev suffix; the
  // exact release state keeps the plain published version. Both shapes are
  // valid here — modification discipline is enforced by the version gate.
  assert.match(pkg.version, /^\d+\.\d+\.\d+(?:-Dev)?$/);
  assert.equal(coordinate.build.packageSha256, digest(await readFile(new URL('runtimes/deepseek-harness/package.json', root))));
  assert.equal(coordinate.build.lockSha256, digest(await readFile(new URL('runtimes/deepseek-harness/package-lock.json', root))));
});

function antigravityCoordinate(overrides = {}) {
  return {
    pluginId: 'io.gian.antigravity',
    runtimeId: 'antigravity-acp',
    version: '1.3.0',
    format: 'tar.gz',
    entryRelativePath: 'agy_acp_server.par',
    probe: { kind: 'proxy' },
    build: { kind: 'antigravity-pair', sourceSha256: antigravityRuntimeSource.sourceSha256 },
    asset: { sha256: 'ab'.repeat(32), size: 4 },
    ...overrides,
  };
}

test('Antigravity source preparation builds the pinned pair and stays fail-closed', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-agy-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const coordinate = antigravityCoordinate();
  const bytes = Buffer.from('agy-tar');
  let builds = 0;
  const buildAntigravity = async (output, _work, options) => {
    builds += 1;
    assert.equal(options.archivePath, '/cache/agy-acp-1.3.0.zip');
    const path = join(output, 'runtime.tar.gz');
    await writeFile(path, bytes);
    return {
      version: coordinate.version,
      format: coordinate.format,
      entryRelativePath: coordinate.entryRelativePath,
      asset: { path, publish: false },
    };
  };
  const options = {
    root, coordinates: [coordinate], directory: join(root, 'cache'), archivePath: '/cache/agy-acp-1.3.0.zip',
    prepareAssets: async ({ coordinates, download }) => {
      assert.deepEqual(coordinates, [coordinate]);
      assert.deepEqual(await download(coordinate.asset), bytes);
    },
    build: async () => { throw new Error('DSH builder must not run for Antigravity'); },
    buildAntigravity,
  };
  await prepareDevSourceRuntimeAssets(options);
  assert.equal(builds, 1);
  await assert.rejects(prepareDevSourceRuntimeAssets({
    ...options,
    buildAntigravity: async () => ({
      version: '9.9.9',
      format: coordinate.format,
      entryRelativePath: coordinate.entryRelativePath,
      asset: { path: join(root, 'missing.tar.gz') },
    }),
  }), /pinned declaration/);
  assert.equal(builds, 1);
  await assert.rejects(prepareDevSourceRuntimeAssets({
    ...options,
    coordinates: [antigravityCoordinate({
      build: { kind: 'antigravity-pair', sourceSha256: 'f'.repeat(64) },
    })],
    prepareAssets: async () => { throw new Error('stale Antigravity source must fail before preparation'); },
  }), /pinned Antigravity archive digest/);
  await assert.rejects(prepareDevSourceRuntimeAssets({
    ...options,
    coordinates: [antigravityCoordinate({ asset: { ...coordinate.asset, url: 'https://example.invalid/agy.zip' } })],
    prepareAssets: async () => { throw new Error('a URL must not be fetched for this asset'); },
  }), /cannot carry a URL/);
  await assert.rejects(prepareDevSourceRuntimeAssets({
    ...options,
    coordinates: [antigravityCoordinate({ probe: { kind: 'version-flag' } })],
    prepareAssets: async () => { throw new Error('probe must be rejected before preparation'); },
  }), /probe must stay on the Proxy/);
  await assert.rejects(prepareDevSourceRuntimeAssets({
    ...options,
    coordinates: [antigravityCoordinate({ version: '1.2.0' })],
    prepareAssets: async () => { throw new Error('version drift must fail before preparation'); },
  }), /Proxy declaration/);
  await assert.rejects(prepareDevSourceRuntimeAssets({
    ...options,
    coordinates: [{ build: { kind: 'zip-directory' } }],
    prepareAssets: async () => { throw new Error('unknown builders stay unsupported'); },
  }), /Unsupported Dev Runtime source builder/);
  assert.equal(builds, 1);
});

test('the Dev Antigravity coordinate follows the Manifest and publishes no asset URL', async () => {
  const root = new URL('../', import.meta.url);
  const coordinates = JSON.parse(await readFile(new URL('packages/host/src/runtime/dev-runtime-coordinates.json', root)));
  const manifest = JSON.parse(await readFile(new URL('packages/proxies/antigravity-proxy/manifest.json', root)));
  const pkg = JSON.parse(await readFile(new URL('packages/proxies/antigravity-proxy/package.json', root)));
  const coordinate = coordinates.find(item => item.pluginId === manifest.id);
  assert.equal(pkg.gianProxy.shipping, false);
  assert.equal(coordinate.runtimeId, manifest.runtime.id);
  assert.equal(coordinate.version, manifest.runtime.verifiedVersions[0]);
  assert.equal(coordinate.format, 'tar.gz');
  assert.equal(coordinate.entryRelativePath, 'agy_acp_server.par');
  assert.deepEqual(coordinate.probe, { kind: 'proxy' });
  assert.equal(coordinate.asset.url, undefined);
  assert.equal(coordinate.build.kind, 'antigravity-pair');
  assert.equal(coordinate.build.sourceSha256, antigravityRuntimeSource.sourceSha256);
  assert.equal(Object.hasOwn(coordinate.build, 'sourceUrl'), false);
  assert.equal(coordinate.asset.sha256, '4f16ac5ffe8eca5155be8a24ce0e7118b1c4574ee1121136e837f18c160cc53c');
  assert.equal(coordinate.asset.size, 111300361);
});
