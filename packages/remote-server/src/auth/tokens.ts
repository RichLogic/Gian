import { ACCESS_TOKEN_TTL_MS } from '@gian/remote-protocol';

import { type Clock } from '../clock.js';
import { hashSecret, hashesEqual, randomSecret } from '../crypto-hash.js';

export interface AccessRecord {
  token: string;
  hash: string;
  expiresAt: number;
  hostId: string;
  deviceId?: string;
  familyId?: string;
  role: 'device' | 'host' | 'admin';
}

export class TokenStore {
  readonly #records = new Map<string, AccessRecord>();

  constructor(private readonly now: Clock) {}

  issue(input: Omit<AccessRecord, 'token' | 'hash' | 'expiresAt'> & { ttlMs?: number }): AccessRecord {
    const token = randomSecret();
    const record: AccessRecord = {
      ...input,
      token,
      hash: hashSecret(token),
      expiresAt: this.now() + (input.ttlMs ?? ACCESS_TOKEN_TTL_MS),
    };
    this.#records.set(record.hash, record);
    return record;
  }

  get(token: string): AccessRecord | undefined {
    const record = this.#records.get(hashSecret(token));
    if (!record || record.expiresAt <= this.now()) {
      if (record) this.#records.delete(record.hash);
      return undefined;
    }
    return record;
  }

  revokeFamily(familyId: string): void {
    for (const [hash, record] of this.#records) {
      if (record.familyId === familyId) this.#records.delete(hash);
    }
  }

  revokeDevice(deviceId: string): void {
    for (const [hash, record] of this.#records) {
      if (record.deviceId === deviceId) this.#records.delete(hash);
    }
  }

  matches(token: string, expectedHash: string): boolean {
    return hashesEqual(hashSecret(token), expectedHash);
  }
}
