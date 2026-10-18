import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';

const documents = ['overview', 'setup', 'usage', 'troubleshooting'];

export function assertQualifiedRuntime(record, definition, certificate) {
  if (!definition.runtimeQualification) return;
  const expectedUrl = `https://github.com/${certificate.repository}/releases/download/${record.tag}/${record.runtimeAsset}`;
  if (record.runtime?.kind !== 'native-binary' || record.runtime.runtimeId !== definition.runtime.id
    || !definition.runtime.verifiedCliVersions.includes(record.runtime.version) || record.publishRuntime !== true
    || !record.runtimeAsset || record.runtime.asset?.url !== expectedUrl
    || !certificate.assets?.some(item => item.name === record.runtimeAsset
      && item.sha256 === record.runtime.asset.sha256 && item.size === record.runtime.asset.size)) {
    throw new Error('Package-owned probe certificate does not bind its published Runtime archive');
  }
}

export function certifiedStable(record, certificate, certificateSha256) {
  const coordinate = name => {
    const artifact = certificate.assets.find(item => item.name === name);
    if (!artifact) throw new Error(`Qualified asset missing: ${name}`);
    return { url: `https://github.com/${certificate.repository}/releases/download/${record.tag}/${name}`, size: artifact.size, sha256: artifact.sha256 };
  };
  return { pluginVersion: record.version, manifest: coordinate(`${record.archive}.manifest.json`),
    artifacts: { 'darwin-arm64': coordinate(record.archive) }, combination: {
      generationId: `${record.provider}-${record.version}-runtime-${record.runtime.version}`,
      certificate: { id: certificate.certificateId, sha256: certificateSha256 }, runtime: record.runtime, companions: [],
    } };
}

export function assertSelectedCatalogPlan(previous, sequence, proof) {
  assertQualifiedProof(proof);
  const updates = new Map(proof.certificate.proxies.map(record => [record.pluginId,
    { pluginId: record.pluginId, stable: certifiedStable(record, proof.certificate, proof.certificateSha256) }]));
  const next = { sourceId: previous.sourceId, sequence,
    plugins: [...previous.plugins.map(plugin => updates.get(plugin.pluginId) ?? plugin),
      ...[...updates.values()].filter(plugin => !previous.plugins.some(old => old.pluginId === plugin.pluginId))] };
  assertSelectedCatalogExecutables(previous, next, [...updates.keys()], proof);
}

function assertQualifiedProof(proof) {
  if (!(proof?.certificateBytes instanceof Uint8Array)
    || createHash('sha256').update(proof.certificateBytes).digest('hex') !== proof.certificateSha256
    || !isDeepStrictEqual(JSON.parse(Buffer.from(proof.certificateBytes).toString('utf8')), proof.certificate)) {
    throw new Error('New Proxy requires matching qualified certificate bytes');
  }
}

/** Input bytes have already passed the pinned-key bundle/localization verifier. */
export function retainedCatalogContent(previous, files, selectedIds, localized) {
  const read = ref => {
    const bytes = files.get(ref.path);
    if (!bytes || bytes.length !== ref.size || createHash('sha256').update(bytes).digest('hex') !== ref.sha256) {
      throw new Error(`Retained Catalog content changed: ${ref.path}`);
    }
    return bytes;
  };
  const plugins = previous.plugins.filter(plugin => !selectedIds.includes(plugin.pluginId)).map(plugin => ({
    pluginId: plugin.pluginId, displayName: plugin.displayName, tagline: plugin.tagline, featuredOrder: plugin.featuredOrder,
    documents: Object.fromEntries(documents.map(key => [key, read(plugin.documentation[key])])),
    branding: Object.fromEntries(['light', 'dark'].map(key => [key, { ref: plugin.branding[key], bytes: read(plugin.branding[key]) }])),
  }));
  const localizations = {};
  for (const plugin of localized?.plugins ?? []) {
    if (selectedIds.includes(plugin.pluginId)) continue;
    if (!plugins.some(item => item.pluginId === plugin.pluginId)) throw new Error('Unknown retained localized Proxy');
    localizations[plugin.pluginId] = Object.fromEntries(Object.entries(plugin.locales).map(([locale, content]) => [locale, {
      displayName: content.displayName, tagline: content.tagline,
      documents: Object.fromEntries(documents.map(key => [key, read(content.documentation[key])])),
    }]));
  }
  return { plugins, localizations };
}

export function selectReleaseDefinitions(definitions, selection) {
  const shipping = definitions.filter(item => item.shipping);
  if (selection?.schema !== 1 || !Array.isArray(selection.providers) || !selection.providers.length
    || new Set(selection.providers).size !== selection.providers.length
    || selection.providers.some(id => !shipping.some(item => item.id === id))
    || !/^catalog-v1\.[1-9][0-9]*\.0$/.test(selection.baseCatalogTag ?? '')) {
    throw new Error('Invalid explicit Proxy release selection or signed base Catalog');
  }
  return selection.providers.map(id => shipping.find(item => item.id === id));
}

