import assert from 'node:assert/strict';
import test from 'node:test';
import { proxiesExportPath, externalProxyLockfile } from './export-proxies.mjs';

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
