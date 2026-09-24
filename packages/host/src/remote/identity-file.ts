import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  exportPublicJwk,
  generateP256SigningKeyPair,
  identityFingerprint,
  signBytes,
} from '@gian/remote-protocol';
import type { CryptoKeyPair, JsonWebKey } from './crypto-types.js';
import type { RemoteIdentityMaterial, RemotePublicIdentity } from './identity.js';
import type { RemoteAccountCredential } from '@gian/shared';

interface StoredIdentityFile {
  version: 1;
  identity: JsonWebKey;
  refresh_secret: string | null;
  accounts?: Record<string, RemoteAccountCredential>;
  controllers?: Record<string, JsonWebKey>;
}

export function createRemoteIdentityFileMaterial(path: string): RemoteIdentityMaterial {
  return new FileRemoteIdentity(path);
}

class FileRemoteIdentity implements RemoteIdentityMaterial {
  readonly kind = 'file' as const;
  private pair: CryptoKeyPair | null = null;
  private cached: RemotePublicIdentity | null = null;
  private ensuring: Promise<RemotePublicIdentity> | null = null;
  private writes: Promise<unknown> = Promise.resolve();

  constructor(private readonly path: string) {}

  async ensurePublic(): Promise<RemotePublicIdentity> {
    if (this.cached) return this.cached;
    if (!this.ensuring) this.ensuring = this.ensureOnce().finally(() => { this.ensuring = null; });
    return this.ensuring;
  }

  private async ensureOnce(): Promise<RemotePublicIdentity> {
    const stored = await this.load();
    const pair = stored
      ? await importSigningPair(stored.identity)
      : await generateP256SigningKeyPair();
    this.pair = pair;
    if (!stored) {
      await this.save({
        version: 1,
        identity: await crypto.subtle.exportKey('jwk', pair.privateKey),
        refresh_secret: null,
      });
    }
    const public_key = await exportPublicJwk(pair.publicKey);
    this.cached = { public_key, fingerprint: await identityFingerprint(public_key) };
    return this.cached;
  }

  async sign(bytes: Uint8Array): Promise<string> {
    if (!this.pair) await this.ensurePublic();
    return signBytes(this.pair!.privateKey, bytes);
  }

  async getRefreshSecret(): Promise<string | null> {
    return (await this.load())?.refresh_secret ?? null;
  }

  async setRefreshSecret(secret: string): Promise<void> {
    await this.mutate(stored => ({ ...stored, refresh_secret: secret }));
  }

  async getAccountSession(origin: string, role = 'host'): Promise<RemoteAccountCredential | null> {
    return (await this.load())?.accounts?.[`${origin}#${role}`] ?? null;
  }

  async ensureControllerIdentity(scope: string): Promise<RemotePublicIdentity> {
    let jwk: JsonWebKey | undefined;
    await this.mutate(async stored => {
      jwk = stored.controllers?.[scope];
      if (jwk) return stored;
      const generated = await generateP256SigningKeyPair();
      jwk = await crypto.subtle.exportKey('jwk', generated.privateKey);
      return { ...stored, controllers: { ...stored.controllers, [scope]: jwk } };
    });
    const pair = await importSigningPair(jwk!);
    const public_key = await exportPublicJwk(pair.publicKey);
    return { public_key, fingerprint: await identityFingerprint(public_key) };
  }

  async signControllerIdentity(scope: string, bytes: Uint8Array): Promise<string> {
    await this.ensureControllerIdentity(scope);
    const pair = await importSigningPair((await this.load())!.controllers![scope]!);
    return signBytes(pair.privateKey, bytes);
  }

  async setAccountSession(origin: string, value: RemoteAccountCredential | null, role = 'host'): Promise<void> {
    await this.mutate(stored => {
      const accounts = { ...stored.accounts };
      const key = `${origin}#${role}`;
      if (value) accounts[key] = value; else delete accounts[key];
      return { ...stored, accounts };
    });
  }

  private async mutate(update: (stored: StoredIdentityFile) => StoredIdentityFile | Promise<StoredIdentityFile>): Promise<void> {
    await this.ensurePublic();
    const run = this.writes.then(async () => {
      const stored = (await this.load())!;
      const next = await update(stored);
      if (next !== stored) await this.save(next);
    });
    this.writes = run.catch(() => undefined);
    return run;
  }

  private async load(): Promise<StoredIdentityFile | null> {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as StoredIdentityFile;
      if (parsed.version !== 1 || !parsed.identity) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private async save(value: StoredIdentityFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, this.path);
    await chmod(this.path, 0o600);
  }
}

async function importSigningPair(jwk: JsonWebKey): Promise<CryptoKeyPair> {
  const privateKey = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign'],
  );
  const publicJwk = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
  const publicKey = await crypto.subtle.importKey(
    'jwk',
    publicJwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['verify'],
  );
  return { privateKey, publicKey };
}
