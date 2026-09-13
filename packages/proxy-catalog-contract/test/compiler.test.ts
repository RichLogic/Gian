import { strict as assert } from 'node:assert';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  compileCatalogBundle,
  compileOfficialCatalogSource,
  ephemeralCatalogSigningKey,
  loadOfficialCatalogSource,
  verifyCatalogAssetManifestWithPinnedKeys,
  verifyCatalogBundleFiles,
  verifyOfficialCatalogSource,
  type CatalogEntryV1,
} from '../src/index.js';
import { validCatalogEntry } from './fixtures.js';

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
  'hex',
);

function sidecarFor(entry: CatalogEntryV1): Buffer {
  const body = `${JSON.stringify({
    schemaVersion: 3,
    id: entry.pluginId,
    displayName: entry.displayName,
    pluginVersion: entry.channels.stable.pluginVersion,
    entry: 'proxy.mjs',
    protocol: { name: 'gian.proxy', range: '>=2.1 <3.0' },
    process: { scope: 'session' },
    branding: {
      logo: {
        light: {
          path: 'logo-light.png',
          mediaType: 'image/png',
          sha256: 'e'.repeat(64),
        },
      },
    },
  })}\n`;
  return Buffer.from(body, 'utf8');
}

function compileInput(overrides: Partial<CatalogEntryV1> = {}) {
  const entry = { ...validCatalogEntry(), ...overrides };
  const sidecar = sidecarFor(entry);
  const manifest = entry.channels.stable.manifest;
  if (!manifest) throw new Error('compileInput fixture requires a Manifest coordinate.');
  entry.channels = {
    stable: {
      ...entry.channels.stable,
      manifest: {
        ...manifest,
        sha256: createHash('sha256').update(sidecar).digest('hex'),
        size: sidecar.byteLength,
      },
    },
  };
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    entry,
    sidecar,
    publicKeyHex: publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex'),
    signingKey: { keyId: 'gian-official-catalog-2026', privateKey },
  };
}

test('compiler emits a signed bundle from source docs, logos, and Manifest sidecar', () => {
  const prepared = compileInput();
  const bundle = compileCatalogBundle({
    sourceId: 'gian-official',
    sequence: 2,
    issuedAt: '2026-09-02T00:00:00.000Z',
    allowedArtifactRepositories: ['RichLogic/Gian'],
    signingKey: prepared.signingKey,
    plugins: [{
      entry: prepared.entry,
      documents: {
        overview: '# Overview\n',
        setup: '# Setup\n',
        usage: '# Usage\n',
        troubleshooting: '# Troubleshooting\n',
      },
      logos: { light: PNG, dark: PNG },
      manifestSidecar: prepared.sidecar,
    }],
  });

  assert.equal(bundle.index.sequence, 2);
  assert.equal(bundle.index.plugins[0]?.pluginId, 'io.gian.fixture');
  assert.equal(bundle.index.plugins[0]?.stable.protocolRange, '>=2.1 <3.0');
  assert.equal(bundle.index.plugins[0]?.stable.processScope, 'session');
  assert.equal(bundle.index.plugins[0]?.stable.runtime, null);
  assert.equal(bundle.index.plugins[0]?.branding.light.mediaType, 'image/png');
  assert.equal(
    verifyCatalogAssetManifestWithPinnedKeys({
      pinnedPublicKeys: { 'gian-official-catalog-2026': prepared.publicKeyHex },
      assetManifestUtf8: bundle.assetManifestUtf8,
      envelope: bundle.envelope,
    }),
    true,
  );
  const verified = verifyCatalogBundleFiles({
    files: bundle.files,
    pinnedPublicKeys: { 'gian-official-catalog-2026': prepared.publicKeyHex },
    expectedSourceId: 'gian-official',
  });
  assert.equal(verified.sequence, 2);
});