export function selectedCatalogRecords(previous, qualified) {
  if (new Set(qualified.map(record => record.pluginId)).size !== qualified.length) throw new Error('Duplicate qualified Proxy');
  const records = new Map(previous.plugins.map(plugin => [plugin.pluginId,
    { pluginId: plugin.pluginId, version: plugin.stable.pluginVersion, runtime: plugin.stable.combination.runtime }]));
  for (const record of qualified) records.set(record.pluginId, record);
  return [...records.values()];
}

function assertQualifiedAddition(plugin, proof) {
  assertQualifiedProof(proof);
  const certificate = proof?.certificate;
  const definition = proof?.definitions?.find(item => item.pluginId === plugin.pluginId && item.shipping === true);
  const record = certificate?.proxies?.find(item => item.pluginId === plugin.pluginId);
  const required = ['source', 'build', 'proxy-contracts', 'runtime-artifacts', 'archive-self-tests'];
  if (!definition || !record || certificate.status !== 'PASS' || certificate.repository !== 'RichLogic/Gian-Proxies'
    || !/^[a-f0-9]{64}$/.test(proof.certificateSha256 ?? '')
    || required.some(id => certificate.steps?.filter(step => step.id === id && step.status === 'PASS').length !== 1)
    || definition.pluginVersion !== record.version || !isDeepStrictEqual(definition.manifest, record.manifest)
    || record.manifest?.id !== plugin.pluginId || record.manifest.pluginVersion !== record.version
    || record.tag !== `proxy-${definition.id}-v${record.version}`
    || plugin.stable.pluginVersion !== record.version
    || !isDeepStrictEqual(plugin.stable.combination?.runtime, record.runtime)
    || !isDeepStrictEqual(plugin.stable.combination?.certificate, { id: certificate.certificateId, sha256: proof.certificateSha256 })) {
    throw new Error(`New Proxy requires exact selected shipping metadata and qualified evidence: ${plugin.pluginId}`);
  }
  const coordinates = [[plugin.stable.manifest, `${record.archive}.manifest.json`],
    [plugin.stable.artifacts['darwin-arm64'], record.archive]];
  if (Object.keys(plugin.stable.artifacts).length !== 1) throw new Error('New Proxy has an unqualified platform');
  for (const [coordinate, name] of coordinates) {
    const artifact = certificate.assets?.find(item => item.name === name);
    if (!artifact || coordinate?.url !== `https://github.com/${certificate.repository}/releases/download/${record.tag}/${name}`
      || coordinate.sha256 !== artifact.sha256 || coordinate.size !== artifact.size) {
      throw new Error(`New Proxy artifact differs from qualification: ${plugin.pluginId}`);
    }
  }
}

export function assertSelectedCatalogExecutables(previous, next, selectedIds, proof) {
  if (next.sourceId !== previous.sourceId || next.sequence <= previous.sequence
    || new Set(selectedIds).size !== selectedIds.length
    || selectedIds.some(id => !next.plugins.some(plugin => plugin.pluginId === id))) {
    throw new Error('Invalid selected Catalog update identity');
  }
  const ids = index => index.plugins.map(plugin => plugin.pluginId).sort();
  if (new Set(ids(previous)).size !== previous.plugins.length || new Set(ids(next)).size !== next.plugins.length) {
    throw new Error('Duplicate Catalog Proxy identity');
  }
  if (previous.plugins.some(plugin => !next.plugins.some(item => item.pluginId === plugin.pluginId))) {
    throw new Error('Selected update cannot remove Proxies');
  }
  for (const plugin of next.plugins) {
    if (previous.plugins.some(item => item.pluginId === plugin.pluginId)) continue;
    if (!selectedIds.includes(plugin.pluginId)) throw new Error('Selected update cannot add an unselected Proxy');
    assertQualifiedAddition(plugin, proof);
  }
  for (const old of previous.plugins) {
    if (!selectedIds.includes(old.pluginId)
      && !isDeepStrictEqual(old.stable, next.plugins.find(plugin => plugin.pluginId === old.pluginId)?.stable)) {
      throw new Error(`Excluded Proxy executable identity changed: ${old.pluginId}`);
    }
  }
}

export function assertSameCatalogExecutables(previous, next) {
  if (next.sourceId !== previous.sourceId || next.sequence <= previous.sequence) {
    throw new Error('Documentation refresh must retain source identity and increase sequence');
  }
  const identities = index => index.plugins.map(plugin => ({ pluginId: plugin.pluginId, stable: plugin.stable }))
    .sort((left, right) => left.pluginId.localeCompare(right.pluginId));
  if (!isDeepStrictEqual(identities(previous), identities(next))) {
    throw new Error('Documentation refresh cannot change Proxy, Runtime or certification coordinates');
  }
}
