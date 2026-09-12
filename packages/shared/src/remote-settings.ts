/** Local Host -> Settings presentation contract. Never contains long-lived secrets. */
export interface RemoteSettingsPairing {
  id: string;
  status: 'pending_claim' | 'pending_confirmation' | 'confirmed' | 'rejected' | 'expired' | 'consumed';
  code: string | null;
  qr_payload: string | null;
  device_name: string | null;
  platform: string | null;
  user_agent: string | null;
  claimed_network: string | null;
  claimed_at: string | null;
  created_at: string;
  expires_at: string;
}

export interface RemoteSettingsSnapshot {
  enrolled: boolean;
  host_id: string | null;
  host_name: string | null;
  server_url: string | null;
  public_url: string | null;
  connection: 'online' | 'reconnecting' | 'offline' | 'disconnected';
  last_heartbeat_at: string | null;
  server_identity_fingerprint: string | null;
  pending_identity_fingerprint: string | null;
  identity_changed_at: string | null;
  pairing: RemoteSettingsPairing | null;
  pending_pairings: Array<Omit<RemoteSettingsPairing, 'code' | 'qr_payload'>>;
  devices: Array<{
    id: string;
    name: string;
    platform: string;
    grants: string[];
    created_at: string;
    last_seen_at: string | null;
    revoked_at: string | null;
    revision: number;
    active_connections: number;
    revoke_status: 'active' | 'revoke-pending' | 'pending-reconciliation' | 'revoked';
  }>;
}

export interface RemoteSettingsAuditEntry {
  id: string;
  deviceId: string;
  method: string;
  commandId: string;
  resultCategory: 'accepted' | 'succeeded' | 'failed' | 'denied' | 'expired' | 'unknown_outcome' | 'precondition_failed';
  createdAt: string;
}
