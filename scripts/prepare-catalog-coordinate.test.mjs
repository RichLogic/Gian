import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';

import { proxyDefinitions, shippingProxyIds } from './build-proxy-artifacts.mjs';
import { proxyReleaseMetadata } from './proxy-release-metadata.mjs';
import { prepareCatalogCoordinate } from './prepare-catalog-coordinate.mjs';
import { zcodeRuntimeSource } from './zcode-runtime-source.mjs';

const requiredSteps = [
  'protocol-build',
  'acceptance-catalog',
  'signed-catalog',
  'artifact-contract',
  'full-deterministic',
  'proxy-ui',
  'preview',
  'proxy-artifacts',
  'runtime-artifacts',
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
  const runtimeAssetName = `gian-runtime-${provider}-${candidatePackages
    .find(candidate => candidate.provider === provider).runtime.verifiedCliVersions[0]}-darwin-arm64`;
  return {
    schemaVersion: 2,
    evidenceModel: 'hosted-artifact-qualification-v1',
    certificateId: `artifacts-${'c'.repeat(40)}-123-1`,
    stage: 'artifacts',
    admissionEligible: false,
    artifactPublicationEligible: true,
    qualified: true,
    status: 'PASS',
    revision: 'c'.repeat(40),
    dirty: false,
    shippingProxyIds: [...shippingProxyIds],
    providers: [...shippingProxyIds],
    certificateMaxAgeHours: 72,
    runner: {
      environment: 'github-hosted',
      os: 'macOS',
      arch: 'ARM64',
      repository: 'RichLogic/Gian',
      runId: '123',
      runAttempt: '1',
    },
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
        source: 'managed-runtime-artifact',
        version: candidate.runtime.verifiedCliVersions[0],
        verified: true,
        sha256: candidate.provider === provider ? runtimeSha256 : 'b'.repeat(64),
        size: candidate.provider === provider ? runtimeSize : 1,
        ...(candidate.provider === 'zcode' ? { sourceCommit: zcodeRuntimeSource.commit } : {}),
      },
    })),
    runtimeArtifacts: candidatePackages
      .map(candidate => {
        const selected = candidate.provider === provider;
        const version = candidate.runtime.verifiedCliVersions[0];
        const name = selected
          ? runtimeAssetName
          : `gian-runtime-${candidate.provider}-${version}-darwin-arm64`;
        const sha256 = selected ? runtimeSha256 : 'b'.repeat(64);
        const size = selected ? runtimeSize : 1;
        return {
          provider: candidate.provider,
          version,
          format: candidate.provider === 'zcode' ? 'tar.gz' : 'raw',
          entryRelativePath: candidate.provider === 'zcode' ? zcodeRuntimeSource.entryRelativePath : `bin/${candidate.provider}`,
          ...(candidate.provider === 'zcode' ? { source: zcodeRuntimeSource } : {}),
          entry: { sha256, size },
          asset: {
            name,
            path: name,
            url: `https://github.com/RichLogic/Gian/releases/download/proxy-${candidate.provider}-v0.0.0/${name}`,
            sha256,
            size,
            publish: true,
          },
        };
      }),
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
  const certifiedRuntime = certificate.runtimeArtifacts.find(candidate => candidate.provider === 'codex');
  certifiedRuntime.asset.name = runtimeAsset;
  certifiedRuntime.asset.path = runtimeAsset;
  certifiedRuntime.asset.url = `https://github.com/RichLogic/Gian/releases/download/${metadata.tag}/${runtimeAsset}`;
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
  assert.equal(coordinate.combination.runtime.format, 'raw');
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

test('ZCode coordinate downloads a Git-pinned CLI archive and rejects changed provenance', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gian-zcode-coordinate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const metadata = proxyReleaseMetadata('zcode');
  const archive = Buffer.from('zcode proxy archive');
  const manifest = Buffer.from('{"schemaVersion":4}\n');
  const entry = Buffer.from("process.stdout.write('0.16.9\\n');\n");
  const tarball = (source) => {
    const records = [];
    for (const [name, bytes] of [
      [zcodeRuntimeSource.entryRelativePath, entry],
      ['zcode/gian-source.json', Buffer.from(JSON.stringify(source))],
    ]) {
      const header = Buffer.alloc(512);
      header.write(name);
      header.write('0000755\0', 100);
      header.write(`${bytes.length.toString(8).padStart(11, '0')}\0`, 124);
      header[156] = 0x30;
      header.fill(0x20, 148, 156);
      const checksum = header.reduce((sum, byte) => sum + byte, 0);
      header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148);
      records.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
    }
    return gzipSync(Buffer.concat([...records, Buffer.alloc(1024)]));
  };
  const runtimeBytes = tarball(zcodeRuntimeSource);
  const certificate = releaseCertificate(
    'zcode',
    createHash('sha256').update(archive).digest('hex'),
    createHash('sha256').update(entry).digest('hex'),
    entry.length,
  );
  const runtime = certificate.runtimeArtifacts.find(candidate => candidate.provider === 'zcode');
  runtime.asset.name = 'zcode-runtime.tar.gz';
  runtime.asset.path = runtime.asset.name;
  runtime.asset.sha256 = createHash('sha256').update(runtimeBytes).digest('hex');
  runtime.asset.size = runtimeBytes.length;
  const certificatePath = join(root, 'certificate.json');
  await Promise.all([
    writeFile(join(root, metadata.asset), archive),
    writeFile(join(root, `${metadata.asset}.manifest.json`), manifest),
    writeFile(join(root, runtime.asset.name), runtimeBytes),
    writeFile(certificatePath, `${JSON.stringify(certificate, null, 2)}\n`),
  ]);

  const coordinate = await prepareCatalogCoordinate({
    provider: 'zcode',
    artifactDir: root,
    certificatePath,
  });
  assert.equal(coordinate.combination.runtime.kind, 'native-binary');
  assert.equal(coordinate.combination.runtime.format, 'tar.gz');
  assert.equal(coordinate.combination.runtime.entryRelativePath, zcodeRuntimeSource.entryRelativePath);
  assert.equal(coordinate.combination.runtime.asset.sha256, runtime.asset.sha256);

  const changed = tarball({ ...zcodeRuntimeSource, commit: 'f'.repeat(40) });
  runtime.asset.sha256 = createHash('sha256').update(changed).digest('hex');
  runtime.asset.size = changed.length;
  await writeFile(join(root, runtime.asset.name), changed);
  await writeFile(certificatePath, JSON.stringify(certificate));
  await assert.rejects(prepareCatalogCoordinate({ provider: 'zcode', artifactDir: root, certificatePath }), /pinned Git source/);
});

test('Catalog coordinate rejects non-shipping packages and malformed repositories', async () => {
  await assert.rejects(
    prepareCatalogCoordinate({ provider: 'vendor-x', artifactDir: '/tmp' }),
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
