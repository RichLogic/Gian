import {
  AUTH_PROTOCOL,
  deviceChallengeResultSchema,
  deviceLoginResultSchema,
  parseClosed,
  pairingClaimResultSchema,
  selfRevokeResultSchema,
  sessionRefreshResultSchema,
  wsTicketResultSchema,
  type HostEnrollmentClaimResult,
} from '@gian/remote-protocol';
import type { RemoteHttpClient } from './http.js';

export class DeviceAuthClient {
  constructor(private readonly http: RemoteHttpClient) {}

  async claimPairing(input: {
    browserInstallationId: string;
    devicePublicKey: { kty: 'EC'; crv: 'P-256'; x: string; y: string };
    platform: string;
    userAgent: string;
    code?: string;
    grantNonce?: string;
  }) {
    return parseClosed(pairingClaimResultSchema, await this.http.request('/api/v1/pairings/claim', {
      protocol: AUTH_PROTOCOL,
      browser_installation_id: input.browserInstallationId,
      device_public_key: input.devicePublicKey,
      platform: input.platform,
      user_agent: input.userAgent,
      ...(input.code ? { code: input.code } : { grant_nonce: input.grantNonce }),
    }));
  }

  async challenge(browserInstallationId: string, hostId: string) {
    return parseClosed(deviceChallengeResultSchema, await this.http.request('/api/v1/sessions/device-challenge', {
      protocol: AUTH_PROTOCOL,
      browser_installation_id: browserInstallationId,
      host_id: hostId,
    }));
  }

  async login(input: {
    browserInstallationId: string;
    hostId: string;
    challengeId: string;
    signature: string;
  }) {
    return parseClosed(deviceLoginResultSchema, await this.http.request('/api/v1/sessions/device-login', {
      protocol: AUTH_PROTOCOL,
      browser_installation_id: input.browserInstallationId,
      host_id: input.hostId,
      challenge_id: input.challengeId,
      signature: input.signature,
    }));
  }

  async refresh(hostId?: string) {
    return parseClosed(sessionRefreshResultSchema, await this.http.request('/api/v1/sessions/refresh', {
      protocol: AUTH_PROTOCOL,
      ...(hostId ? { host_id: hostId } : {}),
    }));
  }

  async wsTicket(accessToken: string, hostId: string) {
    return parseClosed(wsTicketResultSchema, await this.http.request('/api/v1/ws-tickets', {
      protocol: AUTH_PROTOCOL,
      host_id: hostId,
    }, accessToken));
  }

  async me(): Promise<{ hosts?: Array<{ host_id: string; name: string; online: boolean }> }> {
    return this.http.get('/api/v1/me') as Promise<{
      hosts?: Array<{ host_id: string; name: string; online: boolean }>;
    }>;
  }

  async logout(): Promise<void> {
    await this.http.request('/api/v1/sessions/logout', { protocol: AUTH_PROTOCOL });
  }

  async selfRevoke(input: {
    hostId: string;
    signedAt: number;
    signature: string;
    accessToken: string;
  }) {
    return parseClosed(selfRevokeResultSchema, await this.http.del(
      `/api/v1/hosts/${input.hostId}/pairing`,
      {
        protocol: AUTH_PROTOCOL,
        host_id: input.hostId,
        signed_at: input.signedAt,
        signature: input.signature,
      },
      input.accessToken,
    ));
  }
}

export type { HostEnrollmentClaimResult };
