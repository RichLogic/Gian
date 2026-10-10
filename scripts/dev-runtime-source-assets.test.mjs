import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
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
  assert.match(pkg.version, /-Dev$/);
  assert.equal(coordinate.build.packageSha256, digest(await readFile(new URL('runtimes/deepseek-harness/package.json', root))));
  assert.equal(coordinate.build.lockSha256, digest(await readFile(new URL('runtimes/deepseek-harness/package-lock.json', root))));
});
