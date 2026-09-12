import { randomUUID } from 'node:crypto';
import { canonicalJson } from '@gian/remote-protocol';
import type { GianToolMethod } from '@gian/shared';
import type { Db } from '../storage/db.js';
import { assertExactRemoteGrants, defaultRemoteDeviceGrants } from './grants.js';

export interface RemoteDeviceRecord {
  id: string;
  publicKey: string;
  name: string;
  platform: string;
  role: 'admin';
  grants: GianToolMethod[];
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  revision: number;
  cryptoConnectionId: string | null;
}

interface DeviceRow {
  id: string;
  public_key: string;
  name: string;
  platform: string;
  role: string;
  grants_json: string;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
  revision: number;
  crypto_connection_id: string | null;
}

export class RemoteDeviceStore {
  constructor(private readonly db: Db) {}

  list(): RemoteDeviceRecord[] {
    return (this.db.prepare(
      'SELECT * FROM remote_devices ORDER BY created_at ASC',
    ).all() as DeviceRow[]).map(project);
  }

  get(id: string): RemoteDeviceRecord | null {
    const row = this.db.prepare('SELECT * FROM remote_devices WHERE id = ?').get(id) as DeviceRow | undefined;
    return row ? project(row) : null;
  }

  markRevocationSynced(id: string): void {
    this.db.prepare('UPDATE remote_devices SET revoke_synced_at = ? WHERE id = ? AND revoked_at IS NOT NULL')
      .run(new Date().toISOString(), id);
  }

  revocationSynced(id: string): boolean {
    return Boolean((this.db.prepare('SELECT revoke_synced_at FROM remote_devices WHERE id = ?')
      .get(id) as { revoke_synced_at: string | null } | undefined)?.revoke_synced_at);
  }

  getActive(id: string): RemoteDeviceRecord | null {
    const device = this.get(id);
    return device && device.revokedAt === null ? device : null;
  }

  findByPublicKey(publicKey: string): RemoteDeviceRecord | null {
    const row = this.db.prepare('SELECT * FROM remote_devices WHERE public_key = ?')
      .get(publicKey) as DeviceRow | undefined;
    return row ? project(row) : null;
  }

  create(input: {
    publicKey: string;
    name: string;
    platform: string;
    grants?: readonly GianToolMethod[];
    id?: string;
    cryptoConnectionId?: string;
  }): RemoteDeviceRecord {
    const existing = this.findByPublicKey(input.publicKey);
    if (existing) {
      throw new Error(existing.revokedAt
        ? 'revoked device public key cannot be reused'
        : 'device public key is already paired');
    }
    return this.insertDevice(input);
  }

  createGeneration(input: {
    publicKey: string;
    name: string;
    platform: string;
    grants?: readonly GianToolMethod[];
    id?: string;
    cryptoConnectionId?: string;
  }): RemoteDeviceRecord {
    const existing = this.findByPublicKey(input.publicKey);
    if (existing) {
      throw new Error(existing.revokedAt
        ? 'revoked device public key cannot be reused'
        : 'device public key is already paired');
    }
    return this.insertDevice(input);
  }

  private insertDevice(input: {
    publicKey: string;
    name: string;
    platform: string;
    grants?: readonly GianToolMethod[];
    id?: string;
    cryptoConnectionId?: string;
  }): RemoteDeviceRecord {
    const grants = assertExactRemoteGrants(input.grants ?? defaultRemoteDeviceGrants());
    const now = new Date().toISOString();
    const id = input.id ?? randomUUID();
    this.db.prepare(
      `INSERT INTO remote_devices
        (id, public_key, name, platform, role, grants_json, created_at, last_seen_at, revoked_at, revision, crypto_connection_id)
       VALUES (?, ?, ?, ?, 'admin', ?, ?, NULL, NULL, 0, ?)`,
    ).run(id, input.publicKey, input.name, input.platform, JSON.stringify(grants), now, input.cryptoConnectionId ?? null);
    return this.get(id)!;
  }

  touch(id: string): void {
    this.db.prepare(
      'UPDATE remote_devices SET last_seen_at = ? WHERE id = ? AND revoked_at IS NULL',
    ).run(new Date().toISOString(), id);
  }

  revoke(id: string): RemoteDeviceRecord {
    const current = this.get(id);
    if (!current) throw new Error(`remote device not found: ${id}`);
    if (current.revokedAt) return current;
    this.db.prepare(
      `UPDATE remote_devices
          SET revoked_at = ?, revision = revision + 1
        WHERE id = ? AND revoked_at IS NULL`,
    ).run(new Date().toISOString(), id);
    return this.get(id)!;
  }
}

function project(row: DeviceRow): RemoteDeviceRecord {
  return {
    id: row.id,
    publicKey: row.public_key,
    name: row.name,
    platform: row.platform,
    role: 'admin',
    grants: JSON.parse(row.grants_json) as GianToolMethod[],
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
    revision: row.revision,
    cryptoConnectionId: row.crypto_connection_id,
  };
}

export function devicePublicKeyCanonical(jwk: { kty: 'EC'; crv: 'P-256'; x: string; y: string }): string {
  return canonicalJson(jwk);
}
