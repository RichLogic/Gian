import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  assertGianDevRuntimeDataDir,
  bundledDevProxyDirectory,
  declarationsFromProxyDirectory,
  declarationsFromProxyEntries,
  devRuntimeDeclarationsForCoordinates,
  preferProvisionedRuntime,
  provisionDevRuntimes,
  selectDevRuntimeCoordinates,
  shouldProvisionDevRuntimes,
} from '../src/runtime/dev-runtime-provision.js';
import type { DevRuntimeCoordinate } from '../src/runtime/dev-runtime-coordinates.js';
import { downloadDevRuntimeAsset, prepareDevRuntimeAssets, readBundledDevRuntimeAsset } from '../src/runtime/dev-runtime-assets.js';

const coordinate = {
  pluginId: 'example.proxy',
  runtimeId: 'example',
  version: '1.2.3',
  format: 'raw' as const,
  entryRelativePath: 'bin/example',
  asset: {
    url: 'https://example.invalid/example',
    sha256: '',
    size: 0,
  },
};

test('dev runtime provisioning is explicit and package smoke requires isolated mode', () => {
  assert.equal(shouldProvisionDevRuntimes({ GIAN_PROVISION_DEV_RUNTIMES: '1' }), true);
  assert.equal(shouldProvisionDevRuntimes({}), false);
  assert.equal(shouldProvisionDevRuntimes({
    GIAN_PROVISION_DEV_RUNTIMES: '1',
    GIAN_DESKTOP_SMOKE_MANAGE_HOST: '1',
  }), false);
  assert.equal(shouldProvisionDevRuntimes({ GIAN_PROVISION_DEV_RUNTIMES: '1',
    GIAN_DESKTOP_SMOKE_MANAGE_HOST: '1', GIAN_DEV_RUNTIME_PROVISION_MODE: 'isolated' }), true);
});

test('bundled Runtime envelopes retain pinned bytes, reuse cache and reject corruption', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-dev-runtime-assets-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from('original executable bytes\n');
  const pinned = { ...coordinate, asset: { ...coordinate.asset,
    sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length } };
  let downloads = 0;
  await prepareDevRuntimeAssets({ directory: root, coordinates: [pinned], download: async () => {
    downloads += 1; return bytes;
  } });
  assert.deepEqual(await readBundledDevRuntimeAsset(root, pinned.asset), bytes);
  await prepareDevRuntimeAssets({ directory: root, coordinates: [pinned], download: async () => {
    throw new Error('cache reuse must not download');
  } });
  assert.equal(downloads, 1);
  await writeFile(join(root, `${pinned.asset.sha256}.gz`), gzipSync(Buffer.from('wrong')));
  await assert.rejects(readBundledDevRuntimeAsset(root, pinned.asset), /pinned bytes/);
  await assert.rejects(readBundledDevRuntimeAsset(root, { ...pinned.asset, sha256: '../escape' }), /Invalid/);
});

test('a certified runtime path wins and a missing one uses the provisioned CLI', () => {
  const provisioned = new Map([['kimi', '/data/runtimes/kimi/2.1.1/abc/kimi']]);
  assert.equal(preferProvisionedRuntime('/already/certified', 'kimi', provisioned), '/already/certified');
  assert.equal(preferProvisionedRuntime(null, 'kimi', provisioned), '/data/runtimes/kimi/2.1.1/abc/kimi');
  assert.equal(preferProvisionedRuntime(null, 'grok', provisioned), null);
});

test('source-built CLI assets require bundled bytes instead of a fabricated download URL', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-source-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from('locked source CLI bytes');
  const asset = { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
  const pinned = { ...coordinate, asset };
  await assert.rejects(downloadDevRuntimeAsset(asset), /requires bundled CLI assets/);
  await prepareDevRuntimeAssets({ directory: root, coordinates: [pinned], download: async () => bytes });
  assert.deepEqual(await readBundledDevRuntimeAsset(root, asset), bytes);
  await prepareDevRuntimeAssets({ directory: root, coordinates: [pinned] });
});

test('selection follows the proxy runtime version and refuses an unpinned CLI', () => {
  const pinned = { ...coordinate, asset: { ...coordinate.asset, sha256: 'abc', size: 1 } };
  assert.deepEqual(selectDevRuntimeCoordinates([{
    pluginId: 'example.proxy',
    runtimeId: 'example',
    versions: ['1.2.3'],
  }], [pinned]), [pinned]);
  assert.throws(() => selectDevRuntimeCoordinates([{
    pluginId: 'example.proxy',
    runtimeId: 'example',
    versions: ['9.9.9'],
  }], [pinned]), /no pinned GianDev CLI coordinate/);
});

