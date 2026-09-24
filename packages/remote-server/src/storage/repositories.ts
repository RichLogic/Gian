import { createHash } from 'node:crypto';

import {
  ENROLLMENT_TTL_MS,
  PAIRING_MAX_FAILURES,
  PAIRING_TTL_MS,
  REFRESH_ABSOLUTE_MS,
  REFRESH_SLIDING_MS,
  WS_TICKET_TTL_MS,
  canonicalJson,
  generateCanonicalId,
} from '@gian/remote-protocol';

import { type Clock } from '../clock.js';
import { hashSecret } from '../crypto-hash.js';
import { type RemoteDb } from './db.js';

export interface HostRow {
  account_peer_id: string | null;
  id: string;
  name: string;
  public_key_jwk: string;
  created_at: number;
  revoked_at: number | null;
}

export interface PairingGrantRow {
  id: string;
  host_id: string;
  code_hash: string;
  nonce_hash: string;
  expires_at: number;
  failed_claims: number;
  claimed_at: number | null;
  pairing_id: string | null;
  consumed_at: number | null;
  rejected_at: number | null;
  created_at: number;
}

export interface DevicePairingRow {
  account_peer_id: string | null;
  id: string;
  browser_installation_id: string;
  host_id: string;
  public_key_jwk: string;
  platform: string;
  user_agent: string;
  created_at: number;
  confirmed_at: number | null;
  revoked_at: number | null;
  crypto_connection_id: string | null;
}

export interface DeviceSessionRow {
  account_peer_id: string | null;
  id: string;
  browser_installation_id: string;
  current_refresh_hash: string;
  created_at: number;
  sliding_expires_at: number;
  absolute_expires_at: number;
  revoked_at: number | null;
  last_rotated_at: number;
}

export interface TombstoneRow {
  id: string;
  host_id: string;
  device_id: string;
  signed_at: number;
  signature: string;
  public_key_jwk: string | null;
  created_at: number;
  delivered_at: number | null;
}

export interface HostCredentialRow {
  host_id: string;
  refresh_secret_hash: string;
  previous_refresh_secret_hash: string | null;
}

export class RemoteRepositories {
  constructor(
    readonly db: RemoteDb,
    private readonly now: Clock,
  ) {}

