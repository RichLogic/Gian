import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import {
  parseLatestMacManifest,
  main,
  verifyGithubReleaseAssets,
  verifyUpdateArtifacts,
} from './verify-update-artifacts.mjs';

const version = '0.4.3';
const zipName = `Gian-${version}-arm64.zip`;
const dmgName = `Gian-${version}-arm64.dmg`;

function digest(content) {
  return createHash('sha512').update(content).digest('base64');
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
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

function appUpdateConfig() {
  return [
    'owner: RichToyo',
    'repo: Gian',
    'provider: github',
    'private: false',
    'channel: latest',
    'releaseType: release',
    'publishAutoUpdate: true',
    "updaterCacheDirName: '@giandesktop-updater'",
    '',
  ].join('\n');
}

async function writeAppUpdateConfig(directory, source = appUpdateConfig()) {
  const path = join(directory, 'mac-arm64', 'Gian.app', 'Contents', 'Resources', 'app-update.yml');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, source);
  return path;
}

test('verifies the actual App bundle feed alongside valid update metadata', async () => {
  await withReleaseFixture(async ({ directory }) => {
    const appUpdateConfigPath = await writeAppUpdateConfig(directory);
    const result = await verifyUpdateArtifacts({ releaseDir: directory, version, appUpdateConfigPath });
    assert.deepEqual(result.updateFeed, { provider: 'github', owner: 'RichToyo', repo: 'Gian', channel: 'latest' });
    assert.equal(result.artifacts.length, 2);
  });
});

test('a stale embedded RichLogic feed fails even when artifact hashes and latest metadata pass', async () => {
  await withReleaseFixture(async ({ directory }) => {
    const appUpdateConfigPath = await writeAppUpdateConfig(directory, appUpdateConfig().replace('owner: RichToyo', 'owner: RichLogic'));
    assert.equal((await verifyUpdateArtifacts({ releaseDir: directory, version })).artifacts.length, 2);
    await assert.rejects(
      verifyUpdateArtifacts({ releaseDir: directory, version, appUpdateConfigPath }),
      /app-update.yml owner does not match build.publish/,
    );
    await assert.rejects(
      main(['--release-dir', directory, '--version', version, '--app-update-config', appUpdateConfigPath]),
      /app-update.yml owner does not match build.publish/,
    );
  });
});

test('embedded feed verification rejects missing, malformed and overridden configurations', async () => {
  await withReleaseFixture(async ({ directory }) => {
    const invalid = [
      appUpdateConfig().replace('repo: Gian', 'repo: Gian-Proxies'),
      appUpdateConfig().replace('private: false', 'private: true'),
      appUpdateConfig().replace('provider: github', 'provider: generic'),
      appUpdateConfig().replace('channel: latest', 'channel: beta'),
      appUpdateConfig().replace('owner: RichToyo\n', ''),
      `${appUpdateConfig()}owner: RichToyo\n`,
      appUpdateConfig().replace('owner: RichToyo', ' owner: RichToyo'),
      `${appUpdateConfig()}host: example.invalid\n`,
    ];
    for (const source of invalid) {
      const appUpdateConfigPath = await writeAppUpdateConfig(directory, source);
      await assert.rejects(verifyUpdateArtifacts({ releaseDir: directory, version, appUpdateConfigPath }), /app-update.yml/);
    }
    await assert.rejects(
      verifyUpdateArtifacts({ releaseDir: directory, version, appUpdateConfigPath: join(directory, 'missing-app-update.yml') }),
      { code: 'ENOENT' },
    );
  });
});

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
    'CSC_KEYCHAIN',
    'APPLE_API_KEY',
    'APPLE_API_KEY_ID',
    'APPLE_API_ISSUER',
    'GIAN_GITHUB_CLIENT_ID',
  ]) {
    assert.match(command, new RegExp(name));
  }
  assert.doesNotMatch(command, /CSC_LINK|CSC_KEY_PASSWORD/);
  assert.match(command, /forceCodeSigning=true/);
  assert.match(command, /mac\.notarize=true/);
  assert.match(command, /--publish never/);
  assert.match(command, /verify:update-artifacts/);
  assert.match(command, /extraMetadata\.gianReleaseChannel=stable/);
  assert.match(desktopPackage.scripts['verify:update-artifacts'], /--app-update-config release\/mac-arm64\/Gian.app\/Contents\/Resources\/app-update.yml/);
  assert.equal(desktopPackage.build.appId, 'com.gian.desktop');
  assert.equal(desktopPackage.author, 'RichLogic');
  assert.equal(desktopPackage.build.publish.length, 1);

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
      owner: 'RichToyo',
      repo: 'Gian',
      private: false,
      channel: 'latest',
      releaseType: 'release',
      publishAutoUpdate: true,
    },
  );
});

