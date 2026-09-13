import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  GitHubAuthFinishResult,
  GitHubAuthStartResult,
  GitHubAuthState,
  GitHubUserProfile,
} from '@gian/shared';

const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const USER_URL = 'https://api.github.com/user';
const API_VERSION = '2022-11-28';

interface StoredCredential {
  version: 1;
  encryptedToken: string;
  user: GitHubUserProfile;
  savedAt: string;
}

interface Credential {
  token: string;
  user: GitHubUserProfile;
}

export type GitHubBrokerOperation =
  | 'list'
  | 'tag'
  | 'latest-catalog'
  | 'catalog-asset'
  | 'release-asset';

export interface GitHubReleaseMetadataRequest {
  repository: string;
  tag?: string;
  operation?: GitHubBrokerOperation;
  asset?: string;
  ifNoneMatch?: string;
}

export interface GitHubCredentialStore {
  isAvailable(): boolean;
  load(): Promise<Credential | null>;
  save(credential: Credential): Promise<void>;
  clear(): Promise<void>;
}

interface FileCredentialStoreOptions {
  path: string;
  encryptionAvailable(): boolean;
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}

export class FileGitHubCredentialStore implements GitHubCredentialStore {
  constructor(private readonly options: FileCredentialStoreOptions) {}

  isAvailable(): boolean {
    return this.options.encryptionAvailable();
  }

  async load(): Promise<Credential | null> {
    if (!this.isAvailable()) return null;
    try {
      const raw = JSON.parse(await readFile(this.options.path, 'utf8')) as unknown;
      if (!isStoredCredential(raw)) return null;
      const token = this.options.decrypt(Buffer.from(raw.encryptedToken, 'base64'));
      if (!token) return null;
      return { token, user: raw.user };
    } catch {
      return null;
    }
  }

