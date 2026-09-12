import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  MAX_MANIFEST_V4_VERIFIED_VERSIONS,
  SUPPORTED_PROTOCOL_VERSIONS,
  isManifestV4ExclusiveProtocolRange,
  manifestSchema,
  manifestV2Schema,
  manifestV3Schema,
  manifestV4Schema,
  protocolRangeIncludes,
} from '../src/index.js';

const branding = {
  logo: {
    light: {
      path: 'assets/logo-light.png',
      mediaType: 'image/png' as const,
      sha256: 'a'.repeat(64),
    },
  },
};

function v4(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 4,
    id: 'io.gian.fixture',
    displayName: 'Gian Fixture',
    pluginVersion: '0.1.0',
    entry: 'proxy.mjs',
    protocol: { name: 'gian.proxy', range: '>=2.2 <3.0' },
    process: { scope: 'shared' },
    runtime: { kind: 'none' },
    branding,
    ...overrides,
  };
}

test('manifest v4 accepts a none runtime topology', () => {
  const manifest = manifestV4Schema.parse(v4());
  assert.equal(manifest.schemaVersion, 4);
  assert.equal(manifest.runtime.kind, 'none');
  assert.equal(manifestSchema.parse(v4()).schemaVersion, 4);
});

test('manifest v4 accepts an external runtime with unique exact SemVer versions', () => {
  const manifest = manifestV4Schema.parse(v4({
    runtime: {
      kind: 'external',
      id: 'codex',
      displayName: 'Codex CLI',
      verifiedVersions: ['0.146.0', '0.147.0'],
    },
  }));
  assert.equal(manifest.runtime.kind, 'external');
  if (manifest.runtime.kind === 'external') {
    assert.deepEqual(manifest.runtime.verifiedVersions, ['0.146.0', '0.147.0']);
  }
});

test('manifest v4 rejects installer, command, and legacy runtime fields', () => {
  assert.throws(() => manifestV4Schema.parse(v4({
    runtime: { kind: 'none', command: 'brew install fixture' },
  })));
  assert.throws(() => manifestV4Schema.parse(v4({
    installer: { kind: 'shell', command: 'curl | sh' },
  })));
  assert.throws(() => manifestV4Schema.parse(v4({
    runtime: {
      kind: 'external',
      id: 'codex',
      displayName: 'Codex CLI',
      verifiedVersions: ['0.146.0'],
      verifiedCliVersions: ['0.146.0'],
    },
  })));
  assert.throws(() => manifestV4Schema.parse(v4({
    runtime: {
      kind: 'external',
      id: 'codex',
      displayName: 'Codex CLI',
      verifiedVersions: ['0.146.0'],
      recommendedCliVersion: '0.146.0',
    },
  })));
});

test('manifest v4 rejects duplicate or inexact verifiedVersions', () => {
  assert.throws(() => manifestV4Schema.parse(v4({
    runtime: {
      kind: 'external',
      id: 'codex',
      displayName: 'Codex CLI',
      verifiedVersions: ['0.146.0', '0.146.0'],
    },
  })));
  assert.throws(() => manifestV4Schema.parse(v4({
    runtime: {
      kind: 'external',
      id: 'codex',
      displayName: 'Codex CLI',
      verifiedVersions: ['latest'],
    },
  })));
  assert.throws(() => manifestV4Schema.parse(v4({
    runtime: {
      kind: 'external',
      id: 'codex',
      displayName: 'Codex CLI',
      verifiedVersions: [],
    },
  })));
  assert.throws(() => manifestV4Schema.parse(v4({
    runtime: {
      kind: 'external',
      id: 'Codex',
      displayName: 'Codex CLI',
      verifiedVersions: ['0.146.0'],
    },
  })));
});

test('manifest v4 rejects protocol ranges that current 2.1 Host can activate', () => {
  assert.throws(() => manifestV4Schema.parse(v4({
    protocol: { name: 'gian.proxy', range: '>=2.1 <3.0' },
  })));
  assert.throws(() => manifestV4Schema.parse(v4({
    protocol: { name: 'gian.proxy', range: '>=2.0 <3.0' },
  })));
  assert.throws(() => manifestV4Schema.parse(v4({
    protocol: { name: 'gian.proxy', range: '>=2.2 || 2.1' },
  })));
  assert.doesNotThrow(() => manifestV2Schema.parse({
    schemaVersion: 2,
    id: 'codex',
    displayName: 'Codex',
    pluginVersion: '0.3.0',
    entry: 'proxy.mjs',
    protocol: { name: 'gian.proxy', range: '>=2.1 <3.0' },
    process: { scope: 'shared' },
  }));
  assert.doesNotThrow(() => manifestV3Schema.parse({
    schemaVersion: 3,
    id: 'codex',
    displayName: 'Codex',
    pluginVersion: '0.3.0',
    entry: 'proxy.mjs',
    protocol: { name: 'gian.proxy', range: '>=2.1 <3.0' },
    process: { scope: 'shared' },
    branding,
  }));
});

