import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  AUTH_SIGNED_AT_SKEW_MS,
  CROCKFORD_ALPHABET,
  PAIRING_MAX_FAILURES,
  PAIRING_TTL_MS,
  formatPairingCode,
  generateCanonicalId,
  importP256PublicKey,
  selfRevokePayload,
  verifyBytes,
} from '@gian/remote-protocol';
import type { Db } from '../storage/db.js';
import { RemoteDeviceStore, devicePublicKeyCanonical, type RemoteDeviceRecord } from './device-store.js';

export type RemotePairingStatus =
  | 'pending_claim'
  | 'pending_confirmation'
  | 'confirmed'
  | 'rejected'
  | 'expired'
  | 'consumed';

export interface RemotePairingRecord {
  accountId?: string | null;
  id: string;
  grantId: string;
  serverPairingId: string | null;
  code: string;
  grantNonce: string;
  status: RemotePairingStatus;
  devicePublicKey: string | null;
  deviceName: string | null;
  platform: string | null;
  userAgent: string | null;
  claimedNetwork: string | null;
  failureCount: number;
  createdAt: string;
  expiresAt: string;
  claimedAt: string | null;
  resolvedAt: string | null;
  deviceId: string | null;
}

interface PairingRow {
  account_id: string | null;
  id: string;
  grant_id: string;
  code_hash: string;
  grant_nonce_hash: string;
  status: RemotePairingStatus;
  device_public_key: string | null;
  device_name: string | null;
  platform: string | null;
  user_agent: string | null;
  claimed_network: string | null;
  failure_count: number;
  created_at: string;
  expires_at: string;
  claimed_at: string | null;
  resolved_at: string | null;
  device_id: string | null;
  server_pairing_id: string | null;
}

