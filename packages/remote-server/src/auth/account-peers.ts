import {
  ACCOUNT_SESSION_TTL_MS,
  PAIRING_TTL_MS,
  RemoteProtocolError,
  canonicalIdSchema,
  generateCanonicalId,
  identityFingerprint,
  parseClosed,
  remoteAccountChallengePayload,
  remoteAccountIdentitySchema,
  remoteAccountPeerSchema,
  remotePeerRoleSchema,
  sha256HexSchema,
  type RemoteAccountChallenge,
  type RemoteAccountIdentity,
  type RemoteAccountPeer,
} from '@gian/remote-protocol';
import type { Clock } from '../clock.js';
import { hashSecret, hashesEqual, randomSecret } from '../crypto-hash.js';
import type { RemoteDb } from '../storage/db.js';
import { GitHubIdentityVerifier } from './github-identity.js';
import { verifyP256Signature } from './signatures.js';

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_PENDING_CHALLENGES = 1000;

interface ChallengeRow {
  id: string;
  role: RemoteAccountPeer['role'];
  installation_id: string;
  public_key_json: string;
  nonce_hash: string;
  expires_at: number;
  consumed_at: number | null;
}

interface PeerRow {
  role: RemoteAccountPeer['role'];
  installation_id: string;
  github_account_id: string;
  github_login: string;
  public_key_fingerprint: string;
  server_identity_fingerprint: string;
  verified_at: number;
  expires_at: number;
  revoked_at: number | null;
  token_hash: string;
  delegated_host_id: string | null;
}

/** Account proofs are an additional gate, not a replacement for pairing or
 * route authorization. HTTP/WS admission must call this on every new lease. */
export class RemoteAccountPeers {
  private readonly serverFingerprint: string;
  private closed = false;
  close(): void { this.closed = true; }
  private assertOpen(): void { if (this.closed) throw denied(); }

  constructor(
    private readonly db: RemoteDb,
    serverFingerprint: string,
    private readonly now: Clock,
    private readonly verifier = new GitHubIdentityVerifier(),
  ) {
    this.serverFingerprint = parseClosed(sha256HexSchema, serverFingerprint);
  }

