import { createHash } from 'node:crypto';

import {
  parseGitHubReleaseAssetUrl,
  type DownloadAsset,
} from '@gian/proxy-catalog-contract';

import { PluginStoreError } from './errors.js';
import type { PluginArtifactNetwork } from './types.js';

export async function downloadVerifiedAsset(
  network: PluginArtifactNetwork,
  asset: DownloadAsset,
  allowedRepositories: readonly string[],
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  const coordinate = parseGitHubReleaseAssetUrl(asset.url, allowedRepositories);
  if (!coordinate) {
    throw new PluginStoreError('PLUGIN_URL_REJECTED', 'Package URL is not an approved GitHub release asset.');
  }
  if (asset.size > maxBytes) {
    throw new PluginStoreError('PLUGIN_ARCHIVE_SIZE', 'Declared package size exceeds the Host limit.');
  }
  const bytes = await network.download({
    repository: coordinate.repository,
    tag: coordinate.tag,
    asset: coordinate.asset,
    maxBytes,
    signal,
  });
  if (bytes.byteLength !== asset.size) {
    throw new PluginStoreError('PLUGIN_DIGEST', 'Downloaded package size does not match the Catalog coordinate.');
  }
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== asset.sha256) {
    throw new PluginStoreError('PLUGIN_DIGEST', 'Downloaded package digest does not match the Catalog coordinate.');
  }
  return bytes;
}
