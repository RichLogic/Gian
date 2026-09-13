import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { applyCatalogCoordinate } from './apply-catalog-coordinate.mjs';
import { proxyReleaseMetadata } from './proxy-release-metadata.mjs';
import { releaseSourceIssues } from './verify-official-catalog-release-source.mjs';

test('Catalog release source refuses documentation-only shipping entries', () => {
  const metadata = proxyReleaseMetadata('claude');
  const plugins = [{ entry: {
    pluginId: metadata.pluginId,
    channels: { stable: { pluginVersion: metadata.version } },
  } }];
  assert.match(releaseSourceIssues(plugins).join('\n'), /no installable darwin-arm64 Proxy coordinate/);
});

test('Catalog coordinate application changes only the matching stable channel', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-catalog-apply-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const metadata = proxyReleaseMetadata('claude');
  const pluginDir = join(root, 'plugins', metadata.pluginId);
  await mkdir(pluginDir, { recursive: true });
  const entry = {
    schemaVersion: 1,
    pluginId: metadata.pluginId,
    displayName: 'Claude',
    channels: { stable: { pluginVersion: metadata.version } },
  };
  const coordinate = {
    pluginVersion: metadata.version,
    manifest: { url: 'https://example.test/manifest', sha256: 'a'.repeat(64), size: 1 },
    artifacts: {},
    combination: { generationId: 'generation' },
  };
  const coordinatePath = join(root, 'coordinate.json');
  await Promise.all([
    writeFile(join(pluginDir, 'entry.json'), `${JSON.stringify(entry)}\n`),
    writeFile(coordinatePath, `${JSON.stringify(coordinate)}\n`),
  ]);
  await applyCatalogCoordinate({ provider: 'claude', coordinatePath, sourceRoot: root });
  const updated = JSON.parse(await readFile(join(pluginDir, 'entry.json'), 'utf8'));
  assert.equal(updated.displayName, entry.displayName);
  assert.deepEqual(updated.channels.stable, coordinate);
});