  challenge(input: RemoteAccountPeer): RemoteAccountChallenge {
    this.assertOpen();
    const peer = parseClosed(remoteAccountPeerSchema, input, 'AUTH_REQUIRED');
    const now = this.now();
    this.db.prepare('DELETE FROM account_challenges WHERE expires_at <= ?').run(now);
    const { count } = this.db.prepare('SELECT COUNT(*) AS count FROM account_challenges')
      .get() as { count: number };
    if (count >= MAX_PENDING_CHALLENGES) throw new RemoteProtocolError('RATE_LIMITED', 'account challenges full');
    const challenge: RemoteAccountChallenge = {
      type: 'gian.remote.account_challenge/1',
      challenge_id: generateCanonicalId(),
      nonce: randomSecret(),
      server_identity_fingerprint: this.serverFingerprint,
      peer,
      expires_at: now + CHALLENGE_TTL_MS,
    };
    this.db.prepare(`INSERT INTO account_challenges
      (id, role, installation_id, public_key_json, nonce_hash, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(challenge.challenge_id, peer.role, peer.installation_id,
        JSON.stringify(peer.public_key), hashSecret(challenge.nonce), challenge.expires_at);
    return challenge;
  }

  /** accessToken must come from the Server's own OAuth exchange. This is an
   * internal service boundary, never a Renderer token/profile upload API. */
  async authenticate(input: {
    challengeId: string;
    nonce: string;
    signature: string;
    accessToken: string;
  }): Promise<{ account: RemoteAccountIdentity; expiresAt: number; token: string }> {
    this.assertOpen();
    const id = parseClosed(canonicalIdSchema, input.challengeId, 'AUTH_REQUIRED');
    const row = this.db.prepare('SELECT * FROM account_challenges WHERE id = ?')
      .get(id) as ChallengeRow | undefined;
    if (!row || row.consumed_at !== null || row.expires_at <= this.now()
      || !hashesEqual(row.nonce_hash, hashSecret(input.nonce))) throw denied();
    const peer = parseClosed(remoteAccountPeerSchema, {
      role: row.role, installation_id: row.installation_id,
      public_key: JSON.parse(row.public_key_json),
    }, 'AUTH_REQUIRED');
    const payload = remoteAccountChallengePayload({
      type: 'gian.remote.account_challenge/1',
      challenge_id: row.id, nonce: input.nonce,
      server_identity_fingerprint: this.serverFingerprint,
      peer, expires_at: row.expires_at,
    });
    let valid = false;
    try { valid = await verifyP256Signature(peer.public_key, payload, input.signature); } catch { /* fail closed */ }
    if (!valid) throw denied();
    this.assertOpen();
    const consumed = this.db.prepare(`UPDATE account_challenges SET consumed_at = ?
      WHERE id = ? AND consumed_at IS NULL AND expires_at > ?`)
      .run(this.now(), row.id, this.now());
    if (consumed.changes !== 1) throw denied();
    const fingerprint = await identityFingerprint(peer.public_key);
    this.assertOpen();
    const previous = this.peer(peer.role, peer.installation_id);
    if (previous && previous.public_key_fingerprint !== fingerprint) throw denied();
    const account = parseClosed(remoteAccountIdentitySchema,
      await this.verifier.verify(input.accessToken), 'AUTH_REQUIRED');
    this.assertOpen();
    const authenticatedPeer = this.peer(peer.role, peer.installation_id);
    if (authenticatedPeer?.public_key_fingerprint === fingerprint
      && authenticatedPeer.github_account_id !== account.id) {
      // A proven device signing in as another account cannot retain its old
      // lease. Account changes require a new installation/key binding.
      this.revoke(peer.role, peer.installation_id);
      throw denied();
    }
    // Network work above can overlap expiry, another proof, or revocation.
    return this.db.transaction(() => {
      const now = this.now();
      const current = this.peer(peer.role, peer.installation_id);
      const challenge = this.db.prepare('SELECT consumed_at FROM account_challenges WHERE id = ?')
        .get(row.id) as { consumed_at: number | null } | undefined;
      if (row.expires_at <= now || !challenge || challenge.consumed_at === null
        || (current && (current.github_account_id !== account.id
          || current.public_key_fingerprint !== fingerprint
          || current.revoked_at !== null))) throw denied();
      const expiresAt = now + ACCOUNT_SESSION_TTL_MS;
      const token = randomSecret();
      this.db.prepare(`INSERT INTO account_peers
        (role, installation_id, github_account_id, github_login, public_key_fingerprint,
          server_identity_fingerprint, verified_at, expires_at, token_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(role, installation_id) DO UPDATE SET
          github_login = excluded.github_login, verified_at = excluded.verified_at,
          server_identity_fingerprint = excluded.server_identity_fingerprint,
          token_hash = excluded.token_hash,
          expires_at = excluded.expires_at`)
        .run(peer.role, peer.installation_id, account.id, account.login, fingerprint,
          this.serverFingerprint, now, expiresAt, hashSecret(token));
      return { account, expiresAt, token };
    })();
  }

  requireSameAccount(hostId: string, controllerId: string): RemoteAccountIdentity {
    const host = this.requireActive('host', hostId);
    const controller = this.requireActive('controller', controllerId);
    if (host.github_account_id !== controller.github_account_id) throw denied();
    return { provider: 'github', id: host.github_account_id, login: controller.github_login };
  }

  requireToken(token: string | undefined, role?: RemoteAccountPeer['role']): PeerRow {
    this.assertOpen();
    if (!token || token.length > 256) throw denied();
    const row = this.db.prepare('SELECT * FROM account_peers WHERE token_hash = ?')
      .get(hashSecret(token)) as PeerRow | undefined;
    if (!row || row.delegated_host_id || (role && row.role !== role)) throw denied();
    return this.requireActive(row.role, row.installation_id);
  }

  requirePeer(role: RemoteAccountPeer['role'], installationId: string): PeerRow {
    return this.requireActive(role, installationId);
  }

  createPendingBrowserDelegation(hostId: string, fingerprint: string): PeerRow {
    const owner = this.requireHost(hostId);
    const id = generateCanonicalId();
    // No account bearer is issued. This short pending lease grants no access;
    // only explicit Host confirmation can extend it to the normal account TTL.
    this.db.prepare(`INSERT INTO account_peers
      (role, installation_id, github_account_id, github_login, public_key_fingerprint,
       server_identity_fingerprint, verified_at, expires_at, token_hash, delegated_host_id)
      VALUES ('controller', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, owner.github_account_id, owner.github_login, fingerprint, this.serverFingerprint,
        this.now(), this.now() + PAIRING_TTL_MS, hashSecret(randomSecret()), hostId);
    return this.requireActive('controller', id);
  }

  confirmBrowserDelegation(pairingId: string): void {
    const peer = this.requirePairing(pairingId);
    if (!peer.delegated_host_id) return;
    const pairing = this.db.prepare('SELECT confirmed_at FROM device_host_pairings WHERE id = ?').get(pairingId) as { confirmed_at: number | null };
    if (!pairing.confirmed_at) throw denied();
    this.db.prepare("UPDATE account_peers SET expires_at = ? WHERE role = 'controller' AND installation_id = ?")
      .run(pairing.confirmed_at + ACCOUNT_SESSION_TTL_MS, peer.installation_id);
  }

  bindHost(hostId: string, peerId: string): void {
    const peer = this.requireActive('host', peerId);
    const current = this.db.prepare('SELECT account_peer_id FROM hosts WHERE id = ?')
      .get(hostId) as { account_peer_id: string | null } | undefined;
    if (!current) throw denied();
    if (current.account_peer_id && current.account_peer_id !== peerId) {
      const old = this.peer('host', current.account_peer_id);
      if (!old || old.github_account_id !== peer.github_account_id
        || old.public_key_fingerprint !== peer.public_key_fingerprint) throw denied();
    }
    this.db.prepare('UPDATE hosts SET account_peer_id = ? WHERE id = ?').run(peerId, hostId);
  }

  requireHost(hostId: string): PeerRow {
    const host = this.db.prepare('SELECT account_peer_id FROM hosts WHERE id = ? AND revoked_at IS NULL')
      .get(hostId) as { account_peer_id: string | null } | undefined;
    if (!host?.account_peer_id) throw denied();
    return this.requireActive('host', host.account_peer_id);
  }

  requirePairing(pairingId: string): PeerRow {
    const pairing = this.db.prepare('SELECT host_id, account_peer_id FROM device_host_pairings WHERE id = ? AND revoked_at IS NULL')
      .get(pairingId) as { host_id: string; account_peer_id: string | null } | undefined;
    if (!pairing?.account_peer_id) throw denied();
    const host = this.requireHost(pairing.host_id);
    this.requireSameAccount(host.installation_id, pairing.account_peer_id);
    const peer = this.requireActive('controller', pairing.account_peer_id);
    if (peer.delegated_host_id && peer.delegated_host_id !== pairing.host_id) throw denied();
    return peer;
  }

  pairingAllowed(pairingId: string): boolean {
    try { this.requirePairing(pairingId); return true; } catch { return false; }
  }

  rebindPairing(pairingId: string, accountToken: string): void {
    const account = this.requireToken(accountToken, 'controller');
    const pairing = this.db.prepare('SELECT host_id, account_peer_id FROM device_host_pairings WHERE id = ? AND revoked_at IS NULL')
      .get(pairingId) as { host_id: string; account_peer_id: string | null } | undefined;
    if (!pairing?.account_peer_id) throw denied();
    const old = this.peer('controller', pairing.account_peer_id);
    if (!old || old.github_account_id !== account.github_account_id) throw denied();
    this.requireSameAccount(this.requireHost(pairing.host_id).installation_id, account.installation_id);
    this.db.prepare('UPDATE device_host_pairings SET account_peer_id = ? WHERE id = ?')
      .run(account.installation_id, pairingId);
  }

  revoke(role: RemoteAccountPeer['role'], installationId: string): void {
    this.assertOpen();
    parseClosed(remotePeerRoleSchema, role, 'AUTH_REQUIRED');
    parseClosed(canonicalIdSchema, installationId, 'AUTH_REQUIRED');
    this.db.transaction(() => {
      this.db.prepare('UPDATE account_peers SET revoked_at = ? WHERE role = ? AND installation_id = ?')
        .run(this.now(), role, installationId);
      this.db.prepare('DELETE FROM account_challenges WHERE role = ? AND installation_id = ?')
        .run(role, installationId);
    })();
  }

  private requireActive(role: RemoteAccountPeer['role'], id: string): PeerRow {
    this.assertOpen();
    parseClosed(canonicalIdSchema, id, 'AUTH_REQUIRED');
    const row = this.peer(role, id);
    if (!row || row.revoked_at !== null || row.expires_at <= this.now()
      || row.server_identity_fingerprint !== this.serverFingerprint) throw denied();
    if (row.delegated_host_id) {
      if (role !== 'controller' || this.requireHost(row.delegated_host_id).github_account_id !== row.github_account_id) throw denied();
    }
    return row;
  }

  private peer(role: RemoteAccountPeer['role'], id: string): PeerRow | undefined {
    return this.db.prepare('SELECT * FROM account_peers WHERE role = ? AND installation_id = ?')
      .get(role, id) as PeerRow | undefined;
  }
}

function denied(): RemoteProtocolError {
  return new RemoteProtocolError('AUTH_REQUIRED', 'account proof required');
}