  async save(credential: Credential): Promise<void> {
    if (!this.isAvailable()) throw new Error('secure storage unavailable');
    const payload: StoredCredential = {
      version: 1,
      encryptedToken: this.options.encrypt(credential.token).toString('base64'),
      user: credential.user,
      savedAt: new Date().toISOString(),
    };
    await mkdir(dirname(this.options.path), { recursive: true });
    const temporaryPath = `${this.options.path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, this.options.path);
  }

  async clear(): Promise<void> {
    try {
      await unlink(this.options.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

interface GitHubAuthServiceOptions {
  clientId: string | null;
  store: GitHubCredentialStore;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  now?: () => number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

interface PendingAuthorization {
  deviceCode: string;
  expiresAtMs: number;
  intervalMs: number;
  controller: AbortController;
  finishPromise?: Promise<GitHubAuthFinishResult>;
}

export class GitHubAuthService {
  private readonly fetchImpl: (input: string, init?: RequestInit) => Promise<Response>;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private pending: PendingAuthorization | null = null;

  constructor(private readonly options: GitHubAuthServiceOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? abortableDelay;
  }

  async getState(): Promise<GitHubAuthState> {
    if (!this.options.clientId) {
      return { status: 'unavailable', reason: 'not_configured' };
    }
    if (!this.options.store.isAvailable()) {
      return { status: 'unavailable', reason: 'secure_storage_unavailable' };
    }
    const credential = await this.options.store.load();
    return credential
      ? { status: 'signed_in', user: credential.user }
      : { status: 'signed_out' };
  }

  async start(): Promise<GitHubAuthStartResult> {
    const clientId = this.options.clientId;
    if (!clientId) return { ok: false, error: 'not_configured' };
    if (!this.options.store.isAvailable()) {
      return { ok: false, error: 'secure_storage_unavailable' };
    }

    this.cancel();
    try {
      const response = await this.fetchImpl(DEVICE_CODE_URL, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
          'user-agent': 'Gian',
        },
        body: new URLSearchParams({ client_id: clientId }),
      });
      if (!response.ok) return { ok: false, error: 'network' };
      let body: unknown;
      try {
        body = await response.json() as unknown;
      } catch {
        return { ok: false, error: 'invalid_response' };
      }
      if (!isDeviceCodeResponse(body) || !isGitHubDeviceUrl(body.verification_uri)) {
        return { ok: false, error: 'invalid_response' };
      }

      const expiresAtMs = this.now() + body.expires_in * 1_000;
      this.pending = {
        deviceCode: body.device_code,
        expiresAtMs,
        intervalMs: Math.max(1, body.interval) * 1_000,
        controller: new AbortController(),
      };
      return {
        ok: true,
        authorization: {
          userCode: body.user_code,
          verificationUri: body.verification_uri,
          expiresAt: new Date(expiresAtMs).toISOString(),
        },
      };
    } catch {
      return { ok: false, error: 'network' };
    }
  }

  finish(): Promise<GitHubAuthFinishResult> {
    const pending = this.pending;
    if (!pending) return Promise.resolve({ ok: false, error: 'not_started' });
    if (pending.finishPromise) return pending.finishPromise;

    const promise = this.poll(pending).finally(() => {
      if (this.pending === pending) this.pending = null;
    });
    pending.finishPromise = promise;
    return promise;
  }

  cancel(): void {
    this.pending?.controller.abort();
    this.pending = null;
  }

  async signOut(): Promise<void> {
    this.cancel();
    await this.options.store.clear();
  }

  /**
   * Perform the narrow GitHub API operation used by the managed Host without
   * disclosing the OAuth token outside Electron main. The caller supplies a
   * structured repository/tag request rather than an arbitrary URL, and
   * redirects are rejected so the Authorization header cannot cross origins.
   */
  async fetchReleaseMetadata(
    request: GitHubReleaseMetadataRequest,
    signal?: AbortSignal,
  ): Promise<Response> {
    if (request.operation === 'latest-catalog') {
      return this.fetchLatestCatalog(request, signal);
    }
    if (request.operation === 'catalog-asset' || request.operation === 'release-asset') {
      return this.fetchCatalogAsset(request, signal);
    }
    const url = releaseMetadataUrl(request);
    const headers = new Headers({
      accept: 'application/vnd.github+json',
      'user-agent': 'Gian',
      'x-github-api-version': API_VERSION,
    });
    let authenticated = false;
    if (this.options.store.isAvailable()) {
      const credential = await this.options.store.load();
      if (credential) {
        headers.set('authorization', `Bearer ${credential.token}`);
        authenticated = true;
      }
    }
    const init: RequestInit = {
      headers,
      redirect: 'error',
      ...(signal ? { signal } : {}),
    };
    const response = await this.fetchImpl(url, init);
    if (!authenticated || response.status !== 401) return response;

    // Release metadata is public. An expired/revoked OAuth credential must
    // not block Agent updates, but the token also must not cross the retry.
    const anonymousHeaders = new Headers(headers);
    anonymousHeaders.delete('authorization');
    return this.fetchImpl(url, { ...init, headers: anonymousHeaders });
  }

  private async githubJson(
    url: string,
    signal: AbortSignal | undefined,
    extraHeaders?: Record<string, string>,
  ): Promise<Response> {
    const headers = new Headers({
      accept: 'application/vnd.github+json',
      'user-agent': 'Gian',
      'x-github-api-version': API_VERSION,
      ...extraHeaders,
    });
    let authenticated = false;
    if (this.options.store.isAvailable()) {
      const credential = await this.options.store.load();
      if (credential) {
        headers.set('authorization', `Bearer ${credential.token}`);
        authenticated = true;
      }
    }
    const init: RequestInit = {
      headers,
      redirect: 'error',
      ...(signal ? { signal } : {}),
    };
    const response = await this.fetchImpl(url, init);
    if (!authenticated || response.status !== 401) return response;
    const anonymousHeaders = new Headers(headers);
    anonymousHeaders.delete('authorization');
    return this.fetchImpl(url, { ...init, headers: anonymousHeaders });
  }

  private async fetchLatestCatalog(
    request: GitHubReleaseMetadataRequest,
    signal?: AbortSignal,
  ): Promise<Response> {
    const url = releaseMetadataUrl({ repository: request.repository });
    const response = await this.githubJson(
      url,
      signal,
      request.ifNoneMatch ? { 'if-none-match': request.ifNoneMatch } : undefined,
    );
    if (response.status === 304) return response;
    if (!response.ok) return response;
    const parsed = await response.json() as unknown;
    if (!Array.isArray(parsed)) {
      return new Response(JSON.stringify({ error: 'invalid_release_list' }), { status: 502 });
    }
    let selected: { tag: string; sequence: number; assets: Array<{ name: string; size: number }> } | null = null;
    for (const item of parsed) {
      if (!isRecord(item) || typeof item.tag_name !== 'string') continue;
      const match = /^catalog-v1\.([1-9]\d*)\.0$/.exec(item.tag_name);
      if (!match) continue;
      const sequence = Number(match[1]);
      const assets = Array.isArray(item.assets)
        ? item.assets.flatMap((asset) => {
          if (!isRecord(asset) || typeof asset.name !== 'string' || typeof asset.size !== 'number') {
            return [];
          }
          return [{ name: decodeGitHubCatalogAssetName(asset.name), size: asset.size }];
        })
        : [];
      if (!selected || sequence > selected.sequence) {
        selected = { tag: item.tag_name, sequence, assets };
      }
    }
    if (!selected) {
      return new Response(JSON.stringify({ error: 'catalog_release_not_found' }), { status: 404 });
    }
    const headers = new Headers({ 'content-type': 'application/json; charset=utf-8' });
    const etag = response.headers.get('etag');
    if (etag) headers.set('etag', etag);
    return new Response(JSON.stringify(selected), { status: 200, headers });
  }

  private async fetchCatalogAsset(
    request: GitHubReleaseMetadataRequest,
    signal?: AbortSignal,
  ): Promise<Response> {
    if (!request.tag || !request.asset) {
      return new Response(JSON.stringify({ error: 'invalid_request' }), { status: 400 });
    }
    const metadata = await this.githubJson(releaseMetadataUrl({
      repository: request.repository,
      tag: request.tag,
    }), signal);
    if (!metadata.ok) return metadata;
    const parsed = await metadata.json() as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed.assets)) {
      return new Response(JSON.stringify({ error: 'invalid_release' }), { status: 502 });
    }
    const wanted = encodeGitHubCatalogAssetName(request.asset);
    const asset = parsed.assets.find((entry) => (
      isRecord(entry) && (entry.name === wanted || entry.name === request.asset)
    ));
    if (!isRecord(asset) || typeof asset.browser_download_url !== 'string') {
      return new Response(JSON.stringify({ error: 'asset_not_found' }), { status: 404 });
    }
    return fetchApprovedAsset(this.fetchImpl, asset.browser_download_url, signal);
  }

  private async poll(pending: PendingAuthorization): Promise<GitHubAuthFinishResult> {
    const clientId = this.options.clientId;
    if (!clientId) return { ok: false, error: 'not_configured' };
    let intervalMs = pending.intervalMs;

    while (this.now() < pending.expiresAtMs) {
      try {
        await this.sleep(intervalMs, pending.controller.signal);
      } catch {
        return { ok: false, error: 'cancelled' };
      }

      let response: Response;
      try {
        response = await this.fetchImpl(ACCESS_TOKEN_URL, {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/x-www-form-urlencoded',
            'user-agent': 'Gian',
          },
          body: new URLSearchParams({
            client_id: clientId,
            device_code: pending.deviceCode,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          }),
          signal: pending.controller.signal,
        });
      } catch {
        return pending.controller.signal.aborted
          ? { ok: false, error: 'cancelled' }
          : { ok: false, error: 'network' };
      }
      if (!response.ok) return { ok: false, error: 'network' };

      let body: unknown;
      try {
        body = await response.json() as unknown;
      } catch {
        return { ok: false, error: 'invalid_response' };
      }
      if (isAccessTokenResponse(body)) {
        return this.finishWithToken(body.access_token, pending.controller.signal);
      }
      if (!isOAuthErrorResponse(body)) return { ok: false, error: 'invalid_response' };
      if (body.error === 'authorization_pending') continue;
      if (body.error === 'slow_down') {
        intervalMs += 5_000;
        continue;
      }
      if (body.error === 'access_denied') return { ok: false, error: 'denied' };
      if (body.error === 'expired_token') return { ok: false, error: 'expired' };
      return { ok: false, error: 'invalid_response' };
    }
    return { ok: false, error: 'expired' };
  }

  private async finishWithToken(
    token: string,
    signal: AbortSignal,
  ): Promise<GitHubAuthFinishResult> {
    try {
      const response = await this.fetchImpl(USER_URL, {
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'user-agent': 'Gian',
          'x-github-api-version': API_VERSION,
        },
        signal,
      });
      if (!response.ok) return { ok: false, error: 'network' };
      const body = await response.json() as unknown;
      if (!isGitHubUserResponse(body)) return { ok: false, error: 'invalid_response' };
      const user: GitHubUserProfile = {
        id: body.id,
        login: body.login,
        name: body.name,
        avatarUrl: body.avatar_url,
        profileUrl: body.html_url,
      };
      await this.options.store.save({ token, user });
      return { ok: true, user };
    } catch {
      return signal.aborted
        ? { ok: false, error: 'cancelled' }
        : { ok: false, error: 'network' };
    }
  }
}

export function resolveGitHubOAuthClientId(options: {
  env?: NodeJS.ProcessEnv;
  isPackaged: boolean;
  resourcesPath: string;
}): string | null {
  const environmentValue = validClientId(options.env?.['GIAN_GITHUB_CLIENT_ID']);
  if (environmentValue) return environmentValue;
  if (!options.isPackaged) return null;

  try {
    const raw = JSON.parse(
      readFileSync(join(options.resourcesPath, 'runtime', 'github-auth.json'), 'utf8'),
    ) as { clientId?: unknown };
    return validClientId(raw.clientId);
  } catch {
    return null;
  }
}

function validClientId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^[A-Za-z0-9_-]{8,200}$/.test(trimmed) ? trimmed : null;
}

function releaseMetadataUrl(request: GitHubReleaseMetadataRequest): string {
  if (!isGitHubRepository(request.repository)) {
    throw new Error('invalid GitHub release repository');
  }
  const repository = request.repository
    .split('/')
    .map(segment => encodeURIComponent(segment))
    .join('/');
  if (request.tag === undefined) {
    return `https://api.github.com/repos/${repository}/releases?per_page=100`;
  }
  if (
    request.tag.length === 0
    || request.tag.length > 255
    || /[\u0000-\u001f\u007f]/.test(request.tag)
  ) {
    throw new Error('invalid GitHub release tag');
  }
  return `https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(request.tag)}`;
}

