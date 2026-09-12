import { Buffer } from 'node:buffer';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';

import type { CatalogAssetManifestV1, CatalogEntryV1, CatalogIndexV1 } from '../src/index.js';

const digest = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

const GITHUB_MANIFEST =
  'https://github.com/RichLogic/Gian/releases/download/proxy-fixture-v0.1.0/gian-proxy-fixture-0.1.0-darwin-arm64.tar.gz.manifest.json';
const GITHUB_ARCHIVE =
  'https://github.com/RichLogic/Gian/releases/download/proxy-fixture-v0.1.0/gian-proxy-fixture-0.1.0-darwin-arm64.tar.gz';

export const FIXTURE_PLUGIN_ID = 'io.gian.fixture';

export function validCatalogEntry(): CatalogEntryV1 {
  return {
    schemaVersion: 1,
    pluginId: FIXTURE_PLUGIN_ID,
    displayName: 'Gian Fixture',
    tagline: 'Unknown reverse-domain Catalog fixture',
    featuredOrder: 90,
    documentation: {
      overview: 'overview.md',
      setup: 'setup.md',
      usage: 'usage.md',
      troubleshooting: 'troubleshooting.md',
    },
    branding: {
      logoLight: { path: 'assets/logo-light.png', mediaType: 'image/png' },
      logoDark: { path: 'assets/logo-dark.png', mediaType: 'image/png' },
    },
    channels: {
      stable: {
        pluginVersion: '0.1.0',
        manifest: {
          url: GITHUB_MANIFEST,
          sha256: 'a'.repeat(64),
          size: 2048,
        },
        artifacts: {
          'darwin-arm64': {
            url: GITHUB_ARCHIVE,
            sha256: 'b'.repeat(64),
            size: 1_234_567,
          },
        },
      },
    },
  };
}

export function validCatalogIndex(): CatalogIndexV1 {
  const doc = (name: string, body: string) => ({
    path: `docs/${FIXTURE_PLUGIN_ID}/${name}`,
    sha256: digest(body),
    size: Buffer.byteLength(body, 'utf8'),
  });
  return {
    schemaVersion: 1,
    sourceId: 'gian-official',
    sequence: 1,
    issuedAt: '2026-09-01T12:00:00.000Z',
    plugins: [{
      pluginId: FIXTURE_PLUGIN_ID,
      displayName: 'Gian Fixture',
      tagline: 'Unknown reverse-domain Catalog fixture',
      featuredOrder: 90,
      documentation: {
        overview: doc('overview.md', '# Overview\n'),
        setup: doc('setup.md', '# Setup\n'),
        usage: doc('usage.md', '# Usage\n'),
        troubleshooting: doc('troubleshooting.md', '# Troubleshooting\n'),
      },
      branding: {
        light: {
          path: `assets/${FIXTURE_PLUGIN_ID}/logo-light.png`,
          sha256: 'c'.repeat(64),
          size: 1024,
          mediaType: 'image/png',
        },
        dark: {
          path: `assets/${FIXTURE_PLUGIN_ID}/logo-dark.png`,
          sha256: 'd'.repeat(64),
          size: 1024,
          mediaType: 'image/png',
        },
      },
      stable: {
        pluginVersion: '0.1.0',
        protocolRange: '>=2.2 <3.0',
        processScope: 'shared',
        runtime: {
          kind: 'external',
          id: 'fixture-cli',
          displayName: 'Fixture CLI',
          verifiedVersions: ['1.0.0'],
        },
        manifest: {
          url: GITHUB_MANIFEST,
          sha256: 'a'.repeat(64),
          size: 2048,
        },
        artifacts: {
          'darwin-arm64': {
            url: GITHUB_ARCHIVE,
            sha256: 'b'.repeat(64),
            size: 1_234_567,
          },
        },
      },
    }],
  };
}

export function validAssetManifest(): CatalogAssetManifestV1 {
  const index = JSON.stringify(validCatalogIndex());
  return {
    schemaVersion: 1,
    files: [
      {
        path: 'catalog-v1.json',
        sha256: digest(index),
        size: Buffer.byteLength(index, 'utf8'),
      },
      {
        path: `docs/${FIXTURE_PLUGIN_ID}/overview.md`,
        sha256: digest('# Overview\n'),
        size: Buffer.byteLength('# Overview\n', 'utf8'),
      },
    ],
  };
}

export function signAssetManifestBytes(message: Uint8Array | string): {
  publicKeyPem: string;
  envelope: {
    schemaVersion: 1;
    algorithm: 'Ed25519';
    keyId: string;
    signedAsset: 'catalog-assets-v1.json';
    signature: string;
  };
} {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const bytes = typeof message === 'string' ? Buffer.from(message, 'utf8') : Buffer.from(message);
  const signature = sign(null, bytes, privateKey);
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    envelope: {
      schemaVersion: 1,
      algorithm: 'Ed25519',
      keyId: 'gian-official-catalog-2026',
      signedAsset: 'catalog-assets-v1.json',
      signature: signature.toString('base64'),
    },
  };
}
