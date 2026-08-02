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
