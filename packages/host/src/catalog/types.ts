import type { CatalogIndexV1 } from '@gian/proxy-catalog-contract';

export type CatalogFreshness = 'empty' | 'ready' | 'stale' | 'error';

export interface CatalogErrorState {
  code: string;
  message: string;
}

export interface CatalogSnapshot {
  index: CatalogIndexV1 | null;
  sequence: number | null;
  files: Map<string, Buffer> | null;
  state: CatalogFreshness;
  etag: string | null;
  error: CatalogErrorState | null;
}

export interface CatalogReleaseAsset {
  name: string;
  size: number;
}

export interface CatalogLatestRelease {
  tag: string;
  sequence: number;
  etag?: string;
  assets: CatalogReleaseAsset[];
}

export interface CatalogNetwork {
  latest(input: {
    ifNoneMatch?: string;
    signal?: AbortSignal;
  }): Promise<{ status: 200; release: CatalogLatestRelease } | { status: 304; etag?: string }>;
  download(input: {
    tag: string;
    asset: string;
    maxBytes: number;
    signal?: AbortSignal;
  }): Promise<Buffer>;
}
