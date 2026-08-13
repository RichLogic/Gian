import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  parseLatestMacManifest,
  verifyUpdateArtifacts,
} from './verify-update-artifacts.mjs';

const version = '0.4.3';
const zipName = `Gian-${version}-arm64.zip`;
const dmgName = `Gian-${version}-arm64.dmg`;

function digest(content) {
  return createHash('sha512').update(content).digest('base64');
}

function manifestFor(zip, dmg, overrides = {}) {
  return [
    `version: ${overrides.version ?? version}`,
    'files:',
    `  - url: ${overrides.zipUrl ?? zipName}`,
    `    sha512: ${overrides.zipSha512 ?? digest(zip)}`,
    `    size: ${overrides.zipSize ?? zip.length}`,
    `  - url: ${overrides.dmgUrl ?? dmgName}`,
    `    sha512: ${overrides.dmgSha512 ?? digest(dmg)}`,
    `    size: ${overrides.dmgSize ?? dmg.length}`,
    `path: ${overrides.path ?? zipName}`,
    `sha512: ${overrides.topSha512 ?? overrides.zipSha512 ?? digest(zip)}`,
    'releaseDate: 2026-08-12T00:00:00.000Z',
    '',
  ].join('\n');
}

async function withReleaseFixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'gian-update-artifacts-'));
  const zip = Buffer.from('signed zip fixture');
  const dmg = Buffer.from('signed dmg fixture');
  try {
    await Promise.all([
      writeFile(join(directory, zipName), zip),
      writeFile(join(directory, dmgName), dmg),
      writeFile(join(directory, 'latest-mac.yml'), manifestFor(zip, dmg)),
    ]);
    await run({ directory, zip, dmg });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('parses the electron-builder latest-mac.yml subset without a YAML dependency', () => {
  const zip = Buffer.from('zip');
  const dmg = Buffer.from('dmg');
  const manifest = parseLatestMacManifest(manifestFor(zip, dmg));

  assert.equal(manifest.version, version);
  assert.equal(manifest.path, zipName);
  assert.deepEqual(
    manifest.files.map(file => ({ url: file.url, size: file.size })),
    [
      { url: zipName, size: zip.length },
      { url: dmgName, size: dmg.length },
    ],
  );
});

test('verifies version, artifact URLs, sizes, and SHA-512 digests', async () => {
  await withReleaseFixture(async ({ directory, zip, dmg }) => {
    const result = await verifyUpdateArtifacts({ releaseDir: directory, version });
    assert.deepEqual(
      result.artifacts.map(artifact => [artifact.name, artifact.size, artifact.sha512]),
      [
        [zipName, zip.length, digest(zip)],
        [dmgName, dmg.length, digest(dmg)],
      ],
    );
  });
});

test('fails closed on release version or artifact URL drift', async () => {
  await withReleaseFixture(async ({ directory, zip, dmg }) => {
    await writeFile(
      join(directory, 'latest-mac.yml'),
      manifestFor(zip, dmg, { version: '0.4.4' }),
    );
    await assert.rejects(
      verifyUpdateArtifacts({ releaseDir: directory, version }),
      /manifest version 0\.4\.4 does not match release version 0\.4\.3/,
    );

    await writeFile(
      join(directory, 'latest-mac.yml'),
      manifestFor(zip, dmg, { dmgUrl: '../Gian-0.4.3-arm64.dmg' }),
    );
    await assert.rejects(
      verifyUpdateArtifacts({ releaseDir: directory, version }),
      /artifact URL must be a local basename/,
    );
  });
});

test('fails closed on manifest size, entry digest, or top-level ZIP digest drift', async () => {
  await withReleaseFixture(async ({ directory, zip, dmg }) => {
    await writeFile(
      join(directory, 'latest-mac.yml'),
      manifestFor(zip, dmg, { dmgSize: dmg.length + 1 }),
    );
    await assert.rejects(
      verifyUpdateArtifacts({ releaseDir: directory, version }),
      /size mismatch for Gian-0\.4\.3-arm64\.dmg/,
    );

    await writeFile(
      join(directory, 'latest-mac.yml'),
      manifestFor(zip, dmg, { zipSha512: digest(Buffer.from('other')) }),
    );
    await assert.rejects(
      verifyUpdateArtifacts({ releaseDir: directory, version }),
      /sha512 mismatch for Gian-0\.4\.3-arm64\.zip/,
    );

    await writeFile(
      join(directory, 'latest-mac.yml'),
      manifestFor(zip, dmg, { topSha512: digest(Buffer.from('other')) }),
    );
    await assert.rejects(
      verifyUpdateArtifacts({ releaseDir: directory, version }),
      /top-level sha512 does not match the ZIP entry/,
    );
  });
});

test('desktop release build requires credentials and generates public latest metadata without publishing', async () => {
  const desktopPackage = JSON.parse(
    await readFile(new URL('../packages/desktop/package.json', import.meta.url), 'utf8'),
  );
  const command = desktopPackage.scripts['make:mac:release'];

  for (const name of [
    'CSC_LINK',
    'CSC_KEY_PASSWORD',
    'APPLE_API_KEY',
    'APPLE_API_KEY_ID',
    'APPLE_API_ISSUER',
    'GIAN_GITHUB_CLIENT_ID',
  ]) {
    assert.match(command, new RegExp(name));
  }
  assert.match(command, /forceCodeSigning=true/);
  assert.match(command, /mac\.notarize=true/);
  assert.match(command, /--publish never/);
  assert.match(command, /verify:update-artifacts/);
  assert.match(command, /extraMetadata\.gianReleaseChannel=stable/);

  for (const localBuild of ['package:mac', 'make:mac']) {
    assert.match(desktopPackage.scripts[localBuild], /--publish never/);
  }

  const [publish] = desktopPackage.build.publish;
  assert.deepEqual(
    {
      provider: publish.provider,
      owner: publish.owner,
      repo: publish.repo,
      private: publish.private,
      channel: publish.channel,
      releaseType: publish.releaseType,
      publishAutoUpdate: publish.publishAutoUpdate,
    },
    {
      provider: 'github',
      owner: 'RichLogic',
      repo: 'Gian',
      private: false,
      channel: 'latest',
      releaseType: 'release',
      publishAutoUpdate: true,
    },
  );
});
