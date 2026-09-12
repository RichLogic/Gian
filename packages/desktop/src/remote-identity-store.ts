import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

interface StoredBlob {
  version: 1;
  encrypted: string;
}

export type RemoteIdentityJwk = {
  kty?: string;
  crv?: string;
  x?: string;
  y?: string;
  d?: string;
  ext?: boolean;
  key_ops?: string[];
};

export interface RemoteIdentitySecret {
  identity: RemoteIdentityJwk;
  refreshSecret: string | null;
}

export interface RemoteIdentityStore {
  isAvailable(): boolean;
  load(): Promise<RemoteIdentitySecret | null>;
  save(secret: RemoteIdentitySecret): Promise<void>;
}

export class FileRemoteIdentityStore implements RemoteIdentityStore {
  constructor(private readonly options: {
    path: string;
    encryptionAvailable(): boolean;
    encrypt(value: string): Buffer;
    decrypt(value: Buffer): string;
  }) {}

  isAvailable(): boolean {
    return this.options.encryptionAvailable();
  }

  async load(): Promise<RemoteIdentitySecret | null> {
    if (!this.isAvailable()) return null;
    try {
      const raw = JSON.parse(await readFile(this.options.path, 'utf8')) as StoredBlob;
      if (raw.version !== 1 || typeof raw.encrypted !== 'string') return null;
      return JSON.parse(this.options.decrypt(Buffer.from(raw.encrypted, 'base64'))) as RemoteIdentitySecret;
    } catch {
      return null;
    }
  }

  async save(secret: RemoteIdentitySecret): Promise<void> {
    if (!this.isAvailable()) throw new Error('secure storage unavailable');
    const payload: StoredBlob = {
      version: 1,
      encrypted: this.options.encrypt(JSON.stringify(secret)).toString('base64'),
    };
    await mkdir(dirname(this.options.path), { recursive: true });
    const temporary = `${this.options.path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, this.options.path);
  }
}
