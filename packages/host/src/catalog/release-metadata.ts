import {
  CATALOG_RELEASE_TAG_PATTERN,
  MAX_CATALOG_ASSET_FILE_COUNT,
  MAX_CATALOG_BUNDLE_BYTES,
  MAX_CATALOG_PATH_CHARS,
  isCanonicalRelativePath,
  parseCatalogReleaseSequence,
} from '@gian/proxy-catalog-contract';

import { MAX_ANONYMOUS_ETAG_CHARS } from './bounded-body.js';
import type { CatalogLatestRelease, CatalogReleaseAsset } from './types.js';

const RELEASE_KEYS = ['tag', 'sequence', 'assets'] as const;
const RELEASE_KEYS_WITH_ETAG = ['tag', 'sequence', 'assets', 'etag'] as const;

export function parseCatalogLatestRelease(
  value: unknown,
  headerEtag?: string,
): CatalogLatestRelease {
  if (!isRecord(value)) {
    throw new Error('Catalog latest lookup returned an invalid release.');
  }
  const keys = Object.keys(value);
  const allowed = keys.includes('etag') ? RELEASE_KEYS_WITH_ETAG : RELEASE_KEYS;
  if (keys.length !== allowed.length || allowed.some((key) => !keys.includes(key))) {
    throw new Error('Catalog latest lookup returned an invalid release.');
  }
  if (typeof value.tag !== 'string' || value.tag.length > 64 || !CATALOG_RELEASE_TAG_PATTERN.test(value.tag)) {
    throw new Error('Catalog latest lookup returned an invalid release.');
  }
  const tagSequence = parseCatalogReleaseSequence(value.tag);
  if (
    tagSequence === null
    || !Number.isSafeInteger(value.sequence)
    || value.sequence !== tagSequence
  ) {
    throw new Error('Catalog latest lookup sequence does not match the Release tag.');
  }
  if (!Array.isArray(value.assets) || value.assets.length > MAX_CATALOG_ASSET_FILE_COUNT) {
    throw new Error('Catalog latest lookup exceeded the asset bound.');
  }
  const assets: CatalogReleaseAsset[] = [];
  const seenNames = new Set<string>();
  for (const asset of value.assets) {
    const parsed = parseCatalogReleaseAsset(asset);
    if (!parsed) throw new Error('Catalog latest lookup returned an invalid asset.');
    if (seenNames.has(parsed.name)) {
      throw new Error('Catalog latest lookup returned an invalid asset.');
    }
    seenNames.add(parsed.name);
    assets.push(parsed);
  }
  const etag = typeof value.etag === 'string' ? value.etag : headerEtag;
  if (etag !== undefined) assertBoundedEtag(etag);
  return { tag: value.tag, sequence: tagSequence, assets, ...(etag ? { etag } : {}) };
}

const ASSET_KEYS = ['name', 'size'] as const;

export function parseCatalogReleaseAsset(asset: unknown): CatalogReleaseAsset | null {
  if (!isRecord(asset)) return null;
  const keys = Object.keys(asset);
  if (keys.length !== ASSET_KEYS.length || ASSET_KEYS.some((key) => !keys.includes(key))) {
    return null;
  }
  if (typeof asset.name !== 'string' || typeof asset.size !== 'number') {
    return null;
  }
  if (!Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > MAX_CATALOG_BUNDLE_BYTES) {
    return null;
  }
  if (
    asset.name.length === 0
    || asset.name.length > MAX_CATALOG_PATH_CHARS
    || !isCanonicalRelativePath(asset.name)
  ) {
    return null;
  }
  return { name: asset.name, size: asset.size };
}

export function assertBoundedEtag(etag: string): void {
  if (etag.length > MAX_ANONYMOUS_ETAG_CHARS || etag.includes('\0') || /[\r\n]/.test(etag)) {
    throw new Error('Catalog ETag is invalid.');
  }
}

export function assertReleaseCoordinate(release: CatalogLatestRelease): void {
  const tagSequence = parseCatalogReleaseSequence(release.tag);
  if (tagSequence === null || tagSequence !== release.sequence) {
    throw Object.assign(
      new Error('Catalog Release tag sequence does not match metadata sequence.'),
      { code: 'CATALOG_SEQUENCE_MISMATCH' },
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