test('RichToyo embedded feed does not move this release publication or the metadata broker', async () => {
  const release = await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  const promote = await readFile(new URL('../.github/workflows/release-promote.yml', import.meta.url), 'utf8');
  for (const workflow of [release, promote]) {
    assert.match(workflow, /github.repository == 'RichLogic\/Gian' && github.ref == 'refs\/heads\/main'/);
    assert.doesNotMatch(workflow, /RichToyo|build\.publish/);
  }
  assert.match(release, /gh release create/);
  assert.match(release, /gh release upload/);
  assert.match(release, /--app-update-config packages\/desktop\/release\/mac-arm64\/Gian.app\/Contents\/Resources\/app-update.yml/);
  assert.match(promote, /gh release edit "\$TAG" --draft=false --latest/);
  const mainSource = await readFile(new URL('../packages/desktop/src/main.ts', import.meta.url), 'utf8');
  assert.match(mainSource, /function releaseRepository\(\): string \{\s*return process.env\['GIAN_RELEASE_REPOSITORY'\]\?\.trim\(\) \|\| 'RichLogic\/Gian';/);
  assert.doesNotMatch(mainSource, /setFeedURL\(/);
});

async function withDraftReleaseFixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'gian-update-release-'));
  const files = new Map([
    [zipName, Buffer.from('signed zip fixture')],
    [`${zipName}.blockmap`, Buffer.from('zip blockmap fixture')],
    [dmgName, Buffer.from('signed dmg fixture')],
    [`${dmgName}.blockmap`, Buffer.from('dmg blockmap fixture')],
  ]);
  const zip = files.get(zipName);
  const dmg = files.get(dmgName);
  files.set('latest-mac.yml', Buffer.from(manifestFor(zip, dmg)));
  const checksums = [...files]
    .map(([name, content]) => `${sha256(content)}  ${name}`)
    .join('\n');
  files.set('SHA256SUMS', Buffer.from(`${checksums}\n`));
  const release = {
    tagName: `v${version}`,
    isDraft: true,
    isPrerelease: false,
    assets: [...files].map(([name, content]) => ({
      name,
      size: content.length,
      digest: `sha256:${sha256(content)}`,
      state: 'uploaded',
    })),
  };
  try {
    await Promise.all([
      ...[...files].map(([name, content]) => writeFile(join(directory, name), content)),
      writeFile(join(directory, 'release.json'), JSON.stringify(release)),
    ]);
    await run({ directory, files, release });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('verifies an exact draft release asset set before publication', async () => {
  await withDraftReleaseFixture(async ({ directory }) => {
    const result = await verifyGithubReleaseAssets({
      releaseDir: directory,
      releaseJsonPath: join(directory, 'release.json'),
      version,
    });
    assert.equal(result.tag, `v${version}`);
    assert.equal(result.artifacts.length, 6);
  });
});

test('fails closed on public, missing, or changed draft release assets', async () => {
  await withDraftReleaseFixture(async ({ directory, release }) => {
    await writeFile(join(directory, 'release.json'), JSON.stringify({
      ...release,
      isDraft: false,
    }));
    await assert.rejects(
      verifyGithubReleaseAssets({
        releaseDir: directory,
        releaseJsonPath: join(directory, 'release.json'),
        version,
      }),
      /must remain draft/,
    );

    await writeFile(join(directory, 'release.json'), JSON.stringify({
      ...release,
      isDraft: true,
      assets: release.assets.slice(1),
    }));
    await assert.rejects(
      verifyGithubReleaseAssets({
        releaseDir: directory,
        releaseJsonPath: join(directory, 'release.json'),
        version,
      }),
      /asset set mismatch/,
    );

    await writeFile(join(directory, 'release.json'), JSON.stringify({
      ...release,
      assets: release.assets.map(asset => asset.name === zipName
        ? { ...asset, digest: `sha256:${'0'.repeat(64)}` }
        : asset),
    }));
    await assert.rejects(
      verifyGithubReleaseAssets({
        releaseDir: directory,
        releaseJsonPath: join(directory, 'release.json'),
        version,
      }),
      new RegExp(`release digest mismatch for ${zipName.replaceAll('.', '\\.')}`),
    );
  });
});
