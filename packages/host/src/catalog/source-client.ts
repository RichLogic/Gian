import {
  CATALOG_ASSET_MANIFEST_FILE,
  CATALOG_SIGNATURE_FILE,
  MAX_CATALOG_BUNDLE_BYTES,
  MAX_CATALOG_INDEX_BYTES,
  catalogAssetManifestV1Schema,
  parseCatalogReleaseSequence,
  verifyCatalogAssetManifestWithPinnedKeys,
  verifyCatalogBundleFiles,
} from '@gian/proxy-catalog-contract';
import type { OfficialCatalogSourcePolicy } from '@gian/shared';

import { assertReleaseCoordinate } from './release-metadata.js';
import { CatalogIngestBusyError, CatalogStore } from './store.js';
import {
  DEFAULT_CATALOG_PER_REQUEST_MS,
  DEFAULT_CATALOG_TOTAL_BUDGET_MS,
} from './timeouts.js';
import type { CatalogLatestRelease, CatalogNetwork, CatalogSnapshot } from './types.js';

const MAX_SIGNATURE_BYTES = 8 * 1024;
const MAX_ASSET_MANIFEST_BYTES = 256 * 1024;
const DEFAULT_DOWNLOAD_CONCURRENCY = 4;
const MAX_TOTAL_BUDGET_MS = 10 * 60_000;
const MAX_PER_REQUEST_MS = 60_000;
const MAX_DOWNLOAD_CONCURRENCY = 32;

export class CatalogSourceClient {
  private readonly totalBudgetMs: number;
  private readonly perRequestMs: number;
  private readonly downloadConcurrency: number;

  constructor(
    private readonly options: {
      store: CatalogStore;
      network: CatalogNetwork;
      policy: OfficialCatalogSourcePolicy;
      totalBudgetMs?: number;
      perRequestMs?: number;
      downloadConcurrency?: number;
    },
  ) {
    this.totalBudgetMs = boundedPositiveInt(
      options.totalBudgetMs,
      DEFAULT_CATALOG_TOTAL_BUDGET_MS,
      MAX_TOTAL_BUDGET_MS,
      'totalBudgetMs',
    );
    this.perRequestMs = boundedPositiveInt(
      options.perRequestMs,
      DEFAULT_CATALOG_PER_REQUEST_MS,
      MAX_PER_REQUEST_MS,
      'perRequestMs',
    );
    this.downloadConcurrency = boundedPositiveInt(
      options.downloadConcurrency,
      DEFAULT_DOWNLOAD_CONCURRENCY,
      MAX_DOWNLOAD_CONCURRENCY,
      'downloadConcurrency',
    );
  }

