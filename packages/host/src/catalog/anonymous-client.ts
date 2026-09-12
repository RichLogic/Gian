import {
  MAX_CATALOG_ASSET_FILE_COUNT,
  MAX_CATALOG_BUNDLE_BYTES,
  MAX_CATALOG_PATH_CHARS,
  isApprovedRedirectUrl,
  isCanonicalRelativePath,
  parseCatalogReleaseSequence,
} from '@gian/proxy-catalog-contract';
import type { OfficialCatalogSourcePolicy } from '@gian/shared';

import {
  MAX_ANONYMOUS_METADATA_BYTES,
  MAX_ANONYMOUS_RELEASES,
  readBoundedResponseBody,
} from './bounded-body.js';
import { assertBoundedEtag } from './release-metadata.js';
import type { CatalogLatestRelease, CatalogNetwork, CatalogReleaseAsset } from './types.js';

const API_VERSION = '2022-11-28';
const USER_AGENT = 'Gian';
const MAX_REDIRECTS = 5;
const REPOSITORY_PATTERN = /^[0-9A-Za-z_.-]+\/[0-9A-Za-z_.-]+$/;

export function encodeGitHubCatalogAssetName(path: string): string {
  return path.replaceAll('/', '__');
}

export function createCatalogAnonymousNetwork(options: {
  policy: OfficialCatalogSourcePolicy;
  fetchImpl?: typeof fetch;
}): CatalogNetwork {
  const repository = options.policy.repository.trim();
  if (!REPOSITORY_PATTERN.test(repository) || repository.includes('..')) {
    throw new Error('Catalog anonymous network repository is invalid.');
  }
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async latest(input) {
      const url = `https://api.github.com/repos/${repository}/releases?per_page=100`;
      const headers = anonymousHeaders();
      if (input.ifNoneMatch) headers.set('if-none-match', input.ifNoneMatch);
      const response = await fetchImpl(url, {
        headers,
        redirect: 'error',
        ...(input.signal ? { signal: input.signal } : {}),
      });
      try {
        const etag = headerEtag(response);
        if (response.status === 304) {
          await cancelQuietly(response);
          return { status: 304, ...(etag ? { etag } : {}) };
        }
        if (!response.ok) {
          await cancelQuietly(response);
          throw new Error(`Catalog anonymous latest lookup failed (${response.status}).`);
        }
        const body = await readBoundedResponseBody(response, MAX_ANONYMOUS_METADATA_BYTES);
        let parsed: unknown;
        try {
          parsed = JSON.parse(body.toString('utf8'));
        } catch {
          throw new Error('Catalog anonymous latest lookup returned invalid JSON.');
        }
        if (!Array.isArray(parsed)) {
          throw new Error('Catalog anonymous latest lookup returned an invalid release list.');
        }
        if (parsed.length > MAX_ANONYMOUS_RELEASES) {
          throw new Error('Catalog anonymous latest lookup exceeded the release bound.');
        }
        const tagged: { item: unknown; sequence: number }[] = [];
        for (const item of parsed) {
          const sequence = catalogTagSequence(item);
          if (sequence !== null) tagged.push({ item, sequence });
        }
        if (tagged.length === 0) {
          throw Object.assign(new Error('Catalog anonymous latest lookup found no catalog-v1 release.'), {
            code: 'CATALOG_RELEASE_NOT_FOUND',
          });
        }
        tagged.sort((left, right) => right.sequence - left.sequence);
        const release = parseAnonymousRelease(tagged[0]!.item, etag);
        if (!release) {
          throw new Error('Catalog anonymous highest release metadata is invalid.');
        }
        return { status: 200, release };
      } catch (error) {
        await cancelQuietly(response);
        throw error;
      }
    },

    async download(input) {
      if (!isCanonicalRelativePath(input.asset)) {
        throw new Error('Catalog asset path is not canonical.');
      }
      const encoded = encodeURIComponent(encodeGitHubCatalogAssetName(input.asset));
      const url = `https://github.com/${repository}/releases/download/${encodeURIComponent(input.tag)}/${encoded}`;
      const response = await fetchApprovedAsset(fetchImpl, url, input.signal);
      if (!response.ok) {
        await cancelQuietly(response);
        throw new Error(`Catalog anonymous asset download failed (${response.status}): ${input.asset}`);
      }
      const bytes = await readBoundedResponseBody(response, input.maxBytes);
      if (bytes.length === 0 || bytes.length > input.maxBytes) {
        throw new Error(`Catalog asset size is invalid: ${input.asset}`);
      }
      return bytes;
    },
  };
}