export class RemotePairingService {
  constructor(
    private readonly db: Db,
    private readonly devices: RemoteDeviceStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  recordServerGrant(input: {
    grantId: string;
    code: string;
    grantNonce: string;
    expiresAt: number | string;
  }): RemotePairingRecord {
    this.expireStale();
    const createdAt = this.now();
    const requested = typeof input.expiresAt === 'number'
      ? input.expiresAt
      : Date.parse(input.expiresAt);
    const fallback = createdAt.getTime() + PAIRING_TTL_MS;
    const expiresAt = new Date(Number.isFinite(requested) && requested > createdAt.getTime()
      ? requested
      : fallback).toISOString();
    this.db.prepare(
      `INSERT INTO remote_pairings
        (id, grant_id, code_hash, grant_nonce_hash, status, failure_count, created_at, expires_at)
       VALUES (?, ?, ?, ?, 'pending_claim', 0, ?, ?)`,
    ).run(
      input.grantId,
      input.grantId,
      hashUtf8(input.code),
      hashUtf8(input.grantNonce),
      createdAt.toISOString(),
      expiresAt,
    );
    return { ...this.project(this.row(input.grantId)!), code: input.code, grantNonce: input.grantNonce };
  }

  applyServerClaim(input: {
    accountId?: string;
    grantId: string;
    pairingId: string;
    publicKey: { kty: 'EC'; crv: 'P-256'; x: string; y: string };
    name?: string;
    platform?: string;
    userAgent?: string;
  }): RemotePairingRecord {
    this.expireStale();
    const row = this.db.prepare('SELECT * FROM remote_pairings WHERE grant_id = ?').get(input.grantId) as PairingRow | undefined;
    if (!row) {
      throw Object.assign(new Error('pairing grant not found'), { code: 'DEVICE_NOT_PAIRED' });
    }
    if (row.status === 'pending_confirmation' && row.server_pairing_id === input.pairingId) {
      return this.project(row);
    }
    this.assertClaimable(row);
    const claimedAt = this.now();
    this.db.prepare(
      `UPDATE remote_pairings
          SET status = 'pending_confirmation',
              server_pairing_id = ?,
              device_public_key = ?,
              device_name = ?,
              platform = ?,
              user_agent = ?,
              account_id = ?,
              claimed_at = ?,
              expires_at = ?
        WHERE grant_id = ? AND status = 'pending_claim'`,
    ).run(
      input.pairingId,
      devicePublicKeyCanonical(input.publicKey),
      input.name ?? null,
      input.platform ?? null,
      input.userAgent ?? null,
      input.accountId ?? null,
      claimedAt.toISOString(),
      new Date(claimedAt.getTime() + PAIRING_TTL_MS).toISOString(),
      input.grantId,
    );
    return this.project(this.row(row.id)!);
  }

  get(id: string): RemotePairingRecord | null {
    this.expireStale();
    const row = this.row(id) ?? this.byServerPairingId(id);
    return row ? this.project(row) : null;
  }

  create(): { pairing: Omit<RemotePairingRecord, 'code' | 'grantNonce'> & { code: string; grantNonce: string } } {
    this.expireStale();
    const code = generatePairingCode();
    const grantNonce = generateCanonicalId();
    const createdAt = this.now();
    const id = randomUUID();
    const grantId = generateCanonicalId();
    this.db.prepare(
      `INSERT INTO remote_pairings
        (id, grant_id, code_hash, grant_nonce_hash, status, failure_count, created_at, expires_at)
       VALUES (?, ?, ?, ?, 'pending_claim', 0, ?, ?)`,
    ).run(
      id,
      grantId,
      hashUtf8(code),
      hashUtf8(grantNonce),
      createdAt.toISOString(),
      new Date(createdAt.getTime() + PAIRING_TTL_MS).toISOString(),
    );
    return {
      pairing: {
        ...this.project(this.row(id)!),
        code,
        grantNonce,
      },
    };
  }

  claim(input: {
    code?: string;
    grantNonce?: string;
    publicKey: { kty: 'EC'; crv: 'P-256'; x: string; y: string };
    name: string;
    platform: string;
    userAgent: string;
    claimedNetwork?: string;
  }): RemotePairingRecord {
    this.expireStale();
    if (Boolean(input.code) === Boolean(input.grantNonce)) {
      throw Object.assign(new Error('claim must use exactly one of code or grant_nonce'), { code: 'AUTH_REQUIRED' });
    }
    const hash = input.code ? hashUtf8(formatPairingCode(input.code)) : hashUtf8(input.grantNonce!);
    const column = input.code ? 'code_hash' : 'grant_nonce_hash';
    const row = this.db.prepare(`SELECT * FROM remote_pairings WHERE ${column} = ?`).get(hash) as PairingRow | undefined;
    if (!row) {
      throw Object.assign(new Error('pairing grant not found'), { code: 'DEVICE_NOT_PAIRED' });
    }
    this.assertClaimable(row);
    const publicKey = devicePublicKeyCanonical(input.publicKey);
    this.db.prepare(
      `UPDATE remote_pairings
          SET status = 'pending_confirmation',
              device_public_key = ?,
              device_name = ?,
              platform = ?,
              user_agent = ?,
              claimed_network = ?,
              claimed_at = ?
        WHERE id = ? AND status = 'pending_claim'`,
    ).run(
      publicKey,
      input.name,
      input.platform,
      input.userAgent,
      input.claimedNetwork ?? null,
      this.now().toISOString(),
      row.id,
    );
    return this.project(this.row(row.id)!);
  }

  confirm(pairingId: string, assignedDeviceId?: string): RemotePairingRecord {
    this.expireStale();
    const row = this.require(pairingId);
    if (row.status !== 'pending_confirmation' || !row.device_public_key) {
      throw Object.assign(new Error('pairing is not waiting for confirmation'), { code: 'DEVICE_NOT_PAIRED' });
    }
    const deviceId = assignedDeviceId ?? this.devices.create({
      publicKey: row.device_public_key,
      name: row.device_name ?? 'Remote device',
      platform: row.platform ?? 'unknown',
    }).id;
    this.db.prepare(
      `UPDATE remote_pairings
          SET status = 'confirmed', resolved_at = ?, device_id = ?
        WHERE id = ?`,
    ).run(this.now().toISOString(), deviceId, pairingId);
    return this.project(this.row(pairingId)!);
  }

  reject(pairingId: string): RemotePairingRecord {
    this.expireStale();
    const row = this.require(pairingId);
    if (row.status !== 'pending_confirmation' && row.status !== 'pending_claim') {
      throw Object.assign(new Error('pairing cannot be rejected'), { code: 'DEVICE_NOT_PAIRED' });
    }
    this.db.prepare(
      `UPDATE remote_pairings SET status = 'rejected', resolved_at = ? WHERE id = ?`,
    ).run(this.now().toISOString(), pairingId);
    return this.project(this.row(pairingId)!);
  }

  async applySignedSelfRevoke(input: {
    deviceId: string;
    hostId: string;
    signedAt: number;
    signature: string;
    publicKey: { kty: 'EC'; crv: 'P-256'; x: string; y: string };
  }): Promise<RemoteDeviceRecord | null> {
    const device = this.devices.get(input.deviceId);
    if (!device) throw Object.assign(new Error('remote device not found'), { code: 'DEVICE_NOT_PAIRED' });
    if (device.publicKey !== devicePublicKeyCanonical(input.publicKey)) {
      throw Object.assign(new Error('self-revoke public key does not match the device'), { code: 'DEVICE_REVOKED' });
    }
    const key = await importP256PublicKey(input.publicKey, 'verify');
    const payload = new TextEncoder().encode(selfRevokePayload({
      hostId: input.hostId,
      deviceId: input.deviceId,
      signedAt: input.signedAt,
    }));
    const signature = Buffer.from(input.signature, 'base64url');
    if (!await verifyBytes(key, payload, signature)) {
      throw Object.assign(new Error('self-revoke signature is invalid'), { code: 'AUTH_REQUIRED' });
    }
    this.db.prepare(
      `INSERT OR IGNORE INTO remote_revoke_receipts (signature, device_id, signed_at) VALUES (?, ?, ?)`,
    ).run(input.signature, input.deviceId, input.signedAt);
    return device;
  }

  pruneHandshakeReceipts(now = this.now().getTime()): number {
    const result = this.db.prepare(
      `DELETE FROM remote_handshake_receipts WHERE signed_at < ?`,
    ).run(now - AUTH_SIGNED_AT_SKEW_MS);
    return Number(result.changes ?? 0);
  }

  consumeHandshakeNonce(input: { handshakeNonce: string; deviceId: string; signedAt: number }): boolean {
    const now = this.now().getTime();
    this.pruneHandshakeReceipts(now);
    if (input.signedAt - now > AUTH_SIGNED_AT_SKEW_MS || now - input.signedAt > AUTH_SIGNED_AT_SKEW_MS) {
      return false;
    }
    const result = this.db.prepare(
      `INSERT OR IGNORE INTO remote_handshake_receipts (handshake_nonce, device_id, signed_at) VALUES (?, ?, ?)`,
    ).run(input.handshakeNonce, input.deviceId, input.signedAt);
    return Number(result.changes ?? 0) === 1;
  }

  listPending(): RemotePairingRecord[] {
    this.expireStale();
    return (this.db.prepare(
      `SELECT * FROM remote_pairings
        WHERE status IN ('pending_claim', 'pending_confirmation')
        ORDER BY created_at DESC`,
    ).all() as PairingRow[]).map(row => this.project(row));
  }

  latest(): RemotePairingRecord | null {
    this.expireStale();
    const row = this.db.prepare('SELECT * FROM remote_pairings ORDER BY created_at DESC, rowid DESC LIMIT 1')
      .get() as PairingRow | undefined;
    return row ? this.project(row) : null;
  }

  clear(): void {
    this.db.prepare('DELETE FROM remote_pairings').run();
  }

  private expireStale(): void {
    this.db.prepare(
      `UPDATE remote_pairings
          SET status = 'expired', resolved_at = ?
        WHERE status IN ('pending_claim', 'pending_confirmation')
          AND expires_at <= ?`,
    ).run(this.now().toISOString(), this.now().toISOString());
  }

  private assertClaimable(row: PairingRow): void {
    if (row.status === 'pending_confirmation') {
      throw Object.assign(new Error('pairing grant is already claimed'), { code: 'DEVICE_NOT_PAIRED' });
    }
    if (row.status !== 'pending_claim') {
      throw Object.assign(new Error('pairing grant is no longer claimable'), { code: 'DEVICE_NOT_PAIRED' });
    }
    if (Date.parse(row.expires_at) <= this.now().getTime()) {
      throw Object.assign(new Error('pairing grant expired'), { code: 'DEVICE_NOT_PAIRED' });
    }
    if (row.failure_count >= PAIRING_MAX_FAILURES) {
      throw Object.assign(new Error('pairing grant is locked'), { code: 'DEVICE_NOT_PAIRED' });
    }
  }

  private require(id: string): PairingRow {
    const row = this.row(id);
    if (!row) throw Object.assign(new Error('pairing not found'), { code: 'DEVICE_NOT_PAIRED' });
    return row;
  }

  private row(id: string): PairingRow | undefined {
    return this.db.prepare('SELECT * FROM remote_pairings WHERE id = ?').get(id) as PairingRow | undefined;
  }

  private byServerPairingId(id: string): PairingRow | undefined {
    return this.db.prepare('SELECT * FROM remote_pairings WHERE server_pairing_id = ?').get(id) as PairingRow | undefined;
  }

  private project(row: PairingRow): RemotePairingRecord {
    return {
      accountId: row.account_id,
      id: row.id,
      grantId: row.grant_id,
      serverPairingId: row.server_pairing_id,
      code: '',
      grantNonce: '',
      status: row.status,
      devicePublicKey: row.device_public_key,
      deviceName: row.device_name,
      platform: row.platform,
      userAgent: row.user_agent,
      claimedNetwork: row.claimed_network,
      failureCount: row.failure_count,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      claimedAt: row.claimed_at,
      resolvedAt: row.resolved_at,
      deviceId: row.device_id,
    };
  }
}

function generatePairingCode(): string {
  const bytes = randomBytes(8);
  let raw = '';
  for (const byte of bytes) raw += CROCKFORD_ALPHABET[byte >> 3];
  return formatPairingCode(raw);
}

function hashUtf8(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
