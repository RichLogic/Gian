import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  builtPackageTestPlan,
  parseRunOptions,
  sanitizedTestEnv,
  selectCatalogEntries,
  scriptsNeedProxyProtocol,
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

test('root Proxy artifact tests request a clean Proxy Protocol build first', () => {
  assert.equal(scriptsNeedProxyProtocol(['scripts/build-proxy-artifacts.test.mjs']), true);
  assert.equal(scriptsNeedProxyProtocol(['scripts/proxy-real-acceptance-catalog.test.mjs']), true);
  assert.equal(scriptsNeedProxyProtocol(['scripts/check-ui-operations.test.mjs']), false);
});

test('Host integration runs after compiled Proxy package runners', async () => {
  const source = await readFile(new URL('./run-tests.mjs', import.meta.url), 'utf8');
  const hostRun = source.lastIndexOf("entriesForRunner(selected, 'host-node-tsx')");
  for (const runner of [
    'cc-proxy-node',
    'codex-proxy-node',
    'kimi-proxy-node',
    'grok-proxy-node',
    'dsh-proxy-node',
    'zcode-proxy-node',
  ]) {
    assert.ok(source.indexOf(`'${runner}'`) < hostRun, `${runner} must build before Host tests`);
  }
  assert.match(source, /runPnpm\(\['--filter', '\.\/packages\/proxies\/\*\*', 'build'\], env\)/);
});


test('isolated Host-only runs build both Remote and Catalog contracts', async () => {
  const source = await readFile(new URL('./run-tests.mjs', import.meta.url), 'utf8');
  assert.match(source, /entry.runner === 'host-node-tsx' \|\| entry.runner === 'remote-protocol-node'/);
  assert.match(source, /hostSelected && !selected.some\(entry => entry.runner === 'proxy-catalog-contract-node'\)/);
});
