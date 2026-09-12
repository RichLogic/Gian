import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  DevelopmentProxySourceError,
  discoverDevelopmentProxyEntries,
} from '../src/runtime/development-proxy-source.js';

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
  'hex',
);

async function writeProxy(root: string, directory: string, pluginId: string): Promise<string> {
  const packageDir = join(root, 'packages', 'proxies', directory);
  const entry = join(packageDir, 'dist', 'spawn.js');
  await mkdir(join(packageDir, 'dist'), { recursive: true });
  await mkdir(join(packageDir, 'assets'), { recursive: true });
  await writeFile(entry, '#!/usr/bin/env node\n');
  await writeFile(join(packageDir, 'assets', 'logo.png'), PNG);
  await writeFile(join(packageDir, 'package.json'), JSON.stringify({
    name: `@gian/${directory}`,
    version: '1.0.0',
    main: './dist/spawn.js',
  }));
  await writeFile(join(packageDir, 'manifest.json'), JSON.stringify({
    schemaVersion: 4,
    id: pluginId,
    displayName: pluginId,
    pluginVersion: '1.0.0',
    entry: 'proxy.mjs',
    protocol: { name: 'gian.proxy', range: '>=2.2 <3.0' },
    process: { scope: 'session' },
    runtime: { kind: 'none' },
    branding: {
      logo: {
        light: {
          path: 'assets/logo.png',
          mediaType: 'image/png',
          sha256: createHash('sha256').update(PNG).digest('hex'),
        },
      },
    },
  }));
  return entry;
}

test('GianDev discovers arbitrary Proxy packages from their own Manifests', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gian-dev-proxy-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = await writeProxy(root, 'fixture-proxy', 'io.gian.fixture');
  const second = await writeProxy(root, 'other-proxy', 'io.gian.other');

  const entries = await discoverDevelopmentProxyEntries({
    proxiesDir: join(root, 'packages', 'proxies'),
  });
  assert.deepEqual(Object.keys(entries).sort(), ['io.gian.fixture', 'io.gian.other']);
  assert.equal(entries['io.gian.fixture'], await realpath(first));
  assert.equal(entries['io.gian.other'], await realpath(second));
});

test('generic development overrides require absolute paths and matching Manifest identity', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gian-dev-proxy-override-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entry = await writeProxy(root, 'fixture-proxy', 'io.gian.fixture');
  const proxiesDir = join(root, 'empty');
  await mkdir(proxiesDir);

  await assert.rejects(
    discoverDevelopmentProxyEntries({
      proxiesDir,
      overridesJson: JSON.stringify({ 'io.gian.other': entry }),
    }),
    /identity|match|expected/i,
  );
  await assert.rejects(
    discoverDevelopmentProxyEntries({
      proxiesDir,
      overridesJson: JSON.stringify({ 'io.gian.fixture': 'relative/proxy.mjs' }),
    }),
    (error: unknown) => error instanceof DevelopmentProxySourceError,
  );
});

test('isolated override-only discovery never enables sibling Proxy packages', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gian-dev-proxy-source-isolated-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const selected = await writeProxy(root, 'selected-proxy', 'io.gian.selected');
  await writeProxy(root, 'unrelated-proxy', 'io.gian.unrelated');

  const entries = await discoverDevelopmentProxyEntries({
    proxiesDir: join(root, 'packages', 'proxies'),
    overridesJson: JSON.stringify({ 'io.gian.selected': selected }),
    overridesOnly: true,
  });

  assert.deepEqual(Object.keys(entries), ['io.gian.selected']);
  assert.equal(entries['io.gian.selected'], await realpath(selected));
});
