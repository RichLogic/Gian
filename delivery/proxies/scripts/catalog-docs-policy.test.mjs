import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { assertSameCatalogExecutables, assertSelectedCatalogExecutables, assertSelectedCatalogPlan, assertQualifiedRuntime,
  certifiedStable, retainedCatalogContent, selectedCatalogRecords, selectReleaseDefinitions } from './catalog-docs-policy.mjs';

const base = { sourceId: 'gian-official', sequence: 8, plugins: [{ pluginId: 'fixture', tagline: 'Old',
  documentation: { overview: 'old.md' }, stable: { pluginVersion: '0.3.1',
    artifacts: { 'darwin-arm64': { url: 'https://example.test/proxy', sha256: 'abc', size: 10 } },
    combination: { runtime: { version: '1.0', artifactSha256: '123' }, certificate: { id: 'original', sha256: 'def' } },
  } }] };

test('selected releases preserve excluded executable and certificate coordinates', () => {
  const definitions = [{ id: 'claude', shipping: true }, { id: 'zcode', shipping: true }, { id: 'grok', shipping: false }];
  const selection = { schema: 1, providers: ['claude'], baseCatalogTag: 'catalog-v1.9.0' };
  assert.deepEqual(selectReleaseDefinitions(definitions, selection), [definitions[0]]);
  for (const providers of [[], ['grok'], ['claude', 'claude'], ['unknown']]) {
    assert.throws(() => selectReleaseDefinitions(definitions, { ...selection, providers }));
  }
  assert.throws(() => selectReleaseDefinitions(definitions, { ...selection, baseCatalogTag: 'latest' }));
  const previous = structuredClone(base);
  previous.plugins.push({ ...structuredClone(base.plugins[0]), pluginId: 'excluded' });
  const next = structuredClone(previous); next.sequence++;
  next.plugins[0].stable.pluginVersion = '0.4.0';
  assert.doesNotThrow(() => assertSelectedCatalogExecutables(previous, next, ['fixture']));
  next.plugins[1].stable.combination.certificate.sha256 = 'changed';
  assert.throws(() => assertSelectedCatalogExecutables(previous, next, ['fixture']), /Excluded/);
  assert.throws(() => assertSelectedCatalogExecutables(previous, { ...next, plugins: [next.plugins[0]] }, ['fixture']), /remove/);
});

test('documentation refresh preserves exact executable and proof identities', () => {
  const next = structuredClone(base);
  next.sequence++;
  next.plugins[0].tagline = 'Translated';
  next.plugins[0].documentation.overview = 'new.md';
  assert.doesNotThrow(() => assertSameCatalogExecutables(base, next));
  for (const mutate of [
    x => { x.plugins[0].stable.pluginVersion = '0.4.0'; },
    x => { x.plugins[0].stable.combination.runtime.artifactSha256 = 'changed'; },
    x => { x.plugins[0].stable.combination.certificate.sha256 = 'changed'; },
    x => { x.plugins[0].stable.artifacts['darwin-arm64'].url = 'https://other.test/proxy'; },
    x => { x.plugins = []; },
    x => { x.sequence = 8; },
    x => { x.sourceId = 'other'; },
  ]) {
    const invalid = structuredClone(next); mutate(invalid);
    assert.throws(() => assertSameCatalogExecutables(base, invalid));
  }
});

// Explicit selection also owns publication order; package directory sorting
// must not publish Grok before an Owner-selected Kimi release.
test('selected releases retain the explicitly requested publication order', () => {
  const definitions = [{ id: 'grok', shipping: true }, { id: 'kimi', shipping: true }];
  const selection = { schema: 1, providers: ['kimi', 'grok'], baseCatalogTag: 'catalog-v1.19.0' };
  assert.deepEqual(selectReleaseDefinitions(definitions, selection), [definitions[1], definitions[0]]);
});

