import { createHash } from 'node:crypto';

import {
  CATALOG_ASSET_MANIFEST_FILE,
  CATALOG_INDEX_FILE,
  CATALOG_SIGNATURE_FILE,
} from './constants.js';
import {
  catalogAssetManifestV1Schema,
  catalogIndexV1Schema,
  catalogSignatureEnvelopeV1Schema,
  type CatalogIndexV1,
} from './schemas.js';
import { verifyCatalogAssetManifestWithPinnedKeys } from './verify.js';

export interface CatalogBundleFiles {
  get(path: string): Buffer | undefined;
  keys(): IterableIterator<string> | string[];
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function asMap(files: Map<string, Buffer> | Readonly<Record<string, Buffer>>): Map<string, Buffer> {
  return files instanceof Map ? files : new Map(Object.entries(files));
}

/**
 * Reverify signature, asset inventory, sizes, hashes, and index Schema.
 * Extra undeclared payloads and missing declared payloads fail closed.
 */
export function verifyCatalogBundleFiles(input: {
  files: Map<string, Buffer> | Readonly<Record<string, Buffer>>;
  pinnedPublicKeys: Readonly<Record<string, string | Uint8Array>>;
  expectedSourceId?: string;
}): CatalogIndexV1 {
  const files = asMap(input.files);
  const manifestBytes = files.get(CATALOG_ASSET_MANIFEST_FILE);
  const signatureBytes = files.get(CATALOG_SIGNATURE_FILE);
  if (!manifestBytes || !signatureBytes) {
    throw new Error('Catalog bundle is missing the asset manifest or signature.');
  }

  let envelope: unknown;
  try {
    envelope = JSON.parse(signatureBytes.toString('utf8'));
  } catch {
    throw new Error('Catalog signature envelope is not valid JSON.');
  }
  catalogSignatureEnvelopeV1Schema.parse(envelope);
  if (!verifyCatalogAssetManifestWithPinnedKeys({
    pinnedPublicKeys: input.pinnedPublicKeys,
    assetManifestUtf8: manifestBytes,
    envelope,
  })) {
    throw new Error('Catalog signature verification failed.');
  }

  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    throw new Error('Catalog asset manifest is not valid JSON.');
  }
  const manifest = catalogAssetManifestV1Schema.parse(manifestJson);

  const payloadPaths = new Set(manifest.files.map((file) => file.path));
  for (const path of files.keys()) {
    if (path === CATALOG_ASSET_MANIFEST_FILE || path === CATALOG_SIGNATURE_FILE) continue;
    if (!payloadPaths.has(path)) {
      throw new Error(`Catalog bundle contains undeclared payload ${path}.`);
    }
  }
  for (const file of manifest.files) {
    const bytes = files.get(file.path);
    if (!bytes) throw new Error(`Catalog bundle is missing payload ${file.path}.`);
    if (bytes.byteLength !== file.size) {
      throw new Error(`Catalog payload size mismatch for ${file.path}.`);
    }
    if (sha256Hex(bytes) !== file.sha256) {
      throw new Error(`Catalog payload digest mismatch for ${file.path}.`);
    }
  }

  const indexBytes = files.get(CATALOG_INDEX_FILE);
  if (!indexBytes) throw new Error('Catalog bundle is missing catalog-v1.json.');
  let indexJson: unknown;
  try {
    indexJson = JSON.parse(indexBytes.toString('utf8'));
  } catch {
    throw new Error('Catalog index is not valid JSON.');
  }
  const index = catalogIndexV1Schema.parse(indexJson);
  if (input.expectedSourceId && index.sourceId !== input.expectedSourceId) {
    throw new Error(`Catalog sourceId ${index.sourceId} is not ${input.expectedSourceId}.`);
  }
  return index;
}
