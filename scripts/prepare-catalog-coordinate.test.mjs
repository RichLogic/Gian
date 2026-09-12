import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { proxyReleaseMetadata } from './proxy-release-metadata.mjs';
import { prepareCatalogCoordinate } from './prepare-catalog-coordinate.mjs';

test('Catalog coordinate binds immutable darwin-arm64 URLs to exact certified bytes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gian-catalog-coordinate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(root, { recursive: true });
  const metadata = proxyReleaseMetadata('codex');
  const archive = Buffer.from('archive bytes');
  const manifest = Buffer.from('{"schemaVersion":4}\n');
  await writeFile(join(root, metadata.asset), archive);
  await writeFile(join(root, `${metadata.asset}.manifest.json`), manifest);

  const coordinate = await prepareCatalogCoordinate({
    provider: 'codex',
    artifactDir: root,
  });
  assert.equal(coordinate.pluginVersion, metadata.version);
  assert.match(coordinate.manifest.url, new RegExp(`${metadata.tag}/`));
  assert.equal(coordinate.manifest.sha256, createHash('sha256').update(manifest).digest('hex'));
  assert.equal(coordinate.manifest.size, manifest.length);
  assert.equal(
    coordinate.artifacts['darwin-arm64'].sha256,
    createHash('sha256').update(archive).digest('hex'),
  );
  assert.equal(coordinate.artifacts['darwin-arm64'].size, archive.length);
});

test('Catalog coordinate rejects non-shipping packages and malformed repositories', async () => {
  await assert.rejects(
    prepareCatalogCoordinate({ provider: 'grok', artifactDir: '/tmp' }),
    /not in the shipping/,
  );
  await assert.rejects(
    prepareCatalogCoordinate({
      provider: 'codex',
      artifactDir: '/tmp',
      repository: 'https://github.com/RichLogic/Gian',
    }),
    /owner\/name/,
  );
});
