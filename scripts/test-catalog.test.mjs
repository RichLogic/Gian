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
  const hasE2eSources = existsSync(new URL('../e2e/specs', import.meta.url));

  assert.equal(entries.length, hasE2eSources ? 405 : 389);
  assert.equal(counts.unit.length, 169);
  assert.equal(counts.integration.length, 165);
  assert.equal(counts.system.length, 55);
  assert.equal(counts.e2e?.length ?? 0, hasE2eSources ? 16 : 0);
  assert.deepEqual(catalog.defaultScopes, ['unit', 'integration']);
  assert.deepEqual(catalog.fullScopes, ['unit', 'integration', 'system']);
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
