import {
  AUTH_PROTOCOL,
  hostConnectorChallengeResultSchema,
  hostEnrollmentClaimResultSchema,
  isRemoteErrorCode,
  parseClosed,
  RemoteProtocolError,
  type HostEnrollmentClaimResult,
} from '@gian/remote-protocol';
import type { RemoteServerAuthClient } from './connector.js';
import type { RemoteIdentityMaterial } from './identity.js';

export class HttpRemoteServerAuthClient implements RemoteServerAuthClient {
  private accessToken: string | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly identity: RemoteIdentityMaterial,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly timeoutMs = 10_000,
  ) {}

  currentAccessToken(): string | null {
    return this.accessToken;
  }

  async claimEnrollment(input: {
    enrollmentToken: string;
    hostName: string;
    hostVersion: string;
    hostPublicKey: { kty: 'EC'; crv: 'P-256'; x: string; y: string };
  }): Promise<HostEnrollmentClaimResult> {
    const response = await this.request('/api/v1/host-enrollments/claim', {
      protocol: AUTH_PROTOCOL,
      enrollment_token: input.enrollmentToken,
      host_name: input.hostName,
      host_version: input.hostVersion,
      host_public_key: input.hostPublicKey,
    });
    return parseClosed(hostEnrollmentClaimResultSchema, response);
  }

  async challenge(hostId: string): Promise<{
    challenge_id: string;
    challenge: string;
    expires_at: number;
    server_identity_fingerprint: string;
    server_identity: {
      algorithm: 'P-256';
      public_key: { kty: 'EC'; crv: 'P-256'; x: string; y: string };
      fingerprint: string;
    };
    server_identity_signature: string;
  }> {
    const response = await this.request('/api/v1/host/connector-challenge', {
      protocol: AUTH_PROTOCOL,
      host_id: hostId,
    });
    return parseClosed(hostConnectorChallengeResultSchema, response);
  }

  async login(input: {
    hostId: string;
    challengeId: string;
    signature: string;
    refreshSecret: string;
  }): Promise<{ connector_access_token: string; refresh_secret: string }> {
    const response = await this.request('/api/v1/host/connector-login', {
      protocol: AUTH_PROTOCOL,
      host_id: input.hostId,
      challenge_id: input.challengeId,
      signature: input.signature,
      refresh_secret: input.refreshSecret,
    });
    this.accessToken = String(response.connector_access_token);
    await this.identity.setRefreshSecret(String(response.refresh_secret));
    return {
      connector_access_token: String(response.connector_access_token),
      refresh_secret: String(response.refresh_secret),
    };
  }

  async heartbeat(_hostId: string): Promise<void> {
    if (!this.accessToken) {
      throw new RemoteProtocolError('AUTH_REQUIRED', 'Host connector is not logged in');
    }
    await this.request('/api/v1/host/heartbeat', { protocol: AUTH_PROTOCOL }, this.accessToken);
  }

  async hostWsTicket(): Promise<string> {
    if (!this.accessToken) {
      throw new RemoteProtocolError('AUTH_REQUIRED', 'Host connector is not logged in');
    }
    const response = await this.request('/api/v1/host/ws-tickets', { protocol: AUTH_PROTOCOL }, this.accessToken);
    return String(response.ticket);
  }

  async renameHost(name: string): Promise<void> {
    if (!this.accessToken) throw new RemoteProtocolError('AUTH_REQUIRED', 'Host connector is not logged in');
    await this.request('/api/v1/host/profile', { protocol: AUTH_PROTOCOL, name }, this.accessToken);
  }

  async createPairing(): Promise<{
    grant_id: string;
    code: string;
    grant_nonce: string;
    expires_at: number;
  }> {
    if (!this.accessToken) {
      throw new RemoteProtocolError('AUTH_REQUIRED', 'Host connector is not logged in');
    }
    const response = await this.request('/api/v1/host/pairings', { protocol: AUTH_PROTOCOL }, this.accessToken);
    return {
      grant_id: String(response.grant_id),
      code: String(response.code),
      grant_nonce: String(response.grant_nonce),
      expires_at: Number(response.expires_at),
    };
  }

  async revokeDevice(deviceId: string): Promise<void> {
    if (!this.accessToken) {
      throw new RemoteProtocolError('AUTH_REQUIRED', 'Host connector is not logged in');
    }
    await this.request(`/api/v1/host/devices/${deviceId}/revoke`, {
      protocol: AUTH_PROTOCOL,
    }, this.accessToken);
  }

  async confirmPairing(pairingId: string, decision: 'confirm' | 'reject'): Promise<{
    pairing_id: string;
    status: 'confirmed' | 'rejected';
    device_id?: string;
    crypto_connection_id?: string;
  }> {
    if (!this.accessToken) {
      throw new RemoteProtocolError('AUTH_REQUIRED', 'Host connector is not logged in');
    }
    const response = await this.request(`/api/v1/pairings/${pairingId}/confirm`, {
      protocol: AUTH_PROTOCOL,
      pairing_id: pairingId,
      decision,
    }, this.accessToken);
    return {
      pairing_id: String(response.pairing_id),
      status: response.status === 'confirmed' ? 'confirmed' : 'rejected',
      ...(typeof response.device_id === 'string' ? { device_id: response.device_id } : {}),
      ...(typeof response.crypto_connection_id === 'string'
        ? { crypto_connection_id: response.crypto_connection_id }
        : {}),
    };
  }

  private async request(
    path: string,
    body: Record<string, unknown>,
    accessToken?: string,
  ): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (accessToken) headers.authorization = `Bearer ${accessToken}`;
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), this.timeoutMs);
    timeout.unref?.();
    let response: Response;
    try {
      response = await this.fetchFn(new URL(path, this.baseUrl.endsWith('/') ? this.baseUrl : `${this.baseUrl}/`).toString(), {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: abort.signal,
      });
    } catch (error) {
      if (abort.signal.aborted) {
        throw new RemoteProtocolError('HOST_OFFLINE', 'remote server request timed out');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
    const json = await response.json() as Record<string, unknown> & { error?: { code?: string } };
    if (!response.ok) {
      const code = json.error?.code ?? 'AUTH_REQUIRED';
      if (isRemoteErrorCode(code)) {
        throw new RemoteProtocolError(code, `remote server ${response.status}`);
      }
      throw new Error(code);
    }
    return json;
  }
}