  createEnrollment(token: string, githubAccountId: string, label?: string): { id: string; expires_at: number } {
    const id = generateCanonicalId();
    const expiresAt = this.now() + ENROLLMENT_TTL_MS;
    this.db.prepare(`
      INSERT INTO host_enrollments(id, token_hash, label, expires_at, created_at, github_account_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, hashSecret(token), label ?? null, expiresAt, this.now(), githubAccountId);
    return { id, expires_at: expiresAt };
  }

  claimEnrollment(token: string, host: { name: string; public_key_jwk: string }, githubAccountId: string): HostRow | null {
    const tokenHash = hashSecret(token);
    return this.db.transaction(() => {
      const enrollment = this.db.prepare(`
        SELECT id, expires_at, used_at, github_account_id FROM host_enrollments WHERE token_hash = ?
      `).get(tokenHash) as { id: string; expires_at: number; used_at: number | null; github_account_id: string | null } | undefined;
      if (!enrollment || enrollment.used_at !== null || enrollment.expires_at <= this.now()
        || !enrollment.github_account_id || enrollment.github_account_id !== githubAccountId) {
        return null;
      }
      const now = this.now();
      const existing = this.db.prepare(
        'SELECT * FROM hosts WHERE public_key_jwk = ?',
      ).get(host.public_key_jwk) as HostRow | undefined;
      const hostId = existing?.id ?? generateCanonicalId();
      if (existing) {
        this.db.prepare('UPDATE hosts SET name = ? WHERE id = ?').run(host.name, hostId);
      } else {
        this.db.prepare(`
          INSERT INTO hosts(id, name, public_key_jwk, created_at) VALUES (?, ?, ?, ?)
        `).run(hostId, host.name, host.public_key_jwk, now);
      }
      this.db.prepare(`
        UPDATE host_enrollments SET used_at = ?, claimed_host_id = ? WHERE id = ? AND used_at IS NULL
      `).run(now, hostId, enrollment.id);
      const updated = this.db.prepare('SELECT changes() AS changes').get() as { changes: number };
      if (updated.changes !== 1) return null;
      return this.db.prepare('SELECT * FROM hosts WHERE id = ?').get(hostId) as HostRow;
    })();
  }

  getHost(hostId: string): HostRow | undefined {
    return this.db.prepare('SELECT * FROM hosts WHERE id = ?').get(hostId) as HostRow | undefined;
  }

  renameHost(hostId: string, name: string): void {
    this.db.prepare('UPDATE hosts SET name = ? WHERE id = ? AND revoked_at IS NULL').run(name, hostId);
  }

  setHostCredential(hostId: string, refreshSecret: string): void {
    const now = this.now();
    this.db.prepare(`
      INSERT INTO host_credentials(
        host_id, refresh_secret_hash, previous_refresh_secret_hash, created_at, rotated_at
      )
      VALUES (?, ?, NULL, ?, ?)
      ON CONFLICT(host_id) DO UPDATE SET
        refresh_secret_hash = excluded.refresh_secret_hash,
        previous_refresh_secret_hash = NULL,
        rotated_at = excluded.rotated_at
    `).run(hostId, hashSecret(refreshSecret), now, now);
  }

  getHostCredentials(hostId: string): HostCredentialRow | undefined {
    return this.db.prepare(`
      SELECT host_id, refresh_secret_hash, previous_refresh_secret_hash
        FROM host_credentials WHERE host_id = ?
    `).get(hostId) as HostCredentialRow | undefined;
  }

  getHostCredentialHash(hostId: string): string | undefined {
    return this.getHostCredentials(hostId)?.refresh_secret_hash;
  }

  rotateHostCredential(hostId: string, nextRefreshSecret: string): void {
    const now = this.now();
    this.db.prepare(`
      UPDATE host_credentials
         SET previous_refresh_secret_hash = refresh_secret_hash,
             refresh_secret_hash = ?,
             rotated_at = ?
       WHERE host_id = ?
    `).run(hashSecret(nextRefreshSecret), now, hostId);
  }

  replaceCurrentRefreshHash(hostId: string, nextRefreshSecret: string): void {
    const now = this.now();
    this.db.prepare(`
      UPDATE host_credentials
         SET refresh_secret_hash = ?,
             rotated_at = ?
       WHERE host_id = ?
    `).run(hashSecret(nextRefreshSecret), now, hostId);
  }

  createConnectorChallenge(hostId: string, challenge: string, ttlMs: number): { id: string; expires_at: number } {
    const id = generateCanonicalId();
    const expiresAt = this.now() + ttlMs;
    this.db.prepare(`
      INSERT INTO connector_challenges(id, host_id, challenge_hash, expires_at) VALUES (?, ?, ?, ?)
    `).run(id, hostId, hashSecret(challenge), expiresAt);
    return { id, expires_at: expiresAt };
  }

  consumeConnectorChallenge(id: string, hostId: string): boolean {
    const row = this.db.prepare(`
      SELECT expires_at, used_at, host_id FROM connector_challenges WHERE id = ?
    `).get(id) as { expires_at: number; used_at: number | null; host_id: string } | undefined;
    if (!row || row.host_id !== hostId || row.used_at !== null || row.expires_at <= this.now()) return false;
    const result = this.db.prepare('UPDATE connector_challenges SET used_at = ? WHERE id = ? AND used_at IS NULL')
      .run(this.now(), id);
    return result.changes === 1;
  }

  createPairingGrant(hostId: string, codeHash: string, nonceHash: string): PairingGrantRow {
    const id = generateCanonicalId();
    const now = this.now();
    this.db.prepare(`
      INSERT INTO pairing_grants(id, host_id, code_hash, nonce_hash, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, hostId, codeHash, nonceHash, now + PAIRING_TTL_MS, now);
    return this.db.prepare('SELECT * FROM pairing_grants WHERE id = ?').get(id) as PairingGrantRow;
  }

  findGrantByCodeHash(codeHash: string): PairingGrantRow | undefined {
    return this.db.prepare('SELECT * FROM pairing_grants WHERE code_hash = ?').get(codeHash) as PairingGrantRow | undefined;
  }

  findGrantByNonceHash(nonceHash: string): PairingGrantRow | undefined {
    return this.db.prepare('SELECT * FROM pairing_grants WHERE nonce_hash = ?').get(nonceHash) as PairingGrantRow | undefined;
  }

  recordGrantFailure(grantId: string): number {
    this.db.prepare(`
      UPDATE pairing_grants SET failed_claims = failed_claims + 1 WHERE id = ?
    `).run(grantId);
    const row = this.db.prepare('SELECT failed_claims FROM pairing_grants WHERE id = ?').get(grantId) as { failed_claims: number };
    return row.failed_claims;
  }

  claimGrant(grantId: string, pairingId: string): boolean {
    const now = this.now();
    this.db.prepare(`
      UPDATE pairing_grants
      SET claimed_at = ?, pairing_id = ?
      WHERE id = ? AND claimed_at IS NULL AND rejected_at IS NULL AND consumed_at IS NULL
        AND failed_claims < ? AND expires_at > ?
    `).run(now, pairingId, grantId, PAIRING_MAX_FAILURES, now);
    return (this.db.prepare('SELECT changes() AS changes').get() as { changes: number }).changes === 1;
  }

  claimGrantAndUpsertPairing(input: {
    grantId: string;
    browserInstallationId: string;
    hostId: string;
    publicKeyJwk: string;
    platform: string;
    userAgent: string;
  }): DevicePairingRow | undefined {
    return this.db.transaction(() => {
      if (this.isRevokedPublicKey(input.publicKeyJwk)) return undefined;
      const existing = this.getPairingByBrowserHost(input.browserInstallationId, input.hostId);
      if (existing?.confirmed_at && !existing.revoked_at) return undefined;
      if (existing && pairingKeyHash(existing.public_key_jwk) === pairingKeyHash(input.publicKeyJwk)) {
        return undefined;
      }
      const pairingId = generateCanonicalId();
      if (!this.claimGrant(input.grantId, pairingId)) return undefined;
      if (existing) {
        this.recordRevokedKey(existing);
        this.db.prepare('DELETE FROM device_host_pairings WHERE id = ?').run(existing.id);
      }
      this.db.prepare(`
        INSERT INTO device_host_pairings(
          id, browser_installation_id, host_id, public_key_jwk, platform, user_agent,
          created_at, crypto_connection_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        pairingId,
        input.browserInstallationId,
        input.hostId,
        input.publicKeyJwk,
        input.platform,
        input.userAgent,
        this.now(),
        generateCanonicalId(),
      );
      return this.getPairing(pairingId);
    })();
  }

  confirmGrant(pairingId: string, decision: 'confirm' | 'reject'): PairingGrantRow | undefined {
    const now = this.now();
    const current = this.db.prepare('SELECT * FROM pairing_grants WHERE pairing_id = ?').get(pairingId) as PairingGrantRow | undefined;
    if (!current || current.claimed_at === null) return undefined;
    if (current.consumed_at !== null) return decision === 'confirm' ? current : undefined;
    if (current.rejected_at !== null) return decision === 'reject' ? current : undefined;
    if (current.expires_at <= now) return undefined;
    if (decision === 'reject') {
      this.db.prepare(`
        UPDATE pairing_grants SET rejected_at = ? WHERE pairing_id = ? AND consumed_at IS NULL AND rejected_at IS NULL
      `).run(now, pairingId);
    } else {
      this.db.prepare(`
        UPDATE pairing_grants SET consumed_at = ? WHERE pairing_id = ? AND claimed_at IS NOT NULL AND consumed_at IS NULL AND rejected_at IS NULL
      `).run(now, pairingId);
    }
    return this.db.prepare('SELECT * FROM pairing_grants WHERE pairing_id = ?').get(pairingId) as PairingGrantRow | undefined;
  }

  ensureBrowser(id: string): void {
    this.db.prepare(`
      INSERT INTO browser_installations(id, created_at) VALUES (?, ?)
      ON CONFLICT(id) DO NOTHING
    `).run(id, this.now());
  }

  insertPairing(row: Omit<DevicePairingRow, 'confirmed_at' | 'revoked_at'>): DevicePairingRow {
    this.db.prepare(`
      INSERT INTO device_host_pairings(
        id, browser_installation_id, host_id, public_key_jwk, platform, user_agent, created_at, crypto_connection_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id,
      row.browser_installation_id,
      row.host_id,
      row.public_key_jwk,
      row.platform,
      row.user_agent,
      row.created_at,
      row.crypto_connection_id,
    );
    return this.getPairing(row.id)!;
  }

  getPairing(id: string): DevicePairingRow | undefined {
    return this.db.prepare('SELECT * FROM device_host_pairings WHERE id = ?').get(id) as DevicePairingRow | undefined;
  }

  getPairingByBrowserHost(browserId: string, hostId: string): DevicePairingRow | undefined {
    return this.db.prepare(`
      SELECT * FROM device_host_pairings WHERE browser_installation_id = ? AND host_id = ?
    `).get(browserId, hostId) as DevicePairingRow | undefined;
  }

  confirmPairing(id: string): void {
    this.db.prepare('UPDATE device_host_pairings SET confirmed_at = ? WHERE id = ? AND confirmed_at IS NULL').run(this.now(), id);
  }

  revokeExpiredOrUnboundPairings(hostId: string): void {
    const expired = this.db.prepare(`SELECT p.id FROM device_host_pairings p LEFT JOIN account_peers a
      ON a.role = 'controller' AND a.installation_id = p.account_peer_id
      WHERE p.host_id = ? AND p.revoked_at IS NULL
        AND (p.account_peer_id IS NULL OR (a.delegated_host_id = p.host_id AND a.expires_at <= ?))`)
      .all(hostId, this.now()) as Array<{ id: string }>;
    for (const pairing of expired) this.revokePairing(pairing.id);
  }

  deletePairing(id: string): void {
    this.db.prepare('DELETE FROM device_host_pairings WHERE id = ?').run(id);
  }

  setPairingCryptoConnectionId(id: string, cryptoConnectionId: string): void {
    this.db.prepare('UPDATE device_host_pairings SET crypto_connection_id = ? WHERE id = ?')
      .run(cryptoConnectionId, id);
  }

  revokePairing(id: string): void {
    this.db.prepare('UPDATE device_host_pairings SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
      .run(this.now(), id);
    const pairing = this.getPairing(id);
    if (pairing) this.recordRevokedKey(pairing);
  }

  recordRevokedKey(pairing: DevicePairingRow): void {
    this.db.prepare(`
      INSERT INTO revoked_pairing_keys(public_key_hash, public_key_jwk, host_id, device_id, revoked_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(public_key_hash) DO NOTHING
    `).run(pairingKeyHash(pairing.public_key_jwk), pairing.public_key_jwk, pairing.host_id, pairing.id, this.now());
  }

  isRevokedPublicKey(publicKeyJwk: string): boolean {
    const row = this.db.prepare('SELECT public_key_hash FROM revoked_pairing_keys WHERE public_key_hash = ?')
      .get(pairingKeyHash(publicKeyJwk)) as { public_key_hash: string } | undefined;
    return Boolean(row);
  }

  isDeviceRouteClosed(deviceId: string): boolean {
    const pairing = this.getPairing(deviceId);
    if (!pairing || pairing.revoked_at) return true;
    return this.hasPendingTombstone(deviceId);
  }

  hasPendingTombstone(deviceId: string): boolean {
    const row = this.db.prepare(`
      SELECT id FROM revocation_tombstones WHERE device_id = ? AND delivered_at IS NULL
    `).get(deviceId) as { id: string } | undefined;
    return Boolean(row);
  }

  listPairingsForBrowser(browserId: string): DevicePairingRow[] {
    return this.db.prepare(`
      SELECT * FROM device_host_pairings WHERE browser_installation_id = ?
    `).all(browserId) as DevicePairingRow[];
  }

  countHostPairings(hostId: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count FROM device_host_pairings WHERE host_id = ? AND revoked_at IS NULL
    `).get(hostId) as { count: number };
    return row.count;
  }

  createDeviceChallenge(browserId: string, hostId: string, challenge: string, ttlMs: number): { id: string; expires_at: number } {
    const id = generateCanonicalId();
    const expiresAt = this.now() + ttlMs;
    this.db.prepare(`
      INSERT INTO device_challenges(id, browser_installation_id, host_id, challenge_hash, expires_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, browserId, hostId, hashSecret(challenge), expiresAt);
    return { id, expires_at: expiresAt };
  }

  consumeDeviceChallenge(id: string, browserId: string, hostId: string): boolean {
    const row = this.db.prepare(`
      SELECT * FROM device_challenges WHERE id = ?
    `).get(id) as {
      expires_at: number;
      used_at: number | null;
      browser_installation_id: string;
      host_id: string;
    } | undefined;
    if (
      !row
      || row.browser_installation_id !== browserId
      || row.host_id !== hostId
      || row.used_at !== null
      || row.expires_at <= this.now()
    ) {
      return false;
    }
    const result = this.db.prepare('UPDATE device_challenges SET used_at = ? WHERE id = ? AND used_at IS NULL')
      .run(this.now(), id);
    return result.changes === 1;
  }

  createRefreshFamily(browserId: string, refreshSecret: string): DeviceSessionRow {
    const now = this.now();
    const id = generateCanonicalId();
    this.db.prepare(`
      INSERT INTO device_sessions(
        id, browser_installation_id, current_refresh_hash, created_at,
        sliding_expires_at, absolute_expires_at, last_rotated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      browserId,
      hashSecret(refreshSecret),
      now,
      now + REFRESH_SLIDING_MS,
      now + REFRESH_ABSOLUTE_MS,
      now,
    );
    return this.getSession(id)!;
  }

  getSession(id: string): DeviceSessionRow | undefined {
    return this.db.prepare('SELECT * FROM device_sessions WHERE id = ?').get(id) as DeviceSessionRow | undefined;
  }

  findSessionByRefreshHash(refreshHash: string): DeviceSessionRow | undefined {
    return this.db.prepare('SELECT * FROM device_sessions WHERE current_refresh_hash = ?').get(refreshHash) as
      | DeviceSessionRow
      | undefined;
  }

  rotateRefresh(familyId: string, expectedHash: string, nextSecret: string): DeviceSessionRow | undefined {
    const now = this.now();
    const result = this.db.prepare(`
      UPDATE device_sessions
      SET current_refresh_hash = ?, sliding_expires_at = ?, last_rotated_at = ?
      WHERE id = ? AND current_refresh_hash = ? AND revoked_at IS NULL
        AND absolute_expires_at > ? AND sliding_expires_at > ?
    `).run(hashSecret(nextSecret), now + REFRESH_SLIDING_MS, now, familyId, expectedHash, now, now);
    if (result.changes !== 1) return undefined;
    return this.getSession(familyId);
  }

  revokeFamily(familyId: string): void {
    this.db.prepare('UPDATE device_sessions SET revoked_at = ? WHERE id = ?').run(this.now(), familyId);
  }

  revokeBrowserFamilies(browserId: string): void {
    this.db.prepare('UPDATE device_sessions SET revoked_at = ? WHERE browser_installation_id = ? AND revoked_at IS NULL')
      .run(this.now(), browserId);
  }

  createWsTicket(input: {
    role: 'device' | 'host';
    hostId: string;
    deviceId?: string;
    familyId?: string;
    ticket: string;
  }): { expires_at: number } {
    const expiresAt = this.now() + WS_TICKET_TTL_MS;
    this.db.prepare(`
      INSERT INTO ws_tickets(id, ticket_hash, role, device_id, host_id, family_id, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      generateCanonicalId(),
      hashSecret(input.ticket),
      input.role,
      input.deviceId ?? null,
      input.hostId,
      input.familyId ?? null,
      expiresAt,
      this.now(),
    );
    return { expires_at: expiresAt };
  }

  consumeWsTicket(ticket: string): {
    role: 'device' | 'host';
    host_id: string;
    device_id: string | null;
    family_id: string | null;
  } | null {
    const hash = hashSecret(ticket);
    return this.db.transaction(() => {
      const row = this.db.prepare(`
        SELECT * FROM ws_tickets WHERE ticket_hash = ?
      `).get(hash) as {
        id: string;
        role: 'device' | 'host';
        host_id: string;
        device_id: string | null;
        family_id: string | null;
        expires_at: number;
        used_at: number | null;
      } | undefined;
      if (!row || row.used_at !== null || row.expires_at <= this.now()) return null;
      this.db.prepare('UPDATE ws_tickets SET used_at = ? WHERE id = ? AND used_at IS NULL').run(this.now(), row.id);
      if ((this.db.prepare('SELECT changes() AS changes').get() as { changes: number }).changes !== 1) return null;
      return {
        role: row.role,
        host_id: row.host_id,
        device_id: row.device_id,
        family_id: row.family_id,
      };
    })();
  }

  touchPresence(hostId: string, leaseMs: number): number {
    const expiresAt = this.now() + leaseMs;
    this.db.prepare(`
      INSERT INTO presence_leases(host_id, expires_at, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(host_id) DO UPDATE SET expires_at = excluded.expires_at, updated_at = excluded.updated_at
    `).run(hostId, expiresAt, this.now());
    return expiresAt;
  }

  isHostOnline(hostId: string): boolean {
    const row = this.db.prepare('SELECT expires_at FROM presence_leases WHERE host_id = ?').get(hostId) as
      | { expires_at: number }
      | undefined;
    return Boolean(row && row.expires_at > this.now());
  }

  expirePresence(hostId: string): void {
    this.db.prepare('DELETE FROM presence_leases WHERE host_id = ?').run(hostId);
  }

  insertTombstone(input: {
    hostId: string;
    deviceId: string;
    signedAt: number;
    signature: string;
    publicKeyJwk?: string;
  }): 'inserted' | 'duplicate' {
    const existing = this.db.prepare(`
      SELECT id FROM revocation_tombstones WHERE host_id = ? AND device_id = ? AND signature = ?
    `).get(input.hostId, input.deviceId, input.signature) as { id: string } | undefined;
    if (existing) return 'duplicate';
    try {
      this.db.prepare(`
        INSERT INTO revocation_tombstones(id, host_id, device_id, signed_at, signature, public_key_jwk, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        generateCanonicalId(),
        input.hostId,
        input.deviceId,
        input.signedAt,
        input.signature,
        input.publicKeyJwk ?? null,
        this.now(),
      );
      return 'inserted';
    } catch {
      return 'duplicate';
    }
  }

  findTombstone(hostId: string, deviceId: string, signature: string): TombstoneRow | undefined {
    return this.db.prepare(`
      SELECT * FROM revocation_tombstones WHERE host_id = ? AND device_id = ? AND signature = ?
    `).get(hostId, deviceId, signature) as TombstoneRow | undefined;
  }

  findTombstoneBySignature(hostId: string, signature: string): TombstoneRow | undefined {
    return this.db.prepare(`
      SELECT * FROM revocation_tombstones WHERE host_id = ? AND signature = ?
    `).get(hostId, signature) as TombstoneRow | undefined;
  }

  pendingTombstones(hostId: string): TombstoneRow[] {
    return this.db.prepare(`
      SELECT * FROM revocation_tombstones WHERE host_id = ? AND delivered_at IS NULL
    `).all(hostId) as TombstoneRow[];
  }

  markTombstoneDelivered(id: string): void {
    this.db.prepare('UPDATE revocation_tombstones SET delivered_at = ? WHERE id = ?').run(this.now(), id);
  }

  markTombstoneDeliveredFor(hostId: string, deviceId: string): number {
    const result = this.db.prepare(`
      UPDATE revocation_tombstones
         SET delivered_at = ?
       WHERE host_id = ? AND device_id = ? AND delivered_at IS NULL
    `).run(this.now(), hostId, deviceId);
    return Number(result.changes ?? 0);
  }

  cleanupExpired(): void {
    const now = this.now();
    this.db.prepare('DELETE FROM host_enrollments WHERE expires_at <= ? AND used_at IS NOT NULL').run(now - ENROLLMENT_TTL_MS);
    this.db.prepare('DELETE FROM enrollment_sessions WHERE expires_at <= ?').run(now);
    this.db.prepare('DELETE FROM pairing_grants WHERE expires_at <= ? AND claimed_at IS NULL').run(now);
    this.db.prepare('DELETE FROM ws_tickets WHERE expires_at <= ?').run(now);
    this.db.prepare('DELETE FROM connector_challenges WHERE expires_at <= ?').run(now);
    this.db.prepare('DELETE FROM device_challenges WHERE expires_at <= ?').run(now);
    this.db.prepare('DELETE FROM relay_outbox').run();
  }
}

export function pairingKeyHash(publicKeyJwk: string): string {
  const parsed = JSON.parse(publicKeyJwk) as { kty: string; crv: string; x: string; y: string };
  return createHash('sha256').update(canonicalJson(parsed)).digest('hex');
}
