import { isApprovedRedirectUrl, isApprovedRuntimeAssetUrl } from '@gian/proxy-catalog-contract';
import type { DownloadAsset } from '@gian/proxy-catalog-contract';

import { ManagedRuntimeInstallError } from './errors.js';

export const MAX_MANAGED_RUNTIME_DOWNLOAD_BYTES = 512 * 1024 * 1024;
const MAX_REDIRECTS = 5;

function sameOriginHttps(value: string, initial: URL): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && url.origin === initial.origin
      && !url.username
      && !url.password
      && !url.port;
  } catch {
    return false;
  }
}

function downloadError(code: string, message: string): ManagedRuntimeInstallError {
  return new ManagedRuntimeInstallError(code, message);
}

/** Download one signed-Catalog Runtime coordinate without credentials.
 * The initial URL must match an App-pinned vendor prefix. Redirects stay on
 * that origin or on GitHub's fixed release-asset hosts; the caller still
 * verifies the exact Catalog SHA-256 before staging or execution. */
export async function downloadManagedRuntimeAsset(
  asset: DownloadAsset,
  allowedPrefixes: readonly string[],
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
  onProgress?: (receivedBytes: number, totalBytes: number) => void,
): Promise<Buffer> {
  if (!isApprovedRuntimeAssetUrl(asset.url, allowedPrefixes)) {
    throw downloadError('RUNTIME_SOURCE_FORBIDDEN', 'Runtime asset URL is outside the App-pinned official channels.');
  }
  if (!Number.isSafeInteger(asset.size)
    || asset.size <= 0
    || asset.size > MAX_MANAGED_RUNTIME_DOWNLOAD_BYTES) {
    throw downloadError('RUNTIME_SIZE_MISMATCH', 'Runtime asset size is outside the download limit.');
  }
  const initial = new URL(asset.url);
  let current = asset.url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    signal?.throwIfAborted();
    if (hop > 0 && !sameOriginHttps(current, initial) && !isApprovedRedirectUrl(current)) {
      throw downloadError('RUNTIME_SOURCE_FORBIDDEN', 'Runtime download redirected outside approved hosts.');
    }
    const response = await fetchImpl(current, {
      redirect: 'manual',
      headers: {
        accept: 'application/octet-stream',
        'user-agent': 'Gian',
      },
      ...(signal ? { signal } : {}),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => undefined);
      if (!location) {
        throw downloadError('RUNTIME_DOWNLOAD_FAILED', 'Runtime download redirect has no location.');
      }
      current = new URL(location, current).href;
      continue;
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      throw downloadError('RUNTIME_DOWNLOAD_FAILED', `Runtime download failed (${response.status}).`);
    }
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > 0 && declared !== asset.size) {
      await response.body.cancel().catch(() => undefined);
      throw downloadError('RUNTIME_SIZE_MISMATCH', 'Runtime response size differs from the Catalog coordinate.');
    }
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let received = 0;
    let reported = 0;
    while (true) {
      signal?.throwIfAborted();
      const result = await reader.read();
      if (result.done) break;
      const chunk = Buffer.from(result.value);
      received += chunk.length;
      if (received > asset.size || received > MAX_MANAGED_RUNTIME_DOWNLOAD_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw downloadError('RUNTIME_SIZE_MISMATCH', 'Runtime response exceeded the Catalog size.');
      }
      chunks.push(chunk);
      if (received === asset.size || received - reported >= 1024 * 1024) {
        reported = received;
        try {
          onProgress?.(received, asset.size);
        } catch {
          // A disconnected progress consumer must never abort an authorized
          // installation that the Host has already started.
        }
      }
    }
    if (received !== asset.size) {
      throw downloadError('RUNTIME_SIZE_MISMATCH', 'Runtime response size differs from the Catalog coordinate.');
    }
    return Buffer.concat(chunks, received);
  }
  throw downloadError('RUNTIME_DOWNLOAD_FAILED', 'Runtime download exceeded the redirect limit.');
}
