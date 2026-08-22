import assert from 'node:assert/strict';
import test from 'node:test';
import { join, resolve } from 'node:path';
import {
  builtPackageTestPlan,
  parseRunOptions,
  sanitizedTestEnv,
  selectCatalogEntries,
} from './run-tests.mjs';

test('sanitizedTestEnv removes inherited Gian production configuration', () => {
  assert.deepEqual(sanitizedTestEnv({
    PATH: '/bin',
    CI: '1',
    GIAN_PORT: '8990',
    GIAN_DATA_DIR: '/Users/example/.gian',
    GIAN_DESKTOP_TOKEN: 'secret',
  }), {
    PATH: '/bin',
    CI: '1',
  });
});

test('parseRunOptions defaults to the safe daily scopes', () => {
  assert.deepEqual(parseRunOptions([], ['unit', 'integration']), {
    scopes: ['unit', 'integration'],
    files: [],
    qualityGates: false,
    listOnly: false,
  });
});

test('parseRunOptions accepts explicit unique scopes and quality gates', () => {
  assert.deepEqual(
    parseRunOptions(['--scope', 'system', '--scope', 'system', '--quality-gates', '--list']),
    { scopes: ['system'], files: [], qualityGates: true, listOnly: true },
  );
  assert.throws(() => parseRunOptions(['--scope', 'e2e']), /unsupported test scope/);
});

test('parseRunOptions accepts unique exact catalog files', () => {
  assert.deepEqual(parseRunOptions(['--file', 'a.test.ts', '--file', 'a.test.ts']), {
    scopes: ['unit', 'integration'],
    files: ['a.test.ts'],
    qualityGates: false,
    listOnly: false,
  });
  assert.throws(() => parseRunOptions(['--file']), /requires a value/);
});

test('selectCatalogEntries returns only requested layers', () => {
  const entries = [
    { path: 'u', scope: 'unit' },
    { path: 'i', scope: 'integration' },
    { path: 's', scope: 'system' },
  ];
  assert.deepEqual(
    selectCatalogEntries(entries, ['unit', 'integration']).map(entry => entry.path),
    ['u', 'i'],
  );
});

test('selectCatalogEntries intersects scopes with exact catalog files and rejects unknown paths', () => {
  const entries = [
    { path: 'u', scope: 'unit' },
    { path: 'i', scope: 'integration' },
    { path: 's', scope: 'system' },
  ];
  assert.deepEqual(selectCatalogEntries(entries, ['unit', 'integration'], ['i']), [entries[1]]);
  assert.deepEqual(selectCatalogEntries(entries, ['unit'], ['i']), []);
  assert.throws(() => selectCatalogEntries(entries, ['unit'], ['missing']), /unknown catalog/);
});

test('compiled package tests run from their package root', () => {
  const packageRoot = resolve('packages/proxies/cc-proxy');
  assert.deepEqual(
    builtPackageTestPlan(
      ['packages/proxies/cc-proxy/test/protocol-v1-cli.test.ts'],
      packageRoot,
    ),
    {
      cwd: packageRoot,
      paths: [join(packageRoot, 'dist/test/protocol-v1-cli.test.js')],
    },
  );
});
