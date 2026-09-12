import {
  RemoteProtocolError,
  identityFingerprint,
  importP256PublicKey,
  serverChallengePayload,
  verifyBytes,
} from '@gian/remote-protocol';
import type { Db } from '../storage/db.js';
import type { P256PublicJwk, RemoteIdentityMaterial } from './identity.js';

export interface RemoteEnrollmentRecord {
  hostId: string;
  serverUrl: string;
  serverIdentityPublicKey: P256PublicJwk;
  serverIdentityFingerprint: string;
  hostPublicKey: P256PublicJwk;
  hostName: string;
  enrolledAt: string;
  lastConfirmedIdentityAt: string | null;
  pendingIdentityPublicKey: P256PublicJwk | null;
  pendingIdentityFingerprint: string | null;
  connectorEnabled: boolean;
  publicUrl: string;
  identityChangedAt: string | null;
}

interface EnrollmentRow {
  host_id: string;
  server_url: string;
  server_identity_public_key: string;
  server_identity_fingerprint: string;
  host_public_key: string;
  host_name: string;
  enrolled_at: string;
  last_confirmed_identity_at: string | null;
  pending_identity_public_key: string | null;
  pending_identity_fingerprint: string | null;
  connector_enabled: number;
  public_url: string | null;
  identity_changed_at: string | null;
}

export class RemoteEnrollmentStore {
  constructor(
    private readonly db: Db,
    private readonly identity: RemoteIdentityMaterial,
  ) {}

  current(): RemoteEnrollmentRecord | null {
    const row = this.db.prepare('SELECT * FROM remote_enrollments LIMIT 1').get() as EnrollmentRow | undefined;
    return row ? project(row) : null;
  }

  setEnabled(enabled: boolean): void {
    this.db.prepare('UPDATE remote_enrollments SET connector_enabled = ?').run(enabled ? 1 : 0);
  }

  setPublicUrl(url: string): void {
    this.db.prepare('UPDATE remote_enrollments SET public_url = ?').run(url);
  }

  clear(): void {
    this.db.prepare('DELETE FROM remote_enrollments').run();
  }

  rejectServerIdentityChange(): void {
    this.db.prepare(`UPDATE remote_enrollments SET connector_enabled = 0,
      pending_identity_public_key = NULL, pending_identity_fingerprint = NULL, identity_changed_at = NULL`).run();
  }

