import { strict as assert } from 'node:assert';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';

import {
  MAX_CATALOG_BUNDLE_BYTES,
  MAX_CATALOG_DOCUMENT_BYTES,
  MAX_CATALOG_IMAGE_BYTES,
  MAX_CATALOG_PLUGIN_COUNT,
  catalogAssetManifestV1Schema,
  catalogEntryV1Schema,
  catalogIndexV1Schema,
  compiledCatalogEntryV1Schema,
  catalogSignatureEnvelopeV1Schema,
  downloadAssetSchema,
  isCanonicalRelativePath,
  isHttpsUrl,
  isApprovedRuntimeAssetUrl,
  platformIdSchema,
  verifyCatalogAssetManifestBytes,
} from '../src/index.js';
import {
  FIXTURE_PLUGIN_ID,
  signAssetManifestBytes,
  validAssetManifest,
  validCatalogEntry,
  validCatalogIndex,
} from './fixtures.js';

test('Runtime URL policy accepts only exact App-pinned vendor prefixes', () => {
  const prefixes = ['https://downloads.claude.ai/claude-code-releases/'];
  assert.equal(isApprovedRuntimeAssetUrl(
    'https://downloads.claude.ai/claude-code-releases/2.1.159/darwin-arm64/claude',
    prefixes,
  ), true);
  for (const value of [
    'https://downloads.claude.ai.evil.test/claude-code-releases/2.1.159/claude',
    'https://downloads.claude.ai/other/claude',
    'https://downloads.claude.ai/claude-code-releases/../private',
    'https://downloads.claude.ai/claude-code-releases/2.1.159/claude?token=x',
  ]) assert.equal(isApprovedRuntimeAssetUrl(value, prefixes), false, value);
});

test('unknown reverse-domain fixture validates end to end at the contract layer', () => {
  const entry = catalogEntryV1Schema.parse(validCatalogEntry());
  const index = catalogIndexV1Schema.parse(validCatalogIndex());
  const manifest = catalogAssetManifestV1Schema.parse(validAssetManifest());
  assert.equal(entry.pluginId, FIXTURE_PLUGIN_ID);
  assert.equal(index.plugins[0]?.pluginId, FIXTURE_PLUGIN_ID);
  assert.equal(index.plugins[0]?.stable.artifacts['darwin-arm64']?.size, 1_234_567);
  assert.ok(manifest.files.some((file) => file.path === 'catalog-v1.json'));
});

test('PlatformId accepts the known matrix and rejects unknown keys', () => {
  for (const id of ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'win32-x64']) {
    assert.equal(platformIdSchema.parse(id), id);
  }
  assert.throws(() => platformIdSchema.parse('android-arm64'));
  assert.throws(() => catalogEntryV1Schema.parse({
    ...validCatalogEntry(),
    channels: {
      stable: {
        ...validCatalogEntry().channels.stable,
        artifacts: {
          'freebsd-x64': validCatalogEntry().channels.stable.artifacts?.['darwin-arm64'],
        },
      },
    },
  }));
});

test('DownloadAsset requires HTTPS, no credentials, lowercase SHA-256, and positive size', () => {
  const asset = downloadAssetSchema.parse({
    url: 'https://127.0.0.1/catalog/fixture.tar.gz',
    sha256: 'ab'.repeat(32),
    size: 1,
  });
  assert.equal(asset.url.startsWith('https://'), true);
  assert.equal(isHttpsUrl('http://github.com/RichLogic/Gian/a'), false);
  assert.equal(isHttpsUrl('https://user:pass@github.com/a'), false);
  assert.equal(isHttpsUrl(`https://example.com/${'a'.repeat(2000)}`), false);
  assert.equal(isHttpsUrl('https://github.com/RichLogic/Gian/releases/download/x/y'), true);
  assert.throws(() => downloadAssetSchema.parse({
    url: 'http://github.com/RichLogic/Gian/a',
    sha256: 'a'.repeat(64),
    size: 1,
  }));
  assert.throws(() => downloadAssetSchema.parse({
    url: 'https://user:secret@github.com/a',
    sha256: 'a'.repeat(64),
    size: 1,
  }));
  assert.throws(() => downloadAssetSchema.parse({
    url: 'https://github.com/a',
    sha256: 'A'.repeat(64),
    size: 1,
  }));
  assert.throws(() => downloadAssetSchema.parse({
    url: 'https://github.com/a',
    sha256: 'a'.repeat(64),
    size: 0,
  }));
});

