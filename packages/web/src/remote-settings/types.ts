/**
 * Remote Settings controller contract (proposal §5 / WP5 phase 3).
 *
 * The local Gian Settings "Remote" section talks ONLY to this interface: it
 * reads `RemoteSettingsState` through `getState()`/`subscribe()` and issues
 * mutations through the action methods. Components never fetch, open sockets,
 * persist secrets, or decide outcomes themselves — the Host remote subsystem
 * (enrollment, pairing grants, device store, audit query) is the authority
 * and reports canonical results back through state updates.
 *
 * The live adapter uses the local Host Settings API. Fixtures are injected
 * only by tests and explicit component previews.
 *
 * These are UI-domain presentation DTOs, not wire types — wire schemas live
 * in `@gian/remote-protocol` and must not be duplicated here.
 */

// ---------------------------------------------------------------------------
// Server enrollment (proposal §5.1)
// ---------------------------------------------------------------------------

export interface RemoteEnrollmentInfo {
  serverUrl: string;
  publicUrl?: string;
  /** Host remote name as registered on the Server during enrollment. */
  hostRemoteName: string;
  /**
   * SHA-256 hex fingerprint of the Server's pinned application-layer identity
   * key. TLS certificate renewals never change it (§5.1).
   */
  serverIdentityFingerprint: string;
  /** Last connector heartbeat seen by the Host, epoch ms (null = none yet). */
  lastHeartbeatAt: number | null;
}

export type RemoteEnrollmentLink = 'online' | 'reconnecting' | 'offline';

export type RemoteEnrollmentState =
  | { kind: 'loading' }
  | { kind: 'not-enrolled' }
  | { kind: 'connecting'; serverUrl: string }
  | { kind: 'connected'; info: RemoteEnrollmentInfo; link: RemoteEnrollmentLink }
  | { kind: 'connect-failed'; serverUrl: string; error: string }
  /**
   * Enrolled but the connector is stopped (graceful disconnect). The
   * enrollment (identity + refresh secret) is kept; `reconnect()` resumes
   * without a new token. Only `disableRemote()` drops the enrollment.
   */
  | { kind: 'disconnected'; info: RemoteEnrollmentInfo }
  /**
   * Blocking: the Server presented a different application identity key than
   * the pinned one. The connector stays down until the local user explicitly
   * confirms or rejects the new fingerprint. Ordinary TLS certificate renewal
   * must never surface this state.
   */
  | {
      kind: 'identity-changed';
      info: RemoteEnrollmentInfo;
      previousFingerprint: string;
      newFingerprint: string;
      detectedAt: number;
    }
  | { kind: 'disconnecting'; info: RemoteEnrollmentInfo };

// ---------------------------------------------------------------------------
// Device pairing (proposal §5.2)
// ---------------------------------------------------------------------------

export interface PairingClaimInfo {
  deviceName: string;
  browser: string;
  os: string;
  /** Approximate network origin as reported by the Server (e.g. IP city). */
  networkOrigin: string;
  /** When the browser claimed the grant, epoch ms. */
  claimedAt: number;
}

export type RemotePairingState =
  | { kind: 'idle' }
  | { kind: 'creating' }
  /** Grant created: one QR + one `XXXX-XXXX` Crockford Base32 short code,
   *  both referencing the same grant. Expires 5 minutes after creation. */
  | { kind: 'awaiting-claim'; pairingId?: string; code: string; qrPayload: string; expiresAt: number }
  /** A browser claimed the grant; it is frozen and waits for explicit local
   *  confirmation. The Server can never auto-confirm. */
  | {
      kind: 'claimed';
      pairingId?: string;
      code: string;
      qrPayload: string;
      expiresAt: number;
      claim: PairingClaimInfo;
      decision: 'idle' | 'pending';
    }
  | { kind: 'expired' }
  | { kind: 'rejected' }
  /** Local user allowed the claim; the grant was consumed exactly once. */
  | { kind: 'consumed'; deviceName: string };

// ---------------------------------------------------------------------------
// Paired devices (proposal §5.4 + §5.6)
// ---------------------------------------------------------------------------

export type RemoteDeviceRevokeStatus =
  | 'active'
  /** Host applied `revoked_at` but still has to notify the Server / close
   *  routes. NOT done — the UI must not report completion. */
  | 'revoke-pending'
  /** Server was unreachable; revocation is authoritative locally and will be
   *  reconciled with the Server on the next connection. NOT done. */
  | 'pending-reconciliation'
  | 'revoked';

export interface RemoteDeviceInfo {
  id: string;
  name: string;
  /** Platform label captured at claim time (e.g. "iPhone · Safari"). */
  platform: string;
  createdAt: number;
  lastSeenAt: number | null;
  activeConnections: number;
  revokeStatus: RemoteDeviceRevokeStatus;
}

// ---------------------------------------------------------------------------
// Bounded remote mutation audit (proposal §5.8)
// ---------------------------------------------------------------------------

export type RemoteAuditResultCategory =
  | 'pending'
  | 'succeeded'
  | 'failed'
  | 'rejected'
  | 'unknown-outcome';

/**
 * One redacted audit row. Never carries prompt text, params, tokens, paths,
 * or ciphertext — only time, method, a truncated command id, and the
 * sanitized result category.
 */
export interface RemoteAuditEntry {
  id: string;
  at: number;
  deviceId: string;
  method: string;
  /** First 8 characters of the command id. */
  commandIdSummary: string;
  result: RemoteAuditResultCategory;
}

// ---------------------------------------------------------------------------
// Top-level state + actions
// ---------------------------------------------------------------------------

export interface RemoteSettingsState {
  error?: string | null;
  busy?: boolean;
  enrollment: RemoteEnrollmentState;
  pairing: RemotePairingState;
  devices: RemoteDeviceInfo[];
  /** Bounded recent audit per device id (newest first). */
  audit: Record<string, RemoteAuditEntry[]>;
}

export interface RemoteSettingsController {
  getState(): RemoteSettingsState;
  /** Store subscription for the React binding (useSyncExternalStore). */
  subscribe(listener: () => void): () => void;

  // Enrollment
  /**
   * Enroll with a one-time token. The caller clears the token from UI state
   * immediately after invoking this; the token is never echoed back through
   * `RemoteSettingsState`.
   */
  enroll(input: { serverUrl: string; enrollmentToken: string }): Promise<void>;
  /** Graceful disconnect (keeps enrollment so the user can reconnect). */
  disconnect(): Promise<void>;
  /** Resume the connector after a graceful disconnect. */
  reconnect(): Promise<void>;
  /** Emergency disable: disconnect AND drop the local enrollment. */
  disableRemote(): Promise<void>;
  /** Accept the changed Server application identity (blocking warning). */
  confirmServerIdentityChange(expectedFingerprint?: string): Promise<void>;
  /** Refuse the changed identity; the Host stays disconnected. */
  rejectServerIdentityChange(): Promise<void>;

  // Pairing
  /** Create one grant: QR payload + short code, 5-minute validity. */
  startPairing(): Promise<void>;
  /** Explicit local Allow/Reject of a claimed grant. */
  confirmPairingClaim(decision: 'allow' | 'reject', pairingId?: string): Promise<void>;
  /** Discard the current grant and return to idle. */
  cancelPairing(): Promise<void>;

  // Devices
  revokeDevice(deviceId: string): Promise<void>;
  setPublicUrl?(url: string): Promise<void>;
  loadAudit?(deviceId: string): Promise<void>;
  refresh?(): Promise<void>;
  dispose?(): void;
}
