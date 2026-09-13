import { createHash, createPrivateKey, sign, type KeyObject } from 'node:crypto';

import {
  KNOWN_PROTOCOL_VERSIONS,
  manifestSchema,
  protocolRangeIncludes,
} from '@gian/proxy-protocol';

import {
  CATALOG_ASSET_MANIFEST_FILE,
  CATALOG_DOCUMENT_KEYS,
  CATALOG_INDEX_FILE,
  CATALOG_SIGNATURE_ALGORITHM,
  CATALOG_SIGNATURE_FILE,
  CATALOG_SCHEMA_VERSION,
  MAX_CATALOG_DOCUMENT_BYTES,
  MAX_CATALOG_IMAGE_BYTES,
  MAX_CATALOG_INDEX_BYTES,
} from './constants.js';
import { assertCatalogImageMagic } from './media.js';
import {
  catalogAssetManifestV1Schema,
  catalogEntryV1Schema,
  catalogIndexV1Schema,
  catalogSignatureEnvelopeV1Schema,
  compiledRuntimeSummarySchema,
  type CatalogAssetManifestV1,
  type CatalogEntryV1,
  type CatalogIndexV1,
  type CatalogSignatureEnvelopeV1,
  type CompiledCatalogEntryV1,
  type CompiledRuntimeSummary,
} from './schemas.js';
import { assertCatalogMarkdown } from './catalog-markdown.js';
import { isApprovedGitHubReleaseAssetUrl, isApprovedRuntimeAssetUrl } from './url-policy.js';

export interface CatalogSigningKey {
  keyId: string;
  privateKey: KeyObject | string | Uint8Array;
}

export interface CatalogCompilerPluginInput {
  entry: CatalogEntryV1;
  documents: Record<(typeof CATALOG_DOCUMENT_KEYS)[number], string | Uint8Array>;
  logos: { light: Uint8Array; dark: Uint8Array };
  manifestSidecar: Uint8Array | string;
}

export interface CompileCatalogBundleInput {
  sourceId: string;
  sequence: number;
  issuedAt: string;
  plugins: readonly CatalogCompilerPluginInput[];
  allowedArtifactRepositories: readonly string[];
  allowedRuntimeAssetPrefixes?: readonly string[];
  signingKey: CatalogSigningKey;
}

export interface CompiledCatalogBundle {
  files: Map<string, Buffer>;
  index: CatalogIndexV1;
  assetManifest: CatalogAssetManifestV1;
  envelope: CatalogSignatureEnvelopeV1;
  assetManifestUtf8: string;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function asBuffer(value: string | Uint8Array): Buffer {
  return typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value);
}

function stableStringify(value: unknown): string {
  return `${JSON.stringify(sortKeys(value))}\n`;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record).sort().map((key) => [key, sortKeys(record[key])]),
  );
}

function decodeSigningKey(value: CatalogSigningKey['privateKey']): KeyObject {
  if (typeof value === 'string') {
    const key = createPrivateKey(value);
    if (key.asymmetricKeyType !== 'ed25519') {
      throw new Error('Catalog signing key is not Ed25519.');
    }
    return key;
  }
  if (value instanceof Uint8Array) {
    const key = createPrivateKey({
      key: Buffer.from(value),
      format: 'der',
      type: 'pkcs8',
    });
    if (key.asymmetricKeyType !== 'ed25519') {
      throw new Error('Catalog signing key is not Ed25519.');
    }
    return key;
  }
  if (value.asymmetricKeyType !== 'ed25519' || value.type !== 'private') {
    throw new Error('Catalog signing key is not Ed25519.');
  }
  return value;
}

export function signCatalogAssetManifest(
  assetManifestUtf8: string | Uint8Array,
  signingKey: CatalogSigningKey,
): CatalogSignatureEnvelopeV1 {
  const privateKey = decodeSigningKey(signingKey.privateKey);
  const bytes = asBuffer(assetManifestUtf8);
  const envelope = catalogSignatureEnvelopeV1Schema.parse({
    schemaVersion: CATALOG_SCHEMA_VERSION,
    algorithm: CATALOG_SIGNATURE_ALGORITHM,
    keyId: signingKey.keyId,
    signedAsset: CATALOG_ASSET_MANIFEST_FILE,
    signature: sign(null, bytes, privateKey).toString('base64'),
  });
  return envelope;
}