test('source CatalogEntryV1 rejects bad ids, extra fields, and missing documentation', () => {
  assert.throws(() => catalogEntryV1Schema.parse({
    ...validCatalogEntry(),
    pluginId: 'Not A Domain',
  }));
  assert.throws(() => catalogEntryV1Schema.parse({
    ...validCatalogEntry(),
    publisher: 'third-party',
  }));
  assert.throws(() => catalogEntryV1Schema.parse({
    ...validCatalogEntry(),
    documentation: {
      ...validCatalogEntry().documentation,
      overview: '',
    },
  }));
});

test('compiled CatalogIndexV1 rejects duplicate pluginIds and oversized docs or logos', () => {
  const index = validCatalogIndex();
  const plugin = index.plugins[0]!;
  assert.throws(() => catalogIndexV1Schema.parse({
    ...index,
    plugins: [plugin, { ...plugin }],
  }));
  assert.throws(() => catalogIndexV1Schema.parse({
    ...index,
    plugins: [{
      ...plugin,
      documentation: {
        ...plugin.documentation,
        overview: { ...plugin.documentation.overview, size: MAX_CATALOG_DOCUMENT_BYTES + 1 },
      },
    }],
  }));
  assert.throws(() => catalogIndexV1Schema.parse({
    ...index,
    plugins: [{
      ...plugin,
      branding: {
        ...plugin.branding,
        dark: { ...plugin.branding.dark, size: MAX_CATALOG_IMAGE_BYTES + 1 },
      },
    }],
  }));
  assert.throws(() => catalogIndexV1Schema.parse({
    ...index,
    plugins: Array.from({ length: MAX_CATALOG_PLUGIN_COUNT + 1 }, (_, i) => ({
      ...plugin,
      pluginId: `io.gian.fixture${i}`,
    })),
  }));
  assert.throws(() => catalogIndexV1Schema.parse({
    ...index,
    sourceId: 'Gian Official',
  }));
  assert.throws(() => catalogIndexV1Schema.parse({
    ...index,
    sourceId: 'gian\nofficial',
  }));
  assert.throws(() => catalogIndexV1Schema.parse({
    ...index,
    plugins: [{
      ...plugin,
      branding: {
        ...plugin.branding,
        light: { ...plugin.branding.light, mediaType: 'image/svg+xml' },
      },
    }],
  }));
  const { mediaType: _omitted, ...lightWithoutType } = plugin.branding.light;
  assert.throws(() => catalogIndexV1Schema.parse({
    ...index,
    plugins: [{
      ...plugin,
      branding: {
        ...plugin.branding,
        light: lightWithoutType,
      },
    }],
  }));
});

test('compiled Catalog schema requires Manifest and artifact parity', () => {
  const plugin = validCatalogIndex().plugins[0]!;
  assert.doesNotThrow(() => compiledCatalogEntryV1Schema.parse(plugin));
  assert.throws(() => compiledCatalogEntryV1Schema.parse({
    ...plugin,
    stable: {
      ...plugin.stable,
      manifest: undefined,
    },
  }), /Manifest coordinate/);
  assert.throws(() => compiledCatalogEntryV1Schema.parse({
    ...plugin,
    stable: {
      ...plugin.stable,
      artifacts: {},
    },
  }), /Documentation-only/);
  const docsOnly = compiledCatalogEntryV1Schema.parse({
    ...plugin,
    stable: {
      ...plugin.stable,
      manifest: undefined,
      artifacts: {},
    },
  });
  assert.equal(docsOnly.stable.manifest, undefined);
  assert.deepEqual(docsOnly.stable.artifacts, {});
});

