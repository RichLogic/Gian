import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { assertCatalogMarkdown, compileCatalogBundle } from '../src/index.js';
import { validCatalogEntry } from './fixtures.js';
import { createHash, generateKeyPairSync } from 'node:crypto';

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
  'hex',
);

test('Catalog Markdown allows ordinary rich guides and safe HTTPS links', () => {
  assertCatalogMarkdown(`# Setup

Install the CLI, then follow the [docs](https://github.com/RichLogic/Gian).

- item one
- item two

> note
`, 'positive');
});

test('Catalog Markdown rejects HTML, executable links, remote images, and data URLs', () => {
  assert.throws(() => assertCatalogMarkdown('<script>alert(1)</script>', 'html'), /raw HTML/);
  assert.throws(() => assertCatalogMarkdown('<iframe src="https://evil.example"></iframe>', 'iframe'), /raw HTML/);
  assert.throws(() => assertCatalogMarkdown('[x](javascript:alert(1))', 'js'), /executable|unsafe/);
  assert.throws(() => assertCatalogMarkdown('[x](data:text/html;base64,PHNjcmlwdD4=)', 'data'), /executable|data/);
  assert.throws(() => assertCatalogMarkdown('![logo](https://evil.example/x.png)', 'image'), /image/);
  assert.throws(() => assertCatalogMarkdown('![logo](data:image/png;base64,aa)', 'data-image'), /image/);
});

test('compiler rejects forbidden Markdown at publication', () => {
  const entry = validCatalogEntry();
  const sidecar = Buffer.from(`${JSON.stringify({
    schemaVersion: 3,
    id: entry.pluginId,
    displayName: entry.displayName,
    pluginVersion: entry.channels.stable.pluginVersion,
    entry: 'proxy.mjs',
    protocol: { name: 'gian.proxy', range: '>=2.1 <3.0' },
    process: { scope: 'session' },
    branding: {
      logo: {
        light: { path: 'logo-light.png', mediaType: 'image/png', sha256: 'e'.repeat(64) },
      },
    },
  })}\n`);
  const manifest = entry.channels.stable.manifest;
  if (!manifest) throw new Error('fixture requires a Manifest coordinate');
  entry.channels.stable.manifest = {
    ...manifest,
    sha256: createHash('sha256').update(sidecar).digest('hex'),
    size: sidecar.byteLength,
  };
  const { privateKey } = generateKeyPairSync('ed25519');
  assert.throws(() => compileCatalogBundle({
    sourceId: 'gian-official',
    sequence: 1,
    issuedAt: '2026-09-02T00:00:00.000Z',
    allowedArtifactRepositories: ['RichLogic/Gian'],
    signingKey: { keyId: 'gian-official-catalog-2026', privateKey },
    plugins: [{
      entry,
      documents: {
        overview: '<script>alert(1)</script>\n',
        setup: '# Setup\n',
        usage: '# Usage\n',
        troubleshooting: '# Troubleshooting\n',
      },
      logos: { light: PNG, dark: PNG },
      manifestSidecar: sidecar,
    }],
  }), /raw HTML/);
});