test('provisioning refuses production data and installs one raw CLI below an isolated runtimes tree', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gian-dev-runtime-home-'));
  try {
    await assert.rejects(
      assertGianDevRuntimeDataDir(join(home, '.gian'), home, 'isolated'),
      /production/,
    );
    const body = Buffer.from('example-cli\n');
    const { createHash } = await import('node:crypto');
    const digest = createHash('sha256').update(body).digest('hex');
    const pinned = {
      ...coordinate,
      asset: { url: 'https://example.invalid/example', sha256: digest, size: body.length },
    };
    let downloads = 0;
    const dataDir = join(home, 'isolated');
    const installed = await provisionDevRuntimes({
      dataDir,
      homeDir: home,
      mode: 'isolated',
      declarations: [{ pluginId: pinned.pluginId, runtimeId: pinned.runtimeId, versions: [pinned.version] }],
      coordinates: [pinned],
      download: async () => {
        downloads += 1;
        return body;
      },
      probe: async () => pinned.version,
    });
    assert.equal(downloads, 1);
    assert.equal(installed[0]?.entryPath, join(dataDir, 'runtimes', 'example', '1.2.3', digest, 'bin', 'example'));
    assert.equal(await readFile(installed[0]!.entryPath, 'utf8'), 'example-cli\n');
    await provisionDevRuntimes({
      dataDir,
      homeDir: home,
      mode: 'isolated',
      declarations: [{ pluginId: pinned.pluginId, runtimeId: pinned.runtimeId, versions: [pinned.version] }],
      coordinates: [pinned],
      download: async () => { throw new Error('already installed'); },
      probe: async () => { throw new Error('already installed'); },
    });
    assert.equal(downloads, 1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('host provisioning keeps a successful CLI when a later coordinate fails', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gian-dev-runtime-partial-'));
  try {
    const body = Buffer.from('kept-cli\n');
    const { createHash } = await import('node:crypto');
    const digest = createHash('sha256').update(body).digest('hex');
    const kept = {
      ...coordinate,
      asset: { url: 'https://example.invalid/kept', sha256: digest, size: body.length },
    };
    const skipped = {
      ...coordinate,
      pluginId: 'example.other',
      runtimeId: 'other',
      version: '9.9.9',
      entryRelativePath: 'bin/other',
      asset: { url: 'https://example.invalid/other', sha256: 'f'.repeat(64), size: 4 },
    };
    const installed = await provisionDevRuntimes({
      dataDir: join(home, 'isolated'),
      homeDir: home,
      mode: 'isolated',
      continueOnError: true,
      declarations: [
        { pluginId: kept.pluginId, runtimeId: kept.runtimeId, versions: [kept.version] },
        { pluginId: skipped.pluginId, runtimeId: skipped.runtimeId, versions: [skipped.version] },
      ],
      coordinates: [kept, skipped],
      download: async asset => {
        if (asset.sha256 === digest) return body;
        throw new Error('second coordinate failed');
      },
      probe: async () => kept.version,
    });
    assert.deepEqual(installed.map(runtime => runtime.pluginId), [kept.pluginId]);
    assert.equal(installed[0]?.artifactSha256, digest);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('a proxy coordinate probes through its exact entry and a missing binding fails before download', async () => {
  const home = await mkdtemp(join(tmpdir(), 'gian-dev-runtime-proxy-'));
  try {
    const body = Buffer.from('proxy-runtime\n');
    const digest = createHash('sha256').update(body).digest('hex');
    const pinned = {
      ...coordinate,
      probe: { kind: 'proxy' as const },
      asset: { url: 'https://example.invalid/example', sha256: digest, size: body.length },
    };
    const unbound = [{ pluginId: pinned.pluginId, runtimeId: pinned.runtimeId, versions: [pinned.version] }];
    let downloads = 0;
    await assert.rejects(provisionDevRuntimes({
      dataDir: join(home, 'isolated'),
      homeDir: home,
      mode: 'isolated',
      declarations: unbound,
      coordinates: [pinned],
      download: async () => {
        downloads += 1;
        return body;
      },
      probe: async () => { throw new Error('cli probe'); },
      probeProxy: async () => { throw new Error('proxy probe'); },
    }), /exact Proxy entry binding/);
    assert.equal(downloads, 0);

    let cliProbes = 0;
    let seenExecutable = '';
    const installed = await provisionDevRuntimes({
      dataDir: join(home, 'isolated'),
      homeDir: home,
      mode: 'isolated',
      hostVersion: '9.9.9-test',
      declarations: [{
        ...unbound[0]!,
        pluginVersion: '1.0.0',
        processScope: 'session',
        displayName: 'Example Runtime',
        entryPath: '/exact/proxy.mjs',
      }],
      coordinates: [pinned],
      download: async () => body,
      probe: async () => {
        cliProbes += 1;
        return pinned.version;
      },
      probeProxy: async (request) => {
        seenExecutable = request.executable;
        assert.equal(request.hostVersion, '9.9.9-test');
        assert.equal(request.declaration.entryPath, '/exact/proxy.mjs');
        assert.equal(request.declaration.displayName, 'Example Runtime');
        assert.equal(request.declaration.pluginVersion, '1.0.0');
        assert.equal(request.coordinate.probe?.kind, 'proxy');
        return pinned.version;
      },
    });
    assert.equal(cliProbes, 0);
    assert.match(seenExecutable, /[/]bin[/]example$/);
    assert.equal(installed[0]?.version, pinned.version);

    let proxyProbes = 0;
    await provisionDevRuntimes({
      dataDir: join(home, 'cli'),
      homeDir: home,
      mode: 'isolated',
      declarations: unbound,
      coordinates: [{ ...pinned, probe: undefined }],
      download: async () => body,
      probe: async () => pinned.version,
      probeProxy: async () => {
        proxyProbes += 1;
        return pinned.version;
      },
    });
    assert.equal(proxyProbes, 0);

    await assert.rejects(provisionDevRuntimes({
      dataDir: join(home, 'bad-kind'),
      homeDir: home,
      mode: 'isolated',
      declarations: unbound,
      coordinates: [{ ...pinned, probe: { kind: 'cli' } } as DevRuntimeCoordinate],
      download: async () => {
        throw new Error('downloaded');
      },
    }), /unsupported Dev Runtime probe/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('proxy declarations keep Manifest binding fields and packaged proxies stay beside assets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gian-dev-proxy-binding-'));
  try {
    assert.equal(
      bundledDevProxyDirectory('/Applications/GianDev.app/Contents/Resources/giandev/runtime-assets'),
      '/Applications/GianDev.app/Contents/Resources/giandev/proxies',
    );
    await assert.rejects(declarationsFromProxyDirectory(join(root, 'missing')), /Refusing to guess a Proxy path/);

    const directory = join(root, 'proxies', 'example-proxy');
    await mkdir(join(directory, 'assets'), { recursive: true });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    await writeFile(join(directory, 'assets/logo.png'), png);
    const entry = join(directory, 'proxy.mjs');
    await writeFile(entry, 'export {}\n');
    await writeFile(join(directory, 'package.json'), `${JSON.stringify({
      name: '@gian/example-proxy', version: '1.0.0', type: 'module', main: './proxy.mjs',
    })}\n`);
    await writeFile(join(directory, 'manifest.json'), `${JSON.stringify({
      schemaVersion: 4,
      id: 'example.proxy',
      displayName: 'Example',
      pluginVersion: '1.0.0',
      entry: 'proxy.mjs',
      protocol: { name: 'gian.proxy', range: '>=2.2 <3.0' },
      process: { scope: 'session' },
      runtime: {
        kind: 'external',
        id: 'example',
        displayName: 'Example Runtime',
        verifiedVersions: ['1.2.3'],
      },
      branding: {
        logo: {
          light: {
            path: 'assets/logo.png',
            mediaType: 'image/png',
            sha256: createHash('sha256').update(png).digest('hex'),
          },
        },
      },
    })}\n`);
    const declarations = await declarationsFromProxyEntries({ 'example.proxy': entry });
    assert.equal(declarations[0]?.pluginVersion, '1.0.0');
    assert.equal(declarations[0]?.processScope, 'session');
    assert.equal(declarations[0]?.displayName, 'Example Runtime');
    assert.equal(declarations[0]?.entryPath, entry);
    assert.deepEqual(declarations[0]?.versions, ['1.2.3']);
    const bundled = await declarationsFromProxyDirectory(join(root, 'proxies'));
    assert.equal(bundled[0]?.entryPath, await realpath(entry));
    assert.equal(bundled[0]?.entryPath.includes(`${join('packages', 'proxies')}`), false);

    await assert.rejects(
      declarationsFromProxyEntries({ 'example.proxy': 'proxy.mjs' }),
      /exact absolute path/,
    );
    const link = join(root, 'linked.mjs');
    await symlink(entry, link);
    await assert.rejects(declarationsFromProxyEntries({ 'example.proxy': link }), /regular file/);
    await assert.rejects(
      declarationsFromProxyEntries({ 'other.proxy': entry }),
      /does not match Manifest id/,
    );
    const pinned = { ...coordinate, asset: { ...coordinate.asset, sha256: 'abc', size: 1 } };
    const bound = declarations[0]!;
    const covered = devRuntimeDeclarationsForCoordinates([
      bound,
      { ...bound, pluginId: 'io.gian.extra', runtimeId: 'extra', versions: ['9.9.9'] },
    ], [pinned, { ...pinned, pluginId: 'missing.proxy', runtimeId: 'missing', version: '4.5.6' }]);
    assert.deepEqual(covered.map((item) => item.runtimeId), ['example', 'missing']);
    assert.equal(covered[0]?.entryPath, entry);
    assert.equal(covered[1]?.entryPath, undefined);
    assert.throws(() => devRuntimeDeclarationsForCoordinates([bound], [{
      ...pinned,
      probe: { kind: 'proxy' },
      version: '9.9.9',
    }]), /no Proxy declaration binding/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