  async recordClaim(input: {
    hostId: string;
    serverUrl: string;
    serverIdentity: { public_key: P256PublicJwk; fingerprint: string };
    hostName: string;
    refreshSecret: string;
  }): Promise<RemoteEnrollmentRecord> {
    const host = await this.identity.ensurePublic();
    const expected = await identityFingerprint(input.serverIdentity.public_key);
    if (expected !== input.serverIdentity.fingerprint) {
      throw new Error('Server application identity fingerprint does not match the public key');
    }
    const now = new Date().toISOString();
    this.db.prepare('DELETE FROM remote_enrollments').run();
    this.db.prepare(
      `INSERT INTO remote_enrollments
        (host_id, server_url, server_identity_public_key, server_identity_fingerprint,
         host_public_key, host_name, enrolled_at, last_confirmed_identity_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.hostId,
      input.serverUrl,
      JSON.stringify(input.serverIdentity.public_key),
      input.serverIdentity.fingerprint,
      JSON.stringify(host.public_key),
      input.hostName,
      now,
      now,
    );
    await this.identity.setRefreshSecret(input.refreshSecret);
    return this.current()!;
  }

  async observeServerIdentity(observed: { public_key: P256PublicJwk; fingerprint: string }): Promise<
    | { status: 'matched'; enrollment: RemoteEnrollmentRecord }
    | { status: 'pending_confirmation'; enrollment: RemoteEnrollmentRecord }
  > {
    const enrollment = this.current();
    if (!enrollment) throw new Error('Host is not enrolled with a Remote Server');
    const fingerprint = await identityFingerprint(observed.public_key);
    if (fingerprint !== observed.fingerprint) {
      throw new Error('observed Server application identity is inconsistent');
    }
    if (fingerprint === enrollment.serverIdentityFingerprint) {
      return { status: 'matched', enrollment };
    }
    this.db.prepare(
      `UPDATE remote_enrollments
          SET pending_identity_public_key = ?, pending_identity_fingerprint = ?, identity_changed_at = ?
        WHERE host_id = ?`,
    ).run(JSON.stringify(observed.public_key), fingerprint, new Date().toISOString(), enrollment.hostId);
    return { status: 'pending_confirmation', enrollment: this.current()! };
  }

  async verifySignedChallenge(input: {
    hostId: string;
    challengeId: string;
    challenge: string;
    expiresAt: number;
    serverIdentity: { public_key: P256PublicJwk; fingerprint: string };
    signature: string;
  }): Promise<void> {
    const enrollment = this.current();
    if (!enrollment) throw new Error('Host is not enrolled with a Remote Server');
    if (input.serverIdentity.fingerprint !== await identityFingerprint(input.serverIdentity.public_key)) {
      throw new RemoteProtocolError('AUTH_REQUIRED', 'Server identity fingerprint does not match the public key');
    }
    const payload = new TextEncoder().encode(serverChallengePayload({
      host_id: input.hostId,
      challenge_id: input.challengeId,
      challenge: input.challenge,
      expires_at: input.expiresAt,
      fingerprint: input.serverIdentity.fingerprint,
    }));
    const reportedKey = await importP256PublicKey(input.serverIdentity.public_key, 'verify');
    const signature = Buffer.from(input.signature, 'base64url');
    if (!await verifyBytes(reportedKey, payload, signature)) {
      throw new RemoteProtocolError('AUTH_REQUIRED', 'Server identity challenge signature is invalid');
    }
    const observed = await this.observeServerIdentity(input.serverIdentity);
    if (observed.status === 'pending_confirmation') {
      throw new Error('Server application identity fingerprint changed; confirm it before connecting');
    }
    const pinnedKey = await importP256PublicKey(enrollment.serverIdentityPublicKey, 'verify');
    if (!await verifyBytes(pinnedKey, payload, signature)) {
      throw new RemoteProtocolError('AUTH_REQUIRED', 'Server identity is not the pinned enrollment key');
    }
  }

  confirmServerIdentityChange(): RemoteEnrollmentRecord {
    const enrollment = this.current();
    if (!enrollment?.pendingIdentityFingerprint || !enrollment.pendingIdentityPublicKey) {
      throw new Error('no Server application identity change is pending');
    }
    this.db.prepare(
      `UPDATE remote_enrollments
          SET server_identity_public_key = ?,
              server_identity_fingerprint = ?,
              pending_identity_public_key = NULL,
              pending_identity_fingerprint = NULL,
              identity_changed_at = NULL,
              last_confirmed_identity_at = ?
        WHERE host_id = ?`,
    ).run(
      JSON.stringify(enrollment.pendingIdentityPublicKey),
      enrollment.pendingIdentityFingerprint,
      new Date().toISOString(),
      enrollment.hostId,
    );
    return this.current()!;
  }
}

function project(row: EnrollmentRow): RemoteEnrollmentRecord {
  return {
    hostId: row.host_id,
    serverUrl: row.server_url,
    serverIdentityPublicKey: JSON.parse(row.server_identity_public_key) as P256PublicJwk,
    serverIdentityFingerprint: row.server_identity_fingerprint,
    hostPublicKey: JSON.parse(row.host_public_key) as P256PublicJwk,
    hostName: row.host_name,
    enrolledAt: row.enrolled_at,
    lastConfirmedIdentityAt: row.last_confirmed_identity_at,
    pendingIdentityPublicKey: row.pending_identity_public_key
      ? JSON.parse(row.pending_identity_public_key) as P256PublicJwk
      : null,
    pendingIdentityFingerprint: row.pending_identity_fingerprint,
    connectorEnabled: row.connector_enabled !== 0,
    publicUrl: row.public_url ?? row.server_url,
    identityChangedAt: row.identity_changed_at,
  };
}
