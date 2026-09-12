import {
  exportPublicJwk,
  generateP256SigningKeyPair,
  identityFingerprint,
  signBytes,
} from '@gian/remote-protocol';
import type { CryptoKeyPair } from './crypto-types.js';
import { createRemoteIdentityFileMaterial } from './identity-file.js';
import { RemoteIdentityBrokerClient } from './identity-broker.js';

export const REMOTE_IDENTITY_BROKER_SOCKET_ENV = 'GIAN_DESKTOP_REMOTE_BROKER_SOCKET';
export const REMOTE_IDENTITY_FILE_ENV = 'GIAN_REMOTE_IDENTITY_FILE';
export const REMOTE_IDENTITY_FILE_ALLOW_ENV = 'GIAN_ALLOW_REMOTE_IDENTITY_FILE';

export type P256PublicJwk = { kty: 'EC'; crv: 'P-256'; x: string; y: string };

export interface RemotePublicIdentity {
  public_key: P256PublicJwk;
  fingerprint: string;
}

export interface RemoteIdentityMaterial {
  kind: 'broker' | 'file' | 'memory' | 'unavailable';
  ensurePublic(): Promise<RemotePublicIdentity>;
  sign(bytes: Uint8Array): Promise<string>;
  getRefreshSecret(): Promise<string | null>;
  setRefreshSecret(secret: string): Promise<void>;
}

export class UnavailableRemoteIdentity implements RemoteIdentityMaterial {
  readonly kind = 'unavailable' as const;

  async ensurePublic(): Promise<RemotePublicIdentity> {
    throw new Error('Remote identity material is unavailable');
  }

  async sign(): Promise<string> {
    throw new Error('Remote identity material is unavailable');
  }

  async getRefreshSecret(): Promise<string | null> {
    return null;
  }

  async setRefreshSecret(): Promise<void> {
    throw new Error('Remote identity material is unavailable');
  }
}

export class MemoryRemoteIdentity implements RemoteIdentityMaterial {
  readonly kind = 'memory' as const;
  private pair: CryptoKeyPair | null = null;
  private cached: RemotePublicIdentity | null = null;
  private refreshSecret: string | null = null;

  async ensurePublic(): Promise<RemotePublicIdentity> {
    if (this.cached) return this.cached;
    const pair = await generateP256SigningKeyPair();
    this.pair = pair;
    const public_key = await exportPublicJwk(pair.publicKey);
    this.cached = { public_key, fingerprint: await identityFingerprint(public_key) };
    return this.cached;
  }

  async sign(bytes: Uint8Array): Promise<string> {
    if (!this.pair) await this.ensurePublic();
    return signBytes(this.pair!.privateKey, bytes);
  }

  async getRefreshSecret(): Promise<string | null> {
    return this.refreshSecret;
  }

  async setRefreshSecret(secret: string): Promise<void> {
    this.refreshSecret = secret;
  }
}

export function isPackagedHostRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.GIAN_PACKAGED === '1' || env.GIAN_RELEASE_CHANNEL === 'production';
}

export function createRemoteIdentityFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): RemoteIdentityMaterial {
  const broker = env[REMOTE_IDENTITY_BROKER_SOCKET_ENV]?.trim();
  if (broker) return new RemoteIdentityBrokerClient(broker);
  const file = env[REMOTE_IDENTITY_FILE_ENV]?.trim();
  const allowed = env[REMOTE_IDENTITY_FILE_ALLOW_ENV] === '1';
  if (file && allowed && !isPackagedHostRuntime(env)) {
    return createRemoteIdentityFileMaterial(file);
  }
  return new UnavailableRemoteIdentity();
}