function projectManifestSidecar(
  sidecarBytes: Buffer,
  entry: CatalogEntryV1,
): Pick<CompiledCatalogEntryV1['stable'], 'protocolRange' | 'processScope' | 'runtime'> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(sidecarBytes.toString('utf8'));
  } catch {
    throw new Error(`Manifest sidecar for ${entry.pluginId} is not valid JSON.`);
  }
  const sidecar = manifestSchema.parse(parsed);
  if (sidecar.id !== entry.pluginId) {
    throw new Error(`Manifest sidecar id does not match ${entry.pluginId}.`);
  }
  if (sidecar.pluginVersion !== entry.channels.stable.pluginVersion) {
    throw new Error(`Manifest sidecar version does not match ${entry.pluginId}.`);
  }
  if (!KNOWN_PROTOCOL_VERSIONS.some((version) => protocolRangeIncludes(sidecar.protocol.range, version))) {
    throw new Error(`Manifest sidecar protocol range matches no known gian.proxy version for ${entry.pluginId}.`);
  }
  return {
    protocolRange: sidecar.protocol.range,
    processScope: sidecar.process.scope,
    runtime: projectRuntime(sidecar),
  };
}

function projectRuntime(sidecar: {
  schemaVersion: 2 | 3 | 4;
  runtime?: unknown;
}): CompiledRuntimeSummary | null {
  if (sidecar.schemaVersion === 4) {
    return compiledRuntimeSummarySchema.parse(sidecar.runtime);
  }
  const runtime = sidecar.runtime;
  if (!runtime || typeof runtime !== 'object' || Array.isArray(runtime)) return null;
  const record = runtime as Record<string, unknown>;
  if (typeof record.id !== 'string' || typeof record.displayName !== 'string') return null;
  if (!Array.isArray(record.verifiedCliVersions) || record.verifiedCliVersions.length === 0) {
    return null;
  }
  return compiledRuntimeSummarySchema.parse({
    kind: 'external',
    id: record.id,
    displayName: record.displayName,
    verifiedVersions: record.verifiedCliVersions,
  });
}

function assertCertifiedCombination(
  entry: CatalogEntryV1,
  runtime: CompiledRuntimeSummary | null,
  allowedRuntimeAssetPrefixes: readonly string[],
): void {
  const combination = entry.channels.stable.combination;
  if (!combination) return;
  const distributions = [
    ...(combination.runtime?.kind === 'native-binary' ? [combination.runtime] : []),
    ...combination.companions.map(companion => companion.distribution),
  ];
  for (const distribution of distributions) {
    if (!isApprovedRuntimeAssetUrl(distribution.asset.url, allowedRuntimeAssetPrefixes)) {
      throw new Error(`Runtime artifact URL is not allowed for ${entry.pluginId}.`);
    }
  }
  if (runtime?.kind === 'none') {
    if (combination.runtime !== null) {
      throw new Error(`Runtime-free Proxy ${entry.pluginId} cannot declare a Runtime distribution.`);
    }
    return;
  }
  if (!runtime || !combination.runtime) {
    throw new Error(`Certified Runtime combination is incomplete for ${entry.pluginId}.`);
  }
  if (
    combination.runtime.runtimeId !== runtime.id
    || !runtime.verifiedVersions.includes(combination.runtime.version)
  ) {
    throw new Error(`Certified Runtime combination does not match the Manifest for ${entry.pluginId}.`);
  }
}

function addFile(
  files: Map<string, Buffer>,
  path: string,
  bytes: Buffer,
): { path: string; sha256: string; size: number } {
  if (files.has(path)) throw new Error(`Duplicate Catalog payload path ${path}.`);
  files.set(path, bytes);
  return { path, sha256: sha256Hex(bytes), size: bytes.byteLength };
}