test('compiler binds a certified managed Runtime artifact to the Proxy Manifest', () => {
  const prepared = compileInput();
  prepared.entry.channels.stable.combination = {
    generationId: 'fixture-0.1.0-runtime-1.0.0',
    certificate: { id: 'fixture-release-1', sha256: 'f'.repeat(64) },
    runtime: {
      kind: 'native-binary',
      runtimeId: 'fixture-cli',
      version: '1.0.0',
      asset: {
        url: 'https://github.com/RichLogic/Gian/releases/download/proxy-fixture-v0.1.0/gian-runtime-fixture-1.0.0-darwin-arm64',
        sha256: '9'.repeat(64),
        size: 1024,
      },
      format: 'raw',
      entryRelativePath: 'bin/fixture',
    },
    companions: [],
  };
  prepared.sidecar = Buffer.from(`${JSON.stringify({
    schemaVersion: 4,
    id: prepared.entry.pluginId,
    displayName: prepared.entry.displayName,
    pluginVersion: prepared.entry.channels.stable.pluginVersion,
    entry: 'proxy.mjs',
    protocol: { name: 'gian.proxy', range: '>=2.2 <3.0' },
    process: { scope: 'session' },
    runtime: {
      kind: 'external',
      id: 'fixture-cli',
      displayName: 'Fixture CLI',
      verifiedVersions: ['1.0.0'],
    },
    branding: {
      logo: {
        light: { path: 'logo-light.png', mediaType: 'image/png', sha256: 'e'.repeat(64) },
      },
    },
  })}\n`);
  prepared.entry.channels.stable.manifest!.sha256 = createHash('sha256').update(prepared.sidecar).digest('hex');
  prepared.entry.channels.stable.manifest!.size = prepared.sidecar.byteLength;
  const compile = () => compileCatalogBundle({
    sourceId: 'gian-official',
    sequence: 3,
    issuedAt: '2026-09-12T00:00:00.000Z',
    allowedArtifactRepositories: ['RichLogic/Gian'],
    signingKey: prepared.signingKey,
    plugins: [{
      entry: prepared.entry,
      documents: {
        overview: '# Overview\n',
        setup: '# Setup\n',
        usage: '# Usage\n',
        troubleshooting: '# Troubleshooting\n',
      },
      logos: { light: PNG, dark: PNG },
      manifestSidecar: prepared.sidecar,
    }],
  });
  const bundle = compile();
  assert.equal(bundle.index.plugins[0]?.stable.combination?.runtime?.version, '1.0.0');

  prepared.entry.channels.stable.combination.runtime!.version = '2.0.0';
  assert.throws(compile, /does not match the Manifest/);
});

test('compiler rejects wrong image magic, disallowed URLs, and sidecar identity drift', () => {
  const prepared = compileInput();
  assert.throws(() => compileCatalogBundle({
    sourceId: 'gian-official',
    sequence: 1,
    issuedAt: '2026-09-02T00:00:00.000Z',
    allowedArtifactRepositories: ['RichLogic/Gian'],
    signingKey: prepared.signingKey,
    plugins: [{
      entry: prepared.entry,
      documents: {
        overview: '# Overview\n',
        setup: '# Setup\n',
        usage: '# Usage\n',
        troubleshooting: '# Troubleshooting\n',
      },
      logos: { light: Buffer.from('not-an-image'), dark: PNG },
      manifestSidecar: prepared.sidecar,
    }],
  }), /magic bytes/);

  const badUrl = compileInput();
  const badManifest = badUrl.entry.channels.stable.manifest;
  if (!badManifest) throw new Error('expected Manifest coordinate');
  badManifest.url = 'https://evil.example/manifest.json';
  assert.throws(() => compileCatalogBundle({
    sourceId: 'gian-official',
    sequence: 1,
    issuedAt: '2026-09-02T00:00:00.000Z',
    allowedArtifactRepositories: ['RichLogic/Gian'],
    signingKey: badUrl.signingKey,
    plugins: [{
      entry: badUrl.entry,
      documents: {
        overview: '# Overview\n',
        setup: '# Setup\n',
        usage: '# Usage\n',
        troubleshooting: '# Troubleshooting\n',
      },
      logos: { light: PNG, dark: PNG },
      manifestSidecar: badUrl.sidecar,
    }],
  }), /allowed artifact URL/);

  const drifted = compileInput();
  const otherSidecar = Buffer.from(JSON.stringify({
    schemaVersion: 3,
    id: 'claude',
    displayName: 'Nope',
    pluginVersion: '0.1.0',
    entry: 'proxy.mjs',
    protocol: { name: 'gian.proxy', range: '>=2.1' },
    process: { scope: 'session' },
    branding: {
      logo: {
        light: {
          path: 'logo-light.png',
          mediaType: 'image/png',
          sha256: 'e'.repeat(64),
        },
      },
    },
  }));
  const driftedManifest = drifted.entry.channels.stable.manifest;
  if (!driftedManifest) throw new Error('expected Manifest coordinate');
  driftedManifest.sha256 = createHash('sha256').update(otherSidecar).digest('hex');
  driftedManifest.size = otherSidecar.byteLength;
  assert.throws(() => compileCatalogBundle({
    sourceId: 'gian-official',
    sequence: 1,
    issuedAt: '2026-09-02T00:00:00.000Z',
    allowedArtifactRepositories: ['RichLogic/Gian'],
    signingKey: drifted.signingKey,
    plugins: [{
      entry: drifted.entry,
      documents: {
        overview: '# Overview\n',
        setup: '# Setup\n',
        usage: '# Usage\n',
        troubleshooting: '# Troubleshooting\n',
      },
      logos: { light: PNG, dark: PNG },
      manifestSidecar: otherSidecar,
    }],
  }), /does not match/);
});

