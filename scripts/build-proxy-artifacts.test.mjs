import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

import {
  assertRuntimeManifest,
  buildProxyBundle,
  discoverProxyDefinitions,
  proxyDefinitions,
  shippingProxyIds,
} from './build-proxy-artifacts.mjs';

const execFileAsync = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

test('the default release set includes ZCode and excludes the hidden Grok Proxy', () => {
  assert.deepEqual([...shippingProxyIds].sort(), ['claude', 'codex', 'dsh', 'kimi', 'zcode']);
  assert.equal(proxyDefinitions.find(item => item.id === 'grok')?.shipping, false);
});

test('a new self-describing Proxy package needs no release registry edit', async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), 'gian-proxy-discovery-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const directory = join(fixture, 'packages', 'proxies', 'fixture-proxy');
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'package.json'), JSON.stringify({
    name: '@gian/fixture-proxy',
    version: '1.2.3',
    main: './dist/spawn.js',
    gianProxy: {
      releaseId: 'fixture',
      shipping: true,
      realAcceptance: { binaryEnv: 'FIXTURE_BIN', setup: 'default' },
    },
  }));
  await writeFile(join(directory, 'manifest.json'), JSON.stringify({
    schemaVersion: 4,
    id: 'io.gian.fixture',
    displayName: 'Fixture',
    pluginVersion: '1.2.3',
    entry: 'proxy.mjs',
    protocol: { name: 'gian.proxy', range: '>=2.2 <3.0' },
    process: { scope: 'session' },
    runtime: { kind: 'none' },
  }));
  const discovered = await discoverProxyDefinitions(fixture);
  assert.deepEqual(discovered.map(item => ({
    id: item.id,
    pluginId: item.pluginId,
    shipping: item.shipping,
  })), [{ id: 'fixture', pluginId: 'io.gian.fixture', shipping: true }]);
});

test('proxy bundle has one shebang and supports CommonJS dynamic require', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-proxy-bundle-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entry = join(root, 'spawn.js');
  const dependency = join(root, 'dependency.cjs');
  const output = join(root, 'proxy.mjs');

  await writeFile(dependency, [
    "const path = require('node:path');",
    "module.exports = path.join('proxy', 'ready');",
    '',
  ].join('\n'));
  await writeFile(entry, [
    '#!/usr/bin/env node',
    "import result from './dependency.cjs';",
    "if (process.argv.includes('--self-test')) process.stdout.write(result);",
    '',
  ].join('\n'));

  await buildProxyBundle(entry, output);

  const bundle = await readFile(output, 'utf8');
  assert.equal(bundle.match(/^#!/gm)?.length, 1);
  assert.match(bundle, /^#!\/usr\/bin\/env node\n/);
  const result = await execFileAsync(process.execPath, [output, '--self-test'], {
    encoding: 'utf8',
  });
  assert.equal(result.stdout.trim(), join('proxy', 'ready'));
});

test('bundled shipping proxy self-test ignores an ancestor app package.json', async t => {
  for (const plugin of proxyDefinitions.filter(item => item.shipping)) {
    const root = await mkdtemp(join(tmpdir(), `gian-proxy-self-test-${plugin.id}-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, 'package.json'), `${JSON.stringify({ name: 'gian', version: '9.9.9' })}\n`);
    const packageDir = join(root, 'package');
    await mkdir(packageDir);
    const output = join(packageDir, 'proxy.mjs');
    await buildProxyBundle(
      join(repoRoot, 'packages', 'proxies', plugin.directory, 'src', 'cli', 'spawn.ts'),
      output,
      { name: plugin.packageName, version: plugin.pluginVersion },
    );
    assert.deepEqual(JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8')), {
      name: plugin.packageName, version: plugin.pluginVersion, type: 'module',
    });
    const result = await execFileAsync(process.execPath, [output, '--self-test'], { encoding: 'utf8' });
    const response = JSON.parse(result.stdout.trim());
    assert.equal(response.id, plugin.pluginId);
    assert.equal(response.ok, true);
    assert.equal(response.pluginVersion, plugin.pluginVersion);
  }
});

test('all six official bundles self-test as Manifest v4 with matching identity', async (t) => {
  for (const plugin of proxyDefinitions) {
    const root = await mkdtemp(join(tmpdir(), `gian-proxy-v4-${plugin.id}-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    const output = join(root, 'proxy.mjs');
    await buildProxyBundle(
      join(repoRoot, 'packages', 'proxies', plugin.directory, 'src', 'cli', 'spawn.ts'),
      output,
      { name: plugin.packageName, version: plugin.pluginVersion },
    );
    const manifest = JSON.parse(
      await readFile(join(repoRoot, 'packages', 'proxies', plugin.directory, 'manifest.json'), 'utf8'),
    );
    const pkg = JSON.parse(
      await readFile(join(repoRoot, 'packages', 'proxies', plugin.directory, 'package.json'), 'utf8'),
    );
    assert.equal(manifest.schemaVersion, 4);
    assert.equal(manifest.pluginVersion, pkg.version);
    assert.equal(manifest.protocol.range, '>=2.2 <3.0');
    assert.equal(manifest.runtime.kind, 'external');
    assert.equal(manifest.runtime.id, plugin.manifest.runtime.id);
    assert.equal(manifest.runtime.displayName, plugin.manifest.runtime.displayName);
    assertRuntimeManifest(manifest);
    const result = await execFileAsync(process.execPath, [output, '--self-test'], { encoding: 'utf8' });
    const response = JSON.parse(result.stdout.trim());
    assert.equal(response.schemaVersion, 4);
    assert.equal(response.id, manifest.id);
    assert.equal(response.pluginVersion, manifest.pluginVersion);
    assert.equal(response.ok, true);
  }
});

test('external Runtime manifests require exact verified CLI versions', () => {
  assert.doesNotThrow(() => assertRuntimeManifest({
    id: 'grok',
    runtime: { kind: 'external', id: 'grok', displayName: 'Grok', verifiedVersions: ['1.0.3'] },
  }));
  assert.throws(
    () => assertRuntimeManifest({ id: 'grok', runtime: { kind: 'external', id: 'grok', displayName: 'Grok' } }),
    /verifiedVersions/,
  );
  assert.throws(
    () => assertRuntimeManifest({
      id: 'claude',
      runtime: { kind: 'external', id: 'claude', displayName: 'Claude', verifiedVersions: ['latest'] },
    }),
    /SemVer/,
  );
  assert.throws(
    () => assertRuntimeManifest({
      id: 'codex',
      runtime: { kind: 'external', id: 'codex', displayName: 'Codex', verifiedVersions: ['0.146.0', '0.146.0'] },
    }),
    /duplicates/,
  );
  assert.throws(() => assertRuntimeManifest({
    id: 'x.ai.external',
    runtime: { kind: 'external', id: 'x.ai.external', displayName: 'External' },
  }), /verifiedVersions/);
  assert.doesNotThrow(() => assertRuntimeManifest({
    id: 'x.ai.none',
    runtime: { kind: 'none' },
  }));
  assert.throws(
    () => assertRuntimeManifest({
      id: 'ai.deepseek.harness',
      runtime: { kind: 'external', id: 'dsh', displayName: 'DeepSeek Harness' },
    }),
    /verifiedVersions/,
  );
});
