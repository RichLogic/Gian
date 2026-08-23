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
  shippingProxyIds,
} from './build-proxy-artifacts.mjs';

const execFileAsync = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

test('the default release set includes DSH and excludes the hidden Grok Proxy', () => {
  assert.deepEqual(shippingProxyIds, ['claude', 'codex', 'kimi', 'dsh']);
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
  const plugins = [
    {
      id: 'claude',
      source: 'packages/proxies/cc-proxy/src/cli/spawn.ts',
      manifest: 'packages/proxies/cc-proxy/package.json',
    },
    {
      id: 'codex',
      source: 'packages/proxies/codex-proxy/src/cli/spawn.ts',
      manifest: 'packages/proxies/codex-proxy/package.json',
    },
    {
      id: 'kimi',
      source: 'packages/proxies/kimi-proxy/src/cli/spawn.ts',
      manifest: 'packages/proxies/kimi-proxy/package.json',
    },
  ];

  for (const plugin of plugins) {
    const root = await mkdtemp(join(tmpdir(), `gian-proxy-self-test-${plugin.id}-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(root, 'package.json'), `${JSON.stringify({ name: 'gian', version: '9.9.9' })}\n`);
    const packageDir = join(root, 'package');
    await mkdir(packageDir);
    const output = join(packageDir, 'proxy.mjs');
    await buildProxyBundle(join(repoRoot, plugin.source), output);
    const expectedVersion = JSON.parse(await readFile(join(repoRoot, plugin.manifest), 'utf8')).version;
    const result = await execFileAsync(process.execPath, [output, '--self-test'], { encoding: 'utf8' });
    const response = JSON.parse(result.stdout.trim());
    assert.equal(response.id, plugin.id);
    assert.equal(response.ok, true);
    assert.equal(response.pluginVersion, expectedVersion);
  }
});

test('built-in proxy manifests require SemVer recommended CLI versions', () => {
  assert.doesNotThrow(() => assertRuntimeManifest({
    id: 'grok',
    runtime: { id: 'grok', displayName: 'Grok', recommendedCliVersion: '1.0.3' },
  }));
  assert.throws(
    () => assertRuntimeManifest({ id: 'grok', runtime: { id: 'grok', displayName: 'Grok' } }),
    /recommendedCliVersion/,
  );
  assert.throws(
    () => assertRuntimeManifest({
      id: 'claude',
      runtime: { id: 'claude', displayName: 'Claude', recommendedCliVersion: 'latest' },
    }),
    /SemVer/,
  );
  assert.doesNotThrow(() => assertRuntimeManifest({
    id: 'x.ai.external',
    runtime: { id: 'x.ai.external', displayName: 'External' },
  }));
  assert.throws(
    () => assertRuntimeManifest({
      id: 'ai.deepseek.harness',
      runtime: { id: 'dsh', displayName: 'DeepSeek Harness' },
    }),
    /recommendedCliVersion/,
  );
});