test('compiler rejects an arbitrary sidecar and a range that matches no known protocol', () => {
  const prepared = compileInput();
  const arbitrary = Buffer.from(JSON.stringify({
    id: prepared.entry.pluginId,
    version: prepared.entry.channels.stable.pluginVersion,
    range: '>=2.1 <3.0',
    scope: 'session',
  }));
  const arbitraryManifest = prepared.entry.channels.stable.manifest;
  if (!arbitraryManifest) throw new Error('expected Manifest coordinate');
  arbitraryManifest.sha256 = createHash('sha256').update(arbitrary).digest('hex');
  arbitraryManifest.size = arbitrary.byteLength;
  assert.throws(() => compileCatalogBundle({
    sourceId: 'gian-official',
    sequence: 1,
    issuedAt: '2026-09-02T00:00:00.000Z',
    allowedArtifactRepositories: ['RichLogic/Gian'],
    signingKey: prepared.signingKey,
    plugins: [{
      entry: prepared.entry,
      documents: {
        overview: '# Overview\n',
        setup: '# Setup\n',
        usage: '# Usage\n',
        troubleshooting: '# Troubleshooting\n',
      },
      logos: { light: PNG, dark: PNG },
      manifestSidecar: arbitrary,
    }],
  }), /schemaVersion|invalid|Required/i);

  const unknownRange = compileInput();
  const sidecar = Buffer.from(`${JSON.stringify({
    schemaVersion: 3,
    id: unknownRange.entry.pluginId,
    displayName: unknownRange.entry.displayName,
    pluginVersion: unknownRange.entry.channels.stable.pluginVersion,
    entry: 'proxy.mjs',
    protocol: { name: 'gian.proxy', range: '>=9.0 <10.0' },
    process: { scope: 'session' },
    branding: {
      logo: {
        light: {
          path: 'logo-light.png',
          mediaType: 'image/png',
          sha256: 'e'.repeat(64),
        },
      },
    },
  })}\n`);
  const unknownManifest = unknownRange.entry.channels.stable.manifest;
  if (!unknownManifest) throw new Error('expected Manifest coordinate');
  unknownManifest.sha256 = createHash('sha256').update(sidecar).digest('hex');
  unknownManifest.size = sidecar.byteLength;
  assert.throws(() => compileCatalogBundle({
    sourceId: 'gian-official',
    sequence: 1,
    issuedAt: '2026-09-02T00:00:00.000Z',
    allowedArtifactRepositories: ['RichLogic/Gian'],
    signingKey: unknownRange.signingKey,
    plugins: [{
      entry: unknownRange.entry,
      documents: {
        overview: '# Overview\n',
        setup: '# Setup\n',
        usage: '# Usage\n',
        troubleshooting: '# Troubleshooting\n',
      },
      logos: { light: PNG, dark: PNG },
      manifestSidecar: sidecar,
    }],
  }), /no known gian.proxy version/);
});