  async sync(signal?: AbortSignal): Promise<CatalogSnapshot> {
    const owned = new AbortController();
    const totalBudget = AbortSignal.timeout(this.totalBudgetMs);
    const parent = signal
      ? AbortSignal.any([signal, totalBudget, owned.signal])
      : AbortSignal.any([totalBudget, owned.signal]);
    const current = await this.options.store.open();
    const abortOwned = (): void => {
      if (!owned.signal.aborted) owned.abort();
    };
    try {
      throwIfAborted(parent);
      let latest = await this.options.network.latest({
        ifNoneMatch: current.index && current.etag ? current.etag : undefined,
        signal: this.requestSignal(parent),
      });
      if (latest.status === 304) {
        if (current.index && current.etag) {
          return { ...current, state: 'ready', error: null };
        }
        latest = await this.options.network.latest({ signal: this.requestSignal(parent) });
        if (latest.status === 304) {
          throw Object.assign(new Error('Catalog 304 had no valid matching cached generation.'), {
            code: 'CATALOG_CACHE_MISS',
          });
        }
      }
      throwIfAborted(parent);
      const release = latest.release;
      assertReleaseCoordinate(release);
      const files = new Map<string, Buffer>();
      files.set(
        CATALOG_ASSET_MANIFEST_FILE,
        await this.options.network.download({
          tag: release.tag,
          asset: CATALOG_ASSET_MANIFEST_FILE,
          maxBytes: MAX_ASSET_MANIFEST_BYTES,
          signal: this.requestSignal(parent),
        }),
      );
      files.set(
        CATALOG_SIGNATURE_FILE,
        await this.options.network.download({
          tag: release.tag,
          asset: CATALOG_SIGNATURE_FILE,
          maxBytes: MAX_SIGNATURE_BYTES,
          signal: this.requestSignal(parent),
        }),
      );
      let envelope: unknown;
      try {
        envelope = JSON.parse(files.get(CATALOG_SIGNATURE_FILE)!.toString('utf8'));
      } catch {
        throw new Error('Catalog signature envelope is not valid JSON.');
      }
      if (!verifyCatalogAssetManifestWithPinnedKeys({
        pinnedPublicKeys: this.options.policy.pinnedPublicKeys,
        assetManifestUtf8: files.get(CATALOG_ASSET_MANIFEST_FILE)!,
        envelope,
      })) {
        throw Object.assign(new Error('Catalog signature verification failed.'), {
          code: 'CATALOG_SIGNATURE_INVALID',
        });
      }
      const manifest = catalogAssetManifestV1Schema.parse(
        JSON.parse(files.get(CATALOG_ASSET_MANIFEST_FILE)!.toString('utf8')),
      );
      const payloads = await mapPool(
        manifest.files,
        this.downloadConcurrency,
        async (file) => {
          throwIfAborted(parent);
          const maxBytes = Math.min(file.size, file.path === 'catalog-v1.json'
            ? MAX_CATALOG_INDEX_BYTES
            : MAX_CATALOG_BUNDLE_BYTES);
          const bytes = await this.options.network.download({
            tag: release.tag,
            asset: file.path,
            maxBytes,
            signal: this.requestSignal(parent),
          });
          if (bytes.byteLength !== file.size) {
            throw new Error(`Catalog payload size mismatch for ${file.path}.`);
          }
          return { path: file.path, bytes };
        },
        abortOwned,
      );
      for (const payload of payloads) {
        files.set(payload.path, payload.bytes);
      }
      assertSignedIndexMatchesRelease(files, release, this.options.policy);
      return await this.options.store.ingest(files, release.etag);
    } catch (error) {
      abortOwned();
      if (error instanceof CatalogIngestBusyError) {
        return this.options.store.markError({
          code: error.code,
          message: error.message,
        });
      }
      const code = error && typeof error === 'object' && 'code' in error
        && typeof error.code === 'string'
        ? error.code
        : 'CATALOG_SYNC_FAILED';
      return this.options.store.markError({
        code,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private requestSignal(parent: AbortSignal): AbortSignal {
    return AbortSignal.any([
      parent,
      AbortSignal.timeout(this.perRequestMs),
    ]);
  }
}

function assertSignedIndexMatchesRelease(
  files: Map<string, Buffer>,
  release: CatalogLatestRelease,
  policy: OfficialCatalogSourcePolicy,
): void {
  const index = verifyCatalogBundleFiles({
    files,
    pinnedPublicKeys: policy.pinnedPublicKeys,
    expectedSourceId: policy.sourceId,
  });
  const tagSequence = parseCatalogReleaseSequence(release.tag);
  if (
    tagSequence === null
    || index.sequence !== tagSequence
    || index.sequence !== release.sequence
  ) {
    throw Object.assign(
      new Error('Catalog signed index sequence does not match the Release coordinate.'),
      { code: 'CATALOG_SEQUENCE_MISMATCH' },
    );
  }
}

function boundedPositiveInt(
  value: number | undefined,
  fallback: number,
  max: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > max) {
    throw new Error(`Catalog ${name} must be a bounded positive safe integer.`);
  }
  return resolved;
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException('This operation was aborted', 'AbortError');
}

async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
  onFailure: () => void,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  let next = 0;
  let firstError: unknown;
  const run = async (): Promise<void> => {
    while (true) {
      if (firstError) return;
      const index = next;
      next += 1;
      if (index >= items.length) return;
      try {
        results[index] = await worker(items[index]!);
      } catch (error) {
        if (!firstError) {
          firstError = error;
          onFailure();
        }
        return;
      }
    }
  };
  await Promise.allSettled(Array.from(
    { length: Math.min(Math.max(1, concurrency), items.length) },
    () => run(),
  ));
  if (firstError) throw firstError;
  return results;
}