test('compiled protocolRange rejects newline, tab, and other control characters', () => {
  const index = validCatalogIndex();
  const plugin = index.plugins[0]!;
  const withRange = (protocolRange: string) => ({
    ...index,
    plugins: [{
      ...plugin,
      stable: {
        ...plugin.stable,
        protocolRange,
      },
    }],
  });
  assert.doesNotThrow(() => catalogIndexV1Schema.parse(withRange('>=2.2 <3.0')));
  assert.doesNotThrow(() => catalogIndexV1Schema.parse(withRange('^2.2')));
  assert.doesNotThrow(() => catalogIndexV1Schema.parse(withRange('~2.2')));
  assert.doesNotThrow(() => catalogIndexV1Schema.parse(withRange('2.x')));
  assert.throws(() => catalogIndexV1Schema.parse(withRange('>=2.2\nBAD')));
  assert.throws(() => catalogIndexV1Schema.parse(withRange('>=2.2\tBAD')));
  assert.throws(() => catalogIndexV1Schema.parse(withRange('>=2.2\rBAD')));
  assert.throws(() => catalogIndexV1Schema.parse(withRange(`>=2.2${String.fromCharCode(0x7f)}BAD`)));
  assert.throws(() => catalogIndexV1Schema.parse(withRange('>=2.2\u00A0<3.0')));
});

test('bundle paths are canonical forward-slash relative paths', () => {
  assert.equal(isCanonicalRelativePath('docs/io.gian.fixture/overview.md'), true);
  assert.equal(isCanonicalRelativePath('assets\\logo.png'), false);
  assert.equal(isCanonicalRelativePath('/docs/overview.md'), false);
  assert.equal(isCanonicalRelativePath('docs/overview.md/'), false);
  assert.equal(isCanonicalRelativePath('docs//overview.md'), false);
  assert.equal(isCanonicalRelativePath('docs/./overview.md'), false);
  assert.equal(isCanonicalRelativePath('../overview.md'), false);
  assert.equal(isCanonicalRelativePath('docs/\u0000overview.md'), false);
  const entry = validCatalogEntry();
  assert.throws(() => catalogEntryV1Schema.parse({
    ...entry,
    documentation: { ...entry.documentation, overview: 'docs\\overview.md' },
  }));
  assert.throws(() => catalogEntryV1Schema.parse({
    ...entry,
    branding: { ...entry.branding, logoLight: { path: '/assets/logo-light.png', mediaType: 'image/png' } },
  }));
  assert.throws(() => catalogEntryV1Schema.parse({
    ...entry,
    branding: { ...entry.branding, logoDark: { path: 'assets/logo-dark.png/', mediaType: 'image/png' } },
  }));
  assert.throws(() => catalogEntryV1Schema.parse({
    ...entry,
    branding: { ...entry.branding, logoLight: { path: 'assets/logo-light.png', mediaType: 'image/svg+xml' } },
  }));
  assert.throws(() => catalogEntryV1Schema.parse({
    ...entry,
    branding: { ...entry.branding, logoLight: { path: 'assets/logo-light.png' } },
  }));
  assert.throws(() => catalogAssetManifestV1Schema.parse({
    schemaVersion: 1,
    files: [{ path: 'catalog-v1.json\\extra', sha256: 'a'.repeat(64), size: 1 }],
  }));
});

test('CatalogAssetManifest excludes itself and the signature and bounds declared size', () => {
  assert.throws(() => catalogAssetManifestV1Schema.parse({
    schemaVersion: 1,
    files: [{ path: 'catalog-assets-v1.json', sha256: 'a'.repeat(64), size: 1 }],
  }));
  assert.throws(() => catalogAssetManifestV1Schema.parse({
    schemaVersion: 1,
    files: [{ path: 'catalog-v1.sig', sha256: 'a'.repeat(64), size: 1 }],
  }));
  assert.throws(() => catalogAssetManifestV1Schema.parse({
    schemaVersion: 1,
    files: [
      { path: 'catalog-v1.json', sha256: 'a'.repeat(64), size: 1 },
      { path: 'catalog-v1.json', sha256: 'b'.repeat(64), size: 2 },
    ],
  }));
  assert.doesNotThrow(() => catalogAssetManifestV1Schema.parse({
    schemaVersion: 1,
    files: [{ path: 'catalog-v1.json', sha256: 'a'.repeat(64), size: MAX_CATALOG_BUNDLE_BYTES }],
  }));
  assert.throws(() => catalogAssetManifestV1Schema.parse({
    schemaVersion: 1,
    files: [{ path: 'catalog-v1.json', sha256: 'a'.repeat(64), size: MAX_CATALOG_BUNDLE_BYTES + 1 }],
  }));
  assert.throws(() => catalogAssetManifestV1Schema.parse({
    schemaVersion: 1,
    files: [
      { path: 'catalog-v1.json', sha256: 'a'.repeat(64), size: MAX_CATALOG_BUNDLE_BYTES },
      { path: 'docs/io.gian.fixture/overview.md', sha256: 'b'.repeat(64), size: 1 },
    ],
  }));
});

