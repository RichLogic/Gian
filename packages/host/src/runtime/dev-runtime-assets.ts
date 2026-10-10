import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';

import { officialCatalogSourcePolicy } from '@gian/shared';

import type { DevRuntimeCoordinate } from './dev-runtime-coordinates.js';
import { downloadManagedRuntimeAsset, MAX_MANAGED_RUNTIME_DOWNLOAD_BYTES } from './download.js';

export async function downloadDevRuntimeAsset(
  asset: DevRuntimeCoordinate['asset'], signal?: AbortSignal,
): Promise<Buffer> {
  if (!asset.url) throw new Error('This source-built GianDev Runtime requires bundled CLI assets.');
  return downloadManagedRuntimeAsset({ ...asset, url: asset.url },
    officialCatalogSourcePolicy().runtimeAssetPrefixes ?? [], signal);
}

function assetPath(directory: string, asset: DevRuntimeCoordinate['asset']): string {
  if (!/^[a-f0-9]{64}$/.test(asset.sha256) || !Number.isSafeInteger(asset.size)
    || asset.size <= 0 || asset.size > MAX_MANAGED_RUNTIME_DOWNLOAD_BYTES) {
    throw new Error('Invalid bundled Dev Runtime coordinate.');
  }
  return join(directory, `${asset.sha256}.gz`);
}

export async function readBundledDevRuntimeAsset(
  directory: string,
  asset: DevRuntimeCoordinate['asset'],
): Promise<Buffer> {
  const path = assetPath(directory, asset);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_MANAGED_RUNTIME_DOWNLOAD_BYTES + 1024 * 1024) {
    throw new Error('Bundled Dev Runtime asset is not a bounded regular file.');
  }
  const bytes = gunzipSync(await readFile(path), { maxOutputLength: asset.size + 1 });
  if (bytes.length !== asset.size || createHash('sha256').update(bytes).digest('hex') !== asset.sha256) {
    throw new Error('Bundled Dev Runtime asset does not match its pinned bytes.');
  }
  return bytes;
}

export async function prepareDevRuntimeAssets(input: {
  directory: string;
  coordinates: readonly DevRuntimeCoordinate[];
  download?: (asset: DevRuntimeCoordinate['asset']) => Promise<Buffer>;
}): Promise<void> {
  await mkdir(input.directory, { recursive: true, mode: 0o700 });
  for (const coordinate of input.coordinates) {
    const path = assetPath(input.directory, coordinate.asset);
    try {
      await readBundledDevRuntimeAsset(input.directory, coordinate.asset);
      continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    console.log(`[gian-dev] preparing ${coordinate.runtimeId} ${coordinate.version}`);
    let bytes: Buffer | undefined;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        bytes = input.download
          ? await input.download(coordinate.asset)
          : await downloadDevRuntimeAsset(coordinate.asset, AbortSignal.timeout(180_000));
        break;
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (attempt === 3 || (code && code !== 'RUNTIME_DOWNLOAD_FAILED')) throw error;
        await new Promise(resolve => setTimeout(resolve, attempt * 1000));
      }
    }
    if (!bytes || bytes.length !== coordinate.asset.size
      || createHash('sha256').update(bytes).digest('hex') !== coordinate.asset.sha256) {
      throw new Error(`${coordinate.runtimeId} downloaded bytes do not match the pinned coordinate.`);
    }
    // The envelope prevents package signing from rewriting original Mach-O bytes.
    await writeFile(path, gzipSync(bytes), { mode: 0o600, flag: 'wx' });
    await readBundledDevRuntimeAsset(input.directory, coordinate.asset);
  }
}