export function compileCatalogBundle(input: CompileCatalogBundleInput): CompiledCatalogBundle {
  if (!input.signingKey) {
    throw new Error('Catalog compiler requires an injected signing key.');
  }
  if (input.plugins.length === 0) {
    throw new Error('Catalog compiler requires at least one plugin.');
  }

  const files = new Map<string, Buffer>();
  const compiledPlugins: CompiledCatalogEntryV1[] = [];

  const sorted = [...input.plugins].sort((left, right) => {
    if (left.entry.featuredOrder !== right.entry.featuredOrder) {
      return left.entry.featuredOrder - right.entry.featuredOrder;
    }
    return left.entry.pluginId.localeCompare(right.entry.pluginId);
  });

  for (const plugin of sorted) {
    const entry = catalogEntryV1Schema.parse(plugin.entry);
    const artifacts = entry.channels.stable.artifacts ?? {};
    const hasArtifact = Object.values(artifacts).some((asset) => asset !== undefined);
    if (hasArtifact) {
      const manifest = entry.channels.stable.manifest;
      if (!manifest) {
        throw new Error(`Installable Manifest coordinate is missing for ${entry.pluginId}.`);
      }
      if (!isApprovedGitHubReleaseAssetUrl(manifest.url, input.allowedArtifactRepositories)) {
        throw new Error(`Manifest URL is not an allowed artifact URL for ${entry.pluginId}.`);
      }
      for (const artifact of Object.values(artifacts)) {
        if (!artifact) continue;
        if (!isApprovedGitHubReleaseAssetUrl(artifact.url, input.allowedArtifactRepositories)) {
          throw new Error(`Artifact URL is not an allowed artifact URL for ${entry.pluginId}.`);
        }
      }
    }

    const sidecar = asBuffer(plugin.manifestSidecar);
    if (entry.channels.stable.manifest) {
      if (sidecar.byteLength !== entry.channels.stable.manifest.size) {
        throw new Error(`Manifest sidecar size does not match ${entry.pluginId}.`);
      }
      if (sha256Hex(sidecar) !== entry.channels.stable.manifest.sha256) {
        throw new Error(`Manifest sidecar digest does not match ${entry.pluginId}.`);
      }
    }
    const projection = projectManifestSidecar(sidecar, entry);
    assertCertifiedCombination(
      entry,
      projection.runtime,
      input.allowedRuntimeAssetPrefixes ?? input.allowedArtifactRepositories.map(
        repository => `https://github.com/${repository}/releases/download/`,
      ),
    );

    const documentation = {} as CompiledCatalogEntryV1['documentation'];
    for (const key of CATALOG_DOCUMENT_KEYS) {
      const bytes = asBuffer(plugin.documents[key]);
      if (bytes.byteLength > MAX_CATALOG_DOCUMENT_BYTES) {
        throw new Error(`${key} exceeds MAX_CATALOG_DOCUMENT_BYTES for ${entry.pluginId}.`);
      }
      assertCatalogMarkdown(bytes.toString('utf8'), `${entry.pluginId} ${key}`);
      documentation[key] = addFile(files, `docs/${entry.pluginId}/${key}.md`, bytes);
    }

    assertCatalogImageMagic(plugin.logos.light, entry.branding.logoLight.mediaType);
    assertCatalogImageMagic(plugin.logos.dark, entry.branding.logoDark.mediaType);
    if (plugin.logos.light.byteLength > MAX_CATALOG_IMAGE_BYTES) {
      throw new Error(`light logo exceeds MAX_CATALOG_IMAGE_BYTES for ${entry.pluginId}.`);
    }
    if (plugin.logos.dark.byteLength > MAX_CATALOG_IMAGE_BYTES) {
      throw new Error(`dark logo exceeds MAX_CATALOG_IMAGE_BYTES for ${entry.pluginId}.`);
    }

    compiledPlugins.push({
      pluginId: entry.pluginId,
      displayName: entry.displayName,
      tagline: entry.tagline,
      featuredOrder: entry.featuredOrder,
      documentation,
      branding: {
        light: {
          ...addFile(files, `assets/${entry.pluginId}/logo-light${extensionFor(entry.branding.logoLight.mediaType)}`, Buffer.from(plugin.logos.light)),
          mediaType: entry.branding.logoLight.mediaType,
        },
        dark: {
          ...addFile(files, `assets/${entry.pluginId}/logo-dark${extensionFor(entry.branding.logoDark.mediaType)}`, Buffer.from(plugin.logos.dark)),
          mediaType: entry.branding.logoDark.mediaType,
        },
      },
      stable: {
        pluginVersion: entry.channels.stable.pluginVersion,
        protocolRange: projection.protocolRange,
        processScope: projection.processScope,
        runtime: projection.runtime,
        ...(entry.channels.stable.manifest ? { manifest: entry.channels.stable.manifest } : {}),
        artifacts,
        ...(entry.channels.stable.combination ? { combination: entry.channels.stable.combination } : {}),
      },
    });
  }

  const index = catalogIndexV1Schema.parse({
    schemaVersion: CATALOG_SCHEMA_VERSION,
    sourceId: input.sourceId,
    sequence: input.sequence,
    issuedAt: input.issuedAt,
    plugins: compiledPlugins,
  });
  const indexUtf8 = stableStringify(index);
  const indexBytes = Buffer.from(indexUtf8, 'utf8');
  if (indexBytes.byteLength > MAX_CATALOG_INDEX_BYTES) {
    throw new Error('Compiled Catalog index exceeds MAX_CATALOG_INDEX_BYTES.');
  }
  addFile(files, CATALOG_INDEX_FILE, indexBytes);

  const assetManifest = catalogAssetManifestV1Schema.parse({
    schemaVersion: CATALOG_SCHEMA_VERSION,
    files: [...files.entries()]
      .map(([path, bytes]) => ({
        path,
        sha256: sha256Hex(bytes),
        size: bytes.byteLength,
      }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  });
  const assetManifestUtf8 = stableStringify(assetManifest);
  const envelope = signCatalogAssetManifest(assetManifestUtf8, input.signingKey);
  files.set(CATALOG_ASSET_MANIFEST_FILE, Buffer.from(assetManifestUtf8, 'utf8'));
  files.set(CATALOG_SIGNATURE_FILE, Buffer.from(stableStringify(envelope), 'utf8'));

  return {
    files,
    index,
    assetManifest,
    envelope,
    assetManifestUtf8,
  };
}

function extensionFor(mediaType: 'image/png' | 'image/webp'): string {
  return mediaType === 'image/webp' ? '.webp' : '.png';
}