test('CatalogSignatureEnvelopeV1 is Ed25519 over catalog-assets-v1.json', () => {
  const signed = signAssetManifestBytes('{"schemaVersion":1}');
  catalogSignatureEnvelopeV1Schema.parse(signed.envelope);
  assert.throws(() => catalogSignatureEnvelopeV1Schema.parse({
    ...signed.envelope,
    algorithm: 'RSA',
  }));
  assert.throws(() => catalogSignatureEnvelopeV1Schema.parse({
    ...signed.envelope,
    signedAsset: 'catalog-v1.json',
  }));
  assert.throws(() => catalogSignatureEnvelopeV1Schema.parse({
    ...signed.envelope,
    keyId: 'bad key id',
  }));
  assert.throws(() => catalogSignatureEnvelopeV1Schema.parse({
    ...signed.envelope,
    signature: 'not-base64',
  }));
});

test('Ed25519 verification uses exact UTF-8 bytes and fails closed', () => {
  const raw = '{"schemaVersion": 1, "files": [{"path":"catalog-v1.json","sha256":"aa","size":1}]}\n';
  const signed = signAssetManifestBytes(raw);
  assert.equal(verifyCatalogAssetManifestBytes({
    publicKey: signed.publicKeyPem,
    assetManifestUtf8: raw,
    envelope: signed.envelope,
  }), true);

  const reserialized = JSON.stringify(JSON.parse(raw));
  assert.notEqual(reserialized, raw);
  assert.equal(verifyCatalogAssetManifestBytes({
    publicKey: signed.publicKeyPem,
    assetManifestUtf8: reserialized,
    envelope: signed.envelope,
  }), false);

  const tampered = Buffer.from(raw, 'utf8');
  tampered[1] = tampered[1] === 34 ? 35 : 34;
  assert.equal(verifyCatalogAssetManifestBytes({
    publicKey: signed.publicKeyPem,
    assetManifestUtf8: tampered,
    envelope: signed.envelope,
  }), false);

  const other = generateKeyPairSync('ed25519');
  assert.equal(verifyCatalogAssetManifestBytes({
    publicKey: other.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    assetManifestUtf8: raw,
    envelope: signed.envelope,
  }), false);

  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  assert.equal(verifyCatalogAssetManifestBytes({
    publicKey: rsa.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    assetManifestUtf8: raw,
    envelope: signed.envelope,
  }), false);

  assert.equal(verifyCatalogAssetManifestBytes({
    publicKey: '-----BEGIN PUBLIC KEY-----\nnot-a-key\n-----END PUBLIC KEY-----',
    assetManifestUtf8: raw,
    envelope: signed.envelope,
  }), false);

  assert.equal(verifyCatalogAssetManifestBytes({
    publicKey: signed.publicKeyPem,
    assetManifestUtf8: raw,
    envelope: { ...signed.envelope, signature: 'aaaa' },
  }), false);

  assert.equal(verifyCatalogAssetManifestBytes({
    publicKey: signed.publicKeyPem,
    assetManifestUtf8: raw,
    envelope: { ...signed.envelope, keyId: '' },
  }), false);

  assert.doesNotThrow(() => verifyCatalogAssetManifestBytes({
    publicKey: Buffer.from('deadbeef'),
    assetManifestUtf8: raw,
    envelope: signed.envelope,
  }));
});