test('a valid manifest v4 range includes the 2.2 baseline and excludes legacy protocols', () => {
  assert.deepEqual([...SUPPORTED_PROTOCOL_VERSIONS], ['2.3', '2.2', '2.1', '2.0']);
  const accepted = ['>=2.2 <3.0', '>=2.2', '2.2', '^2.2', '~2.2'];
  for (const range of accepted) {
    assert.equal(isManifestV4ExclusiveProtocolRange(range), true);
    assert.doesNotThrow(() => manifestV4Schema.parse(v4({
      protocol: { name: 'gian.proxy', range },
    })));
    assert.equal(
      protocolRangeIncludes(range, '2.1') || protocolRangeIncludes(range, '2.0'),
      false,
      `v4 range ${range} must not intersect production support`,
    );
  }
  assert.equal(isManifestV4ExclusiveProtocolRange('>=2.1 <3.0'), false);
  assert.equal(protocolRangeIncludes('>=2.1 <3.0', '2.1'), true);
  for (const wildcard of ['2.x', '2.X', '2.*']) {
    assert.equal(protocolRangeIncludes(wildcard, '2.1'), true);
    assert.equal(isManifestV4ExclusiveProtocolRange(wildcard), false);
    assert.throws(() => manifestV4Schema.parse(v4({
      protocol: { name: 'gian.proxy', range: wildcard },
    })));
  }
  assert.throws(() => manifestV4Schema.parse(v4({
    protocol: { name: 'gian.proxy', range: '>=2.2\n<3.0' },
  })));
  assert.throws(() => manifestV4Schema.parse(v4({
    protocol: { name: 'gian.proxy', range: '>=2.2\t<3.0' },
  })));
});

test('manifest v4 verifiedVersions is bounded to 32', () => {
  const atBound = Array.from({ length: MAX_MANIFEST_V4_VERIFIED_VERSIONS }, (_, index) => `0.1.${index}`);
  assert.doesNotThrow(() => manifestV4Schema.parse(v4({
    runtime: {
      kind: 'external',
      id: 'codex',
      displayName: 'Codex CLI',
      verifiedVersions: atBound,
    },
  })));
  assert.throws(() => manifestV4Schema.parse(v4({
    runtime: {
      kind: 'external',
      id: 'codex',
      displayName: 'Codex CLI',
      verifiedVersions: [...atBound, '0.1.32'],
    },
  })));
});

test('manifest v2 and v3 remain readable with legacy runtime fields', () => {
  const v2 = manifestV2Schema.parse({
    schemaVersion: 2,
    id: 'codex',
    displayName: 'Codex',
    pluginVersion: '0.3.0',
    entry: 'proxy.mjs',
    protocol: { name: 'gian.proxy', range: '>=2.0 <3.0' },
    process: { scope: 'shared' },
    runtime: {
      id: 'codex',
      displayName: 'Codex CLI',
      verifiedCliVersions: ['0.146.0'],
      recommendedCliVersion: '0.146.0',
    },
  });
  assert.equal(v2.runtime?.verifiedCliVersions?.[0], '0.146.0');

  const v3 = manifestV3Schema.parse({
    schemaVersion: 3,
    id: 'codex',
    displayName: 'Codex',
    pluginVersion: '0.3.0',
    entry: 'proxy.mjs',
    protocol: { name: 'gian.proxy', range: '>=2.1 <3.0' },
    process: { scope: 'shared' },
    runtime: {
      id: 'codex',
      displayName: 'Codex CLI',
      verifiedCliVersions: ['0.146.0'],
    },
    branding,
  });
  assert.equal(v3.schemaVersion, 3);
  assert.equal(manifestSchema.parse(v2).schemaVersion, 2);
  assert.equal(manifestSchema.parse(v3).schemaVersion, 3);
});