test('only a selected qualified addition may join the complete immutable base', () => {
  // Synthetic qualification fixtures, never release evidence or asset pins.
  const pluginId = 'io.fixture.new';
  const manifest = { id: pluginId, pluginVersion: '0.0.1' };
  const runtime = { version: '1.3.0' };
  const record = { pluginId, provider: 'new', version: '0.0.1', manifest, runtime,
    tag: 'proxy-new-v0.0.1', archive: 'new.tar.gz' };
  const certificate = { status: 'PASS', repository: 'RichLogic/Gian-Proxies', certificateId: 'fixture-certificate',
    proxies: [record], steps: ['source', 'build', 'proxy-contracts', 'runtime-artifacts', 'archive-self-tests'].map(id => ({ id, status: 'PASS' })),
    assets: [{ name: 'new.tar.gz', size: 10, sha256: 'a'.repeat(64) }, { name: 'new.tar.gz.manifest.json', size: 20, sha256: 'b'.repeat(64) }] };
  const certificateBytes = Buffer.from(JSON.stringify(certificate));
  const certificateSha256 = createHash('sha256').update(certificateBytes).digest('hex');
  const definition = { id: 'new', pluginId, pluginVersion: '0.0.1', shipping: true, manifest };
  const coordinate = name => ({ url: `https://github.com/RichLogic/Gian-Proxies/releases/download/${record.tag}/${name}`,
    size: certificate.assets.find(item => item.name === name).size, sha256: certificate.assets.find(item => item.name === name).sha256 });
  const addition = { pluginId, stable: { pluginVersion: '0.0.1', manifest: coordinate('new.tar.gz.manifest.json'),
    artifacts: { 'darwin-arm64': coordinate('new.tar.gz') }, combination: { runtime, certificate: { id: certificate.certificateId, sha256: certificateSha256 } } } };
  const next = { ...structuredClone(base), sequence: 29, plugins: [...structuredClone(base.plugins), addition] };
  const proof = { certificate, certificateBytes, certificateSha256, definitions: [definition] };
  assert.deepEqual(certifiedStable(record, certificate, certificateSha256), {
    ...addition.stable, combination: { ...addition.stable.combination, generationId: 'new-0.0.1-runtime-1.3.0', companions: [] },
  });
  assert.doesNotThrow(() => assertSelectedCatalogPlan(base, 29, proof));
  assert.doesNotThrow(() => assertSelectedCatalogExecutables(base, next, [pluginId], proof));
  assert.deepEqual(selectedCatalogRecords(base, [record]).map(item => item.pluginId), ['fixture', pluginId]);
  assert.deepEqual(selectedCatalogRecords(base, [record])[0].runtime, base.plugins[0].stable.combination.runtime);
  assert.throws(() => selectedCatalogRecords(base, [record, record]), /Duplicate/);
  assert.throws(() => assertSelectedCatalogExecutables(base, next, [], proof), /unselected/);
  assert.throws(() => assertSelectedCatalogExecutables(base, next, [pluginId]), /qualified/);
  for (const mutate of [
    x => { x.plugins.shift(); },
    x => { x.plugins[0].stable.combination.certificate.sha256 = 'tampered'; },
    x => { x.plugins[0].stable.artifacts['darwin-arm64'].url = 'https://other.invalid'; },
    x => { x.plugins[1].stable.manifest.sha256 = 'tampered'; },
    x => { x.plugins[1].stable.combination.runtime.version = '9.0.0'; },
    x => { x.plugins.push(structuredClone(addition)); },
  ]) {
    const invalid = structuredClone(next); mutate(invalid);
    assert.throws(() => assertSelectedCatalogExecutables(base, invalid, [pluginId], proof));
  }
  for (const mutate of [
    x => { x.certificate.status = 'NOT_RUN'; },
    x => { x.definitions[0].shipping = false; },
    x => { x.certificate.steps.pop(); },
    x => { x.certificate.assets[0].sha256 = 'tampered'; },
    x => { x.certificate.proxies[0].version = '0.0.2'; },
  ]) {
    const invalid = structuredClone(proof); mutate(invalid);
    assert.throws(() => assertSelectedCatalogExecutables(base, next, [pluginId], invalid));
    assert.throws(() => assertSelectedCatalogPlan(base, 29, invalid));
  }
});