test('compiler accepts documentation-only entries with empty artifacts', () => {
  const prepared = compileInput();
  delete prepared.entry.channels.stable.manifest;
  delete prepared.entry.channels.stable.artifacts;
  const bundle = compileCatalogBundle({
    sourceId: 'gian-official',
    sequence: 1,
    issuedAt: '2026-09-02T00:00:00.000Z',
    allowedArtifactRepositories: ['RichLogic/Gian'],
    signingKey: prepared.signingKey,
    plugins: [{
      entry: prepared.entry,
      documents: {
        overview: '# Overview\n',
        setup: '# Setup\n',
        usage: '# Usage\n',
        troubleshooting: '# Troubleshooting\n',
      },
      logos: { light: PNG, dark: PNG },
      manifestSidecar: prepared.sidecar,
    }],
  });
  assert.equal(bundle.index.plugins[0]?.stable.manifest, undefined);
  assert.deepEqual(bundle.index.plugins[0]?.stable.artifacts, {});
});

test('official Catalog source verifies and compiles reproducibly without the test fixture', async () => {
  const fromSrc = fileURLToPath(new URL('../../../catalog/official-source', import.meta.url));
  const fromDist = fileURLToPath(new URL('../../../../catalog/official-source', import.meta.url));
  const sourceRoot = existsSync(fromSrc) ? fromSrc : fromDist;
  const plugins = await loadOfficialCatalogSource(sourceRoot);
  verifyOfficialCatalogSource(plugins);
  assert.equal(plugins.some((plugin) => plugin.entry.pluginId === 'io.gian.fixture'), false);
  assert.deepEqual(
    plugins.map((plugin) => plugin.entry.pluginId).sort(),
    ['ai.deepseek.harness', 'claude', 'codex', 'com.zhipu.zcode', 'kimi'],
  );
  const signingKey = ephemeralCatalogSigningKey();
  const first = await compileOfficialCatalogSource({
    sourceRoot,
    sequence: 1,
    issuedAt: '2026-09-02T00:00:00.000Z',
    signingKey,
  });
  const second = await compileOfficialCatalogSource({
    sourceRoot,
    sequence: 1,
    issuedAt: '2026-09-02T00:00:00.000Z',
    signingKey,
  });
  assert.equal(first.files.size, second.files.size);
  for (const [path, bytes] of first.files) {
    assert.ok(bytes.equals(second.files.get(path)!));
  }
  assert.deepEqual(
    first.index.plugins.map((plugin) => plugin.pluginId).sort(),
    ['ai.deepseek.harness', 'claude', 'codex', 'com.zhipu.zcode', 'kimi'],
  );
  for (const plugin of first.index.plugins) {
    assert.equal(plugin.stable.runtime?.kind, 'external');
    assert.ok((plugin.stable.runtime?.verifiedVersions.length ?? 0) > 0);
  }
});

test('pinned keyId cannot be ignored by a different verifying key', () => {
  const prepared = compileInput();
  const bundle = compileCatalogBundle({
    sourceId: 'gian-official',
    sequence: 1,
    issuedAt: '2026-09-02T00:00:00.000Z',
    allowedArtifactRepositories: ['RichLogic/Gian'],
    signingKey: prepared.signingKey,
    plugins: [{
      entry: prepared.entry,
      documents: {
        overview: '# Overview\n',
        setup: '# Setup\n',
        usage: '# Usage\n',
        troubleshooting: '# Troubleshooting\n',
      },
      logos: { light: PNG, dark: PNG },
      manifestSidecar: prepared.sidecar,
    }],
  });
  const other = generateKeyPairSync('ed25519');
  const otherHex = other.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
  assert.equal(verifyCatalogAssetManifestWithPinnedKeys({
    pinnedPublicKeys: { 'some-other-key': otherHex },
    assetManifestUtf8: bundle.assetManifestUtf8,
    envelope: bundle.envelope,
  }), false);
  assert.equal(verifyCatalogAssetManifestWithPinnedKeys({
    pinnedPublicKeys: { 'gian-official-catalog-2026': otherHex },
    assetManifestUtf8: bundle.assetManifestUtf8,
    envelope: bundle.envelope,
  }), false);
});
