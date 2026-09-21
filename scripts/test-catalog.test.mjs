import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  discoverStandardTests,
  loadValidatedCatalog,
  matchesPattern,
  validateCatalog,
} from './test-catalog.mjs';

test('catalog reconciles every current standard test exactly once', () => {
  const { catalog, entries } = loadValidatedCatalog();
  const counts = Object.groupBy(entries, entry => entry.scope);
  const discoveredE2eCount = discoverStandardTests(catalog)
    .filter(path => path.startsWith('e2e/specs/') || path.startsWith('test/e2e/specs/'))
    .length;
  const privateCheckout = existsSync(
    new URL('../AGENTS.md', import.meta.url),
  );
  const missingOptionalRoots = (catalog.optionalDiscoveryRoots ?? []).filter(root => (
    !existsSync(new URL(`../${root}/`, import.meta.url))
  ));

  // Semantic reconciliation instead of a fixed total baseline: the catalog
  // must classify every discovered test exactly once and every group must
  // stay non-empty, so adding/removing tests never forces a magic-number
  // edit while drift still fails loudly (Review Round 1/5, finding 10).
  assert.ok(entries.length >= 1);
  assert.ok(counts.unit.length >= 1);
  assert.ok(counts.integration.length >= 1);
  assert.ok(counts.system.length >= 1);
  assert.equal(counts.e2e?.length ?? 0, discoveredE2eCount);
  if (privateCheckout) {
    assert.ok(entries.some(entry => entry.path === 'e2e/specs/02-workspace-and-session.spec.ts'),
      'the private source must retain its core workspace/session journey');
  }
  assert.deepEqual(catalog.defaultScopes, ['unit', 'integration']);
  assert.deepEqual(catalog.fullScopes, ['unit', 'integration', 'system']);
  for (const group of catalog.groups) {
    const belongsToMissingOptionalRoot = group.patterns.every(pattern => (
      missingOptionalRoots.some(root => pattern === root || pattern.startsWith(`${root}/`))
    ));
    if (belongsToMissingOptionalRoot) continue;
    assert.ok(
      entries.some(entry => group.patterns.some(pattern => matchesPattern(entry.path, pattern))),
      `catalog group ${group.id} matches no test file`,
    );
  }
});

test('customization regression surface is cataloged exactly once per file', () => {
  const { entries } = loadValidatedCatalog();
  const required = [
    'packages/proxy-protocol/test/customization-protocol.test.ts',
    'packages/proxies/cc-proxy/test/customization.test.ts',
    'packages/proxies/codex-proxy/test/customization.test.ts',
    'packages/proxies/codex-proxy/test/customization-cli.test.ts',
    'packages/proxies/kimi-proxy/test/customization.test.ts',
    'packages/proxies/dsh-proxy/test/customization.test.ts',
    'packages/proxies/grok-proxy/test/customization.test.ts',
    'packages/proxies/zcode-proxy/test/customization.test.ts',
    'packages/host/test/customization-inventory.test.ts',
    'packages/host/test/customizations-routes.test.ts',
    'packages/host/test/protocol-v2-client.test.ts',
    'scripts/docs-adr.test.mjs',
  ];
  for (const path of required) {
    const matches = entries.filter(entry => entry.path === path);
    assert.equal(matches.length, 1, `${path} must be cataloged exactly once`);
  }
});

test('catalog glob matching never crosses a directory boundary for *', () => {
  assert.equal(matchesPattern('packages/web/test/example.test.tsx', 'packages/web/test/*.test.tsx'), true);
  assert.equal(matchesPattern('packages/web/test/nested/example.test.tsx', 'packages/web/test/*.test.tsx'), false);
});

test('catalog rejects unclassified and multiply-classified tests', () => {
  const base = {
    version: 1,
    defaultScopes: ['unit'],
    fullScopes: ['unit', 'system'],
    specialEntrypoints: [],
  };
  const group = {
    id: 'one',
    patterns: ['a.test.mjs'],
    module: 'scripts',
    scope: 'unit',
    purposes: ['regression'],
    sideEffects: ['none'],
    platforms: ['any'],
    runner: 'scripts-node',
  };

  assert.throws(
    () => validateCatalog({ ...base, groups: [group] }, ['missing.test.mjs']),
    /unclassified test paths/,
  );
  assert.throws(
    () => validateCatalog({ ...base, groups: [group, { ...group, id: 'two' }] }, ['a.test.mjs']),
    /multiply classified test paths/,
  );
});

test('catalog rejects real external side effects from default scopes', () => {
  const catalog = {
    version: 1,
    defaultScopes: ['integration'],
    fullScopes: ['integration', 'system'],
    specialEntrypoints: [],
    groups: [{
      id: 'unsafe',
      patterns: ['unsafe.test.mjs'],
      module: 'scripts',
      scope: 'integration',
      purposes: ['regression'],
      sideEffects: ['real-provider', 'network'],
      platforms: ['any'],
      runner: 'scripts-node',
    }],
  };
  assert.throws(
    () => validateCatalog(catalog, ['unsafe.test.mjs']),
    /forbidden side effects: real-provider, network/,
  );
});

test('catalog permits explicitly optional discovery roots to be absent', () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'gian-test-catalog-'));
  try {
    mkdirSync(join(baseDir, 'scripts'), { recursive: true });
    writeFileSync(join(baseDir, 'scripts', 'example.test.mjs'), '');
    const catalog = {
      version: 1,
      discoveryRoots: ['scripts', 'e2e/specs'],
      optionalDiscoveryRoots: ['e2e/specs'],
      defaultScopes: ['unit'],
      fullScopes: ['unit', 'system'],
      specialEntrypoints: [],
      groups: [
        {
          id: 'scripts',
          patterns: ['scripts/*.test.mjs'],
          module: 'scripts',
          scope: 'unit',
          purposes: ['regression'],
          sideEffects: ['none'],
          platforms: ['any'],
          runner: 'scripts-node',
        },
        {
          id: 'e2e',
          patterns: ['e2e/specs/*.spec.ts'],
          module: 'e2e',
          scope: 'e2e',
          purposes: ['regression'],
          sideEffects: ['browser'],
          platforms: ['any'],
          runner: 'playwright',
        },
      ],
    };

    const discovered = discoverStandardTests(catalog, baseDir);
    assert.deepEqual(discovered, ['scripts/example.test.mjs']);
    assert.equal(validateCatalog(catalog, discovered, baseDir).length, 1);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