test('excluded documents, localized documents and branding come only from verified base bytes', () => {
  const files = new Map();
  const ref = (path, text) => {
    const bytes = Buffer.from(text); files.set(path, bytes);
    return { path, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  };
  const documentation = Object.fromEntries(['overview', 'setup', 'usage', 'troubleshooting'].map(key => [key, ref(`docs/old/${key}.md`, `signed ${key}`)]));
  const branding = { light: { ...ref('assets/old/light.png', 'signed light'), mediaType: 'image/png' },
    dark: { ...ref('assets/old/dark.png', 'signed dark'), mediaType: 'image/png' } };
  const previous = { plugins: [{ ...base.plugins[0], displayName: 'Signed name', tagline: 'Signed tagline', featuredOrder: 4, documentation, branding }] };
  const localized = { plugins: [{ pluginId: 'fixture', locales: {
    en: { displayName: 'Signed English', tagline: 'Signed English tagline', documentation },
    'zh-CN': { displayName: 'Signed other locale', tagline: 'Signed other tagline', documentation },
  } }] };
  const retained = retainedCatalogContent(previous, files, ['io.fixture.new'], localized);
  assert.equal(retained.plugins[0].displayName, 'Signed name');
  assert.deepEqual(retained.plugins[0].documents.overview, files.get(documentation.overview.path));
  assert.deepEqual(retained.plugins[0].branding.dark.bytes, files.get(branding.dark.path));
  assert.deepEqual(retained.localizations.fixture.en.documents.usage, files.get(documentation.usage.path));
  assert.deepEqual(retainedCatalogContent(previous, files, ['fixture'], localized), { plugins: [], localizations: {} });
  for (const path of [documentation.overview.path, branding.light.path]) {
    const invalid = new Map(files); invalid.set(path, Buffer.from('tampered'));
    assert.throws(() => retainedCatalogContent(previous, invalid, [], localized), /content changed/);
  }
  const invalidLocalized = structuredClone(localized);
  invalidLocalized.plugins[0].locales.en.documentation.overview = ref('docs/old/en/overview.md', 'localized');
  files.delete('docs/old/en/overview.md');
  assert.throws(() => retainedCatalogContent(previous, files, [], invalidLocalized), /content changed/);
});

test('package-owned Runtime publication binds the exact qualified archive and immutable URL', () => {
  const definition = { runtimeQualification: { module: 'owned.js', export: 'probe' },
    runtime: { id: 'fixture-acp', verifiedCliVersions: ['1.3.0'] } };
  const record = { tag: 'proxy-new-v0.0.1', runtimeAsset: 'runtime.tar.gz', publishRuntime: true,
    runtime: { kind: 'native-binary', runtimeId: 'fixture-acp', version: '1.3.0',
      asset: { url: 'https://github.com/RichLogic/Gian-Proxies/releases/download/proxy-new-v0.0.1/runtime.tar.gz', size: 50, sha256: 'a'.repeat(64) } } };
  const certificate = { repository: 'RichLogic/Gian-Proxies', assets: [{ name: 'runtime.tar.gz', size: 50, sha256: 'a'.repeat(64) }] };
  assert.doesNotThrow(() => assertQualifiedRuntime(record, definition, certificate));
  for (const mutate of [
    x => { x.publishRuntime = false; }, x => { x.runtime.version = '0.0.1'; },
    x => { x.runtime.runtimeId = 'other'; }, x => { x.runtime.asset.url = 'https://other.invalid/runtime'; },
    x => { x.runtime.asset.sha256 = 'b'.repeat(64); }, x => { x.runtime.asset.size = 51; },
  ]) {
    const invalid = structuredClone(record); mutate(invalid);
    assert.throws(() => assertQualifiedRuntime(invalid, definition, certificate), /published Runtime/);
  }
});
