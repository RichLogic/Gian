import { createHash } from 'node:crypto';

import { manifestSchema, type ManifestV4 } from '@gian/proxy-protocol';
import { isProxyPluginId } from '@gian/shared';

import { PluginStoreError } from './errors.js';
import { MAX_PLUGIN_FILE_BYTES, MAX_PLUGIN_MANIFEST_BYTES } from './limits.js';
import {
  assertCanonicalRelativePath,
  assertContainedSkill,
  readContainedLogo,
  readContainedRegularFile,
  readPackageInventory,
} from './containment.js';
import { PLUGIN_INSTALL_RECEIPT_FILE } from './receipt.js';

const DANGEROUS_PATH = /(^|\/)(?:\.git|node_modules)(?:\/|$)|[.](?:node|dylib|so|dll|exe)$/i;

export interface CatalogPackageProjection {
  pluginId: string;
  pluginVersion: string;
  protocolRange: string;
  processScope: 'shared' | 'session';
  runtime: ManifestV4['runtime'] | null;
}

export async function validateCatalogPackage(
  directory: string,
  expected: CatalogPackageProjection,
): Promise<{ manifest: ManifestV4; manifestSha256: string }> {
  const raw = await readContainedRegularFile(directory, 'manifest.json', MAX_PLUGIN_MANIFEST_BYTES);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new PluginStoreError('PLUGIN_MANIFEST_INVALID', 'Package manifest is not valid JSON.');
  }
  const result = manifestSchema.safeParse(parsed);
  if (!result.success || result.data.schemaVersion !== 4) {
    throw new PluginStoreError('PLUGIN_MANIFEST_INVALID', 'Package manifest must be Manifest v4.');
  }
  const manifest = result.data;
  if (!isProxyPluginId(manifest.id) || manifest.id !== expected.pluginId) {
    throw new PluginStoreError('PLUGIN_MANIFEST_IDENTITY', 'Package manifest id does not match Catalog.');
  }
  if (manifest.pluginVersion !== expected.pluginVersion) {
    throw new PluginStoreError(
      'PLUGIN_MANIFEST_VERSION',
      'Package manifest version does not match Catalog.',
    );
  }
  if (manifest.protocol.range !== expected.protocolRange) {
    throw new PluginStoreError(
      'PLUGIN_MANIFEST_RANGE',
      'Package manifest protocol range does not match Catalog.',
    );
  }
  if (manifest.process.scope !== expected.processScope) {
    throw new PluginStoreError(
      'PLUGIN_MANIFEST_SCOPE',
      'Package manifest process scope does not match Catalog.',
    );
  }
  if (expected.runtime && JSON.stringify(manifest.runtime) !== JSON.stringify(expected.runtime)) {
    throw new PluginStoreError(
      'PLUGIN_MANIFEST_RUNTIME',
      'Package manifest runtime does not match Catalog.',
    );
  }
  assertCanonicalRelativePath(manifest.entry, 'entry');
  await readContainedRegularFile(directory, manifest.entry, MAX_PLUGIN_FILE_BYTES);
  await readContainedLogo(directory, manifest.branding.logo.light);
  if (manifest.branding.logo.dark) {
    await readContainedLogo(directory, manifest.branding.logo.dark);
  }
  for (const skill of manifest.skills ?? []) {
    await assertContainedSkill(directory, skill);
  }

  const inventory = await readPackageInventory(directory);
  for (const path of inventory.keys()) {
    if (path === PLUGIN_INSTALL_RECEIPT_FILE) continue;
    if (DANGEROUS_PATH.test(path)) {
      throw new PluginStoreError('PLUGIN_PATH_DANGEROUS', `Undeclared dangerous package path: ${path}`);
    }
  }
  return {
    manifest,
    manifestSha256: createHash('sha256').update(raw).digest('hex'),
  };
}