const APPROVED_ASSET_HOSTS = new Set([
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]);

export function encodeGitHubCatalogAssetName(path: string): string {
  return path.replaceAll('/', '__');
}

export function decodeGitHubCatalogAssetName(name: string): string {
  return name.replaceAll('__', '/');
}

function isApprovedAssetUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && url.username === ''
      && url.password === ''
      && url.port === ''
      && APPROVED_ASSET_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

async function fetchApprovedAsset(
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>,
  url: string,
  signal?: AbortSignal,
): Promise<Response> {
  if (!isApprovedAssetUrl(url)) {
    return new Response(JSON.stringify({ error: 'redirect_not_allowed' }), { status: 502 });
  }
  // Electron net.fetch cancels a 30x response when redirect='manual' instead
  // of exposing Location. The URL itself comes from the authenticated or
  // anonymous GitHub Releases API and is allowlisted above. Follow it without
  // Authorization; Catalog signatures and package SHA-256 checks remain the
  // execution authority for the returned bytes.
  return fetchImpl(url, {
    redirect: 'follow',
    ...(signal ? { signal } : {}),
    headers: {
      accept: 'application/octet-stream',
      'user-agent': 'Gian',
    },
  });
}

function isGitHubRepository(value: string): boolean {
  if (value.length === 0 || value.length > 200) return false;
  const segments = value.split('/');
  return segments.length === 2
    && segments.every(segment => (
      segment.length > 0
      && segment.length <= 100
      && /^[A-Za-z0-9_.-]+$/.test(segment)
      && segment !== '.'
      && segment !== '..'
    ));
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('cancelled'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('cancelled'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isGitHubUserProfile(value: unknown): value is GitHubUserProfile {
  return isRecord(value)
    && typeof value.id === 'number'
    && typeof value.login === 'string'
    && (typeof value.name === 'string' || value.name === null)
    && typeof value.avatarUrl === 'string'
    && typeof value.profileUrl === 'string';
}

function isStoredCredential(value: unknown): value is StoredCredential {
  return isRecord(value)
    && value.version === 1
    && typeof value.encryptedToken === 'string'
    && typeof value.savedAt === 'string'
    && isGitHubUserProfile(value.user);
}

function isDeviceCodeResponse(value: unknown): value is {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
} {
  return isRecord(value)
    && typeof value.device_code === 'string'
    && typeof value.user_code === 'string'
    && typeof value.verification_uri === 'string'
    && typeof value.expires_in === 'number'
    && value.expires_in > 0
    && typeof value.interval === 'number'
    && value.interval > 0;
}

function isGitHubDeviceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && url.hostname === 'github.com'
      && url.pathname.startsWith('/login/device');
  } catch {
    return false;
  }
}

function isAccessTokenResponse(value: unknown): value is { access_token: string } {
  return isRecord(value) && typeof value.access_token === 'string' && value.access_token.length > 0;
}

function isOAuthErrorResponse(value: unknown): value is { error: string } {
  return isRecord(value) && typeof value.error === 'string';
}

function isGitHubUserResponse(value: unknown): value is {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string;
  html_url: string;
} {
  return isRecord(value)
    && typeof value.id === 'number'
    && typeof value.login === 'string'
    && (typeof value.name === 'string' || value.name === null)
    && typeof value.avatar_url === 'string'
    && typeof value.html_url === 'string';
}
