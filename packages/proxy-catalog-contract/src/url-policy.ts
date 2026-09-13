import { isCanonicalRelativePath, isHttpsUrl } from './schemas.js';

export const APPROVED_CATALOG_DOWNLOAD_HOSTS = [
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
] as const;

export const CATALOG_RELEASE_TAG_PATTERN = /^catalog-v1\.([1-9]\d*)\.0$/;

const REPOSITORY_PATTERN = /^[0-9A-Za-z_.-]+\/[0-9A-Za-z_.-]+$/;
const RELEASE_DOWNLOAD = /^\/([^/]+)\/([^/]+)\/releases\/download\/([^/]+)\/(.+)$/;

export function parseCatalogReleaseSequence(tag: string): number | null {
  const match = CATALOG_RELEASE_TAG_PATTERN.exec(tag);
  if (!match) return null;
  const sequence = Number(match[1]);
  return Number.isSafeInteger(sequence) && sequence > 0 ? sequence : null;
}

export function catalogReleaseTag(sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error(`invalid Catalog sequence: ${sequence}`);
  }
  return `catalog-v1.${sequence}.0`;
}

export function isApprovedDownloadHost(hostname: string): boolean {
  return (APPROVED_CATALOG_DOWNLOAD_HOSTS as readonly string[]).includes(hostname);
}

export interface GitHubReleaseAssetCoordinate {
  repository: string;
  tag: string;
  asset: string;
}

export function parseGitHubReleaseAssetUrl(
  value: string,
  allowedRepositories: readonly string[],
): GitHubReleaseAssetCoordinate | null {
  if (!isHttpsUrl(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.hostname !== 'github.com' || url.port !== '' || url.username || url.password) {
    return null;
  }
  const match = RELEASE_DOWNLOAD.exec(url.pathname);
  if (!match) return null;
  const repository = `${decodeURIComponent(match[1]!)}/${decodeURIComponent(match[2]!)}`;
  const tag = decodeURIComponent(match[3]!);
  const asset = decodeURIComponent(match[4]!);
  if (
    !allowedRepositories.includes(repository)
    || !REPOSITORY_PATTERN.test(repository)
    || !isCanonicalRelativePath(asset)
    || tag.length === 0
    || tag.length > 255
    || /[\u0000-\u001f\u007f]/.test(tag)
  ) {
    return null;
  }
  return { repository, tag, asset };
}

export function isApprovedGitHubReleaseAssetUrl(
  value: string,
  allowedRepositories: readonly string[],
): boolean {
  return parseGitHubReleaseAssetUrl(value, allowedRepositories) !== null;
}

/** Runtime bytes may come from an official vendor channel rather than the
 * Gian Proxy repository. Prefixes are compile-time trust roots; the signed
 * Catalog still binds exact size and SHA-256. */
export function isApprovedRuntimeAssetUrl(
  value: string,
  allowedPrefixes: readonly string[],
): boolean {
  if (!isHttpsUrl(value)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.port || url.username || url.password || url.search || url.hash) return false;
  try {
    if (url.pathname.split('/').some(part => {
      const decoded = decodeURIComponent(part);
      return decoded === '.' || decoded === '..' || /[\u0000-\u001f\u007f]/.test(decoded);
    })) return false;
  } catch {
    return false;
  }
  return allowedPrefixes.some(prefix => {
    try {
      const root = new URL(prefix);
      return root.protocol === 'https:'
        && !root.port
        && !root.username
        && !root.password
        && !root.search
        && !root.hash
        && root.pathname.endsWith('/')
        && url.href.startsWith(root.href);
    } catch {
      return false;
    }
  });
}

export function isApprovedRedirectUrl(value: string): boolean {
  if (!isHttpsUrl(value)) return false;
  try {
    const url = new URL(value);
    return url.port === '' && isApprovedDownloadHost(url.hostname);
  } catch {
    return false;
  }
}
