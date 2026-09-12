import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { proxyDefinitions, shippingProxyIds } from './build-proxy-artifacts.mjs';
import { proxyReleaseMetadata } from './proxy-release-metadata.mjs';
import { prepareCatalogCoordinate } from './prepare-catalog-coordinate.mjs';

const requiredSteps = [
  'acceptance-catalog',
  'signed-catalog',
  'artifact-contract',
  'full-deterministic',
  'proxy-ui',
  'preview',
  'proxy-artifacts',
  'package',
  'real-provider',
  'candidate-binding',
];

function releaseCertificate(provider, proxySha256, runtimeSha256, runtimeSize) {
  const candidatePackages = proxyDefinitions
    .filter(definition => definition.shipping)
    .map(definition => ({
      provider: definition.id,
      pluginId: definition.pluginId,
      packageName: definition.packageName,
      proxyVersion: definition.pluginVersion,
      processScope: definition.manifest.process.scope,
      runtime: {
        id: definition.runtime.id,
        verifiedCliVersions: [...definition.runtime.verifiedCliVersions],
      },
    }));
  return {
    schemaVersion: 1,
    certificateId: `release-${'c'.repeat(40)}`,
    stage: 'release',
    admissionEligible: true,
    qualified: true,
    status: 'PASS',
    revision: 'c'.repeat(40),
    dirty: false,
    shippingProxyIds: [...shippingProxyIds],
    providers: [...shippingProxyIds],
    realEvidenceMaxAgeHours: 72,
    completedAt: new Date().toISOString(),
    steps: requiredSteps.map(id => ({ id, status: 'PASS' })),
    candidatePackages,
    candidateTuple: candidatePackages.map(candidate => ({
      provider: candidate.provider,
      proxy: {
        source: 'packaged-artifact',
        proxyVersion: candidate.proxyVersion,
        sha256: candidate.provider === provider ? proxySha256 : 'a'.repeat(64),
      },
      cli: {
        version: candidate.runtime.verifiedCliVersions[0],
        verified: true,
        sha256: candidate.provider === provider ? runtimeSha256 : 'b'.repeat(64),
        size: candidate.provider === provider ? runtimeSize : 1,
      },
    })),
  };
}

test('Catalog coordinate binds immutable darwin-arm64 URLs to exact certified bytes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gian-catalog-coordinate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(root, { recursive: true });
  const metadata = proxyReleaseMetadata('codex');
  const archive = Buffer.from('archive bytes');
  const manifest = Buffer.from('{"schemaVersion":4}\n');
  const runtime = Buffer.from('#!/bin/sh\necho 0.146.0\n');
  const certificate = releaseCertificate(
    'codex',
    createHash('sha256').update(archive).digest('hex'),
    createHash('sha256').update(runtime).digest('hex'),
    runtime.length,
  );
  const certificateBytes = Buffer.from(`${JSON.stringify(certificate, null, 2)}\n`);
  const runtimeAsset = 'gian-runtime-codex-0.146.0-darwin-arm64';
  const certificatePath = join(root, 'certificate.json');
  await writeFile(join(root, metadata.asset), archive);
  await writeFile(join(root, `${metadata.asset}.manifest.json`), manifest);
  await writeFile(join(root, runtimeAsset), runtime);
  await writeFile(certificatePath, certificateBytes);

  const coordinate = await prepareCatalogCoordinate({
    provider: 'codex',
    artifactDir: root,
    certificatePath,
    runtimeAsset,
    runtimeEntry: 'bin/codex',
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
  assert.equal(coordinate.combination.runtime.kind, 'native-binary');
  assert.equal(
    coordinate.combination.runtime.asset.sha256,
    createHash('sha256').update(runtime).digest('hex'),
  );
  assert.equal(coordinate.combination.runtime.entryRelativePath, 'bin/codex');
  assert.equal(coordinate.combination.certificate.id, certificate.certificateId);
  assert.equal(
    coordinate.combination.certificate.sha256,
    createHash('sha256').update(certificateBytes).digest('hex'),
  );
});

test('ZCode coordinate binds the certified local App Runtime without a CLI download', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gian-zcode-coordinate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const metadata = proxyReleaseMetadata('zcode');
  const archive = Buffer.from('zcode proxy archive');
  const manifest = Buffer.from('{"schemaVersion":4}\n');
  const runtimeSha256 = createHash('sha256').update('zcode app runtime').digest('hex');
  const certificate = releaseCertificate(
    'zcode',
    createHash('sha256').update(archive).digest('hex'),
    runtimeSha256,
    321,
  );
  const certificatePath = join(root, 'certificate.json');
  await Promise.all([
    writeFile(join(root, metadata.asset), archive),
    writeFile(join(root, `${metadata.asset}.manifest.json`), manifest),
    writeFile(certificatePath, `${JSON.stringify(certificate, null, 2)}\n`),
  ]);

  const coordinate = await prepareCatalogCoordinate({
    provider: 'zcode',
    artifactDir: root,
    certificatePath,
  });
  assert.deepEqual(coordinate.combination.runtime, {
    kind: 'external-app',
    runtimeId: 'zcode',
    version: metadata.runtime.verifiedVersions[0],
    artifactSha256: runtimeSha256,
  });
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
