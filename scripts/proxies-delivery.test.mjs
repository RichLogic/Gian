import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { proxiesExportPath, externalProxyLockfile, standaloneRuntimeVerifier } from './export-proxies.mjs';
import { proxyProbeCoordinate, verifyProxyRuntimeCandidate } from './verify-managed-runtime-candidates.mjs';

test('source Proxy packages use the workspace protocol dependency', () => {
  const root = new URL('../packages/proxies/', import.meta.url);
  for (const directory of readdirSync(root, { withFileTypes: true })) {
    if (!directory.isDirectory()) continue;
    const manifest = new URL(`${directory.name}/package.json`, root);
    let metadata;
    try {
      metadata = JSON.parse(readFileSync(manifest, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    if (metadata.dependencies?.['@gian/proxy-protocol']) {
      assert.equal(metadata.dependencies['@gian/proxy-protocol'], 'workspace:*', directory.name);
    }
  }
});

test('Proxy product excludes App and private protocol source and reuses the exact runtime extractor', () => {
  for (const path of ['AGENTS.md', '.ai/MEMORY.md', 'packages/host/package.json', 'packages/desktop/src/main.ts',
    'packages/web/package.json', 'packages/proxy-protocol/src/index.ts', 'packages/shared/test/identity.test.mjs']) {
    assert.equal(proxiesExportPath(path), null);
  }
  assert.equal(proxiesExportPath('packages/proxies/dsh-proxy/package.json'), 'packages/proxies/dsh-proxy/package.json');
  assert.equal(proxiesExportPath('packages/host/src/runtime/safe-extract.ts'), 'support/runtime-extractor/src/safe-extract.ts');
  assert.equal(proxiesExportPath('delivery/proxies/.github/workflows/catalog.yml'), '.github/workflows/catalog.yml');
  assert.equal(proxiesExportPath('scripts/check-node.js'), 'scripts/check-node.cjs');
  assert.equal(proxiesExportPath('catalog/proxy-information/claude/tutorial.md'), 'catalog/proxy-information/claude/tutorial.md');
  for (const path of ['scripts/build-zcode-runtime.mjs', 'scripts/zcode-runtime-source.mjs',
    'scripts/build-antigravity-runtime.mjs',
    'scripts/build-antigravity-runtime.test.mjs',
    'scripts/verify-zcode-runtime-protocol.mjs',
    'scripts/zcode-runtime-integration.mjs',
    'scripts/build-managed-runtime-candidates.test.mjs', 'scripts/proxy-release-metadata.test.mjs',
    'packages/proxies/zcode-proxy/src/runtime/source.json']) {
    assert.equal(proxiesExportPath(path), path, 'Standalone release must retain ZCode source lock and build dependencies');
  }
});

test('standalone Runtime builder and verifier import with no private Host tree', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gian-standalone-import-'));
  const put = (path, value) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), value); };
  try {
    put('package.json', '{"type":"module"}');
    // A fake build dependency proves cold imports only; no build/Runtime is executed.
    put('node_modules/esbuild/package.json', '{"type":"module","exports":"./index.js"}');
    put('node_modules/esbuild/index.js', 'export function build() { throw Error("unexpected build"); }');
    for (const path of ['scripts/verify-managed-runtime-candidates.mjs', 'scripts/build-proxy-artifacts.mjs',
      'scripts/build-managed-runtime-candidates.mjs', 'scripts/proxy-release-metadata.mjs',
      'scripts/build-antigravity-runtime.mjs', 'scripts/build-zcode-runtime.mjs',
      'scripts/verify-zcode-runtime-protocol.mjs', 'scripts/zcode-runtime-source.mjs', 'scripts/zcode-runtime-integration.mjs',
      'packages/proxies/zcode-proxy/src/runtime/source.json', 'packages/host/src/runtime/dev-runtime-coordinates.json']) {
      const destination = proxiesExportPath(path);
      assert.ok(destination, `Missing standalone dependency: ${path}`);
      const bytes = readFileSync(new URL(`../${path}`, import.meta.url));
      put(destination, path.endsWith('/verify-managed-runtime-candidates.mjs') ? standaloneRuntimeVerifier(bytes.toString()) : bytes);
    }
    assert.equal(existsSync(join(root, 'packages/host')), false);
    assert.doesNotMatch(readFileSync(join(root, 'scripts/verify-managed-runtime-candidates.mjs'), 'utf8'), /packages\/host\//);
    const verifier = await import(pathToFileURL(join(root, 'scripts/verify-managed-runtime-candidates.mjs')).href);
    const builder = await import(pathToFileURL(join(root, 'scripts/build-managed-runtime-candidates.mjs')).href);
    assert.equal(typeof verifier.verifyManagedRuntimeCandidates, 'function');
    assert.equal(typeof builder.buildManagedRuntimeCandidates, 'function');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('package-owned qualification retains pin checks and rejects probe identity/layout drift', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gian-owned-probe-'));
  const directory = join(root, 'packages/proxies/fixture-proxy');
  const statePath = join(directory, 'state.json');
  const home = join(root, 'isolated-home');
  const entryPath = join(root, 'runtime/server');
  const definition = { pluginId: 'io.fixture.probe', directory: 'fixture-proxy',
    runtime: { id: 'fixture-runtime', displayName: 'Fixture ACP' }, runtimeQualification: { module: 'probe.mjs', export: 'probe' } };
  const coordinate = { pluginId: definition.pluginId, runtimeId: definition.runtime.id, version: '1.3.0', format: 'tar.gz',
    entryRelativePath: 'server', probe: { kind: 'proxy' }, asset: { sha256: 'a'.repeat(64), size: 123 } };
  const candidate = { provider: 'fixture', ...coordinate, asset: { ...coordinate.asset } };
  const definitions = [{ ...definition, id: 'fixture' }];
  try {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'probe.mjs'), `import { readFile } from 'node:fs/promises';
export async function probe(path, env) {
  if (env.HOME !== env.GEMINI_HOME || env.HOME !== env.GIAN_AGENT_HOME) throw Error('unisolated probe');
  return { runtimeId: 'fixture-runtime', displayName: 'Fixture ACP', path, version: '1.3.0', configHome: env.HOME,
    contentRoots: [{ path, mode: 'file' }], ...JSON.parse(await readFile(new URL('./state.json', import.meta.url), 'utf8')) };
}`);
    writeFileSync(statePath, '{}');
    assert.ok(proxyProbeCoordinate(candidate, [coordinate], definitions));
    for (const changed of [{ ...candidate, entryRelativePath: 'other' }, { ...candidate, format: 'raw' },
      { ...candidate, asset: { ...candidate.asset, sha256: 'b'.repeat(64) } }, { ...candidate, asset: { ...candidate.asset, size: 124 } }]) {
      assert.throws(() => proxyProbeCoordinate(changed, [coordinate], definitions), /differs/);
    }
    const input = { candidate, definition, entryPath, home, repositoryRoot: root };
    assert.equal(await verifyProxyRuntimeCandidate(input), '1.3.0');
    for (const changed of [{ runtimeId: 'other' }, { version: '9.0.0' }, { displayName: 'Other' },
      { path: '/other/server' }, { configHome: '/other/home' }, { contentRoots: [{ path: entryPath, mode: 'directory' }] },
      { contentRoots: [{ path: entryPath, mode: 'file' }, { path: '/outside/harness', mode: 'file' }] }]) {
      writeFileSync(statePath, JSON.stringify(changed));
      await assert.rejects(verifyProxyRuntimeCandidate(input), /differs|escapes/);
    }
    await assert.rejects(verifyProxyRuntimeCandidate({ ...input, definition: { ...definition, runtimeQualification: null } }), /package-owned/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('standalone lock retains exact registry snapshots and removes private protocol importers', () => {
  const coordinate = { url: 'https://github.com/RichLogic/Gian/releases/download/proxy-protocol-v1.0.0/gian-proxy-protocol-1.0.0.tgz',
    integrity: 'fixture-integrity', version: '1.0.0', dependencies: { zod: '4.4.3' } };
  const lock = { lockfileVersion: '9.0', importers: {
    '.': { devDependencies: { typescript: { specifier: '^5.9.0', version: '5.9.3' }, '@playwright/test': {} } },
    'packages/proxies/fixture': { dependencies: { '@gian/proxy-protocol': { specifier: 'workspace:*', version: 'link:../../proxy-protocol' } } },
    'packages/proxy-protocol': {}, 'packages/host': {},
  }, packages: { 'zod@4.4.3': { resolution: { integrity: 'registry-fixture' } } }, snapshots: { 'zod@4.4.3': {} } };
  const result = externalProxyLockfile(lock, coordinate, ['packages/proxies/fixture'], { typescript: '^5.9.0' });
  assert.deepEqual(Object.keys(result.importers), ['.', 'packages/proxies/fixture']);
  assert.equal(result.importers['packages/proxies/fixture'].dependencies['@gian/proxy-protocol'].specifier, coordinate.url);
  assert.deepEqual(result.packages['zod@4.4.3'], lock.packages['zod@4.4.3']);
  assert.equal(result.importers['.'].devDependencies['@playwright/test'], undefined);
  assert.equal(result.packages[`@gian/proxy-protocol@${coordinate.url}`].resolution.integrity, coordinate.integrity);
  assert.throws(() => externalProxyLockfile(lock, { ...coordinate, dependencies: { zod: '99.0.0' } }, [], {}), /absent from the source lock/);
});