function catalogTagSequence(item: unknown): number | null {
  if (!isRecord(item) || typeof item.tag_name !== 'string') return null;
  if (item.tag_name.length > 64) return null;
  return parseCatalogReleaseSequence(item.tag_name);
}

function parseAnonymousRelease(item: unknown, etag?: string): CatalogLatestRelease | null {
  const sequence = catalogTagSequence(item);
  if (sequence === null || !isRecord(item) || typeof item.tag_name !== 'string') return null;
  if (!Array.isArray(item.assets)) return null;
  if (item.assets.length > MAX_CATALOG_ASSET_FILE_COUNT) {
    throw new Error('Catalog anonymous latest lookup exceeded the asset bound.');
  }
  const assets: CatalogReleaseAsset[] = [];
  for (const asset of item.assets) {
    const parsed = parseAnonymousAsset(asset);
    if (!parsed) return null;
    assets.push(parsed);
  }
  return { tag: item.tag_name, sequence, assets, ...(etag ? { etag } : {}) };
}

function parseAnonymousAsset(asset: unknown): CatalogReleaseAsset | null {
  if (!isRecord(asset) || typeof asset.name !== 'string' || typeof asset.size !== 'number') {
    return null;
  }
  if (!Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > MAX_CATALOG_BUNDLE_BYTES) {
    return null;
  }
  const name = decodeGitHubCatalogAssetName(asset.name);
  if (
    name.length === 0
    || name.length > MAX_CATALOG_PATH_CHARS
    || !isCanonicalRelativePath(name)
  ) {
    return null;
  }
  return { name, size: asset.size };
}

function decodeGitHubCatalogAssetName(name: string): string {
  return name.replaceAll('__', '/');
}

function anonymousHeaders(): Headers {
  return new Headers({
    accept: 'application/vnd.github+json',
    'user-agent': USER_AGENT,
    'x-github-api-version': API_VERSION,
  });
}

function headerEtag(response: Response): string | undefined {
  const etag = response.headers.get('etag');
  if (!etag) return undefined;
  assertBoundedEtag(etag);
  return etag;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function cancelQuietly(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    /* already cancelled */
  }
}

async function fetchApprovedAsset(
  fetchImpl: typeof fetch,
  url: string,
  signal?: AbortSignal,
): Promise<Response> {
  let current = url;
  for (let hop = 0; hop < MAX_REDIRECTS; hop += 1) {
    if (!isApprovedRedirectUrl(current) && !isApprovedGitHubDownloadUrl(current)) {
      throw new Error('Catalog anonymous download redirect is not allowed.');
    }
    const response = await fetchImpl(current, {
      redirect: 'manual',
      ...(signal ? { signal } : {}),
      headers: {
        accept: 'application/octet-stream',
        'user-agent': USER_AGENT,
      },
    });
    if (response.status >= 300 && response.status < 400) {
      await cancelQuietly(response);
      const location = response.headers.get('location');
      if (!location) throw new Error('Catalog anonymous download redirect is missing.');
      current = new URL(location, current).href;
      continue;
    }
    return response;
  }
  throw new Error('Catalog anonymous download exceeded redirect hops.');
}

function isApprovedGitHubDownloadUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && url.username === ''
      && url.password === ''
      && url.port === ''
      && url.hostname === 'github.com'
      && /\/releases\/download\//.test(url.pathname);
  } catch {
    return false;
  }
}
